import type { NormalizedJob } from "../types";
import type { Fetcher } from "./types";
import { decodeEntities, stripStrongTags } from "../util";

interface AdzunaResult {
  id?: string | number;
  title?: string;
  company?: { display_name?: string };
  redirect_url?: string;
  location?: { display_name?: string };
  created?: string;
}

interface AdzunaResponse {
  results?: AdzunaResult[];
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const adzuna: Fetcher = async (ctx) => {
  const config = ctx.config as { country?: unknown; results_per_page?: unknown; what?: unknown };

  const country = typeof config.country === "string" && config.country.trim() !== "" ? config.country : "us";

  const rawResultsPerPage =
    typeof config.results_per_page === "number" && Number.isFinite(config.results_per_page)
      ? config.results_per_page
      : 50;
  const resultsPerPage = clamp(Math.trunc(rawResultsPerPage), 1, 50);

  const appId = ctx.secrets.ADZUNA_APP_ID;
  const appKey = ctx.secrets.ADZUNA_APP_KEY;

  const params = new URLSearchParams({
    app_id: appId ?? "",
    app_key: appKey ?? "",
    results_per_page: String(resultsPerPage),
    sort_by: "date",
    max_days_old: String(ctx.criteria.max_age_days),
    "content-type": "application/json",
  });

  if (ctx.criteria.required_keywords.length > 0) {
    params.set("what_or", ctx.criteria.required_keywords.join(" "));
  }

  if (typeof config.what === "string" && config.what.trim() !== "") {
    params.set("what", config.what);
  }

  //console.log('country', country, 'params', params);
  const apiUrl = `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/1?${params.toString()}`;

  const res = await fetch(apiUrl, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    // Never include app_key (or the full URL, which contains it) in the error message.
    throw new Error(`adzuna: request failed with status ${res.status}`);
  }

  const data = (await res.json()) as AdzunaResponse;
  const results = Array.isArray(data.results) ? data.results : [];

  const jobs: NormalizedJob[] = [];
  for (const raw of results) {
    if (!raw || raw.id === undefined || raw.id === null) continue;
    if (typeof raw.redirect_url !== "string" || raw.redirect_url === "" || !raw.title) continue;

    jobs.push({
      id: `adzuna:${raw.id}`,
      title: decodeEntities(stripStrongTags(raw.title)),
      company: raw.company?.display_name || "Unknown",
      company_url: null,
      listing_url: raw.redirect_url,
      location: raw.location?.display_name ?? null,
      posted_at: toIsoOrNull(raw.created),
      source: "adzuna",
    });
  }

  return jobs;
};
