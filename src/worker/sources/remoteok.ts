import type { NormalizedJob } from "../types";
import type { Fetcher } from "./types";
import { decodeEntities, htmlToText } from "../util";
import { includesAny } from "../matching";

// --- RemoteOK source -----------------------------------------------------
//
// RemoteOK's public JSON feed (`https://remoteok.com/api`) honors `?tags=`
// but ignores any location parameter, and its `location` field is a bare
// city with the country stripped ("San Francisco, ") — so a country filter
// can't be done from JSON. RemoteOK's own site filter pages load rows from
// an HTML pagination endpoint that *does* honor both filters:
//
//   https://remoteok.com/?action=get_jobs&tags=dev&location=US&offset=0
//
// (then offset=50, 100, ...; 50 rows/page, newest first). This is the
// primary path below; the JSON feed is kept only as a fallback for when the
// HTML endpoint is unreachable or its markup has drifted underneath us.
//
// Structure: config parsing -> parseJobsPage (pure, exported for testing)
// -> HTML path -> JSON fallback -> exported `remoteok` fetcher.

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 2;
const LOCATION_CODE_RE = /^[A-Za-z_-]{2,12}$/;

interface RemoteOkConfig {
  tags?: unknown;
  location?: unknown;
  max_pages?: unknown;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^https?:\/\//i.test(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === "string" && t.trim() !== "");
}

/** Validates a RemoteOK location code (`Worldwide`, `region_*`, or an ISO-2 country). */
function parseLocationCode(value: unknown): string | null {
  return typeof value === "string" && LOCATION_CODE_RE.test(value) ? value : null;
}

// --- HTML pagination endpoint --------------------------------------------

export interface ParsedRow {
  id: string;
  title: string;
  company: string;
  listingUrl: string;
  location: string;
  postedAt: string | null;
  description: string | null;
}

/** Accumulates the fields of one job row while `parseJobsPage` walks the document. */
interface RowAccum {
  id: string | null;
  slug: string | null;
  dataUrl: string | null;
  epoch: number | null;
  dataSearch: string | null;
  dataCompany: string | null;
  title: string | null;
  company: string | null;
  time: string | null;
  locations: string[];
}

// Matches either a job row's opening `<tr data-offset="N" ...>` tag (capture
// its attribute string) or one of the child elements we need from within
// that row (a location cell, the title `<h2>`, the company `<h3>`, or the
// `<time>` element). Walking these matches in one linear pass — instead of a
// `[\s\S]*?</tr>` regex per row, or building a DOM — keeps a 1MB page well
// under the Workers CPU budget (~1-3ms for 50 rows).
const ROW_SCAN_RE =
  /<tr\s+data-offset="\d+"([^>]*)>|<div class="location[^"]*"[^>]*>([\s\S]*?)<\/div>|<h2\s+itemprop="title">([\s\S]*?)<\/h2>|<h3\s+itemprop="name">([\s\S]*?)<\/h3>|<time datetime="([^"]*)">/g;

function extractAttr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/**
 * `data-search` values embed raw, unescaped double quotes (a RemoteOK
 * markup quirk, e.g. `data-search="Acme Engineer ["dev","golang"]"`), so a
 * plain `data-search="([^"]*)"` capture stops at the first embedded quote.
 * Bound it by the next attribute (`data-company=`) instead, which is always
 * the one immediately following.
 */
function extractDataSearch(attrs: string): string | null {
  const m = attrs.match(/data-search="([\s\S]*?)"\s+data-company="/);
  return m ? m[1] : null;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const LEADING_EMOJI_RE = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\s]+/u;

/** Strips a leading flag/globe emoji from a location cell's text; drops the "upgrade to see salary" placeholder cell. */
function cleanLocationText(raw: string): string | null {
  const text = collapseWhitespace(decodeEntities(stripTags(raw)));
  const withoutEmoji = text.replace(LEADING_EMOJI_RE, "").trim();
  if (withoutEmoji === "" || /upgrade to premium/i.test(withoutEmoji)) return null;
  return withoutEmoji;
}

/** Fallback title when `itemprop="title"` is missing: `data-search` minus the leading company name and trailing tag array. */
function fallbackTitleFromSearch(dataSearch: string | null, dataCompany: string | null): string | null {
  if (!dataSearch) return null;
  let text = collapseWhitespace(decodeEntities(dataSearch));
  text = text.replace(/\s*\[.*\]\s*$/s, "").trim();
  if (dataCompany) {
    const company = collapseWhitespace(decodeEntities(dataCompany));
    if (company && text.startsWith(company)) {
      text = text.slice(company.length).trim();
    }
  }
  return text === "" ? null : text;
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Each job row is followed in the same document by a collapsed detail row,
// `<tr class="expand expand-<ID>" data-id="<ID>">`, whose
// `<div class="description" itemprop="description">` holds the full listing
// body inside a `<div class="html">` (older postings) or `<div class="markdown">`
// (newer ones). Both are flat — no nested `<div>` — so a single non-greedy
// scan per row is enough; like ROW_SCAN_RE above this stays a linear pass over
// the ~1MB page rather than a DOM build (~0.3ms to find the 50 bodies, ~3ms to
// turn them into capped plain text).
const EXPAND_ROW_RE = /<tr class="expand expand-(\d+)[^>]*>([\s\S]*?)<\/tr>/g;
const DESCRIPTION_BODY_RE = /<div class="(?:html|markdown)"[^>]*>([\s\S]*?)<\/div>/;
// Boilerplate RemoteOK appends inside the body ("Upgrade to Premium to see
// salary…"); it carries no signal for the matcher, so cut it off.
const DESCRIPTION_TAIL_RE = /<h2>\s*Salary and compensation\s*<\/h2>[\s\S]*$/i;
// A listing body can run to ~10KB of markup; htmlToText only keeps the first
// 3000 characters of text, so trimming the raw HTML first (generous 4x margin
// for tags) saves most of the per-page CPU without ever truncating early.
const DESCRIPTION_MAX_HTML_CHARS = 12_000;

/** Extracts the listing body of every detail row on the page, keyed by numeric job id. */
function parseDescriptions(html: string): Map<string, string> {
  const byId = new Map<string, string>();
  for (const match of html.matchAll(EXPAND_ROW_RE)) {
    const body = DESCRIPTION_BODY_RE.exec(match[2]);
    if (!body) continue;
    const text = htmlToText(body[1].slice(0, DESCRIPTION_MAX_HTML_CHARS).replace(DESCRIPTION_TAIL_RE, ""));
    if (text !== "") byId.set(match[1], text);
  }
  return byId;
}

function finalizeRow(acc: RowAccum, descriptions: Map<string, string>): ParsedRow | null {
  if (!acc.id) return null; // ad/placeholder rows have no numeric data-id; skip them

  const title = acc.title
    ? collapseWhitespace(decodeEntities(stripTags(acc.title)))
    : fallbackTitleFromSearch(acc.dataSearch, acc.dataCompany);
  const company = acc.company
    ? collapseWhitespace(decodeEntities(stripTags(acc.company)))
    : acc.dataCompany
      ? collapseWhitespace(decodeEntities(acc.dataCompany))
      : null;
  if (!title || !company) return null; // markup we can't make sense of; drop rather than guess

  const listingUrl = acc.dataUrl
    ? `https://remoteok.com${acc.dataUrl}`
    : acc.slug
      ? `https://remoteok.com/remote-jobs/${acc.slug}`
      : null;
  if (!listingUrl) return null;

  const uniqueLocations = [...new Set(acc.locations)];
  const location = uniqueLocations.length > 0 ? uniqueLocations.join(", ") : "Remote";

  const postedAt = acc.time ? toIsoOrNull(acc.time) : acc.epoch !== null ? new Date(acc.epoch * 1000).toISOString() : null;

  return {
    id: `remoteok:${acc.id}`,
    title,
    company,
    listingUrl,
    location,
    postedAt,
    description: descriptions.get(acc.id) ?? null,
  };
}

/** Parses one HTML page from the `?action=get_jobs` endpoint into job rows. Pure; exported for testing. */
export function parseJobsPage(html: string): ParsedRow[] {
  const descriptions = parseDescriptions(html);
  const rows: ParsedRow[] = [];
  let current: RowAccum | null = null;

  for (const match of html.matchAll(ROW_SCAN_RE)) {
    const [, rowAttrs, locationHtml, titleHtml, companyHtml, timeIso] = match;

    if (rowAttrs !== undefined) {
      if (current) {
        const row = finalizeRow(current, descriptions);
        if (row) rows.push(row);
      }
      const id = extractAttr(rowAttrs, "data-id");
      const epochStr = extractAttr(rowAttrs, "data-epoch");
      current = {
        id: id && /^\d+$/.test(id) ? id : null,
        slug: extractAttr(rowAttrs, "data-slug"),
        dataUrl: extractAttr(rowAttrs, "data-url"),
        epoch: epochStr && /^\d+$/.test(epochStr) ? Number(epochStr) : null,
        dataSearch: extractDataSearch(rowAttrs),
        dataCompany: extractAttr(rowAttrs, "data-company"),
        title: null,
        company: null,
        time: null,
        locations: [],
      };
      continue;
    }
    if (!current) continue; // stray match before the first row; ignore

    if (locationHtml !== undefined) {
      const cleaned = cleanLocationText(locationHtml);
      if (cleaned) current.locations.push(cleaned);
    } else if (titleHtml !== undefined) {
      current.title = titleHtml;
    } else if (companyHtml !== undefined) {
      current.company = companyHtml;
    } else if (timeIso !== undefined) {
      current.time = timeIso;
    }
  }

  if (current) {
    const row = finalizeRow(current, descriptions);
    if (row) rows.push(row);
  }

  return rows;
}

async function fetchHtmlPage(offset: number, tags: string[], location: string | null): Promise<string> {
  let url = `https://remoteok.com/?action=get_jobs&offset=${offset}`;
  if (tags.length > 0) url += `&tags=${tags.map((t) => encodeURIComponent(t)).join(",")}`;
  if (location) url += `&location=${encodeURIComponent(location)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "job-digest/1.0 (cloudflare worker)",
      Accept: "text/html",
    },
  });
  if (!res.ok) {
    throw new Error(`remoteok: HTML endpoint request failed with status ${res.status}`);
  }
  return res.text();
}

/**
 * Fetches and parses up to `maxPages` HTML pages, newest first. Returns
 * `null` (rather than an empty array) when page 0 parses to zero rows,
 * which signals the caller to fall back to the JSON feed instead of
 * reporting "no jobs found" — RemoteOK always has *something* for `dev`.
 */
async function fetchFromHtmlPages(
  tags: string[],
  location: string | null,
  maxPages: number,
  maxAgeDays: number
): Promise<NormalizedJob[] | null> {
  const cutoffMs = Date.now() - (maxAgeDays + 1) * 86400 * 1000;
  const jobs: NormalizedJob[] = [];
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page++) {
    const html = await fetchHtmlPage(page * PAGE_SIZE, tags, location);
    pagesFetched++;
    const rows = parseJobsPage(html);

    if (page === 0 && rows.length === 0) {
      return null;
    }

    let oldestMs: number | null = null;
    for (const row of rows) {
      jobs.push({
        id: row.id,
        title: row.title,
        company: row.company,
        company_url: null, // rows don't carry the employer's own site; the UI's Google fallback handles it
        listing_url: row.listingUrl,
        location: row.location,
        posted_at: row.postedAt,
        source: "remoteok",
        description: row.description,
      });
      if (row.postedAt) {
        const t = Date.parse(row.postedAt);
        if (oldestMs === null || t < oldestMs) oldestMs = t;
      }
    }

    // Newest-first pagination: a short page or one whose oldest row is
    // already past max_age_days means later pages can't add anything.
    if (rows.length < PAGE_SIZE || (oldestMs !== null && oldestMs < cutoffMs)) break;
  }

  console.log(
    `[remoteok] html path: pages=${pagesFetched} rows=${jobs.length} tags=[${tags.join(",")}] location=${location ?? "(any)"}`
  );
  return jobs;
}

// --- JSON feed (fallback only; ignores location) --------------------------

interface RemoteOkItem {
  id?: string | number;
  position?: string;
  company?: string;
  company_url?: string;
  url?: string;
  slug?: string;
  location?: string;
  description?: string;
  date?: string;
  epoch?: number;
}

/** Prefers the ISO `date` field; falls back to `epoch` (unix seconds). */
function resolvePostedAt(date: unknown, epoch: unknown): string | null {
  const fromDate = toIsoOrNull(date);
  if (fromDate) return fromDate;
  if (typeof epoch === "number" && Number.isFinite(epoch)) {
    const parsed = new Date(epoch * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** Trims whitespace and stray trailing commas (e.g. "Coimbatore South, "); empty -> "Remote". */
function normalizeLocation(value: unknown): string {
  if (typeof value !== "string") return "Remote";
  const cleaned = value.trim().replace(/,\s*$/, "").trim();
  return cleaned === "" ? "Remote" : cleaned;
}

/**
 * The public JSON feed. Honors `?tags=` but has no location parameter — its
 * `location` field is a bare city with the country already stripped, so a
 * country filter can't be applied here. Used only when the HTML endpoint
 * above throws or its markup no longer parses.
 */
async function fetchFromJsonFeed(tags: string[]): Promise<NormalizedJob[]> {
  let apiUrl = "https://remoteok.com/api";
  if (tags.length > 0) {
    apiUrl += `?tags=${tags.join(",")}`;
  }

  const res = await fetch(apiUrl, {
    headers: {
      "User-Agent": "job-digest/1.0 (cloudflare worker)",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`remoteok: JSON feed request failed with status ${res.status}`);
  }

  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("remoteok: unexpected response shape (expected array)");
  }

  const jobs: NormalizedJob[] = [];
  for (const raw of data as RemoteOkItem[]) {
    // item[0] is a legal-notice object ({ last_updated, legal }) with no id/position; skip it.
    if (!raw || raw.id === undefined || raw.id === null || !raw.position) continue;

    const listingUrl = isHttpUrl(raw.url) ? raw.url : `https://remoteok.com/remote-jobs/${raw.slug ?? raw.id}`;

    jobs.push({
      id: `remoteok:${raw.id}`,
      title: decodeEntities(raw.position),
      company: raw.company ? decodeEntities(raw.company) : "Unknown",
      company_url: isHttpUrl(raw.company_url) ? raw.company_url : null,
      listing_url: listingUrl,
      location: normalizeLocation(raw.location),
      posted_at: resolvePostedAt(raw.date, raw.epoch),
      source: "remoteok",
      description: typeof raw.description === "string" && raw.description.trim() !== "" ? htmlToText(raw.description) : null,
    });
  }

  console.log(`[remoteok] json fallback: rows=${jobs.length} tags=[${tags.join(",")}]`);
  return jobs;
}

// --- Fetcher ---------------------------------------------------------------

/**
 * Decides whether a RemoteOK job satisfies the non-geo-scoped parts of
 * criteria (required/excluded keywords, and location when remote isn't
 * blanket-acceptable). `text` is the caller's pre-lowercased keyword-check
 * haystack (title + company + location, matching the generic matcher's
 * basis); `locationText` is the pre-lowercased location alone. Every
 * RemoteOK job is remote and config.location already scopes the request
 * geographically, so when `criteria.remote_ok` is true no further location
 * check is needed.
 */
export function remoteokJobOk(
  text: string,
  locationText: string,
  criteria: { required_keywords: string[]; excluded_keywords: string[]; locations: string[]; remote_ok: boolean }
): boolean {
  if (criteria.required_keywords.length > 0 && !includesAny(text, criteria.required_keywords)) return false;
  if (criteria.excluded_keywords.length > 0 && includesAny(text, criteria.excluded_keywords)) return false;

  if (criteria.remote_ok) return true;
  if (criteria.locations.length === 0) return true;
  return includesAny(locationText, criteria.locations);
}

export const remoteok: Fetcher = async (ctx) => {
  const config = ctx.config as RemoteOkConfig;
  const tags = parseTags(config.tags);
  const location = parseLocationCode(config.location);
  const maxPages = clampInt(config.max_pages, 1, 4, DEFAULT_MAX_PAGES);

  let jobs: NormalizedJob[];
  try {
    const htmlJobs = await fetchFromHtmlPages(tags, location, maxPages, ctx.criteria.max_age_days);
    if (htmlJobs !== null) {
      jobs = htmlJobs;
    } else {
      console.warn("[remoteok] HTML endpoint unusable, falling back to JSON feed (location filter not applied)");
      jobs = await fetchFromJsonFeed(tags);
    }
  } catch (err) {
    console.warn("[remoteok] HTML endpoint unusable, falling back to JSON feed (location filter not applied)", err);
    jobs = await fetchFromJsonFeed(tags);
  }

  // The page-boundary cutoff in fetchFromHtmlPages can let a few stale rows
  // through, and the JSON fallback applies no age filter at all; the generic
  // re-filter that used to catch those no longer runs for this source.
  const maxAgeDays = ctx.criteria.max_age_days;
  const cutoff =
    typeof maxAgeDays === "number" && Number.isFinite(maxAgeDays) && maxAgeDays > 0
      ? Date.now() - maxAgeDays * 86_400_000
      : null;

  return jobs.filter((job) => {
    if (cutoff !== null && job.posted_at) {
      const posted = new Date(job.posted_at).getTime();
      if (!Number.isNaN(posted) && posted < cutoff) return false;
    }
    const text = `${job.title} ${job.company} ${job.location ?? ""}`.toLowerCase();
    const locationText = (job.location ?? "").toLowerCase();
    return remoteokJobOk(text, locationText, ctx.criteria);
  });
};

// Every RemoteOK job is remote, and geo eligibility is already scoped
// API-side by config.location, so the generic matcher's job.source ===
// "remoteok" special case (now removed) is replaced by applying the
// remaining criteria (keywords, location-when-not-remote-ok) here directly.
remoteok.appliesCriteria = true;
