import type { Env } from "./types";

// --- Resume profile summary ------------------------------------------------
//
// The scorer used to paste 12,000 characters of raw resume into *every*
// scoring batch, so a run of 80 jobs re-sent the whole resume ten times. This
// condenses the resume ONCE per upload into a compact structured profile that
// carries everything the matcher actually uses — titles, seniority, skills,
// tools, roles, quantified outcomes — and drops the prose.
//
// The model is asked to EXTRACT into typed arrays (json_schema), not to write a
// summary: enumerating into a list is the mode it is reliable in, whereas a
// prose summary quietly drops anything it judges secondary (a technology named
// once inside a role description, for instance). The profile text the scorer
// sees is rendered from those arrays here, deterministically.
//
// A second, cheap pass then acts as a completeness critic: shown the resume
// and the extracted profile, it lists technologies and tools the first pass
// left out. Anything it names is only accepted if it literally occurs in the
// resume text, so the critic can add but never invent.
//
// Because it runs once per upload rather than once per batch, quality matters
// more than price here: this deliberately uses the same 70B model as the
// scorer. Failure is never fatal — scoring.ts falls back to the raw text.
//
// Like `resume.text`, the profile is never logged. It can be read by the admin
// via GET /api/resume/summary; the raw text still never leaves the Worker.

export const SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Hard cap on the stored/rendered profile. Generous on purpose: an exhaustive
 * skills list is the point, and even 6k chars is half the raw text the scorer
 * used to send per batch.
 */
export const RESUME_SUMMARY_MAX_CHARS = 6_000;

/** Same input cap the scorer used to apply to the raw resume text. */
const RESUME_INPUT_MAX_CHARS = 12_000;

/** Below this the model clearly returned a refusal or a stub, not a profile. */
const RESUME_SUMMARY_MIN_CHARS = 100;

/** Per-list ceiling, so a runaway response can't produce a megabyte of bullets. */
const MAX_ITEMS_PER_LIST = 120;
const MAX_ITEM_CHARS = 300;

const SUMMARY_SYSTEM_PROMPT =
  "You extract a structured, exhaustive profile from a candidate's resume so the candidate can be matched against job listings. Respond with JSON only, matching the schema you are given. " +
  "Rules:\n" +
  "- technical_skills: EVERY named technology in the resume — programming languages, frameworks, libraries, runtimes, cloud services, databases, platforms, protocols, architectures — including ones that appear only inside a role, project or achievement description, and ones mentioned only once. One item per technology, using the resume's own name for it; a phrase that names several technologies together yields one item for each of them. Never generalise ('web APIs', 'various databases'), merge, paraphrase or omit: if a technology is named anywhere in the resume it must appear by name in this list. When unsure whether something counts, include it.\n" +
  "- tools: tooling, CI/CD, DevOps, infrastructure, version control, monitoring, testing, project and collaboration tools, and named methodologies. Same exhaustiveness rule as technical_skills.\n" +
  "- roles: one entry per position held — title, employer, years exactly as written, and a one-sentence scope.\n" +
  "- quantified_achievements: every statement carrying a number, percentage, amount of money, headcount or other measurable outcome. Keep the numbers exactly as written.\n" +
  "- profile: one to three sentences — current or most recent title, total years of professional experience, seniority level, primary domains or industries.\n" +
  "State only facts present in the resume; never infer, embellish, or invent titles, dates, employers, technologies or numbers. Do not shorten any list to save space.";

/** The structured profile the model returns; rendered to text by `renderResumeProfile`. */
export interface ResumeProfile {
  profile: string;
  technical_skills: string[];
  tools: string[];
  roles: Array<{ title: string; company: string; years: string; scope: string }>;
  quantified_achievements: string[];
}

function buildJsonSchema() {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      technical_skills: { type: "array", items: { type: "string" } },
      tools: { type: "array", items: { type: "string" } },
      roles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            company: { type: "string" },
            years: { type: "string" },
            scope: { type: "string" },
          },
          required: ["title", "company", "years", "scope"],
        },
      },
      quantified_achievements: { type: "array", items: { type: "string" } },
    },
    required: ["profile", "technical_skills", "tools", "roles", "quantified_achievements"],
  } as const;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS) : "";
}

/** Trims, drops empties, de-duplicates case-insensitively (first spelling wins) and caps the list. */
function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = cleanString(item);
    const key = text.toLowerCase();
    if (text === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_ITEMS_PER_LIST) break;
  }
  return out;
}

/**
 * Validates and normalises the model's JSON (parsed object or a possibly
 * fenced JSON string) into a `ResumeProfile`. Returns null when the shape is
 * unusable; individual bad items are dropped rather than failing the whole
 * profile.
 */
export function parseResumeProfile(raw: unknown): ResumeProfile | null {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    const stripped = parsed
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const roles: ResumeProfile["roles"] = [];
  if (Array.isArray(obj.roles)) {
    for (const entry of obj.roles) {
      if (!entry || typeof entry !== "object") continue;
      const role = entry as Record<string, unknown>;
      const title = cleanString(role.title);
      const company = cleanString(role.company);
      if (title === "" && company === "") continue;
      roles.push({ title, company, years: cleanString(role.years), scope: cleanString(role.scope) });
      if (roles.length >= MAX_ITEMS_PER_LIST) break;
    }
  }

  const profile: ResumeProfile = {
    profile: cleanString(obj.profile),
    technical_skills: cleanList(obj.technical_skills),
    tools: cleanList(obj.tools),
    roles,
    quantified_achievements: cleanList(obj.quantified_achievements),
  };

  const hasContent =
    profile.profile !== "" ||
    profile.technical_skills.length > 0 ||
    profile.tools.length > 0 ||
    profile.roles.length > 0 ||
    profile.quantified_achievements.length > 0;
  return hasContent ? profile : null;
}

const COMPLETENESS_SYSTEM_PROMPT =
  "You audit an extracted candidate profile for completeness against the resume it was built from. Respond with JSON only, matching the schema. " +
  "List every technology (language, framework, library, runtime, cloud service, database, platform, protocol) and every tool (tooling, CI/CD, DevOps, infrastructure, monitoring, testing, collaboration, methodology) that is named in the resume but does NOT already appear in the profile, using the resume's own wording. " +
  "Check role and project descriptions and achievements, not just a skills section. Only list things that literally appear in the resume; return empty arrays when nothing is missing.";

function buildCompletenessSchema() {
  return {
    type: "object",
    properties: {
      missing_technical_skills: { type: "array", items: { type: "string" } },
      missing_tools: { type: "array", items: { type: "string" } },
    },
    required: ["missing_technical_skills", "missing_tools"],
  } as const;
}

/** Items the completeness pass proposes adding; see `mergeMissingItems`. */
export interface MissingItems {
  missing_technical_skills: string[];
  missing_tools: string[];
}

export function parseMissingItems(raw: unknown): MissingItems | null {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    const stripped = parsed
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  return {
    missing_technical_skills: cleanList(obj.missing_technical_skills),
    missing_tools: cleanList(obj.missing_tools),
  };
}

/**
 * Adds the critic's findings to the profile. An item is only accepted when it
 * occurs verbatim (case-insensitively) in the resume text — the critic may
 * surface what the first pass missed, but it can't introduce anything the
 * resume doesn't say. Duplicates of existing items are dropped.
 */
export function mergeMissingItems(profile: ResumeProfile, missing: MissingItems, resumeText: string): ResumeProfile {
  const haystack = resumeText.toLowerCase();
  const verified = (items: string[]) => items.filter((item) => haystack.includes(item.toLowerCase()));
  return {
    ...profile,
    technical_skills: cleanList([...profile.technical_skills, ...verified(missing.missing_technical_skills)]),
    tools: cleanList([...profile.tools, ...verified(missing.missing_tools)]),
  };
}

/**
 * Renders the profile as the markdown-ish text the scorer puts in its prompt
 * (and the admin sees on the Manage page). Same five headings as before, so
 * the scoring prompt didn't have to change.
 */
export function renderResumeProfile(profile: ResumeProfile): string {
  const bullets = (items: string[]) => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none listed)");
  const roles =
    profile.roles.length > 0
      ? profile.roles
          .map((role) => {
            const who = [role.title, role.company].filter((part) => part !== "").join(" @ ");
            const when = role.years !== "" ? ` (${role.years})` : "";
            const scope = role.scope !== "" ? ` — ${role.scope}` : "";
            return `- ${who}${when}${scope}`;
          })
          .join("\n")
      : "- (none listed)";

  const text = [
    "## Profile",
    profile.profile !== "" ? profile.profile : "(not stated)",
    "",
    "## Technical skills",
    bullets(profile.technical_skills),
    "",
    "## Tools",
    bullets(profile.tools),
    "",
    "## Roles",
    roles,
    "",
    "## Quantified achievements",
    bullets(profile.quantified_achievements),
  ].join("\n");

  return text.length > RESUME_SUMMARY_MAX_CHARS ? `${text.slice(0, RESUME_SUMMARY_MAX_CHARS - 1)}…` : text;
}

/**
 * Condenses the stored resume into a structured profile and renders it.
 *
 * Returns null (never throws) when the model errors or returns something
 * unusable, so callers can fall back to the raw resume text.
 */
export async function summarizeResume(env: Env, resumeText: string): Promise<string | null> {
  const input = resumeText.slice(0, RESUME_INPUT_MAX_CHARS);

  try {
    const aiResponse = await env.AI.run(SUMMARY_MODEL, {
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Extract the candidate's profile from this resume. Remember: every named technology and tool, with nothing merged or left out.\n\n${input}`,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response_format: { type: "json_schema", json_schema: buildJsonSchema() } as any,
      max_tokens: 1536,
    });

    const extracted = parseResumeProfile((aiResponse as { response?: unknown }).response);
    if (!extracted) {
      // Never log the payload itself — it is resume-derived content.
      console.error("[resume] summary failed", "unusable response shape");
      return null;
    }

    const profile = await addMissingItems(env, input, extracted);
    const summary = renderResumeProfile(profile);
    if (summary.length < RESUME_SUMMARY_MIN_CHARS) {
      console.error("[resume] summary failed", "too short");
      return null;
    }
    return summary;
  } catch (err) {
    // Log the error *type* only: AI errors can echo the prompt back.
    console.error("[resume] summary failed", err instanceof Error ? err.name : typeof err);
    return null;
  }
}

/**
 * Completeness pass: asks the model what the extraction left out and merges
 * the verified additions. Best effort — on any failure the first-pass profile
 * is returned unchanged.
 */
async function addMissingItems(env: Env, resumeText: string, profile: ResumeProfile): Promise<ResumeProfile> {
  try {
    const aiResponse = await env.AI.run(SUMMARY_MODEL, {
      messages: [
        { role: "system", content: COMPLETENESS_SYSTEM_PROMPT },
        {
          role: "user",
          content: `## Resume\n${resumeText}\n\n## Extracted profile\n${renderResumeProfile(profile)}\n\nList what the profile is missing.`,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response_format: { type: "json_schema", json_schema: buildCompletenessSchema() } as any,
      max_tokens: 512,
    });

    const missing = parseMissingItems((aiResponse as { response?: unknown }).response);
    if (!missing) {
      console.error("[resume] completeness check skipped", "unusable response shape");
      return profile;
    }
    const merged = mergeMissingItems(profile, missing, resumeText);
    const added =
      merged.technical_skills.length - profile.technical_skills.length + (merged.tools.length - profile.tools.length);
    console.log(`[resume] completeness check added=${added}`);
    return merged;
  } catch (err) {
    console.error("[resume] completeness check skipped", err instanceof Error ? err.name : typeof err);
    return profile;
  }
}
