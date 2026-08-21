import type { Env } from "./types";

// --- Resume profile summary ------------------------------------------------
//
// The scorer used to paste 12,000 characters of raw resume into *every*
// scoring batch, so a run of 80 jobs re-sent the whole resume ten times. This
// condenses the resume ONCE per upload into a compact structured profile
// (~2.5k chars) that carries everything the matcher actually uses — titles,
// seniority, skills, tools, roles, quantified outcomes — and drops the prose.
//
// Because it runs once per upload rather than once per batch, quality matters
// more than price here: this deliberately uses the same 70B model as the
// scorer. Failure is never fatal — scoring.ts falls back to the raw text.
//
// Like `resume.text`, the summary must never be logged (see migrations/0006).
// /api/resume exposes only its length; the admin can read the full summary via
// GET /api/resume/summary.

export const SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Hard cap on the stored summary. Matches migrations/0006's ~2.5k target plus slack. */
export const RESUME_SUMMARY_MAX_CHARS = 4_000;

/** Same input cap the scorer used to apply to the raw resume text. */
const RESUME_INPUT_MAX_CHARS = 12_000;

/** Below this the model clearly returned a refusal or a stub, not a profile. */
const RESUME_SUMMARY_MIN_CHARS = 100;

const SUMMARY_SYSTEM_PROMPT =
  "You condense resumes into compact, factual profiles used to match the candidate against job listings. " +
  "Output bullet lists under exactly these headings, in this order, and nothing else — no preamble, no commentary, no closing remarks:\n" +
  "## Profile\n" +
  "(1-3 lines: current or most recent title, total years of professional experience, seniority level, primary domains/industries)\n" +
  "## Technical skills\n" +
  "(languages, frameworks, platforms — one per bullet, grouped sensibly)\n" +
  "## Tools\n" +
  "(tooling, cloud, CI/CD, databases, etc.)\n" +
  "## Roles\n" +
  "(one bullet per role: title @ company, years, one-line scope)\n" +
  "## Quantified achievements\n" +
  "(bullets with numbers or outcomes — keep the numbers)\n\n" +
  "Keep the whole profile under about 2,500 characters. State only facts present in the resume: never infer, embellish, or invent titles, dates, employers or numbers.";

/**
 * Condenses the stored resume into a structured profile.
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
          content: `Condense this resume into a compact, factual profile for matching against job listings.\n\n${input}`,
        },
      ],
      max_tokens: 1024,
    });

    const raw = (aiResponse as { response?: unknown }).response;
    if (typeof raw !== "string") {
      // Never log the payload itself — it is resume-derived content.
      console.error("[resume] summary failed", "non-string response");
      return null;
    }

    const summary = raw.trim();
    if (summary.length < RESUME_SUMMARY_MIN_CHARS) {
      console.error("[resume] summary failed", "too short");
      return null;
    }

    return summary.slice(0, RESUME_SUMMARY_MAX_CHARS);
  } catch (err) {
    // Log the error *type* only: AI errors can echo the prompt back.
    console.error("[resume] summary failed", err instanceof Error ? err.name : typeof err);
    return null;
  }
}
