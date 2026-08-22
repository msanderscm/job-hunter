import type { NormalizedJob } from "../types";
import type { Fetcher } from "./types";
import { decodeEntities, htmlToText } from "../util";
import { includesAny } from "../matching";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

const SEARCH_DEPTHS = new Set(["basic", "advanced", "fast", "ultra-fast"]);

// Known ATS URL patterns: host (lowercased) -> true. The company slug is the
// first path segment for all of them.
const ATS_HOSTS = new Set([
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "apply.workable.com",
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cleanDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/**
 * Extracts the company slug from a job listing URL when it points at a known
 * ATS host (Greenhouse, Lever, Ashby, Workable) — the first path segment is
 * the company's slug on all of them. Returns "Unknown" for anything else, or
 * if the URL fails to parse.
 */
export function companyFromListingUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!ATS_HOSTS.has(host)) return "Unknown";
    const segment = parsed.pathname.split("/").filter(Boolean)[0];
    if (!segment) return "Unknown";
    return decodeURIComponent(segment);
  } catch {
    return "Unknown";
  }
}

/**
 * Normalizes a Tavily result URL so http/https and "/apply" sub-page variants
 * of the same posting collapse to one id: forces https, drops query/hash,
 * lowercases the host, and removes a trailing "/apply" path segment. Returns
 * the input unchanged if it fails to parse as a URL.
 */
export function normalizeListingUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  parsed.protocol = "https:";
  parsed.search = "";
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length > 0 && segments[segments.length - 1].toLowerCase() === "apply") {
    segments.pop();
  }
  parsed.pathname = segments.length > 0 ? `/${segments.join("/")}` : "/";

  return parsed.href;
}

/**
 * Builds the Tavily search query from the base query phrase plus the
 * criteria that Tavily results otherwise carry no structured fields for:
 * required keywords become a `(kw1 OR kw2) ` prefix, and locations (plus the
 * literal "remote" when remote_ok is set) become an ` in (loc1 OR loc2)`
 * suffix. Either part is omitted when there's nothing to add.
 */
export function buildTavilyQuery(
  requiredKeywords: string[],
  locations: string[],
  remoteOk: boolean,
  baseQuery: string,
): string {
  const keywords = requiredKeywords.map((k) => k.trim()).filter((k) => k !== "");
  const locationTerms = locations.map((l) => l.trim()).filter((l) => l !== "");
  if (remoteOk) locationTerms.push("remote");

  let query = baseQuery;
  if (locationTerms.length > 0) {
    query = `${query} in (${locationTerms.join(" OR ")})`;
  }
  if (keywords.length > 0) {
    query = `(${keywords.join(" OR ")}) ${query}`;
  }
  return query;
}

export const tavily: Fetcher = async (ctx) => {
  const config = ctx.config as {
    query?: unknown;
    max_results?: unknown;
    search_depth?: unknown;
    include_domains?: unknown;
    exclude_domains?: unknown;
    min_score?: unknown;
  };

  const baseQuery = typeof config.query === "string" && config.query.trim() !== "" ? config.query : "job opening hiring";

  const rawMaxResults =
    typeof config.max_results === "number" && Number.isFinite(config.max_results) ? config.max_results : 20;
  const maxResults = clamp(Math.trunc(rawMaxResults), 1, 20);

  const searchDepth =
    typeof config.search_depth === "string" && SEARCH_DEPTHS.has(config.search_depth) ? config.search_depth : "basic";

  const includeDomains = cleanDomainList(config.include_domains);
  const excludeDomains = cleanDomainList(config.exclude_domains);

  const minScore = typeof config.min_score === "number" && Number.isFinite(config.min_score) ? config.min_score : 0;

  const query = buildTavilyQuery(ctx.criteria.required_keywords, ctx.criteria.locations, ctx.criteria.remote_ok, baseQuery);

  const body: Record<string, unknown> = {
    query,
    search_depth: searchDepth,
    max_results: maxResults,
    topic: "general",
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  };

  if (includeDomains.length > 0) body.include_domains = includeDomains;
  if (excludeDomains.length > 0) body.exclude_domains = excludeDomains;

  const maxAgeDays = ctx.criteria.max_age_days;
  if (typeof maxAgeDays === "number" && Number.isFinite(maxAgeDays) && maxAgeDays > 0) {
    body.start_date = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
  }

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.secrets.TAVILY_API_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`tavily: request failed with status ${res.status}`);
  }

  const data = (await res.json()) as TavilyResponse;
  const results = Array.isArray(data.results) ? data.results : [];

  const jobs: NormalizedJob[] = [];
  const seenIds = new Set<string>();
  for (const raw of results) {
    if (!raw) continue;
    if (typeof raw.url !== "string" || raw.url.trim() === "") continue;
    if (typeof raw.title !== "string" || raw.title.trim() === "") continue;
    if (typeof raw.score === "number" && raw.score < minScore) continue;

    if (ctx.criteria.excluded_keywords.length > 0) {
      const text = `${raw.title} ${raw.content ?? ""}`.toLowerCase();
      if (includesAny(text, ctx.criteria.excluded_keywords)) continue;
    }

    const url = normalizeListingUrl(raw.url);
    const id = `tavily:${url}`;
    // Results arrive score-descending; keep the first (highest-scoring) of
    // any http/https or "/apply" variant of the same posting.
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    jobs.push({
      id,
      title: decodeEntities(raw.title),
      company: companyFromListingUrl(url),
      company_url: null,
      listing_url: url,
      location: null,
      posted_at: null,
      source: "tavily",
      description: typeof raw.content === "string" && raw.content.trim() !== "" ? htmlToText(raw.content) : null,
    });
  }

  return jobs;
};

// Tavily results carry no structured location field and only short snippets,
// so cron's generic keyword/location re-filter (matching.ts) would reject
// almost everything — a non-empty criteria.locations rejects every job with
// location === null, for instance. The search query above already encodes
// the required keywords, locations, and remote_ok, and excluded keywords are
// checked above, so this source judges criteria itself; cron must skip its
// re-filter for it (see hackernews.ts for the same pattern).
tavily.appliesCriteria = true;
