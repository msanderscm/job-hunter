-- Resume storage + AI match scoring.
--
-- Two additions, both feeding the same feature: the user uploads a resume
-- (PDF -> text via Workers AI `toMarkdown`), and every imported job is rated
-- 1-5 against that resume by an LLM (see src/worker/scoring.ts).
--
-- Conventions (see 0001_init.sql):
--   * `description` holds the listing text as plain text (HTML stripped,
--     entities decoded, capped at 3000 chars by the source modules). It is
--     stored for the scorer's benefit and is deliberately NOT returned by
--     /api/jobs.
--   * `match_score` is 1-5 (5 = best fit) and NULL until the job has been
--     evaluated; `scored_at` is the UTC timestamp of that evaluation.
--   * `resume` is a single-row table (id is CHECK'd to always be 1), same
--     pattern as `criteria`. The extracted text never leaves the Worker via
--     the API - /api/resume returns metadata only.

ALTER TABLE jobs ADD COLUMN description TEXT;
ALTER TABLE jobs ADD COLUMN match_score INTEGER;
ALTER TABLE jobs ADD COLUMN match_reason TEXT;
ALTER TABLE jobs ADD COLUMN scored_at TEXT;

CREATE TABLE resume (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  filename TEXT NOT NULL,
  text TEXT NOT NULL,
  uploaded_at TEXT DEFAULT (datetime('now'))
);
