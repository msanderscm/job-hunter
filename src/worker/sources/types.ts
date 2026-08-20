import type { Criteria, NormalizedJob } from "../types";

export interface FetcherContext {
  criteria: Criteria;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  ai?: Ai;
}

/**
 * A source fetcher. Set `appliesCriteria = true` on fetchers that already
 * judge posts against the criteria themselves (e.g. LLM-based ones); the
 * cron then skips its keyword re-filter for that source's results.
 */
export interface Fetcher {
  (ctx: FetcherContext): Promise<NormalizedJob[]>;
  appliesCriteria?: boolean;
}
