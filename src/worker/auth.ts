import type { Env } from "./types";

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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies the `Authorization: Bearer <token>` header against env.ADMIN_TOKEN.
 * Returns a Response to short-circuit the request when auth fails, or null
 * when the request is authorized and the caller should proceed.
 */
export function requireAdmin(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN secret is not configured" }, 503);
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/.exec(authHeader);
  const token = match ? match[1] : "";

  if (!token || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }

  return null;
}
