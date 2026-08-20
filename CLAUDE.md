# CLAUDE.md — job-digest

Project-specific rules for Claude Code. These override default behaviour.

## Branching and pushing

- **Never push to `main` without explicit permission.** A push to `main` triggers the
  production deploy (`.github/workflows/deploy.yml`). The only standing permission is
  the release procedure below — a release request *is* the permission for that one push.
- Day-to-day work happens on `develop` (or `feature/*` branches off `develop`, per
  git flow). Pushing `develop` or a feature branch is fine when asked.
- Never force-push, rewrite published history, or delete tags/branches on the remote.
- The remote is reached via the SSH alias `git@github-msanderscm:msanderscm/job-hunter.git`
  (key `~/.ssh/id_ed25519_mscm`, GitHub account `msanderscm`). Don't change the remote URL.

## Release procedure

When the user asks for a release ("cut a release", "release 0.3.0", etc.):

1. **Pre-flight — stop if dirty.** Run `git status --porcelain`. If it prints anything
   (uncommitted or untracked changes), report exactly what is dirty and **do nothing
   else**. Do not stash, commit, or discard on the user's behalf.
2. Make sure you are on `develop` and it is up to date: `git checkout develop && git pull --ff-only`.
3. **Pick the version.** Use the version the user gave. If none was given, infer from
   the Unreleased changelog entries (semver: breaking → major, feature → minor,
   fix-only → patch) and state the choice. Tags use the repo's git flow
   `gitflow.prefix.versiontag` (currently empty, so the tag is e.g. `0.2.0`).
4. **Update `Changelog.md`** (on `develop`, before starting the release branch):
   - Rename the `## Unreleased` section to `## <version> — <YYYY-MM-DD>`.
   - Make sure there is one line for every significant feature, fix, or behaviour
     change since the previous release — check `git log <last-tag>..develop` and add
     anything missing. Skip trivia (typos, formatting, CI noise).
   - Add a fresh empty `## Unreleased` section at the top.
   - Bump `"version"` in `package.json` to match.
   - Commit: `chore(release): <version>`.
5. **Git flow release:**
   ```bash
   git flow release start <version>
   git flow release finish -m "Release <version>" <version>
   ```
   (`finish` merges the release branch into `main`, tags `main`, back-merges into
   `develop`, and deletes the release branch. Use the `-m` flag so the tag message
   doesn't open an editor.)
6. **Verify the tag:** `git tag --points-at main` must show `<version>`.
7. **Push:** `git push origin main develop --follow-tags` (this is the one sanctioned
   push to `main`; it deploys to production).
8. Watch the deploy (`gh run watch`) and report the result, including the live URL
   `https://job-digest.msanders-77c.workers.dev`.

If any step fails, stop, report the state (branch, whether the tag exists, whether the
merge happened), and let the user decide — do not try to "fix forward" by force-pushing
or deleting tags.

## Day-to-day conventions

- Keep `Changelog.md` current: when you finish a user-visible feature or fix, add a
  line under `## Unreleased` in the same commit.
- Schema changes go in a new numbered file in `migrations/` (never edit an applied
  migration). New job sources = one module in `src/worker/sources/` + a registry entry
  + a migration inserting the `sources` row.
- The Worker runs on V8 isolates: `fetch()` and Web-standard APIs only, no Node
  built-ins. Secrets come from Wrangler secrets / `.dev.vars`, never the DB or repo,
  and must never be logged or returned by the API.
- Before committing: `npm run typecheck && npm run build`. For Worker changes, also run
  `wrangler dev --test-scheduled` and exercise the affected route or
  `curl "http://localhost:8787/__scheduled?cron=0+6,10+*+*+*"`.
- Local D1 state is keyed by `database_id`; if `wrangler dev` reports "no such table",
  run `npm run db:migrate:local`.
