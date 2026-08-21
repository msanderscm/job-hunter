const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#x27": "'",
  nbsp: " ",
};

/**
 * Decodes a small set of common HTML entities (named + numeric decimal/hex).
 * Job feeds (RemoteOK, Adzuna) frequently embed entity-encoded text in
 * titles/company names (e.g. "Larsen &amp; Toubro").
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z0-9]+);/g, (match, entity: string) => {
    if (entity in NAMED_ENTITIES) return NAMED_ENTITIES[entity];
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (entity.startsWith("#")) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return match;
  });
}

/** Strips `<strong>`/`</strong>` tags that some feeds (e.g. Adzuna) wrap around matched terms. */
export function stripStrongTags(value: string): string {
  return value.replace(/<\/?strong>/gi, "");
}

/** Every stored job `description` is capped at this many characters (see migrations/0004). */
export const DESCRIPTION_MAX_CHARS = 3000;

const BLOCK_TAG_RE = /<\s*(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/blockquote)\s*\/?>/gi;

/**
 * Turns a snippet of feed HTML (Adzuna's `description`, RemoteOK's listing
 * body) into the plain text stored in `jobs.description` and fed to the
 * match scorer: block-level tags become newlines, all other tags are dropped,
 * entities are decoded, whitespace is collapsed to single spaces/newlines,
 * and the result is capped at `maxChars`.
 */
export function htmlToText(value: string, maxChars = DESCRIPTION_MAX_CHARS): string {
  const text = decodeEntities(value.replace(BLOCK_TAG_RE, "\n").replace(/<[^>]*>/g, " "))
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return capText(text, maxChars);
}

/** Truncates to `maxChars`, appending an ellipsis when anything was dropped. */
export function capText(value: string, maxChars = DESCRIPTION_MAX_CHARS): string {
  return value.length > maxChars ? `${value.slice(0, maxChars).trimEnd()}…` : value;
}
