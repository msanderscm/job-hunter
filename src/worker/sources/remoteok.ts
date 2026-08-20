import type { NormalizedJob } from "../types";
import type { Fetcher } from "./types";
import { decodeEntities } from "../util";

interface RemoteOkItem {
  id?: string | number;
  position?: string;
  company?: string;
  company_url?: string;
  url?: string;
  slug?: string;
  location?: string;
  date?: string;
  epoch?: number;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^https?:\/\//i.test(value);
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

export const remoteok: Fetcher = async (ctx) => {
  let apiUrl = "https://remoteok.com/api";
  const tags = (ctx.config as { tags?: unknown }).tags;
  if (Array.isArray(tags) && tags.length > 0 && tags.every((t) => typeof t === "string")) {
    apiUrl += `?tags=${(tags as string[]).join(",")}`;
  }

  const res = await fetch(apiUrl, {
    headers: {
      "User-Agent": "job-digest/1.0 (cloudflare worker)",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`remoteok: request failed with status ${res.status}`);
  }

  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("remoteok: unexpected response shape (expected array)");
  }

  const jobs: NormalizedJob[] = [];
  for (const raw of data as RemoteOkItem[]) {
    // item[0] is a legal-notice object ({ last_updated, legal }) with no id/position; skip it.
    if (!raw || raw.id === undefined || raw.id === null || !raw.position) continue;

    const listingUrl = isHttpUrl(raw.url)
      ? raw.url
      : `https://remoteok.com/remote-jobs/${raw.slug ?? raw.id}`;

    jobs.push({
      id: `remoteok:${raw.id}`,
      title: decodeEntities(raw.position),
      company: raw.company ? decodeEntities(raw.company) : "Unknown",
      company_url: isHttpUrl(raw.company_url) ? raw.company_url : null,
      listing_url: listingUrl,
      location: normalizeLocation(raw.location),
      posted_at: resolvePostedAt(raw.date, raw.epoch),
      source: "remoteok",
    });
  }

  return jobs;
};
