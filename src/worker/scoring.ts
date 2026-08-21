import type { Env } from "./types";
import { loadResume } from "./db";

// --- AI match scoring ------------------------------------------------------
//
// Rates every newly imported job against the uploaded resume (see
// migrations/0004 and PUT /api/resume) on a 1-5 scale, 5 = best fit. Jobs are
// batched through one Workers AI call each; a job that can't be scored keeps
// `match_score = NULL` and is simply picked up by the next run.
//
// Called from cron.ts after `insertJobs` (limit 80) and from POST /api/score,
// which the Manage page calls in a loop (limit 8 per call) after
// POST /api/rescore has cleared the scores. Neither caller should fail
// because scoring did: every batch is individually try/caught and the
// function never throws for a batch-level problem.

export const SCORING_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Jobs per AI call. Small, so one bad batch costs little and prompts stay well inside the context window. */
const BATCH_SIZE = 8;
const RESUME_MAX_CHARS = 12_000;
const JOB_DESCRIPTION_MAX_CHARS = 2_500;
const MAX_REASON_CHARS = 300;
/** Only jobs still visible in the UI (same 7-day window as `listRecentJobs`) are worth scoring. */
const WINDOW = "-7 days";

const SYSTEM_PROMPT =
  "You evaluate job listings for a specific candidate. Compare the candidate's resume to each listing and rate the fit from 1 to 5, where 5 = excellent (role, seniority, core skills and domain all line up), 3 = plausible partial match, and 1 = unrelated or the candidate is clearly unqualified. Weigh the job title, required skills and experience, seniority and domain. Consider location or remote only when the listing makes it a hard constraint. " +
  "Also classify each listing's work_mode. This is a judgment call, not a keyword search: read what the listing actually says. " +
  "'remote' = the listing says fully remote work is possible (e.g. \"remote\", \"work from anywhere\", \"100% remote\", \"remote-first\", or the Location field is \"Remote\"/\"Worldwide\" and nothing in the text contradicts it). Negated or restricted phrasing is NOT remote: \"remote not available\", \"no remote\", \"we don't allow remote workers\", \"this is an on-site role\", \"must be located in the office\" -> that is 'onsite'. " +
  "'hybrid' = fully remote is NOT possible but a remote/on-site mix is: the listing explicitly says hybrid, or describes remote work with a REQUIRED recurring on-site component (\"remote with occasional on-site work\", \"2 days a week in office\", \"mostly remote, some travel to HQ\"). Do not confuse this with a choice: when remote is offered as one option among alternatives (\"NYC or Remote\", \"remote or onsite\", \"Remote and Hybrid available\", \"US-Based / Remote\"), fully remote IS possible, so that is 'remote', not 'hybrid'. " +
  "'onsite' = clearly in-office/on-site only. 'unknown' = the listing gives no usable signal (e.g. no description and a plain city location). If the Location field says Remote but the description says otherwise, the description wins. " +
  "Return exactly one result for every job id you are given, copying each id verbatim — never skip a job. Keep each reason under 200 characters. Respond with JSON only.";

interface PendingJob {
  id: string;
  title: string;
  company: string;
  location: string | null;
  source: string;
  description: string | null;
}

interface ScoreResult {
  id?: unknown;
  score?: unknown;
  reason?: unknown;
  work_mode?: unknown;
}

function buildJsonSchema() {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            score: { type: "integer" },
            reason: { type: "string" },
            work_mode: { type: "string", enum: ["remote", "hybrid", "onsite", "unknown"] },
          },
          required: ["id", "score", "reason", "work_mode"],
        },
      },
    },
    required: ["results"],
  } as const;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function buildUserPrompt(resumeText: string, jobs: PendingJob[]): string {
  const blocks = jobs
    .map((job) =>
      [
        `### Job ${job.id}`,
        `Title: ${job.title}`,
        `Company: ${job.company}`,
        `Location: ${job.location ?? "(unspecified)"}`,
        `Source: ${job.source}`,
        `Description: ${
          job.description && job.description.trim() !== ""
            ? truncate(job.description, JOB_DESCRIPTION_MAX_CHARS)
            : "(no description available — judge from title/company)"
        }`,
      ].join("\n")
    )
    .join("\n\n");

  return `## Candidate resume\n${resumeText}\n\n## Jobs\n${blocks}\n\nRate all ${jobs.length} jobs above: return ${jobs.length} results, one per job id.`;
}

/** Unwraps Workers AI's `.response`, which may be a parsed object or a (possibly fenced) JSON string. */
function parseAiResponse(response: unknown): { results: ScoreResult[] } {
  let parsed: unknown = response;
  if (typeof parsed === "string") {
    const stripped = parsed
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    parsed = JSON.parse(stripped);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { results?: unknown }).results)) {
    throw new Error("scoring: AI response missing 'results' array");
  }
  return parsed as { results: ScoreResult[] };
}

/** Coerces the model's `score` to an integer in 1-5; null when it isn't a usable number. */
function normalizeScore(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(num)) return null;
  return Math.min(5, Math.max(1, Math.round(num)));
}

const WORK_MODES = new Set(["remote", "hybrid", "onsite", "unknown"]);

/** Accepts only the four enum values (case/whitespace-insensitive); anything else falls back to "unknown". */
function normalizeWorkMode(value: unknown): "remote" | "hybrid" | "onsite" | "unknown" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (WORK_MODES.has(normalized) ? normalized : "unknown") as "remote" | "hybrid" | "onsite" | "unknown";
}

export async function countPendingJobs(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE match_score IS NULL AND first_seen_at >= datetime('now', ?1)`
    )
    .bind(WINDOW)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Scores up to `opts.limit` not-yet-evaluated jobs from the last 7 days.
 * Returns how many were written and how many are still unscored afterwards.
 */
export async function scorePendingJobs(env: Env, opts: { limit: number }): Promise<{ scored: number; pending: number }> {
  const resume = await loadResume(env.DB);
  if (!resume) {
    console.log("[scoring] no resume uploaded; skipping");
    return { scored: 0, pending: 0 };
  }

  const { results } = await env.DB.prepare(
    `SELECT id, title, company, location, source, description
       FROM jobs
      WHERE match_score IS NULL AND first_seen_at >= datetime('now', ?1)
      ORDER BY first_seen_at DESC
      LIMIT ?2`
  )
    .bind(WINDOW, opts.limit)
    .all<PendingJob>();

  const pendingJobs = results ?? [];
  if (pendingJobs.length === 0) {
    console.log("[scoring] scored=0 pending=0");
    return { scored: 0, pending: 0 };
  }

  const resumeText = truncate(resume.text, RESUME_MAX_CHARS);
  let scored = 0;

  for (let i = 0; i < pendingJobs.length; i += BATCH_SIZE) {
    const batch = pendingJobs.slice(i, i + BATCH_SIZE);
    const batchIds = new Set(batch.map((job) => job.id));

    try {
      const aiResponse = await env.AI.run(SCORING_MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(resumeText, batch) },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response_format: { type: "json_schema", json_schema: buildJsonSchema() } as any,
        max_tokens: 3072,
      });

      const { results: scores } = parseAiResponse((aiResponse as { response?: unknown }).response);

      const updates: D1PreparedStatement[] = [];
      const seen = new Set<string>();
      const stmt = env.DB.prepare(
        `UPDATE jobs SET match_score = ?1, match_reason = ?2, work_mode = ?3, scored_at = datetime('now') WHERE id = ?4`
      );

      for (const result of scores) {
        if (!result || typeof result.id !== "string") continue;
        if (!batchIds.has(result.id) || seen.has(result.id)) continue; // ignore hallucinated/duplicated ids
        const score = normalizeScore(result.score);
        if (score === null) continue;
        const reason =
          typeof result.reason === "string" ? result.reason.trim().slice(0, MAX_REASON_CHARS) : null;
        const workMode = normalizeWorkMode(result.work_mode);
        seen.add(result.id);
        updates.push(stmt.bind(score, reason, workMode, result.id));
      }

      if (updates.length > 0) {
        await env.DB.batch(updates);
        scored += updates.length;
      }
    } catch (err) {
      // One bad batch (AI error, malformed JSON, …) leaves its jobs unscored
      // for the next run — it must never fail the digest.
      console.error(`[scoring] batch ${Math.floor(i / BATCH_SIZE)} failed`, err);
    }
  }

  const pending = await countPendingJobs(env.DB);
  console.log(`[scoring] scored=${scored} pending=${pending}`);
  return { scored, pending };
}

/** Clears the scores of every job in the 7-day window so they get re-evaluated (used after a resume change). */
export async function clearScores(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE jobs SET match_score = NULL, match_reason = NULL, work_mode = NULL, scored_at = NULL
        WHERE first_seen_at >= datetime('now', ?1)`
    )
    .bind(WINDOW)
    .run();
  return result.meta?.changes ?? 0;
}
