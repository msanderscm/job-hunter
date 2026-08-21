-- Remote/hybrid/on-site classification, judged by the same AI pass as
-- match_score (see src/worker/scoring.ts).
--
-- Values: 'remote' | 'hybrid' | 'onsite' | 'unknown'. NULL until the job has
-- been evaluated (same lifecycle as match_score / scored_at from 0004).

ALTER TABLE jobs ADD COLUMN work_mode TEXT;
