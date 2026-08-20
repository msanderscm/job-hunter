import type { Env, NormalizedJob } from "./types";
import { loadCriteria, loadSources, insertJobs } from "./db";
import { getFetcher } from "./sources";
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

  const runnable: Array<{ id: string; run: () => Promise<NormalizedJob[]> }> = [];

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
      run: () => fetcher({ criteria, config: source.config, secrets }),
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
  const allJobs: NormalizedJob[] = [];
  settled.forEach((result, i) => {
    const id = runnable[i].id;
    if (result.status === "fulfilled") {
      fetched += result.value.length;
      allJobs.push(...result.value);
    } else {
      failed.push(id);
    }
  });

  //console.log('allJobs', allJobs);
  const matchedJobs = allJobs.filter((job) => matchesCriteria(job, criteria));
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
