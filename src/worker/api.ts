import type { Criteria, Env, ResumeInfo } from "./types";
import {
  loadCriteria,
  loadSources,
  listRecentJobs,
  updateCriteria,
  updateSource,
  getSource,
  getResumeInfo,
  loadResumeSummary,
  saveResume,
  saveResumeSummary,
} from "./db";
import { requireAdmin } from "./auth";
import { runDigest } from "./cron";
import { clearScores, countPendingJobs, scorePendingJobs } from "./scoring";
import { SUMMARY_MODEL, summarizeResume } from "./resume-summary";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

class ValidationError extends Error {}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("body: invalid JSON");
  }
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field}: must be an array`);
  }
  const trimmed: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ValidationError(`${field}: items must be strings`);
    }
    const t = item.trim();
    if (t === "") {
      throw new ValidationError(`${field}: items must be non-empty strings`);
    }
    if (t.length > 100) {
      throw new ValidationError(`${field}: items must be at most 100 characters`);
    }
    trimmed.push(t);
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of trimmed) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  if (deduped.length > 50) {
    throw new ValidationError(`${field}: at most 50 items allowed`);
  }

  return deduped;
}

function validateCriteriaBody(body: unknown): Criteria {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("body: must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const required_keywords = validateStringArray(b.required_keywords, "required_keywords");
  const excluded_keywords = validateStringArray(b.excluded_keywords, "excluded_keywords");
  const locations = validateStringArray(b.locations, "locations");

  if (typeof b.remote_ok !== "boolean") {
    throw new ValidationError("remote_ok: must be a boolean");
  }

  if (
    typeof b.max_age_days !== "number" ||
    !Number.isInteger(b.max_age_days) ||
    b.max_age_days < 1 ||
    b.max_age_days > 30
  ) {
    throw new ValidationError("max_age_days: must be an integer between 1 and 30");
  }

  return {
    required_keywords,
    excluded_keywords,
    locations,
    remote_ok: b.remote_ok,
    max_age_days: b.max_age_days,
  };
}

function secretsPresent(env: Env, names: string[]): boolean {
  return names.every((name) => typeof env[name] === "string" && (env[name] as string).trim() !== "");
}

async function handleSourcesRoute(request: Request, env: Env, sourceId: string): Promise<Response> {
  if (request.method !== "PUT") {
    return json({ error: "method not allowed" }, 405);
  }

  const authFailure = requireAdmin(request, env);
  if (authFailure) return authFailure;

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "body: must be a JSON object" }, 400);
  }
  const b = body as Record<string, unknown>;

  const update: { enabled?: boolean; config?: Record<string, unknown> } = {};

  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") {
      return json({ error: "enabled: must be a boolean" }, 400);
    }
    update.enabled = b.enabled;
  }

  if ("config" in b) {
    if (typeof b.config !== "object" || b.config === null || Array.isArray(b.config)) {
      return json({ error: "config: must be a JSON object" }, 400);
    }
    const serialized = JSON.stringify(b.config);
    if (new TextEncoder().encode(serialized).length > 4096) {
      return json({ error: "config: must be at most 4KB when JSON-serialized" }, 400);
    }
    update.config = b.config as Record<string, unknown>;
  }

  if (update.enabled === undefined && update.config === undefined) {
    return json({ error: "body: must include enabled and/or config" }, 400);
  }

  const existing = await getSource(env.DB, sourceId);
  if (!existing) {
    return json({ error: "source not found" }, 404);
  }

  const ok = await updateSource(env.DB, sourceId, update);
  if (!ok) {
    return json({ error: "source not found" }, 404);
  }

  const fresh = await getSource(env.DB, sourceId);
  if (!fresh) {
    return json({ error: "source not found" }, 404);
  }

  return json({
    id: fresh.id,
    display_name: fresh.display_name,
    enabled: fresh.enabled,
    config: fresh.config,
    requires_secrets: fresh.requires_secrets,
    secrets_present: secretsPresent(env, fresh.requires_secrets),
    updated_at: fresh.updated_at,
  });
}

// --- Resume upload --------------------------------------------------------

/** Hard cap on the uploaded PDF; Workers AI's PDF -> text conversion is the expensive part. */
const RESUME_MAX_BYTES = 5 * 1024 * 1024;
/** Hard cap on the stored text (the scorer only ever sends the first 12k chars anyway). */
const RESUME_MAX_CHARS = 50_000;
/** Below this, the "PDF" almost certainly has no text layer (a scan/photo). */
const RESUME_MIN_CHARS = 50;

async function handleResumeRoute(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    // Metadata only — the extracted text never leaves the Worker. The condensed
    // profile summary is available to the admin via GET /api/resume/summary.
    const resume = await getResumeInfo(env.DB);
    return json({ resume });
  }

  if (request.method !== "PUT") {
    return json({ error: "method not allowed" }, 405);
  }

  const authFailure = requireAdmin(request, env);
  if (authFailure) return authFailure;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "body: expected multipart/form-data" }, 400);
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return json({ error: "file: required (multipart/form-data field named 'file')" }, 400);
  }

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return json({ error: "file: must be a PDF" }, 400);
  }
  if (file.size > RESUME_MAX_BYTES) {
    return json({ error: "file: must be at most 5 MB" }, 400);
  }

  const conversion = await env.AI.toMarkdown({ name: file.name, blob: file });
  if (conversion.format === "error") {
    // conversion.error can echo document content; keep it out of the response and the log.
    console.error("[resume] toMarkdown failed");
    return json({ error: "file: could not extract text from PDF" }, 400);
  }

  const text = conversion.data.trim();
  if (text.length < RESUME_MIN_CHARS) {
    return json({ error: "file: no text could be extracted (is the PDF a scanned image?)" }, 400);
  }

  const stored = text.slice(0, RESUME_MAX_CHARS);
  await saveResume(env.DB, file.name, stored);

  // Condense the resume into the profile the scorer sends with every batch
  // (see resume-summary.ts). Doing it here means the first scoring run after
  // an upload doesn't pay for it — but a failure must not fail the upload:
  // scorePendingJobs retries, and falls back to the raw text if need be.
  const summary = await summarizeResume(env, stored);
  if (summary) {
    await saveResumeSummary(env.DB, summary, SUMMARY_MODEL);
  }

  // Existing scores are left alone; POST /api/rescore re-evaluates on demand.
  const resume = (await getResumeInfo(env.DB)) as ResumeInfo;
  return json({ resume });
}

/**
 * The condensed profile summary (see resume-summary.ts), admin-only. The raw resume
 * text is never exposed by any route — only this structured summary is.
 */
async function handleResumeSummaryRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  const authFailure = requireAdmin(request, env);
  if (authFailure) return authFailure;

  const row = await loadResumeSummary(env.DB);
  if (!row) {
    return json({ error: "no resume uploaded" }, 404);
  }

  return json({
    summary: row.summary,
    summary_model: row.summary_model,
    summarized_at: row.summarized_at,
  });
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  try {
    const path = url.pathname;

    if (path === "/api/jobs") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const jobs = await listRecentJobs(env.DB);
      return json({ jobs });
    }

    // Manual trigger of the morning fetch. Admin-only so a public URL can't be
    // used to burn subrequests; runs synchronously and returns the summary.
    if (path === "/api/run") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const authFailure = requireAdmin(request, env);
      if (authFailure) return authFailure;
      const summary = await runDigest(env);
      return json(summary);
    }

    if (path === "/api/resume/summary") {
      return handleResumeSummaryRoute(request, env);
    }

    if (path === "/api/resume") {
      return handleResumeRoute(request, env);
    }

    // Clear every score in the 7-day window so those jobs get re-evaluated
    // against the current resume. Separate from the upload so a resume change
    // doesn't silently burn a pile of AI calls, and separate from scoring
    // itself so the client can drive the (potentially slow) scoring loop and
    // show progress — see POST /api/score.
    if (path === "/api/rescore") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const authFailure = requireAdmin(request, env);
      if (authFailure) return authFailure;
      const cleared = await clearScores(env.DB);
      const pending = await countPendingJobs(env.DB);
      return json({ cleared, pending });
    }

    // Rate the next batch of not-yet-scored jobs. Called in a loop by the
    // Manage page (after POST /api/rescore) so the UI can show live progress;
    // also usable standalone to pick up any jobs a previous run left pending.
    if (path === "/api/score") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const authFailure = requireAdmin(request, env);
      if (authFailure) return authFailure;

      const limitParam = url.searchParams.get("limit");
      let limit = 16;
      if (limitParam !== null) {
        limit = Number(limitParam);
        if (!Number.isInteger(limit) || limit < 1 || limit > 40) {
          return json({ error: "limit: must be an integer between 1 and 40" }, 400);
        }
      }

      const resumeInfo = await getResumeInfo(env.DB);
      if (!resumeInfo) {
        return json({ error: "no resume uploaded" }, 409);
      }

      const { scored, deduped, pending } = await scorePendingJobs(env, { limit });
      return json({ scored, deduped, pending });
    }

    if (path === "/api/criteria") {
      if (request.method === "GET") {
        const criteria = await loadCriteria(env.DB);
        return json(criteria);
      }
      if (request.method === "PUT") {
        const authFailure = requireAdmin(request, env);
        if (authFailure) return authFailure;

        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch (err) {
          return json({ error: (err as Error).message }, 400);
        }

        let validated: Criteria;
        try {
          validated = validateCriteriaBody(body);
        } catch (err) {
          if (err instanceof ValidationError) {
            return json({ error: err.message }, 400);
          }
          throw err;
        }

        const fresh = await updateCriteria(env.DB, validated);
        return json(fresh);
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (path === "/api/sources") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const sources = await loadSources(env.DB);
      return json({
        sources: sources.map((s) => ({
          id: s.id,
          display_name: s.display_name,
          enabled: s.enabled,
          config: s.config,
          requires_secrets: s.requires_secrets,
          secrets_present: secretsPresent(env, s.requires_secrets),
          updated_at: s.updated_at,
        })),
      });
    }

    const sourceMatch = /^\/api\/sources\/([^/]+)$/.exec(path);
    if (sourceMatch) {
      return handleSourcesRoute(request, env, decodeURIComponent(sourceMatch[1]));
    }

    return json({ error: "not found" }, 404);
  } catch (err) {
    console.error("api error", err);
    return json({ error: "internal error" }, 500);
  }
}
