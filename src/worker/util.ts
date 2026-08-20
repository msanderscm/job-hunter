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
