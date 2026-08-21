import type { Criteria, Env, JobStatus, ResumeInfo, UserRow } from "./types";
import {
  createUser,
  deleteExpiredSessions,
  deleteSession,
  getUserForLogin,
  listUsers,
  UsernameTakenError,
  loadCriteria,
  loadSources,
  listRecentJobs,
  setJobStatus,
  updateCriteria,
  updateSource,
  getSource,
  getResumeInfo,
  loadResumeSummary,
  saveResume,
  saveResumeSummary,
} from "./db";
import {
  authenticate,
  clearSessionCookie,
  issueSession,
  requireAdmin,
  sameOrigin,
  sessionIdHashFromRequest,
  sha256Base64url,
  timingSafeEqual,
} from "./auth";
import {
  hashPassword,
  normalizeUsername,
  validateFirstName,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "./password";
import { runDigest } from "./cron";
import { clearScores, countPendingJobs, scorePendingJobs } from "./scoring";
import { SUMMARY_MODEL, summarizeResume } from "./resume-summary";

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
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

const JOB_STATUSES: JobStatus[] = ["new", "saved", "deleted"];

/** Validates a candidate job status; returns null (not a throw) so callers can format their own 400. */
export function parseJobStatus(value: unknown): JobStatus | null {
  if (typeof value !== "string") return null;
  return (JOB_STATUSES as string[]).includes(value) ? (value as JobStatus) : null;
}

/**
 * PATCH /api/jobs/:id — user-driven save/delete triage (see migrations/0007).
 * Admin-only, same as the sources route: this mutates state, not just reads it.
 */
async function handleJobStatusRoute(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "PATCH") {
    return json({ error: "method not allowed" }, 405);
  }

  const authFailure = await requireAdmin(request, env);
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

  const status = parseJobStatus(b.status);
  if (!status) {
    return json({ error: "status: must be one of new, saved, deleted" }, 400);
  }

  const job = await setJobStatus(env.DB, id, status);
  if (!job) {
    return json({ error: "job not found" }, 404);
  }

  return json(job);
}

function secretsPresent(env: Env, names: string[]): boolean {
  return names.every((name) => typeof env[name] === "string" && (env[name] as string).trim() !== "");
}

async function handleSourcesRoute(request: Request, env: Env, sourceId: string): Promise<Response> {
  if (request.method !== "PUT") {
    return json({ error: "method not allowed" }, 405);
  }

  const authFailure = await requireAdmin(request, env);
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

  const authFailure = await requireAdmin(request, env);
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

  const authFailure = await requireAdmin(request, env);
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

// --- Login, sessions and users -------------------------------------------
//
// Two ways to authenticate, both handled in src/worker/auth.ts:
//
//   * a browser logs in at POST /api/auth/login and gets an HttpOnly session
//     cookie whose SHA-256 is the sessions-table key (see migrations/0008);
//   * scripts keep sending `Authorization: Bearer <ADMIN_TOKEN>`, unchanged.
//
// The 'admin' row shipped by migration 0008 has a NULL password_hash, meaning
// "check the password against the ADMIN_TOKEN secret" — that bootstraps the
// first login without ever putting the secret in the database. Users created
// through POST /api/users get a real PBKDF2 hash instead.

/**
 * A hash to verify against when the username doesn't exist, so an unknown user
 * costs the same wall-clock time as a wrong password (no enumeration by timing).
 * Built once, lazily, on the first failed lookup.
 */
let dummyHash: Promise<string> | null = null;

function dummyPasswordHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword("dummy");
  return dummyHash;
}

/** The login response body — never the whole row, and never password_hash. */
function publicUser(user: Pick<UserRow, "id" | "username" | "first_name">) {
  return { id: user.id, username: user.username, first_name: user.first_name };
}

async function handleLoginRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  if (!sameOrigin(request)) {
    return json({ error: "forbidden" }, 403);
  }

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

  if (typeof b.username !== "string" || typeof b.password !== "string") {
    return json({ error: "username and password: must be strings" }, 400);
  }

  // Started before the lookup so a cold isolate's first unknown-user attempt
  // doesn't cost a visibly different amount of time.
  const dummy = dummyPasswordHash();
  const username = normalizeUsername(b.username);
  const user = await getUserForLogin(env.DB, username);

  let ok = false;
  /** For bootstrap-admin sessions: hash of the token they were opened with (migrations/0009). */
  let authRef: string | null = null;
  if (!user) {
    // Burn the same work as a real check, then fail.
    await verifyPassword(b.password, await dummy);
  } else if (user.password_hash === null) {
    // The token compare is instant; spend a PBKDF2 anyway so this account
    // isn't identifiable by response time.
    await verifyPassword(b.password, await dummy);
    ok =
      typeof env.ADMIN_TOKEN === "string" &&
      env.ADMIN_TOKEN !== "" &&
      timingSafeEqual(b.password, env.ADMIN_TOKEN);
    if (ok) authRef = await sha256Base64url(env.ADMIN_TOKEN as string);
  } else {
    ok = await verifyPassword(b.password, user.password_hash);
  }

  if (!ok || !user) {
    // One message for every failure mode — a wrong username must be
    // indistinguishable from a wrong password. The submitted username is
    // deliberately not logged: it is untrusted, unbounded, and is where a
    // mistyped password ends up.
    console.warn("[auth] login failed");
    return json({ error: "invalid username or password" }, 401);
  }

  // Housekeeping, not correctness: getSessionUser already ignores expired rows.
  try {
    await deleteExpiredSessions(env.DB);
  } catch (err) {
    console.warn("[auth] expired-session sweep failed", err);
  }

  const { setCookie } = await issueSession(env.DB, request, user.id, authRef);
  return json({ user: publicUser(user) }, 200, { "Set-Cookie": setCookie });
}

/**
 * Logout deliberately requires no auth: a stale or already-deleted session must
 * still clear the cookie rather than leaving the browser stuck holding it.
 */
async function handleLogoutRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  // Not authenticated, but still same-origin only: a cross-site form POST must
  // not be able to log the user out (the clearing Set-Cookie is the damage).
  if (!sameOrigin(request)) {
    return json({ error: "forbidden" }, 403);
  }

  const idHash = await sessionIdHashFromRequest(request);
  if (idHash) {
    await deleteSession(env.DB, idHash);
  }

  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store", "Set-Cookie": clearSessionCookie(request) },
  });
}

async function handleMeRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  const principal = await authenticate(request, env);
  if (!principal) {
    return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }

  if (principal.kind === "session") {
    return json({ user: publicUser(principal.user) });
  }

  // A bearer-token caller has no user row; report the bootstrap identity so
  // scripts still see a principal.
  return json({ user: { id: 0, username: "admin", first_name: "Admin" } });
}

async function handleUsersRoute(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const authFailure = await requireAdmin(request, env);
    if (authFailure) return authFailure;
    const users = await listUsers(env.DB);
    return json({ users });
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const authFailure = await requireAdmin(request, env);
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

  const invalid =
    validateUsername(b.username) ?? validatePassword(b.password) ?? validateFirstName(b.first_name);
  if (invalid) {
    return json({ error: invalid }, 400);
  }

  const username = normalizeUsername(b.username as string);
  if (username === "admin") {
    // The bootstrap row already owns it (see migrations/0008).
    return json({ error: "username: already taken" }, 409);
  }

  const password_hash = await hashPassword(b.password as string);

  try {
    const user = await createUser(env.DB, {
      username,
      first_name: (b.first_name as string).trim(),
      password_hash,
    });
    return json({ user }, 201);
  } catch (err) {
    if (err instanceof UsernameTakenError) {
      return json({ error: "username: already taken" }, 409);
    }
    throw err;
  }
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  try {
    const path = url.pathname;

    if (path === "/api/auth/login") {
      return handleLoginRoute(request, env);
    }

    if (path === "/api/auth/logout") {
      return handleLogoutRoute(request, env);
    }

    if (path === "/api/auth/me") {
      return handleMeRoute(request, env);
    }

    if (path === "/api/users") {
      return handleUsersRoute(request, env);
    }

    if (path === "/api/jobs") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const jobs = await listRecentJobs(env.DB);
      return json({ jobs });
    }

    const jobStatusMatch = /^\/api\/jobs\/([^/]+)$/.exec(path);
    if (jobStatusMatch) {
      return handleJobStatusRoute(request, env, decodeURIComponent(jobStatusMatch[1]));
    }

    // Manual trigger of the morning fetch. Admin-only so a public URL can't be
    // used to burn subrequests; runs synchronously and returns the summary.
    if (path === "/api/run") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const authFailure = await requireAdmin(request, env);
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
      const authFailure = await requireAdmin(request, env);
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
      const authFailure = await requireAdmin(request, env);
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
        const authFailure = await requireAdmin(request, env);
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
