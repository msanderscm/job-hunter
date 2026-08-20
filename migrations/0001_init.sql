-- Initial schema for job-digest.
--
-- SQLite/D1 has no native JSON or boolean type, so a few conventions are
-- used throughout this schema and the code that reads/writes it:
--   * Columns holding lists or objects (required_keywords, excluded_keywords,
--     locations, config, requires_secrets) are stored as TEXT containing a
--     JSON-serialized array/object. They are parsed/serialized in the
--     application layer (see src/worker/db.ts).
--   * Boolean-ish columns (remote_ok, enabled) are stored as INTEGER 0/1.

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  company_url TEXT,
  listing_url TEXT NOT NULL,
  location TEXT,
  posted_at TEXT,
  first_seen_at TEXT DEFAULT (datetime('now')),
  source TEXT NOT NULL
);
CREATE INDEX idx_jobs_first_seen ON jobs(first_seen_at);

-- Single-row table (id is CHECK'd to always be 1) holding the matching
-- criteria used by the cron digest. required_keywords / excluded_keywords /
-- locations are JSON arrays of strings stored as TEXT.
CREATE TABLE criteria (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  required_keywords TEXT NOT NULL DEFAULT '[]',
  excluded_keywords TEXT NOT NULL DEFAULT '[]',
  locations TEXT NOT NULL DEFAULT '[]',
  remote_ok INTEGER NOT NULL DEFAULT 1,
  max_age_days INTEGER NOT NULL DEFAULT 2,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- One row per job source/scraper. `config` is a JSON object of
-- source-specific settings (e.g. tags, country). `requires_secrets` is a
-- JSON array of env var names that must be present for the source to run.
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  requires_secrets TEXT DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO criteria (id, required_keywords, excluded_keywords, locations, remote_ok, max_age_days)
VALUES (
  1,
  '["software engineer","developer","typescript","react"]',
  '["intern","unpaid"]',
  '[]',
  1,
  2
);

INSERT INTO sources (id, display_name, enabled, config, requires_secrets)
VALUES
  ('remoteok', 'RemoteOK', 1, '{"tags":[]}', '[]'),
  ('adzuna', 'Adzuna', 1, '{"country":"us","results_per_page":50}', '["ADZUNA_APP_ID","ADZUNA_APP_KEY"]');
