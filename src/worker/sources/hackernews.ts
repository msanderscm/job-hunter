import type { NormalizedJob } from "../types";
import type { Fetcher } from "./types";
import { capText, decodeEntities } from "../util";

// --- Hacker News "Ask HN: Who is hiring?" source -----------------------
//
// This is the reference implementation for LLM-based sources. Unlike the
// other fetchers (RemoteOK, Adzuna), which return raw listings for the
// generic keyword/location filter in matching.ts, this source judges each
// post itself with Workers AI and only returns posts it considers a match
// (see `hackernews.appliesCriteria = true` below, and cron.ts's handling of
// that flag). That's necessary because HN posts are free text, not
// structured listings with a title/location field — a keyword filter alone
// would badly over- or under-match.
//
// Flow: find this month's "who is hiring" thread on HN Algolia -> fetch its
// top-level comments (each comment = one job post) -> cheap deterministic
// pre-filter (excluded keywords, recency, cap) -> batch the remainder
// through Workers AI for a criteria match + field extraction -> map matches
// to NormalizedJob.

const ALGOLIA_BASE = "https://hn.algolia.com/api/v1";
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_POSTS = 60;
const DEFAULT_MAX_CHARS = 2500;

const THREAD_TITLE_RE = /^Ask HN: Who is hiring\? \(([A-Za-z]+) (\d{4})\)/;

interface AlgoliaStoryHit {
  objectID: string;
  title?: string;
  created_at?: string;
  num_comments?: number;
}

interface AlgoliaCommentHit {
  objectID: string;
  parent_id?: number | string | null;
  story_id?: number | string | null;
  author?: string | null;
  created_at?: string;
  created_at_i?: number;
  comment_text?: string | null;
}

interface AlgoliaSearchResponse<T> {
  hits: T[];
}

interface HackerNewsConfig {
  model?: unknown;
  batch_size?: unknown;
  max_posts?: unknown;
  max_chars?: unknown;
}

interface ThreadInfo {
  storyId: string;
  title: string;
}

interface CleanedPost {
  id: string;
  createdAtI: number;
  createdAt: string;
  text: string;
  firstUrl: string | null;
}

interface LlmResult {
  id: string;
  match: boolean;
  reason?: string;
  company?: string;
  title?: string;
  location?: string | null;
  remote?: boolean;
  company_url?: string | null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const bodyText = await res.text();
  if (!bodyText.trim().startsWith("{")) {
    throw new Error(`hackernews: unexpected response (status ${res.status}) from Algolia`);
  }
  return JSON.parse(bodyText) as T;
}

/** Finds the most recent "Ask HN: Who is hiring? (Month Year)" thread. */
async function findThread(): Promise<ThreadInfo> {
  const url = `${ALGOLIA_BASE}/search_by_date?tags=story,author_whoishiring&hitsPerPage=10`;
  const data = await fetchJson<AlgoliaSearchResponse<AlgoliaStoryHit>>(url);
  const hit = (data.hits ?? []).find((h) => typeof h.title === "string" && THREAD_TITLE_RE.test(h.title));
  if (!hit) {
    throw new Error("hackernews: no 'Who is hiring?' thread found");
  }
  return { storyId: hit.objectID, title: hit.title ?? "" };
}

/** Fetches top-level comments (job posts) on the thread since `sinceUnixSeconds`. */
async function fetchPosts(storyId: string, sinceUnixSeconds: number): Promise<AlgoliaCommentHit[]> {
  const url = `${ALGOLIA_BASE}/search_by_date?tags=comment,story_${storyId}&numericFilters=created_at_i>${sinceUnixSeconds}&hitsPerPage=1000`;
  const data = await fetchJson<AlgoliaSearchResponse<AlgoliaCommentHit>>(url);
  return (data.hits ?? []).filter((hit) => {
    if (String(hit.parent_id) !== String(storyId)) return false;
    const text = hit.comment_text;
    if (typeof text !== "string" || text.trim() === "") return false;
    if (text.trim() === "[dead]" || text.trim() === "[flagged]") return false;
    return true;
  });
}

const FIRST_URL_RE = /https?:\/\/[^\s<>"]+/i;

/** Strips HTML from a comment's `comment_text`, decodes entities, and caps length. */
function cleanPost(hit: AlgoliaCommentHit, maxChars: number): CleanedPost {
  const raw = hit.comment_text ?? "";

  const urlMatch = raw.match(FIRST_URL_RE);
  const firstUrl = urlMatch ? decodeEntities(urlMatch[0]).replace(/[),.;]+$/, "") : null;

  let text = raw
    .replace(/<p>/gi, "\n\n")
    .replace(/<\/?(pre|code)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const decodedHref = decodeEntities(href);
      const decodedLabel = decodeEntities(label).trim();
      return decodedLabel === decodedHref ? decodedHref : `${decodedLabel} (${decodedHref})`;
    })
    .replace(/<[^>]+>/g, "");

  text = decodeEntities(text);
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;

  return {
    id: hit.objectID,
    createdAtI: hit.created_at_i ?? 0,
    createdAt: hit.created_at ?? new Date((hit.created_at_i ?? 0) * 1000).toISOString(),
    text: truncated,
    firstUrl,
  };
}

function buildJsonSchema() {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            match: { type: "boolean" },
            reason: { type: "string" },
            company: { type: "string" },
            title: { type: "string" },
            location: { type: ["string", "null"] },
            remote: { type: "boolean" },
            company_url: { type: ["string", "null"] },
          },
          required: ["id", "match", "company", "title", "remote"],
        },
      },
    },
    required: ["results"],
  } as const;
}

function buildUserPrompt(posts: CleanedPost[], criteriaText: string): string {
  const postBlocks = posts.map((p) => `### Post ${p.id}\n${p.text}`).join("\n\n");
  return `${criteriaText}\n\n${postBlocks}`;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^https?:\/\//i.test(value);
}

/** Unwraps Workers AI's `.response`, which may be a parsed object or a (possibly fenced) JSON string. */
function parseAiResponse(response: unknown): { results: LlmResult[] } {
  let parsed: unknown = response;
  if (typeof parsed === "string") {
    const stripped = parsed
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    parsed = JSON.parse(stripped);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { results?: unknown }).results)) {
    throw new Error("hackernews: AI response missing 'results' array");
  }
  return parsed as { results: LlmResult[] };
}

/** First line's leading "Company | Title | ..." segment, used as a fallback when the LLM omits a field. */
function firstLineSegments(text: string): string[] {
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.split("|").map((s) => s.trim());
}

function fallbackTitle(text: string): string {
  const segments = firstLineSegments(text);
  const candidate = segments.length > 1 ? segments[1] : segments[0];
  return (candidate || "Untitled role").slice(0, 140);
}

function fallbackCompany(text: string): string {
  const segments = firstLineSegments(text);
  return (segments[0] || "Unknown").slice(0, 100);
}

export const hackernews: Fetcher = async (ctx) => {
  if (!ctx.ai) {
    throw new Error('hackernews: AI binding not configured (add [ai] binding = "AI" to wrangler.toml)');
  }

  const config = ctx.config as HackerNewsConfig;
  const model = typeof config.model === "string" && config.model.trim() !== "" ? config.model : DEFAULT_MODEL;
  const batchSize = clampInt(config.batch_size, 1, 40, DEFAULT_BATCH_SIZE);
  const maxPosts = clampInt(config.max_posts, 1, 200, DEFAULT_MAX_POSTS);
  const maxChars = clampInt(config.max_chars, 500, 8000, DEFAULT_MAX_CHARS);

  const thread = await findThread();

  const sinceUnixSeconds = Math.floor(Date.now() / 1000) - ctx.criteria.max_age_days * 86400;
  const rawPosts = await fetchPosts(thread.storyId, sinceUnixSeconds);
  const postsFetched = rawPosts.length;

  const cleaned = rawPosts.map((hit) => cleanPost(hit, maxChars));

  const excluded = ctx.criteria.excluded_keywords.map((k) => k.toLowerCase());
  let filtered = cleaned.filter((post) => {
    const lower = post.text.toLowerCase();
    return !excluded.some((kw) => kw && lower.includes(kw));
  });

  // Newest first, then cap at max_posts.
  filtered.sort((a, b) => b.createdAtI - a.createdAtI);
  const afterPrefilter = filtered.length;
  if (filtered.length > maxPosts) {
    console.warn(`[hackernews] dropped ${filtered.length - maxPosts} posts beyond max_posts=${maxPosts}`);
    filtered = filtered.slice(0, maxPosts);
  }

  if (filtered.length === 0) {
    console.log(
      `[hackernews] thread=${thread.storyId} "${thread.title}" fetched=${postsFetched} afterPrefilter=0 sentToLlm=0 matched=0`
    );
    return [];
  }

  const criteriaText = [
    `Required keywords (post should clearly involve at least one, treat close synonyms as matches): ${
      ctx.criteria.required_keywords.length > 0 ? ctx.criteria.required_keywords.join(", ") : "(none specified)"
    }`,
    `Excluded keywords (hard constraint, reject if present): ${
      ctx.criteria.excluded_keywords.length > 0 ? ctx.criteria.excluded_keywords.join(", ") : "(none)"
    }`,
    `Acceptable locations (hard constraint unless remote): ${
      ctx.criteria.locations.length > 0 ? ctx.criteria.locations.join(", ") : "any"
    }`,
    `Remote acceptable: ${ctx.criteria.remote_ok ? "yes" : "no"}`,
  ].join("\n");

  const postsById = new Map(filtered.map((p) => [p.id, p]));
  const jobs: NormalizedJob[] = [];
  let sentToLlm = 0;

  for (let i = 0; i < filtered.length; i += batchSize) {
    const batch = filtered.slice(i, i + batchSize);
    sentToLlm += batch.length;

    try {
      const userPrompt = buildUserPrompt(batch, criteriaText);
      const aiResponse = await ctx.ai.run(model, {
        messages: [
          {
            role: "system",
            content:
              "You screen Hacker News 'Who is hiring' posts for a job seeker. Judge each post against the candidate's criteria and extract fields. Be strict about hard constraints (excluded terms, location/remote). 'Required keywords' means the post should clearly involve at least one of them (roles, technologies or domains) — treat close synonyms as matches. Respond with JSON only.",
          },
          { role: "user", content: userPrompt },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response_format: { type: "json_schema", json_schema: buildJsonSchema() } as any,
        max_tokens: 4096,
      });

      const { results } = parseAiResponse((aiResponse as { response?: unknown }).response);

      for (const result of results) {
        if (!result || typeof result.id !== "string" || result.match !== true) continue;
        const post = postsById.get(result.id);
        if (!post) continue; // ignore ids the model hallucinated outside this batch

        const title = (typeof result.title === "string" && result.title.trim()) || fallbackTitle(post.text);
        const company = (typeof result.company === "string" && result.company.trim()) || fallbackCompany(post.text);
        const companyUrl = isHttpUrl(result.company_url) ? result.company_url : isHttpUrl(post.firstUrl) ? post.firstUrl : null;
        const location =
          typeof result.location === "string" && result.location.trim()
            ? result.location.trim()
            : result.location === null && result.remote === true
              ? "Remote"
              : null;

        jobs.push({
          id: `hackernews:${post.id}`,
          title: title.slice(0, 140),
          company: company.slice(0, 100),
          company_url: companyUrl,
          listing_url: `https://news.ycombinator.com/item?id=${post.id}`,
          location,
          posted_at: new Date(post.createdAtI * 1000).toISOString(),
          source: "hackernews",
          // post.text is already HTML-stripped and entity-decoded by cleanPost().
          description: capText(post.text),
        });
      }
    } catch (err) {
      // One bad batch (AI error, malformed JSON, etc.) must not kill the
      // whole source — log and move on to the next batch.
      console.error(`[hackernews] batch ${Math.floor(i / batchSize)} failed`, err);
    }
  }

  console.log(
    `[hackernews] thread=${thread.storyId} "${thread.title}" fetched=${postsFetched} afterPrefilter=${afterPrefilter} sentToLlm=${sentToLlm} matched=${jobs.length}`
  );

  return jobs;
};

hackernews.appliesCriteria = true;
