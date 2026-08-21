import type { AuthPrincipal, Env } from "./types";
import { createSession, getSessionUser } from "./db";
import { base64urlEncode } from "./password";

function json(data: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Name of the session cookie set at login and cleared at logout. */
export const SESSION_COOKIE = "session";
/** How long a session stays valid: 30 days, matching the cookie's Max-Age. */
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

/** Parses a Cookie header into a name -> value map. Values may contain "=". */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (name === "") continue;
    out[name] = part.slice(eq + 1).trim();
  }

  return out;
}

/** SHA-256 of a string, base64url — how session cookie values are stored (see migrations/0008). */
export async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64urlEncode(new Uint8Array(digest));
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Builds the Set-Cookie header for the session. `Secure` is always set except
 * for local development hosts (Safari drops Secure cookies on plain http). The
 * decision is keyed on the hostname, not the URL scheme, so a TLS-terminating
 * proxy handing the Worker an http:// URL can't silently drop the flag in
 * production. Pass an empty value with maxAge 0 to clear.
 */
export function sessionCookie(value: string, request: Request, maxAge: number): string {
  const secure = LOCAL_HOSTS.has(new URL(request.url).hostname) ? "" : "; Secure";
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

/**
 * Mints a session for `userId`: 32 random bytes become the cookie value, and
 * only their SHA-256 is stored. expires_at is written as SQLite datetime text
 * so it compares directly with datetime('now').
 */
export async function issueSession(
  db: D1Database,
  request: Request,
  userId: number,
  authRef: string | null = null
): Promise<{ setCookie: string }> {
  const value = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  await createSession(db, userId, await sha256Base64url(value), expiresAt, authRef);

  return { setCookie: sessionCookie(value, request, SESSION_TTL_SECONDS) };
}

/** The Set-Cookie header that removes the session cookie. */
export function clearSessionCookie(request: Request): string {
  return sessionCookie("", request, 0);
}

/** Deletes the session behind the request's cookie, if there is one. Best effort. */
export async function sessionIdHashFromRequest(request: Request): Promise<string | null> {
  const value = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (!value) return null;
  return sha256Base64url(value);
}

/**
 * Identifies the caller: a logged-in user via the session cookie, or a script
 * holding the ADMIN_TOKEN bearer secret. Returns null when neither checks out.
 */
export async function authenticate(request: Request, env: Env): Promise<AuthPrincipal | null> {
  const cookieValue = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (cookieValue) {
    const session = await getSessionUser(env.DB, await sha256Base64url(cookieValue));
    if (session) {
      // A bootstrap-admin session is only as good as the ADMIN_TOKEN it was
      // opened with: once the secret is rotated (or removed) it stops working.
      const tokenStillValid =
        session.authRef === null ||
        (!!env.ADMIN_TOKEN && session.authRef === (await sha256Base64url(env.ADMIN_TOKEN)));
      if (tokenStillValid) return { kind: "session", user: session.user };
    }
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/.exec(authHeader);
  const token = match ? match[1] : "";
  if (token && env.ADMIN_TOKEN && timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return { kind: "token" };
  }

  return null;
}

/**
 * Gate for the admin-only routes. Returns a Response to short-circuit the
 * request when auth fails, or null when the caller may proceed. A session
 * cookie and an `Authorization: Bearer <ADMIN_TOKEN>` header are both accepted.
 */
export async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  // Session cookies are ambient, so every state-changing route gets the CSRF
  // check here rather than relying on each handler to remember it.
  if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
    return json({ error: "forbidden" }, 403);
  }

  const principal = await authenticate(request, env);
  if (principal) return null;

  // A missing secret is an operator problem: say so in the logs, but don't
  // tell anonymous callers whether the deployment is configured.
  if (!env.ADMIN_TOKEN && /^Bearer\s+.+$/.test(request.headers.get("Authorization") ?? "")) {
    console.error("[auth] bearer auth attempted but ADMIN_TOKEN secret is not configured");
  }

  return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
}

/**
 * Belt-and-braces CSRF check for the state-changing auth routes: SameSite=Lax
 * already keeps the cookie off cross-site POSTs, but a request that announces
 * itself as cross-site, or carries a foreign Origin, is refused outright.
 * Requests with neither header (curl, scripts) are allowed.
 */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return false;

  return true;
}
