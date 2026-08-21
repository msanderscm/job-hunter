/**
 * Password hashing and the login-form validators.
 *
 * Everything here is pure Web Crypto (crypto.subtle / crypto.getRandomValues)
 * so it runs unchanged on a V8 isolate and under vitest — no env, no DB, no
 * Node built-ins. Stored hashes look like:
 *
 *   pbkdf2-sha256$<iterations>$<salt>$<hash>
 *
 * with salt and hash base64url-encoded without padding.
 */

/**
 * PBKDF2 rounds for new hashes. Workers Free allows ~10 ms of CPU per request,
 * which is the ceiling this has to live under: 100k rounds measured ~11 ms, so
 * 50k leaves headroom for the rest of the request. The count is embedded in every
 * stored hash, so lowering (or raising) it later only affects new passwords —
 * hashes written with the old value stay verifiable.
 */
export const PBKDF2_ITERATIONS = 50_000;

/** Length of the derived key, in bits — SHA-256's natural output. */
const HASH_BITS = 256;
/** Salt length in bytes. */
const SALT_BYTES = 16;
/** Prefix identifying the one hash format we write. */
const HASH_PREFIX = "pbkdf2-sha256";
/**
 * Bounds on the iteration count parsed out of a stored hash. The floor means a
 * row written by anything other than hashPassword (a seed script, a bad import)
 * can't quietly downgrade an account to a trivially brute-forceable hash.
 */
const MIN_ITERATIONS = 10_000;
const MAX_ITERATIONS = 1_000_000;

/** base64url (RFC 4648 §5) without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of base64urlEncode; returns null for anything that isn't valid base64url. */
export function base64urlDecode(value: string): Uint8Array | null {
  if (value === "" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Constant-time byte comparison. Workers exposes crypto.subtle.timingSafeEqual;
 * Node (vitest) does not, so fall back to an XOR loop over the full length.
 * A length mismatch is an immediate false — lengths are not secret here.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(a, b);
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BITS
  );
  return new Uint8Array(bits);
}

/**
 * Hashes a password with a fresh random salt. `iterations` is only overridden
 * by the tests (100k rounds per assertion would make the suite crawl).
 */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(password, salt, iterations);
  return `${HASH_PREFIX}$${iterations}$${base64urlEncode(salt)}$${base64urlEncode(hash)}`;
}

/**
 * Checks a password against a stored hash string, re-deriving with the salt and
 * iteration count it carries. Any malformed input is a plain false — a corrupt
 * or unknown-format row must never authenticate anyone.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 4) return false;

  const [prefix, iterationsText, saltText, hashText] = parts;
  if (prefix !== HASH_PREFIX) return false;

  if (!/^[0-9]+$/.test(iterationsText)) return false;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    return false;
  }

  const salt = base64urlDecode(saltText);
  const expected = base64urlDecode(hashText);
  if (!salt || !expected || expected.length !== HASH_BITS / 8) return false;

  const actual = await deriveBits(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

// --- Field validation -----------------------------------------------------

/** The stored form of a username: trimmed and lowercased. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

const USERNAME_RE = /^[a-z0-9._-]+$/;
const USERNAME_MESSAGE = "username: must be 3-32 characters of a-z, 0-9, '.', '_' or '-'";

/** Returns an error message, or null when the value is a usable username. */
export function validateUsername(value: unknown): string | null {
  if (typeof value !== "string") return USERNAME_MESSAGE;
  const normalized = normalizeUsername(value);
  if (normalized.length < 3 || normalized.length > 32) return USERNAME_MESSAGE;
  if (!USERNAME_RE.test(normalized)) return USERNAME_MESSAGE;
  return null;
}

/** Returns an error message, or null when the value is a usable password. */
export function validatePassword(value: unknown): string | null {
  const message = "password: must be 10-128 characters";
  if (typeof value !== "string") return message;
  if (value.length < 10 || value.length > 128) return message;
  return null;
}

/** Returns an error message, or null when the value is a usable first name. */
export function validateFirstName(value: unknown): string | null {
  const message = "first_name: must be 1-60 characters";
  if (typeof value !== "string") return message;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 60) return message;
  return null;
}
