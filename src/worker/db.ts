import type {
  Criteria,
  JobRow,
  JobStatus,
  NormalizedJob,
  ResumeInfo,
  SourceRow,
  UserAuthRow,
  UserRow,
} from "./types";

function safeJsonParse<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text.trim() === "") return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed as T;
  } catch {
    return fallback;
  }
}

interface CriteriaRow {
  id: number;
  required_keywords: string;
  excluded_keywords: string;
  locations: string;
  remote_ok: number;
  max_age_days: number;
  updated_at?: string;
}

interface RawSourceRow {
  id: string;
  display_name: string;
  enabled: number;
  config: string;
  requires_secrets: string | null;
  updated_at?: string;
}

export function parseCriteriaRow(row: CriteriaRow): Criteria {
  return {
    required_keywords: safeJsonParse<string[]>(row.required_keywords, []),
    excluded_keywords: safeJsonParse<string[]>(row.excluded_keywords, []),
    locations: safeJsonParse<string[]>(row.locations, []),
    remote_ok: !!row.remote_ok,
    max_age_days: row.max_age_days,
    updated_at: row.updated_at,
  };
}

export function parseSourceRow(row: RawSourceRow): SourceRow {
  return {
    id: row.id,
    display_name: row.display_name,
    enabled: !!row.enabled,
    config: safeJsonParse<Record<string, unknown>>(row.config, {}),
    requires_secrets: safeJsonParse<string[]>(row.requires_secrets ?? "[]", []),
    updated_at: row.updated_at,
  };
}

const DEFAULT_CRITERIA: Criteria = {
  required_keywords: [],
  excluded_keywords: [],
  locations: [],
  remote_ok: true,
  max_age_days: 2,
};

export async function loadCriteria(db: D1Database): Promise<Criteria> {
  const row = await db.prepare("SELECT * FROM criteria WHERE id = 1").first<CriteriaRow>();
  if (!row) return DEFAULT_CRITERIA;
  return parseCriteriaRow(row);
}

export async function loadSources(
  db: D1Database,
  opts: { enabledOnly?: boolean } = {}
): Promise<SourceRow[]> {
  const query = opts.enabledOnly
    ? "SELECT * FROM sources WHERE enabled = 1 ORDER BY id"
    : "SELECT * FROM sources ORDER BY id";
  const { results } = await db.prepare(query).all<RawSourceRow>();
  return (results ?? []).map(parseSourceRow);
}

export async function getSource(db: D1Database, id: string): Promise<SourceRow | null> {
  const row = await db.prepare("SELECT * FROM sources WHERE id = ?1").bind(id).first<RawSourceRow>();
  return row ? parseSourceRow(row) : null;
}

export async function insertJobs(db: D1Database, jobs: NormalizedJob[]): Promise<number> {
  if (jobs.length === 0) return 0;

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO jobs (id, title, company, company_url, listing_url, location, posted_at, source, description)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  );

  const statements = jobs.map((job) =>
    stmt.bind(
      job.id,
      job.title,
      job.company,
      job.company_url,
      job.listing_url,
      job.location,
      job.posted_at,
      job.source,
      job.description ?? null
    )
  );

  const results = await db.batch(statements);
  return results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
}

/** Column list shared by listRecentJobs and setJobStatus so the two queries can't drift. */
const JOB_ROW_COLUMNS = `id, title, company, company_url, listing_url, location, posted_at, first_seen_at, source,
              match_score, match_reason, scored_at, work_mode, duplicate_of, status, status_changed_at`;

/**
 * Jobs from the last `days` days, plus any 'saved' job regardless of age —
 * a save is a deliberate keep, so it must never silently age out of the list.
 */
export async function listRecentJobs(db: D1Database, days = 7): Promise<JobRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${JOB_ROW_COLUMNS}
       FROM jobs
       WHERE (first_seen_at >= datetime('now', ?1) OR status = 'saved')
       ORDER BY posted_at DESC, first_seen_at DESC`
    )
    .bind(`-${days} days`)
    .all<JobRow>();
  return results ?? [];
}

/**
 * Sets a job's triage status (see migrations/0007) and stamps status_changed_at.
 * Returns the updated row, or null if no job matches `id`.
 */
export async function setJobStatus(db: D1Database, id: string, status: JobStatus): Promise<JobRow | null> {
  const result = await db
    .prepare(`UPDATE jobs SET status = ?1, status_changed_at = datetime('now') WHERE id = ?2`)
    .bind(status, id)
    .run();

  if ((result.meta?.changes ?? 0) === 0) return null;

  const row = await db.prepare(`SELECT ${JOB_ROW_COLUMNS} FROM jobs WHERE id = ?1`).bind(id).first<JobRow>();
  return row ?? null;
}

// --- Resume (single row, id = 1; see migrations/0004) ---------------------

interface ResumeRow {
  filename: string;
  text: string;
  uploaded_at: string;
  /** Condensed profile the scorer sends instead of the raw text; null until built (see resume-summary.ts). */
  summary: string | null;
  summary_model: string | null;
}

/** Loads the stored resume, text and summary included. Callers must never return either over the API. */
export async function loadResume(db: D1Database): Promise<ResumeRow | null> {
  const row = await db
    .prepare("SELECT filename, text, uploaded_at, summary, summary_model FROM resume WHERE id = 1")
    .first<ResumeRow>();
  return row ?? null;
}

/** Metadata only — the lengths are computed in SQL so neither the resume text nor its summary leaves D1. */
export async function getResumeInfo(db: D1Database): Promise<ResumeInfo | null> {
  const row = await db
    .prepare(
      "SELECT filename, uploaded_at, length(text) AS chars, length(summary) AS summary_chars FROM resume WHERE id = 1"
    )
    .first<ResumeInfo>();
  return row ?? null;
}

/**
 * The summary itself (not just its length), for the admin-only GET /api/resume/summary
 * route. Deliberately excludes `text` — the raw resume must never be served.
 */
export async function loadResumeSummary(
  db: D1Database
): Promise<{ summary: string | null; summary_model: string | null; summarized_at: string | null } | null> {
  const row = await db
    .prepare("SELECT summary, summary_model, summarized_at FROM resume WHERE id = 1")
    .first<{ summary: string | null; summary_model: string | null; summarized_at: string | null }>();
  return row ?? null;
}

/**
 * Stores a new resume. The summary belongs to the *previous* text, so it is
 * reset here and rebuilt by the caller (or lazily by the next scoring run).
 */
export async function saveResume(db: D1Database, filename: string, text: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO resume (id, filename, text, uploaded_at, summary, summary_model, summarized_at)
       VALUES (1, ?1, ?2, datetime('now'), NULL, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, text = excluded.text,
         uploaded_at = excluded.uploaded_at, summary = NULL, summary_model = NULL, summarized_at = NULL`
    )
    .bind(filename, text)
    .run();
}

/** Persists the condensed profile produced by src/worker/resume-summary.ts. */
export async function saveResumeSummary(db: D1Database, summary: string, model: string): Promise<void> {
  await db
    .prepare(
      `UPDATE resume SET summary = ?1, summary_model = ?2, summarized_at = datetime('now') WHERE id = 1`
    )
    .bind(summary, model)
    .run();
}

export async function updateCriteria(db: D1Database, c: Criteria): Promise<Criteria> {
  await db
    .prepare(
      `UPDATE criteria
       SET required_keywords = ?1, excluded_keywords = ?2, locations = ?3, remote_ok = ?4, max_age_days = ?5, updated_at = datetime('now')
       WHERE id = 1`
    )
    .bind(
      JSON.stringify(c.required_keywords),
      JSON.stringify(c.excluded_keywords),
      JSON.stringify(c.locations),
      c.remote_ok ? 1 : 0,
      c.max_age_days
    )
    .run();

  return loadCriteria(db);
}

export interface SourceUpdate {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export async function updateSource(db: D1Database, id: string, update: SourceUpdate): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (update.enabled !== undefined) {
    sets.push(`enabled = ?${idx}`);
    values.push(update.enabled ? 1 : 0);
    idx += 1;
  }
  if (update.config !== undefined) {
    sets.push(`config = ?${idx}`);
    values.push(JSON.stringify(update.config));
    idx += 1;
  }

  if (sets.length === 0) return getSource(db, id).then((row) => row !== null);

  sets.push(`updated_at = datetime('now')`);
  values.push(id);

  const result = await db
    .prepare(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?${idx}`)
    .bind(...values)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

// --- Users and sessions (see migrations/0008) -----------------------------

/** Columns safe to hand back over the API — never password_hash. */
const USER_ROW_COLUMNS = "id, username, first_name, created_at";

/** Thrown by createUser when the username is already in the table. */
export class UsernameTakenError extends Error {
  constructor() {
    super("username: already taken");
    this.name = "UsernameTakenError";
  }
}

/**
 * The login-path lookup: includes password_hash, so callers must use it only to
 * verify a password and must never return the row. `username` is expected to be
 * already normalized (see normalizeUsername in password.ts).
 */
export async function getUserForLogin(db: D1Database, username: string): Promise<UserAuthRow | null> {
  const row = await db
    .prepare(`SELECT ${USER_ROW_COLUMNS}, password_hash FROM users WHERE username = ?1`)
    .bind(username)
    .first<UserAuthRow>();
  return row ?? null;
}

export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  const row = await db
    .prepare(`SELECT ${USER_ROW_COLUMNS} FROM users WHERE id = ?1`)
    .bind(id)
    .first<UserRow>();
  return row ?? null;
}

export async function listUsers(db: D1Database): Promise<UserRow[]> {
  const { results } = await db
    .prepare(`SELECT ${USER_ROW_COLUMNS} FROM users ORDER BY username`)
    .all<UserRow>();
  return results ?? [];
}

/**
 * Creates a user. `username` must already be normalized and `password_hash`
 * produced by hashPassword(). A UNIQUE collision comes back as
 * UsernameTakenError so the route can answer 409 instead of 500.
 */
export async function createUser(
  db: D1Database,
  user: { username: string; first_name: string; password_hash: string }
): Promise<UserRow> {
  let id: number;
  try {
    const result = await db
      .prepare("INSERT INTO users (username, first_name, password_hash) VALUES (?1, ?2, ?3)")
      .bind(user.username, user.first_name, user.password_hash)
      .run();
    id = Number(result.meta?.last_row_id);
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new UsernameTakenError();
    throw err;
  }

  const row = await getUserById(db, id);
  if (!row) throw new Error("user row vanished after insert");
  return row;
}

/**
 * Stores a session. `sessionIdHash` is the SHA-256 of the cookie value (the
 * value itself is never persisted) and `expiresAt` is SQLite datetime text.
 */
export async function createSession(
  db: D1Database,
  userId: number,
  sessionIdHash: string,
  expiresAt: string,
  authRef: string | null
): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at, auth_ref) VALUES (?1, ?2, ?3, ?4)")
    .bind(sessionIdHash, userId, expiresAt, authRef)
    .run();
}

/**
 * The user behind a live (non-expired) session, or null. `authRef` is the
 * hash of the ADMIN_TOKEN a bootstrap-admin session was opened with (see
 * migrations/0009); null for password-backed users.
 */
export async function getSessionUser(
  db: D1Database,
  sessionIdHash: string
): Promise<{ user: UserRow; authRef: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.first_name, u.created_at, s.auth_ref
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?1 AND s.expires_at > datetime('now')`
    )
    .bind(sessionIdHash)
    .first<UserRow & { auth_ref: string | null }>();
  if (!row) return null;
  const { auth_ref, ...user } = row;
  return { user, authRef: auth_ref };
}

export async function deleteSession(db: D1Database, sessionIdHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?1").bind(sessionIdHash).run();
}

/** Housekeeping sweep, run on login so the table can't grow without bound. */
export async function deleteExpiredSessions(db: D1Database): Promise<number> {
  const result = await db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  return result.meta?.changes ?? 0;
}
