export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI: Ai;
  ADMIN_TOKEN?: string;
  ADZUNA_APP_ID?: string;
  ADZUNA_APP_KEY?: string;
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
}

/** A jobs-table row as returned by the API (NormalizedJob + when we first stored it). */
export interface JobRow extends NormalizedJob {
  first_seen_at: string;
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
