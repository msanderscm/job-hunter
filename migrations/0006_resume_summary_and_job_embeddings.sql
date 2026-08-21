-- Cheaper AI scoring: a condensed resume profile + per-job embeddings.
--
-- Two independent cost reductions for src/worker/scoring.ts, which used to
-- re-send 12k characters of raw resume text with every scoring batch:
--
--   * `resume.summary` holds a ~2.5k-character structured profile produced once
--     per upload by src/worker/resume-summary.ts (`summary_model` records which
--     model wrote it, `summarized_at` when). The scorer sends that instead of
--     the raw text. Like `resume.text` it is NEVER returned by the API —
--     /api/resume exposes `length(summary)` only.
--
--   * `jobs.embedding` is the raw little-endian float32 vector of the listing
--     text (title/company/location/description), written by
--     src/worker/dedupe.ts; `embedding_model` records which model produced it
--     so a model change can't silently mix incompatible vector spaces.
--     Re-posted listings that are near-identical to an already-rated job copy
--     that job's rating instead of costing another LLM call, and record its id
--     in `duplicate_of` (NULL = rated by the LLM itself). Cleared by
--     POST /api/rescore alongside match_score; embeddings are NOT cleared,
--     since they describe the job text and not the resume.

ALTER TABLE resume ADD COLUMN summary TEXT;
ALTER TABLE resume ADD COLUMN summary_model TEXT;
ALTER TABLE resume ADD COLUMN summarized_at TEXT;

ALTER TABLE jobs ADD COLUMN embedding BLOB;
ALTER TABLE jobs ADD COLUMN embedding_model TEXT;
ALTER TABLE jobs ADD COLUMN duplicate_of TEXT;
