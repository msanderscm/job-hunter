# job-digest

A lightweight Cloudflare Worker that automatically fetches and filters job listings from multiple sources, stores matches in D1, and serves them via a React SPA with a management interface. Run once daily at 11:00 UTC to discover new remote and on-site roles matching your criteria—no server to maintain, no deployment complexity.

**How it works:**
- **Cron trigger** runs on schedule (`0 6,10 * * *`, i.e. 06:00 and 10:00 UTC) and fetches jobs from enabled sources in parallel.
- **Filtering** matches jobs against criteria stored in D1 (keywords, locations, remote OK, max age). Sources that already judge posts themselves (see Hacker News below) are exempt — see `appliesCriteria` in "Adding a new job source".
- **Deduplication** via `INSERT OR IGNORE` on source-prefixed IDs (`adzuna:12345`, `remoteok:67890`).
- **Match scoring** rates every newly imported job 1–5 against your uploaded resume with Workers AI, so the jobs list leads with the roles that actually fit (see "Resume & match scoring").
- **API** exposes jobs and sources; protected write endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.
- **SPA** (React + Vite) provides two hash routes: jobs list (`#/`) and management (`#/manage`).

## Prerequisites

- **Node 20+** (22 recommended) and npm
- **Cloudflare account** (free plan is sufficient)

No Docker, no external services needed.

## Local development

1. **Clone and install:**
   ```bash
   git clone <repo-url>
   cd job-hunter
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   Edit `.dev.vars` and set `ADMIN_TOKEN` to a temporary value. Adzuna keys (`ADZUNA_APP_ID`, `ADZUNA_APP_KEY`) are optional; without them the app runs RemoteOK-only.

3. **Apply database migrations locally:**
   ```bash
   npm run db:migrate:local
   # or: npx wrangler d1 migrations apply job-digest --local
   ```
   The local D1 database works independently of the placeholder `database_id` in `wrangler.toml`.

4. **Start the dev server:**
   ```bash
   npm run dev
   ```
   This builds the React SPA with Vite, watches for changes, and runs `wrangler dev --test-scheduled` on `http://localhost:8787`.

5. **Trigger the cron locally:**
   ```bash
   npm run cron:local
   # or: curl "http://localhost:8787/__scheduled?cron=0+6,10+*+*+*"
   ```
   After the cron completes, reload the jobs page to see new matches.

6. **Inspect the local database:**
   ```bash
   # Recent jobs
   npx wrangler d1 execute job-digest --local --command \
     "SELECT id, title, company, source, first_seen_at FROM jobs ORDER BY first_seen_at DESC LIMIT 20"
   
   # Criteria (single row)
   npx wrangler d1 execute job-digest --local --command "SELECT * FROM criteria"
   
   # Sources and config
   npx wrangler d1 execute job-digest --local --command "SELECT id, enabled, config FROM sources"

   # Match scores and description coverage per source
   npx wrangler d1 execute job-digest --local --command \
     "SELECT source, COUNT(*), SUM(description IS NOT NULL), AVG(match_score) FROM jobs GROUP BY source"

   # Stored resume (metadata only — don't dump the text)
   npx wrangler d1 execute job-digest --local --command "SELECT filename, uploaded_at, length(text) FROM resume"
   ```

## Using the management page

Open `http://localhost:8787/#/manage`. Reading is open; the first save prompts for your `ADMIN_TOKEN`.

**Setting criteria:**
- **Required keywords:** job must match at least one (e.g., "Python", "React").
- **Excluded keywords:** drop jobs if any match (e.g., "VB.NET").
- **Locations:** filter by region; leave empty to include all.
- **Remote OK:** when on, remote jobs pass the location filter regardless of the locations list (the RemoteOK feed is entirely remote, so turn this off only if you also set locations).
- **Max age (days):** only fetch jobs posted within this window.

Criteria and source changes take effect immediately on the next cron run—no redeploy needed.

**Managing sources:**
- Toggle each source on/off to enable or disable it.
- Edit JSON config:
  - **RemoteOK:** `{"tags": ["dev"], "location": "US", "max_pages": 2}` — all optional. See below for what each does.
  - **Adzuna:** `{"country": "us", "results_per_page": 50}` ([country codes](https://developer.adzuna.com/docs/overview)).
  - **Hacker News — Who is hiring?:** `{"model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "batch_size": 20, "max_posts": 60, "max_chars": 2500}` — all optional, shown here at their defaults. See below for what each does.
- **Missing secrets warning:** appears if Adzuna is enabled but `ADZUNA_APP_ID` or `ADZUNA_APP_KEY` are not set.

### RemoteOK

RemoteOK's public JSON feed (`https://remoteok.com/api`) honors a `tags` filter but
ignores location entirely — its `location` field is a bare city with the country
stripped, so a country filter can't be done from JSON. Instead, this source uses the
same HTML pagination endpoint RemoteOK's own site filter pages use
(`https://remoteok.com/?action=get_jobs&tags=…&location=…&offset=…`, 50 rows/page,
newest first), which honors both filters, and parses the job rows out of the returned
HTML in a single linear pass (no DOM).

Config keys (all optional):
- `tags` — array of tag strings, comma-joined into `&tags=` (default `[]`, no tag
  filter). RemoteOK's dev-focused tag is `"dev"`.
- `location` — a single RemoteOK location code (default: none, no location filter).
  Valid values: `Worldwide`, a region code (`region_NA`, `region_LA`, `region_EU`,
  `region_AF`, `region_ME`, `region_AS`, `region_OC`), or an ISO-2 country code (`US`,
  `CA`, `UK`, `AU`, `DE`, …).
- `max_pages` — how many 50-row pages to fetch, 1–4 (default 2, i.e. up to 100 newest
  matching jobs). Pagination stops early once a page returns fewer than 50 rows or its
  oldest post is past `max_age_days`, so the common case is a single request.

If the HTML endpoint is unreachable or its markup changes such that no rows parse, this
source logs a warning and falls back to the JSON feed (`tags` filter only — location is
not applied in that case). Subrequest cost is typically 1–2 fetches per run (one per
page fetched, plus 1 if the JSON fallback triggers).

### Hacker News — Who is hiring?

Every month the HN account `whoishiring` posts a thread titled "Ask HN: Who is hiring? (Month Year)"; each top-level comment is a free-text job post. This source:
1. Finds the current thread via the [HN Algolia API](https://hn.algolia.com/api).
2. Fetches its top-level comments posted within `max_age_days` (from criteria).
3. Strips HTML and does a cheap pre-filter (drops posts containing an excluded keyword, caps the count at `max_posts`, newest first).
4. Sends the remainder to **Cloudflare Workers AI** (`env.AI` binding, see `wrangler.toml`) in batches of `batch_size`, asking it to judge each post against the current criteria and extract `company`, `title`, `location`, `remote`, `company_url`.
5. Returns only posts the model judged a match, already normalized — unlike the other sources, this one does its own criteria matching (see `appliesCriteria` below) rather than relying on the generic keyword filter, since HN posts are free text without structured fields.

Config keys (all optional):
- `model` — Workers AI model id (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; must support `json_schema` response format).
- `batch_size` — posts per AI call, 1–40 (default 20).
- `max_posts` — cap on posts considered per run, 1–200 (default 60).
- `max_chars` — per-post text truncation before sending to the model, 500–8000 (default 2500).

Requires the `[ai]` binding in `wrangler.toml` (already configured — `binding = "AI"`); no secrets needed. With the defaults, a run costs about 2 Algolia requests plus up to 3 Workers AI requests (60 posts ÷ 20/batch). Workers AI is included in the Workers free tier (10,000 neurons/day); a daily run with the defaults stays well within that. In local dev, the `AI` binding calls the real Workers AI service through your `wrangler login` session (no separate API key needed).

### Resume & match scoring

Upload your resume once (Manage page, or `PUT /api/resume`) and every job the digest
imports is rated against it.

1. The uploaded PDF (≤ 5 MB) is converted to text by **Workers AI**'s document
   conversion (`env.AI.toMarkdown`) — one call per upload. The text is stored in the
   single-row `resume` table, capped at 50,000 characters. The same upload then condenses
   the text once into a structured **profile** (`resume.summary`, migration 0006: title,
   years of experience, seniority, skills, tools, roles, quantified achievements — up to
   6,000 characters) with `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; that profile is
   what the scorer sends with every batch instead of 12,000 characters of raw resume. The
   model is asked to *extract* into JSON arrays (one item per named technology, nothing
   merged or generalised) rather than to write prose, and a second pass audits the result
   against the resume for anything left out — an addition is only kept if it occurs
   verbatim in the resume text. Two AI calls per upload. If the summary step fails, the
   next scoring run rebuilds it (and falls back to the raw text until then). The raw text is never logged or returned by the API: `GET
   /api/resume` gives back only `filename`, `uploaded_at`, `chars` and `summary_chars`.
   The profile itself, however, can be read by the admin — `GET /api/resume/summary`
   (Bearer token) returns it, and the Manage page's "View profile summary" button on the
   resume card shows it inline.
2. After each fetch (cron or **Fetch now**), `scorePendingJobs` picks up every job from
   the last 7 days that has no score yet. Each pending job is first embedded once with
   `@cf/baai/bge-base-en-v1.5` (`jobs.embedding`, 768 floats); a job whose vector is
   near-identical (cosine ≥ 0.95) to a same-company job already rated against the
   *current* resume copies that rating instead of costing an AI call, recording the
   source in `jobs.duplicate_of`. Listings with a placeholder employer ("Unknown") are
   never deduplicated. The rest go to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` in
   batches of 16 to be rated 1–5 with a one-line reason; the prompt carries the resume
   profile plus each job's title, company, location, source and stored description
   (2,500 characters max). Dedupe is best-effort: if embedding fails, every job simply
   goes to the LLM.
3. Scores land in `jobs.match_score` / `match_reason` / `scored_at` (and
   `duplicate_of` for copied ratings — the tile's tooltip says so) and are returned by
   `/api/jobs`. A job the model failed to rate stays `NULL` and is retried on the next
   run — a scoring failure never fails the digest.
4. Changing your resume doesn't rescore anything by itself. The **Re-evaluate all
   matches** button drives this in two steps so the UI can show live progress:
   `POST /api/rescore` clears the scores in the 7-day window and returns how many jobs
   are now pending, then the Manage page calls `POST /api/score?limit=16` in a loop
   (one call per batch) until nothing is left pending, updating the button's label —
   `Reevaluating x of y` — after each batch. Rescoring clears `duplicate_of` but keeps
   the stored embeddings (they describe the job text, not the resume), so duplicates
   are re-detected without being re-embedded.

The 1–5 scale is what the jobs list colours each tile's border with:

| Score | Meaning | Colour |
|-------|---------|--------|
| 1 | Unrelated, or clearly unqualified | neutral (default border) |
| 2 | Weak match | `#1d4877` |
| 3 | Plausible partial match | `#fbb021` |
| 4 | Strong match | `#f68838` |
| 5 | Excellent — role, seniority, skills and domain all line up | `#ee3e32` |

The same AI pass also classifies each job's remote/hybrid/on-site status (`work_mode`,
migration 0005) from the listing text — a judgment call, not a keyword search, so
negated phrasing like "no remote" or "must be on-site" is respected rather than matched
on the word "remote". The jobs list marks the result in the tile's top-right corner: a
solid red star means remote, an outline star means hybrid (remote with a recurring
on-site component), and no star means on-site or unclassified (`unknown`). `work_mode`
is included on `/api/jobs` alongside the score fields.

Cost: like the Hacker News source, this uses the `[ai]` binding, no secrets. A run that
scores 80 jobs is at most 5 LLM requests (80 ÷ 16 per batch — fewer when re-posts are
deduplicated) plus 1–2 cheap embedding requests (50 texts per call), and each resume
upload costs 1 conversion request plus 2 profile requests (extract + completeness check); Workers AI is included in the
Workers free tier (10,000 neurons/day) and two daily runs stay well inside it. A full
re-evaluate is the expensive one (up to ~8 `/api/score` requests for a full 7-day
window), which is why it's a separate, explicit action. In local dev the `AI` binding calls the real Workers AI service through
your `wrangler login` session.

Jobs already stored before their source started capturing descriptions are scored from
title/company/location alone (`INSERT OR IGNORE` never backfills an existing row).

**Auth:** The UI prompts for `ADMIN_TOKEN` once per session and stores it in memory only. Reload or 401 response will re-prompt.

## API reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/jobs` | Open | Jobs first seen in the last 7 days, newest first. |
| GET | `/api/criteria` | Open | Fetch current matching criteria. |
| PUT | `/api/criteria` | Bearer token | Replace criteria. Body: `{ required_keywords: [], excluded_keywords: [], locations: [], remote_ok: bool, max_age_days: 1-30 }`. 400 with a message on bad input. |
| GET | `/api/sources` | Open | All sources with `enabled`, `config`, `requires_secrets` (names only) and `secrets_present`. |
| POST | `/api/run` | Bearer token | Run the fetch now (same code path as the cron). Returns `{ fetched, matched, inserted, scored, skipped, failed }` (`scored` = jobs rated against the resume this run). Also available as the **Fetch now** button on the Manage page. |
| GET | `/api/resume` | Open | Stored resume metadata: `{ resume: { filename, uploaded_at, chars } \| null }`. The extracted text is never returned. |
| GET | `/api/resume/summary` | Bearer token | The condensed profile summary: `{ summary, summary_model, summarized_at }` (`summary` is `null` if none has been built yet). 404 if no resume is uploaded. The raw resume text is still never served anywhere. |
| PUT | `/api/resume` | Bearer token | Upload a resume. Body: `multipart/form-data` with a `file` field holding a PDF (≤ 5 MB). Replaces any previous resume. 400 if the file isn't a PDF, is too large, or has no extractable text. Does **not** rescore existing jobs — use `/api/rescore`. |
| POST | `/api/rescore` | Bearer token | Clear all ratings in the 7-day window (do this after uploading a new resume). Returns `{ cleared, pending }`. Doesn't score anything itself — follow with `/api/score`. |
| POST | `/api/score?limit=N` | Bearer token | Rate the next `N` (1–40, default 8) unrated jobs. Returns `{ scored, pending }`. 409 if no resume is uploaded. The Manage page calls this in a loop after `/api/rescore` to show live progress. |
| PUT | `/api/sources/:id` | Bearer token | Update `enabled` and/or `config` of one source. Sources can't be created or deleted via the API. |

## Deploying to Cloudflare

1. **Authenticate:**
   ```bash
   npx wrangler login
   ```

2. **Create the D1 database:**
   ```bash
   npx wrangler d1 create job-digest
   ```
   Copy the `database_id` from the output and paste it into `wrangler.toml` (replace the placeholder).

3. **Apply migrations:**
   ```bash
   npm run db:migrate:remote
   ```

4. **Set secrets:**
   ```bash
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put ADZUNA_APP_ID     # optional
   npx wrangler secret put ADZUNA_APP_KEY    # optional
   ```
   Get free Adzuna keys at [https://developer.adzuna.com/](https://developer.adzuna.com/).

5. **Deploy:**
   ```bash
   npm run deploy
   ```

## CI/CD with GitHub Actions

Create `.github/workflows/deploy.yml` to auto-deploy on push to `main`. The workflow:
- Runs `npm ci`, builds the SPA, applies migrations, and deploys via Wrangler.
- Uses `cloudflare/wrangler-action` with two repository secrets:

**Set secrets via the GitHub dashboard or CLI:**
```bash
# Create a Cloudflare API token at:
# Dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"
# (add permission Account → D1 → Edit)
gh secret set CLOUDFLARE_API_TOKEN

# Find your account ID at Workers & Pages overview (sidebar).
gh secret set CLOUDFLARE_ACCOUNT_ID
```

## Adding a new job source

1. Create `src/worker/sources/<id>.ts`:
   ```typescript
   export async function fetch<id>(ctx: {
     criteria: Criteria,
     config: Record<string, any>,
     secrets: Record<string, string>
   }): Promise<NormalizedJob[]> {
     // Return array of jobs normalized to:
     // { id: "<id>:<external_id>", title, company, company_url | null,
     //   listing_url, location | null, posted_at (ISO) | null, source: "<id>" }
   }
   ```

2. Register in `src/worker/sources/index.ts`.

3. Add migration `migrations/000N_add_<id>.sql` to insert a `sources` row with `requires_secrets` field listing any secret names.

4. Set secrets via `npx wrangler secret put`.

If the fetcher already judges posts against the criteria itself (e.g. an LLM-based source — see `hackernews.ts`), set `<fetcher>.appliesCriteria = true` after the export; `runDigest` (`cron.ts`) then skips the generic keyword/location filter for that source's results instead of re-filtering output the fetcher already decided on.

Sources cannot be created or deleted via the API by design.

## Project layout

```
src/
  worker/
    index.ts                # Entry point, request routing
    api.ts                  # Endpoint handlers
    auth.ts                 # Bearer token validation
    cron.ts                 # Scheduled job fetch and insert
    db.ts                   # D1 query helpers
    matching.ts             # Keyword/location filter logic
    util.ts                 # Shared utilities
    scoring.ts              # Resume-vs-job match scoring (Workers AI)
    resume-summary.ts       # Condenses the resume into the profile the scorer sends
    dedupe.ts               # Job embeddings + near-duplicate detection (copies ratings)
    sources/
      index.ts              # Source registry
      types.ts              # Normalized job shape
      remoteok.ts           # RemoteOK fetcher
      adzuna.ts             # Adzuna fetcher
      hackernews.ts         # Hacker News "Who is hiring?" fetcher (Workers AI)
  app/
    main.tsx                # React entry, router setup
    App.tsx                 # Layout component
    api.ts                  # Fetch client for backend
    styles.css              # Global styles
    views/                  # Page components (JobsList, Manage)
    components/             # Reusable UI components
    hooks/                  # Custom React hooks
    utils/                  # Frontend helpers
migrations/
  0001_init.sql             # Tables: jobs, criteria, sources
  0004_resume_and_match_scores.sql  # jobs.description/match_score/match_reason/scored_at + resume table
  0005_job_work_mode.sql    # jobs.work_mode
  0006_resume_summary_and_job_embeddings.sql  # resume.summary + jobs.embedding/duplicate_of
.github/workflows/
  deploy.yml                # Automated deployment
wrangler.toml               # Worker config
vite.config.ts              # Build config
```

## Free-plan notes

- **Cron:** Runs once daily (limited by Cloudflare free tier).
- **Subrequests:** 2–3 sources generate a handful per run; well under free limits.
- **Jobs retention:** UI displays last 7 days by default; no archival.
- **D1 free tier:** Ample for this workload (read/write costs negligible).

## Troubleshooting

| Issue | Cause & fix |
|-------|------------|
| `ADMIN_TOKEN secret is not configured` (503) | Set `ADMIN_TOKEN` in `.dev.vars` (local) or `wrangler secret put ADMIN_TOKEN` (remote). |
| 401 Unauthorized | Wrong token in the UI. Reload to re-prompt; token is never persisted. |
| Adzuna shows "Missing secrets" | Set both `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` via secrets or `.dev.vars`. |
| Cron ran but no new jobs | Check `wrangler dev` terminal for errors. Criteria may be too strict; clear required keywords to see all matches. |
| RemoteOK jobs filtered by location | RemoteOK feed is remote-only; enable "Remote OK" toggle or remove location filters. |
| `hackernews failed: AI binding not configured` | Add the `[ai]` / `binding = "AI"` block to `wrangler.toml` (see the Hacker News section above) and redeploy / restart `wrangler dev`. |
| Resume upload returns `no text could be extracted` | The PDF has no text layer (a scan or photo). Re-export it from the original document, or run OCR first. |
| Jobs show no match score | No resume uploaded (`GET /api/resume` returns `null`), or the jobs pre-date the resume — run `POST /api/rescore`. Scores are only computed for jobs first seen in the last 7 days. |
