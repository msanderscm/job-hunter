import type { Criteria, NormalizedJob } from "../types";

export interface FetcherContext {
  criteria: Criteria;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export type Fetcher = (ctx: FetcherContext) => Promise<NormalizedJob[]>;
