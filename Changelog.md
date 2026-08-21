# Changelog

All notable changes to job-digest are listed here, newest first. Each release lists one
line per significant feature, fix, or behaviour change.

## Unreleased

## 0.6.0 — 2026-08-21

- Real login replaces the admin-token prompt. `POST /api/auth/login` (username + password)
  sets an HttpOnly session cookie (30 days; only its SHA-256 is stored), with
  `/api/auth/logout` and `/api/auth/me` alongside. New `users` and `sessions` tables
  (migrations 0008–0009); passwords are stored as salted PBKDF2-SHA256 hashes only. Bootstrap
  by logging in as `admin` with the `ADMIN_TOKEN` secret (rotating the secret also ends
  sessions opened with it), then create users on the new Users page (`GET`/`POST /api/users`).
  The Jobs page stays open; Manage, Users and the Save/Delete actions redirect to the login
  page when logged out. `Authorization: Bearer <ADMIN_TOKEN>` still works on the API for
  scripts. Every state-changing route now also rejects cross-site requests (403).

## 0.5.0 — 2026-08-21

- Triage listings from the Jobs page: each tile now has a footer with **Save** (purple border,
  never ages out of the list) and **Delete** (hidden, but kept in the DB so the importer won't
  re-list it), and the page has **Current / Saved / Deleted** tabs with Unsave / Undelete.
  Backed by a new `status` column (migration 0007) and `PATCH /api/jobs/:id` (Bearer token,
  body `{ status: "new" | "saved" | "deleted" }`). Deleted-but-unrated jobs are skipped by the
  AI scorer. The admin token is now shared between the Jobs and Manage pages for the session.
- The scheduled fetch now runs at 11:00 and 18:00 UTC (was 06:00 and 10:00); the app
  footer reflects the new times.

## 0.4.2 — 2026-08-21

- Resume profile extraction no longer drops skills: the summariser now extracts into JSON
  arrays (one item per named technology/tool, nothing merged or generalised) and renders
  the profile text from them, the length budget is raised to 6,000 characters, and a
  second completeness pass asks what the first pass missed — additions are only kept if
  they occur verbatim in the resume. Re-upload the resume to rebuild the profile.

## 0.4.1 — 2026-08-21

- The admin can now read the resume's condensed profile summary from the Manage page:
  `GET /api/resume/summary` (Bearer token) returns `{ summary, summary_model,
  summarized_at }`, and the resume card's new "View profile summary" button shows it
  inline. The raw resume text is still never served by any route.

## 0.4.0 — 2026-08-21

- Cheaper AI scoring: the resume is condensed once per upload into a compact structured
  profile (~2.5k chars) that the scorer sends with every batch, instead of re-sending 12k
  characters of raw resume with each one. `GET /api/resume` reports `summary_chars`; the
  summary itself, like the resume text, is never served.
- Scoring batches went from 8 to 16 jobs per AI call (and `POST /api/score` now defaults to
  `limit=16`), halving the number of calls for the same set of jobs.
- Re-posted listings no longer cost a second AI rating: every pending job is embedded
  (`@cf/baai/bge-base-en-v1.5`) and one that is near-identical (cosine >= 0.95) to a job
  from the same company already rated against the current resume copies that rating.
  `/api/jobs` exposes `duplicate_of`, `/api/score` and the `[digest]` log line report
  `deduped`, and the jobs list flags copied ratings in the score badge's tooltip.
- Migration 0006 adds `resume.summary`/`summary_model`/`summarized_at` and
  `jobs.embedding`/`embedding_model`/`duplicate_of`.
- Unit tests: `npm test` (vitest) covers the embedding/dedupe helpers; the tests make no
  Workers AI calls.

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
