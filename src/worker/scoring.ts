import type { Env } from "./types";
import { loadResume, saveResumeSummary } from "./db";
import { RESUME_SUMMARY_MAX_CHARS, SUMMARY_MODEL, summarizeResume } from "./resume-summary";
import {
  DUPLICATE_POOL_WINDOW,
  EMBEDDING_MODEL,
  decodeEmbedding,
  embedTexts,
  encodeEmbedding,
  findDuplicate,
  jobEmbeddingText,
} from "./dedupe";

// --- AI match scoring ------------------------------------------------------
//
// Rates every newly imported job against the uploaded resume (see
// migrations/0004 and PUT /api/resume) on a 1-5 scale, 5 = best fit. Jobs are
// batched through one Workers AI call each; a job that can't be scored keeps
// `match_score = NULL` and is simply picked up by the next run.
//
// Two things keep the token bill down (migrations/0006):
//   * the prompt carries a condensed resume *profile* (resume-summary.ts)
//     rather than 12k characters of raw resume re-sent with every batch;
//   * near-identical re-posts of an already-rated listing copy that rating
//     instead of costing an LLM call (dedupe.ts). Dedupe is an optimisation
//     and never a gate: if any part of it fails, every pending job goes to the
//     LLM exactly as before.
//
// Called from cron.ts after `insertJobs` (limit 80) and from POST /api/score,
// which the Manage page calls in a loop (limit 16 per call) after
// POST /api/rescore has cleared the scores. Neither caller should fail
// because scoring did: every batch is individually try/caught and the
// function never throws for a batch-level problem.

export const SCORING_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Jobs per AI call. The prompt now carries a ~2.5k-char profile instead of a 12k resume, so 16 fits comfortably. */
const BATCH_SIZE = 16;
const RESUME_MAX_CHARS = 12_000;
const JOB_DESCRIPTION_MAX_CHARS = 2_500;
const MAX_REASON_CHARS = 300;
/** Only jobs still visible in the UI (same 7-day window as `listRecentJobs`) are worth scoring. */
const WINDOW = "-7 days";

const SYSTEM_PROMPT =
  "You evaluate job listings for a specific candidate. The candidate is described by a structured summary of their resume. Compare that summary to each listing and rate the fit from 1 to 5, where 5 = excellent (role, seniority, core skills and domain all line up), 3 = plausible partial match, and 1 = unrelated or the candidate is clearly unqualified. Weigh the job title, required skills and experience, seniority and domain. Consider location or remote only when the listing makes it a hard constraint. " +
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
  embedding: ArrayBuffer | Uint8Array | number[] | null;
  embedding_model: string | null;
}

/** An already-rated job its near-duplicates can copy from. */
interface PoolEntry {
  id: string;
  company: string;
  embedding: Float32Array;
  match_score: number;
  match_reason: string | null;
  work_mode: string | null;
}

interface ScoreResult {
  id?: unknown;
  score?: unknown;
  reason?: unknown;
  work_mode?: unknown;
}

/** What was written for one job, so its in-run duplicates can copy it verbatim. */
interface WrittenScore {
  score: number;
  reason: string | null;
  work_mode: string;
}

export interface ScoringResult {
  /** Jobs given a rating this run: LLM-scored plus copied from a duplicate. */
  scored: number;
  /** How many of `scored` were copied from a near-identical listing instead of costing an LLM call. */
  deduped: number;
  pending: number;
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

function buildUserPrompt(resumeProfile: string, jobs: PendingJob[]): string {
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

  return `## Candidate resume\n${resumeProfile}\n\n## Jobs\n${blocks}\n\nRate all ${jobs.length} jobs above: return ${jobs.length} results, one per job id.`;
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
 * The condensed profile the prompt should carry. Builds and persists one when
 * the stored resume predates migrations/0006 (or a previous summary attempt
 * failed); falls back to the raw resume text if the model won't cooperate.
 */
async function resolveResumeProfile(
  env: Env,
  resume: { text: string; summary: string | null }
): Promise<string> {
  if (resume.summary && resume.summary.trim() !== "") {
    return truncate(resume.summary, RESUME_SUMMARY_MAX_CHARS);
  }

  const summary = await summarizeResume(env, resume.text);
  if (summary) {
    try {
      await saveResumeSummary(env.DB, summary, SUMMARY_MODEL);
    } catch (err) {
      // Not fatal: we can still use the summary for this run.
      console.error("[scoring] storing resume summary failed", err);
    }
    return summary;
  }

  return truncate(resume.text, RESUME_MAX_CHARS);
}

/**
 * Embeds every pending job that doesn't already have a usable vector and
 * stores the result. Returns id -> vector for the whole batch (including the
 * ones that were already stored). Throws only from `embedTexts`; the caller
 * treats a failure as "no dedupe this run".
 */
async function ensureEmbeddings(env: Env, jobs: PendingJob[]): Promise<Map<string, Float32Array>> {
  const embeddings = new Map<string, Float32Array>();
  const missing: PendingJob[] = [];

  for (const job of jobs) {
    // A vector from a different model lives in a different space, so it is
    // worthless for comparison — treat it as missing and re-embed.
    if (job.embedding && job.embedding_model === EMBEDDING_MODEL) {
      embeddings.set(job.id, decodeEmbedding(job.embedding));
    } else {
      missing.push(job);
    }
  }

  if (missing.length === 0) return embeddings;

  const vectors = await embedTexts(env, missing.map(jobEmbeddingText));

  const stmt = env.DB.prepare(`UPDATE jobs SET embedding = ?1, embedding_model = ?2 WHERE id = ?3`);
  const updates: D1PreparedStatement[] = [];
  missing.forEach((job, i) => {
    const vector = vectors[i];
    if (!vector) return;
    embeddings.set(job.id, vector);
    updates.push(stmt.bind(encodeEmbedding(vector), EMBEDDING_MODEL, job.id));
  });

  if (updates.length > 0) await env.DB.batch(updates);
  return embeddings;
}

/**
 * Recently rated jobs a duplicate may copy from. `scored_at >= uploaded_at`
 * keeps us from copying a rating produced against an older resume, and
 * `duplicate_of IS NULL` stops copies from chaining off other copies.
 */
async function loadDuplicatePool(env: Env, resumeUploadedAt: string): Promise<PoolEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, company, embedding, match_score, match_reason, work_mode
       FROM jobs
      WHERE match_score IS NOT NULL
        AND embedding IS NOT NULL
        AND embedding_model = ?1
        AND duplicate_of IS NULL
        AND scored_at >= ?2
        AND first_seen_at >= datetime('now', ?3)`
  )
    .bind(EMBEDDING_MODEL, resumeUploadedAt, DUPLICATE_POOL_WINDOW)
    .all<{
      id: string;
      company: string;
      embedding: ArrayBuffer | Uint8Array | number[];
      match_score: number;
      match_reason: string | null;
      work_mode: string | null;
    }>();

  return (results ?? []).map((row) => ({
    id: row.id,
    company: row.company,
    embedding: decodeEmbedding(row.embedding),
    match_score: row.match_score,
    match_reason: row.match_reason,
    work_mode: row.work_mode,
  }));
}

/**
 * Scores up to `opts.limit` not-yet-evaluated jobs from the last 7 days.
 * Returns how many were written (and how many of those were copied from a
 * near-identical listing) plus how many are still unscored afterwards.
 */
export async function scorePendingJobs(env: Env, opts: { limit: number }): Promise<ScoringResult> {
  const resume = await loadResume(env.DB);
  if (!resume) {
    console.log("[scoring] no resume uploaded; skipping");
    return { scored: 0, deduped: 0, pending: 0 };
  }

  const { results } = await env.DB.prepare(
    `SELECT id, title, company, location, source, description, embedding, embedding_model
       FROM jobs
      WHERE match_score IS NULL AND first_seen_at >= datetime('now', ?1)
      ORDER BY first_seen_at DESC
      LIMIT ?2`
  )
    .bind(WINDOW, opts.limit)
    .all<PendingJob>();

  const pendingJobs = results ?? [];
  if (pendingJobs.length === 0) {
    console.log("[scoring] scored=0 deduped=0 pending=0");
    return { scored: 0, deduped: 0, pending: 0 };
  }

  const resumeProfile = await resolveResumeProfile(env, resume);

  // --- Duplicate detection (best effort) ---------------------------------
  let embeddings = new Map<string, Float32Array>();
  let pool: PoolEntry[] = [];
  try {
    embeddings = await ensureEmbeddings(env, pendingJobs);
    pool = await loadDuplicatePool(env, resume.uploaded_at);
  } catch (err) {
    console.error("[scoring] embedding failed", err);
    embeddings = new Map();
    pool = [];
  }

  const copyStmt = env.DB.prepare(
    `UPDATE jobs SET match_score = ?1, match_reason = ?2, work_mode = ?3, duplicate_of = ?4,
            scored_at = datetime('now')
      WHERE id = ?5`
  );

  const canonical: PendingJob[] = [];
  /** Copies of a canonical job from this same run, keyed by that canonical's id. */
  const inRunDups = new Map<string, string[]>();
  const poolCopies: D1PreparedStatement[] = [];
  /** Canonicals seen so far this run, so two fresh copies cost one LLM slot. */
  const runPool: Array<{ id: string; company: string; embedding: Float32Array }> = [];

  for (const job of pendingJobs) {
    const embedding = embeddings.get(job.id);
    if (!embedding) {
      canonical.push(job); // no vector -> always rated by the LLM
      continue;
    }

    const candidate = { company: job.company, embedding };

    const poolMatch = findDuplicate(candidate, pool);
    if (poolMatch) {
      const source = pool.find((entry) => entry.id === poolMatch.id);
      if (source) {
        // Copy the reason verbatim; the UI uses `duplicate_of` for the hint.
        poolCopies.push(
          copyStmt.bind(source.match_score, source.match_reason, source.work_mode, source.id, job.id)
        );
        continue;
      }
    }

    const runMatch = findDuplicate(candidate, runPool);
    if (runMatch) {
      const siblings = inRunDups.get(runMatch.id);
      if (siblings) siblings.push(job.id);
      else inRunDups.set(runMatch.id, [job.id]);
      continue;
    }

    canonical.push(job);
    runPool.push({ id: job.id, company: job.company, embedding });
  }

  let deduped = 0;
  if (poolCopies.length > 0) {
    try {
      await env.DB.batch(poolCopies);
      deduped += poolCopies.length;
    } catch (err) {
      // The affected jobs stay pending and are retried next run.
      console.error("[scoring] copying duplicate scores failed", err);
    }
  }

  // --- LLM scoring -------------------------------------------------------
  let scored = 0;

  for (let i = 0; i < canonical.length; i += BATCH_SIZE) {
    const batch = canonical.slice(i, i + BATCH_SIZE);
    const batchIds = new Set(batch.map((job) => job.id));

    try {
      const aiResponse = await env.AI.run(SCORING_MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(resumeProfile, batch) },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response_format: { type: "json_schema", json_schema: buildJsonSchema() } as any,
        max_tokens: 4096,
      });

      const { results: scores } = parseAiResponse((aiResponse as { response?: unknown }).response);

      const updates: D1PreparedStatement[] = [];
      const written = new Map<string, WrittenScore>();
      const stmt = env.DB.prepare(
        `UPDATE jobs SET match_score = ?1, match_reason = ?2, work_mode = ?3, scored_at = datetime('now') WHERE id = ?4`
      );

      for (const result of scores) {
        if (!result || typeof result.id !== "string") continue;
        if (!batchIds.has(result.id) || written.has(result.id)) continue; // ignore hallucinated/duplicated ids
        const score = normalizeScore(result.score);
        if (score === null) continue;
        const reason =
          typeof result.reason === "string" ? result.reason.trim().slice(0, MAX_REASON_CHARS) : null;
        const workMode = normalizeWorkMode(result.work_mode);
        written.set(result.id, { score, reason, work_mode: workMode });
        updates.push(stmt.bind(score, reason, workMode, result.id));
      }

      // Copies of anything this batch just rated get the same values. A
      // canonical the model skipped leaves its copies pending for next run.
      let copies = 0;
      for (const [canonicalId, dupIds] of inRunDups) {
        const source = written.get(canonicalId);
        if (!source) continue;
        for (const dupId of dupIds) {
          updates.push(copyStmt.bind(source.score, source.reason, source.work_mode, canonicalId, dupId));
          copies += 1;
        }
        inRunDups.delete(canonicalId);
      }

      if (updates.length > 0) {
        await env.DB.batch(updates);
        scored += updates.length - copies;
        deduped += copies;
      }
    } catch (err) {
      // One bad batch (AI error, malformed JSON, …) leaves its jobs unscored
      // for the next run — it must never fail the digest.
      console.error(`[scoring] batch ${Math.floor(i / BATCH_SIZE)} failed`, err);
    }
  }

  const pending = await countPendingJobs(env.DB);
  console.log(`[scoring] scored=${scored + deduped} deduped=${deduped} pending=${pending}`);
  return { scored: scored + deduped, deduped, pending };
}

/**
 * Clears the scores of every job in the 7-day window so they get re-evaluated
 * (used after a resume change). Embeddings are deliberately kept: they
 * describe the job text, which hasn't changed.
 */
export async function clearScores(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE jobs SET match_score = NULL, match_reason = NULL, work_mode = NULL, scored_at = NULL,
              duplicate_of = NULL
        WHERE first_seen_at >= datetime('now', ?1)`
    )
    .bind(WINDOW)
    .run();
  return result.meta?.changes ?? 0;
}
