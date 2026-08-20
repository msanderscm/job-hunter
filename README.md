# job-digest

A lightweight Cloudflare Worker that automatically fetches and filters job listings from multiple sources, stores matches in D1, and serves them via a React SPA with a management interface. Run once daily at 11:00 UTC to discover new remote and on-site roles matching your criteria—no server to maintain, no deployment complexity.

**How it works:**
- **Cron trigger** runs on schedule (`0 6,10 * * *`, i.e. 06:00 and 10:00 UTC) and fetches jobs from enabled sources in parallel.
- **Filtering** matches jobs against criteria stored in D1 (keywords, locations, remote OK, max age). Sources that already judge posts themselves (see Hacker News below) are exempt — see `appliesCriteria` in "Adding a new job source".
- **Deduplication** via `INSERT OR IGNORE` on source-prefixed IDs (`adzuna:12345`, `remoteok:67890`).
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
  - **RemoteOK:** `{"tags": []}` (optional tag filters).
  - **Adzuna:** `{"country": "us", "results_per_page": 50}` ([country codes](https://developer.adzuna.com/docs/overview)).
  - **Hacker News — Who is hiring?:** `{"model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "batch_size": 20, "max_posts": 60, "max_chars": 2500}` — all optional, shown here at their defaults. See below for what each does.
- **Missing secrets warning:** appears if Adzuna is enabled but `ADZUNA_APP_ID` or `ADZUNA_APP_KEY` are not set.

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

**Auth:** The UI prompts for `ADMIN_TOKEN` once per session and stores it in memory only. Reload or 401 response will re-prompt.

## API reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/jobs` | Open | Jobs first seen in the last 7 days, newest first. |
| GET | `/api/criteria` | Open | Fetch current matching criteria. |
| PUT | `/api/criteria` | Bearer token | Replace criteria. Body: `{ required_keywords: [], excluded_keywords: [], locations: [], remote_ok: bool, max_age_days: 1-30 }`. 400 with a message on bad input. |
| GET | `/api/sources` | Open | All sources with `enabled`, `config`, `requires_secrets` (names only) and `secrets_present`. |
| POST | `/api/run` | Bearer token | Run the fetch now (same code path as the cron). Returns `{ fetched, matched, inserted, skipped, failed }`. Also available as the **Fetch now** button on the Manage page. |
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
