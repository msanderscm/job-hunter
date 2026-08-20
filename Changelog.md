# Changelog

All notable changes to job-digest are listed here, newest first. Each release lists one
line per significant feature, fix, or behaviour change.

## Unreleased

- Admin-only `POST /api/run` endpoint and a "Fetch now" button on the Manage page to
  trigger the fetch on demand.
- Cron schedule changed to `0 6,10 * * *` (06:00 and 10:00 UTC).

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
