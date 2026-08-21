# Changelog

All notable changes to job-digest are listed here, newest first. Each release lists one
line per significant feature, fix, or behaviour change.

## Unreleased

## 0.3.0 — 2026-08-21

- Resume upload: `PUT /api/resume` takes a PDF, extracts its text with Workers AI
  (`toMarkdown`) and stores it in D1; `GET /api/resume` returns metadata only
  (filename, upload time, character count) — the text is never served.
- AI match scoring: every imported job is rated 1–5 against the resume by Workers AI
  and stored with a short reason (`match_score`, `match_reason`, `scored_at` on
  `/api/jobs`). `POST /api/run` now also reports `scored`.
- Admin-only `POST /api/rescore` clears all ratings in the 7-day window after a resume
  change; a new admin-only `POST /api/score?limit=N` rates the next batch of pending
  jobs. The Manage page's "Re-evaluate all matches" button calls `/api/rescore` then
  loops `/api/score` (8 jobs per call), showing live progress as
  `Reevaluating x of y`.
- Job descriptions are captured from RemoteOK, Adzuna and Hacker News (plain text,
  capped at 3000 chars) and stored so the matcher can judge more than the title.
- The same AI pass now classifies each job's `work_mode` (remote/hybrid/onsite/unknown,
  migration 0005) from the listing text, respecting negations ("no remote" ≠ remote).
  The jobs list marks remote roles with a solid star and hybrid roles with an outline
  star in the tile's top-right corner.
- The match-score accent bar now runs down the tile's left edge as well as along the
  bottom.
- Jobs list is now ordered by posting date first (then by when it was first seen).

## 0.2.0 — 2026-08-20

- RemoteOK source supports `tags` + `location` filters (defaults to dev jobs in the US).
- Admin-only `POST /api/run` endpoint and a "Fetch now" button on the Manage page to
  trigger the fetch on demand.
- Cron schedule changed to `0 6,10 * * *` (06:00 and 10:00 UTC).
- Hacker News "Who is hiring?" source screened with Workers AI.

## 0.1.0 — 2026-08-20

- Initial release: single Cloudflare Worker serving the React SPA, the JSON API, and a
  scheduled job fetch.
- D1 schema (`jobs`, `criteria`, `sources`) with seed criteria and the RemoteOK and
  Adzuna sources.
- Fetcher registry with RemoteOK (public feed) and Adzuna (API keys via secrets); sources
  with missing secrets are skipped with a warning.
- Criteria matching (required/excluded keywords, locations, remote-OK, max age) read
  from D1 on every run; batch `INSERT OR IGNORE` dedupe.
- Jobs page with text and source filters; Manage page for criteria and sources with
  bearer-token protected writes.
- GitHub Actions deploy on push to `main` (remote D1 migrations + `wrangler deploy`).
