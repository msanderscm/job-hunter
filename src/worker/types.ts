export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI: Ai;
  ADMIN_TOKEN?: string;
  ADZUNA_APP_ID?: string;
  ADZUNA_APP_KEY?: string;
  TAVILY_API_KEY?: string;
  [key: string]: unknown;
}

export interface NormalizedJob {
  id: string;
  title: string;
  company: string;
  company_url: string | null;
  listing_url: string;
  location: string | null;
  posted_at: string | null;
  source: string;
  /** Listing text, plain (HTML stripped) and capped — stored for the AI matcher, never returned by the API. */
  description: string | null;
}

/** Remote/hybrid/on-site classification judged by the AI scorer; null until evaluated. */
export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";

/**
 * User-driven triage state for a listing (see migrations/0007). "new" is the
 * default (shown in the Current tab); "saved" is kept and highlighted, and
 * never ages out of /api/jobs; "deleted" is hidden from Current but kept in
 * the DB so the importer's INSERT OR IGNORE won't re-list it.
 */
export type JobStatus = "new" | "saved" | "deleted";

/**
 * A jobs-table row as returned by the API: NormalizedJob (minus `description`,
 * which is stored but never served) + when we first stored it + the AI match
 * rating (see src/worker/scoring.ts; null until the job has been evaluated).
 */
export interface JobRow extends Omit<NormalizedJob, "description"> {
  first_seen_at: string;
  match_score: number | null;
  match_reason: string | null;
  scored_at: string | null;
  work_mode: WorkMode | null;
  /** Id of the near-identical earlier listing this rating was copied from; null when the LLM rated it. */
  duplicate_of: string | null;
  status: JobStatus;
  /** UTC timestamp of the last status change; null while still "new". */
  status_changed_at: string | null;
}

/** Metadata about the stored resume. Deliberately excludes the text itself. */
export interface ResumeInfo {
  filename: string;
  uploaded_at: string;
  chars: number;
  /**
   * Length of the condensed profile summary the scorer uses; null until one has been
   * built. The summary text itself is available to the admin via GET /api/resume/summary.
   */
  summary_chars: number | null;
}

export interface Criteria {
  required_keywords: string[];
  excluded_keywords: string[];
  locations: string[];
  remote_ok: boolean;
  max_age_days: number;
  updated_at?: string;
}

export interface SourceRow {
  id: string;
  display_name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  requires_secrets: string[];
  updated_at?: string;
}

/**
 * A user as returned by the API (see migrations/0008). Deliberately excludes
 * password_hash — no route may ever serve it.
 */
export interface UserRow {
  id: number;
  username: string;
  first_name: string;
  created_at: string;
}

/** Internal shape used only by the login path. `password_hash` NULL = check ADMIN_TOKEN. */
export interface UserAuthRow extends UserRow {
  password_hash: string | null;
}

/**
 * Who is making a request: a logged-in user (session cookie) or a script
 * holding the ADMIN_TOKEN bearer secret, which has no user row behind it.
 */
export type AuthPrincipal = { kind: "session"; user: UserRow } | { kind: "token" };
