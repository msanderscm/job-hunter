import type { Fetcher } from "./types";
import { remoteok } from "./remoteok";
import { adzuna } from "./adzuna";
import { hackernews } from "./hackernews";

// Adding a new job source = one module here (implementing `Fetcher`) + one
// row in a migration (see migrations/0001_init.sql for the `sources` table).
export const fetchers: Record<string, Fetcher> = {
  remoteok,
  adzuna,
  hackernews,
};

export function getFetcher(id: string): Fetcher | undefined {
  return fetchers[id];
}

export type { Fetcher, FetcherContext } from "./types";
