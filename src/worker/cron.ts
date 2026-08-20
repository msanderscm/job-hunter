import type { Env, NormalizedJob } from "./types";
import { loadCriteria, loadSources, insertJobs } from "./db";
import { getFetcher } from "./sources";
import type { Fetcher } from "./sources";
import { matchesCriteria } from "./matching";

export interface DigestResult {
  fetched: number;
  matched: number;
  inserted: number;
  skipped: string[];
  failed: string[];
}

export async function runDigest(env: Env): Promise<DigestResult> {
  const criteria = await loadCriteria(env.DB);
  const sources = await loadSources(env.DB, { enabledOnly: true });

  const skipped: string[] = [];
  const failed: string[] = [];

  const runnable: Array<{ id: string; fetcher: Fetcher; run: () => Promise<NormalizedJob[]> }> = [];

  for (const source of sources) {
    const missingSecrets = source.requires_secrets.filter((name) => {
      const value = env[name];
      return typeof value !== "string" || value.trim() === "";
    });
    if (missingSecrets.length > 0) {
      console.warn(`[${source.id}] skipped: missing secrets ${missingSecrets.join(", ")}`);
      skipped.push(source.id);
      continue;
    }

    const fetcher = getFetcher(source.id);
    if (!fetcher) {
      console.warn(`[${source.id}] skipped: no fetcher registered`);
      skipped.push(source.id);
      continue;
    }

    const secrets: Record<string, string> = {};
    for (const name of source.requires_secrets) {
      secrets[name] = String(env[name]);
    }

    runnable.push({
      id: source.id,
      fetcher,
      run: () => fetcher({ criteria, config: source.config, secrets, ai: env.AI }),
    });
  }

  const settled = await Promise.allSettled(
    runnable.map(async ({ id, run }) => {
      try {
        return await run();
      } catch (err) {
        console.error(`[${id}] failed`, err);
        throw err;
      }
    })
  );

  let fetched = 0;
  const matchedJobs: NormalizedJob[] = [];
  settled.forEach((result, i) => {
    const { id, fetcher } = runnable[i];
    if (result.status === "fulfilled") {
      const jobs = result.value;
      fetched += jobs.length;
      // LLM-based sources (e.g. hackernews) already judge posts against the
      // criteria themselves; re-running the keyword filter on their output
      // would be redundant (and could wrongly drop matches phrased loosely).
      matchedJobs.push(...(fetcher.appliesCriteria ? jobs : jobs.filter((j) => matchesCriteria(j, criteria))));
    } else {
      failed.push(id);
    }
  });
  const inserted = await insertJobs(env.DB, matchedJobs);

  const summary: DigestResult = {
    fetched,
    matched: matchedJobs.length,
    inserted,
    skipped,
    failed,
  };

  console.log(
    `[digest] fetched=${summary.fetched} matched=${summary.matched} inserted=${summary.inserted} skipped=[${summary.skipped.join(",")}] failed=[${summary.failed.join(",")}]`
  );

  return summary;
}
