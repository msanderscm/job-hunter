-- User-driven triage state for a listing (save / delete from the UI).
--
-- Values: 'new' (default; shown in the Current tab) | 'saved' (kept and
-- highlighted; never ages out of /api/jobs, see listRecentJobs) | 'deleted'
-- (hidden from Current but kept in the DB so the importer's INSERT OR IGNORE
-- won't re-list it on the next fetch). status_changed_at is the UTC
-- timestamp of the last change, NULL while still 'new'.

ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE jobs ADD COLUMN status_changed_at TEXT;
