import type { Criteria, JobRow, NormalizedJob, ResumeInfo, SourceRow } from "./types";

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

export async function listRecentJobs(db: D1Database, days = 7): Promise<JobRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, company, company_url, listing_url, location, posted_at, first_seen_at, source,
              match_score, match_reason, scored_at, work_mode
       FROM jobs
       WHERE first_seen_at >= datetime('now', ?1)
       ORDER BY posted_at DESC, first_seen_at DESC`
    )
    .bind(`-${days} days`)
    .all<JobRow>();
  return results ?? [];
}

// --- Resume (single row, id = 1; see migrations/0004) ---------------------

interface ResumeRow {
  filename: string;
  text: string;
  uploaded_at: string;
}

/** Loads the stored resume, text included. Callers must never return the text over the API. */
export async function loadResume(db: D1Database): Promise<ResumeRow | null> {
  const row = await db
    .prepare("SELECT filename, text, uploaded_at FROM resume WHERE id = 1")
    .first<ResumeRow>();
  return row ?? null;
}

/** Metadata only — `chars` is computed in SQL so the resume text never leaves D1. */
export async function getResumeInfo(db: D1Database): Promise<ResumeInfo | null> {
  const row = await db
    .prepare("SELECT filename, uploaded_at, length(text) AS chars FROM resume WHERE id = 1")
    .first<ResumeInfo>();
  return row ?? null;
}

export async function saveResume(db: D1Database, filename: string, text: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO resume (id, filename, text, uploaded_at)
       VALUES (1, ?1, ?2, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, text = excluded.text, uploaded_at = excluded.uploaded_at`
    )
    .bind(filename, text)
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
