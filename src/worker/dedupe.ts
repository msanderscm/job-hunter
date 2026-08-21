import type { Env } from "./types";

// --- Embedding-based duplicate detection -----------------------------------
//
// Job boards re-post the same listing constantly: the same role from the same
// company appears again days later under a new id, and the scorer pays for a
// full LLM rating each time. This embeds every pending listing once (cheap,
// ~1/1000th of a chat completion) and, when a listing is near-identical to one
// already rated against the CURRENT resume, copies that rating instead of
// asking the LLM again.
//
// It is strictly an optimisation: any failure here just means every pending
// job goes to the LLM exactly as before (see scoring.ts). The threshold is
// deliberately high — a false duplicate would silently mis-rate a real job,
// while a missed duplicate only costs one LLM slot.

/**
 * 768-dimension embeddings. Near-duplicate detection of short listing text does
 * not need the 1024-d `-large` model, and `-base` is ~3x cheaper per token.
 */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/** Cosine similarity at or above this counts as the same listing. */
export const DUPLICATE_THRESHOLD = 0.95;

/** bge models take 512 tokens; 2,000 characters of English is safely inside that. */
export const EMBED_MAX_CHARS = 2_000;

/** Only recent already-rated jobs are worth comparing against (same order as the UI window). */
export const DUPLICATE_POOL_WINDOW = "-14 days";

/** The binding accepts up to 100 texts per call; 50 keeps each request comfortably small. */
const EMBED_CHUNK_SIZE = 50;

/** Legal suffixes that differ between postings of the same employer ("Acme" vs "Acme, Inc."). */
const COMPANY_SUFFIX = /\s+(?:inc|llc|ltd|corp|gmbh|co)$/;

/**
 * Company keys that identify nobody. Sources fall back to "Unknown" when a
 * listing has no employer (adzuna.ts, remoteok.ts); matching on that would let
 * unrelated employers' postings collapse into one rating.
 */
const PLACEHOLDER_COMPANY_KEYS = new Set(["", "unknown", "n a", "none", "confidential"]);

/** The text an embedding is computed from: the fields that identify a listing. */
export function jobEmbeddingText(job: {
  title: string;
  company: string;
  location: string | null;
  description: string | null;
}): string {
  const text = `${job.title}\n${job.company}\n${job.location ?? ""}\n${job.description ?? ""}`;
  return text.trim().slice(0, EMBED_MAX_CHARS);
}

/**
 * Embeds `texts` in chunks, returning one L2-normalised vector per input, in
 * order. Normalising here means cosine similarity is a plain dot product and
 * stored vectors are directly comparable. Throws on a malformed response — the
 * caller treats that as "no dedupe this run".
 */
export async function embedTexts(env: Env, texts: string[]): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += EMBED_CHUNK_SIZE) {
    const chunk = texts.slice(i, i + EMBED_CHUNK_SIZE);
    const response = (await env.AI.run(EMBEDDING_MODEL as never, { text: chunk } as never)) as unknown as {
      data?: unknown;
    };

    const data = response?.data;
    if (!Array.isArray(data) || data.length !== chunk.length) {
      throw new Error("dedupe: embedding response missing 'data' array");
    }

    for (const row of data) {
      if (!Array.isArray(row) || row.length === 0) {
        throw new Error("dedupe: embedding response contains a malformed vector");
      }
      vectors.push(normalize(Float32Array.from(row as number[])));
    }
  }

  return vectors;
}

/** Scales `vec` to unit length in place (a zero vector is left alone). */
function normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i += 1) vec[i] = vec[i] / norm;
  return vec;
}

/** Proper cosine similarity — vectors from D1 are trusted to be normalised, but this doesn't assume it. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`dedupe: cosineSimilarity length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Raw float32, little-endian. Endianness is written explicitly through a
 * DataView rather than inherited from the platform, so a stored vector stays
 * readable no matter where the Worker runs.
 */
export function encodeEmbedding(vec: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(vec.length * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < vec.length; i += 1) {
    view.setFloat32(i * 4, vec[i], true);
  }
  return buffer;
}

/**
 * Inverse of `encodeEmbedding`. D1 hands BLOB columns back as an ArrayBuffer;
 * `Uint8Array`/`number[]` are accepted defensively for the local
 * miniflare path, which has been known to return plain byte arrays.
 */
export function decodeEmbedding(blob: ArrayBuffer | Uint8Array | number[]): Float32Array {
  let bytes: Uint8Array;
  if (blob instanceof Uint8Array) {
    bytes = blob;
  } else if (Array.isArray(blob)) {
    bytes = Uint8Array.from(blob);
  } else {
    bytes = new Uint8Array(blob);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vec = new Float32Array(Math.floor(bytes.byteLength / 4));
  for (let i = 0; i < vec.length; i += 1) {
    vec[i] = view.getFloat32(i * 4, true);
  }
  return vec;
}

/**
 * Normalised employer name, used as a hard guard before comparing embeddings:
 * two different companies advertising the same boilerplate role must never be
 * collapsed into one rating.
 */
export function companyKey(company: string): string {
  const cleaned = company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned.replace(COMPANY_SUFFIX, "").trim();
}

/**
 * The best already-rated match for `candidate`, or null when nothing in `pool`
 * is close enough. Only same-company entries are considered, and a candidate
 * with a placeholder company is never deduplicated at all.
 */
export function findDuplicate(
  candidate: { company: string; embedding: Float32Array },
  pool: Array<{ id: string; company: string; embedding: Float32Array }>
): { id: string; similarity: number } | null {
  const key = companyKey(candidate.company);
  if (PLACEHOLDER_COMPANY_KEYS.has(key)) return null;
  let best: { id: string; similarity: number } | null = null;

  for (const entry of pool) {
    if (companyKey(entry.company) !== key) continue;
    if (entry.embedding.length !== candidate.embedding.length) continue;
    const similarity = cosineSimilarity(candidate.embedding, entry.embedding);
    if (best === null || similarity > best.similarity) {
      best = { id: entry.id, similarity };
    }
  }

  return best !== null && best.similarity >= DUPLICATE_THRESHOLD ? best : null;
}
