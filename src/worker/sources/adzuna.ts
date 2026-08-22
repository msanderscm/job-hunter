import type { NormalizedJob } from "../types";
import type { Fetcher } from "./types";
import { decodeEntities, htmlToText, stripStrongTags } from "../util";
import { includesAny } from "../matching";

interface AdzunaResult {
  id?: string | number;
  title?: string;
  company?: { display_name?: string };
  redirect_url?: string;
  location?: { display_name?: string };
  created?: string;
  description?: string;
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

// Lowercase names/aliases for each Adzuna country code, used by
// adzunaLocationOk to recognize when a configured criteria.locations entry
// just names the country the request is already scoped to (config.country).
const COUNTRY_ALIASES: Record<string, string[]> = {
  us: ["united states", "usa", "us", "u.s.", "america", "united states of america"],
  gb: ["united kingdom", "uk", "great britain", "england"],
  ca: ["canada"],
  au: ["australia"],
  de: ["germany"],
  fr: ["france"],
  nl: ["netherlands"],
  es: ["spain"],
  it: ["italy"],
  in: ["india"],
  nz: ["new zealand"],
  sg: ["singapore"],
  za: ["south africa"],
  mx: ["mexico"],
  br: ["brazil"],
  pl: ["poland"],
  be: ["belgium"],
  at: ["austria"],
  ch: ["switzerland"],
};

/**
 * Decides whether an Adzuna result's location satisfies criteria.locations,
 * accounting for the fact that the API request is already scoped to
 * `country` (so a location that just names that country is trivially
 * satisfied even when Adzuna's own `location.display_name` is a bare city,
 * or missing).
 */
export function adzunaLocationOk(
  locationText: string | null,
  country: string,
  criteria: { locations: string[]; remote_ok: boolean }
): boolean {
  if (criteria.locations.length === 0) return true;

  const countryTerms = COUNTRY_ALIASES[country.trim().toLowerCase()] ?? [];
  const namesConfiguredCountry = criteria.locations.some((loc) => countryTerms.includes(loc.trim().toLowerCase()));
  if (namesConfiguredCountry) return true;

  const lowerLocationText = (locationText ?? "").toLowerCase();
  if (includesAny(lowerLocationText, criteria.locations)) return true;

  if (criteria.remote_ok && lowerLocationText.includes("remote")) return true;

  return false;
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

  if (ctx.criteria.excluded_keywords.length > 0) {
    params.set("what_exclude", ctx.criteria.excluded_keywords.join(" "));
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

    if (!adzunaLocationOk(raw.location?.display_name ?? null, country, ctx.criteria)) continue;

    const description =
      typeof raw.description === "string" && raw.description.trim() !== "" ? htmlToText(raw.description) : null;

    // Belt-and-suspenders over the API-side what_exclude param above.
    if (ctx.criteria.excluded_keywords.length > 0) {
      const text = `${raw.title} ${description ?? ""}`.toLowerCase();
      if (includesAny(text, ctx.criteria.excluded_keywords)) continue;
    }

    jobs.push({
      id: `adzuna:${raw.id}`,
      title: decodeEntities(stripStrongTags(raw.title)),
      company: raw.company?.display_name || "Unknown",
      company_url: null,
      listing_url: raw.redirect_url,
      location: raw.location?.display_name ?? null,
      posted_at: toIsoOrNull(raw.created),
      source: "adzuna",
      description,
    });
  }

  return jobs;
};

// required keywords are enforced API-side by what_or, age by max_days_old,
// excluded keywords by what_exclude plus the in-loop check above, and
// location by country scoping (config.country) plus adzunaLocationOk — the
// generic re-filter's title-only keyword check and location substring check
// wrongly drop valid results (null or city-formatted listing locations).
adzuna.appliesCriteria = true;
