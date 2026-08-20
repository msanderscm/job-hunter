import type { Criteria, Env } from "./types";
import { loadCriteria, loadSources, listRecentJobs, updateCriteria, updateSource, getSource } from "./db";
import { requireAdmin } from "./auth";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

class ValidationError extends Error {}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("body: invalid JSON");
  }
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field}: must be an array`);
  }
  const trimmed: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ValidationError(`${field}: items must be strings`);
    }
    const t = item.trim();
    if (t === "") {
      throw new ValidationError(`${field}: items must be non-empty strings`);
    }
    if (t.length > 100) {
      throw new ValidationError(`${field}: items must be at most 100 characters`);
    }
    trimmed.push(t);
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of trimmed) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  if (deduped.length > 50) {
    throw new ValidationError(`${field}: at most 50 items allowed`);
  }

  return deduped;
}

function validateCriteriaBody(body: unknown): Criteria {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("body: must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const required_keywords = validateStringArray(b.required_keywords, "required_keywords");
  const excluded_keywords = validateStringArray(b.excluded_keywords, "excluded_keywords");
  const locations = validateStringArray(b.locations, "locations");

  if (typeof b.remote_ok !== "boolean") {
    throw new ValidationError("remote_ok: must be a boolean");
  }

  if (
    typeof b.max_age_days !== "number" ||
    !Number.isInteger(b.max_age_days) ||
    b.max_age_days < 1 ||
    b.max_age_days > 30
  ) {
    throw new ValidationError("max_age_days: must be an integer between 1 and 30");
  }

  return {
    required_keywords,
    excluded_keywords,
    locations,
    remote_ok: b.remote_ok,
    max_age_days: b.max_age_days,
  };
}

function secretsPresent(env: Env, names: string[]): boolean {
  return names.every((name) => typeof env[name] === "string" && (env[name] as string).trim() !== "");
}

async function handleSourcesRoute(request: Request, env: Env, sourceId: string): Promise<Response> {
  if (request.method !== "PUT") {
    return json({ error: "method not allowed" }, 405);
  }

  const authFailure = requireAdmin(request, env);
  if (authFailure) return authFailure;

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "body: must be a JSON object" }, 400);
  }
  const b = body as Record<string, unknown>;

  const update: { enabled?: boolean; config?: Record<string, unknown> } = {};

  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") {
      return json({ error: "enabled: must be a boolean" }, 400);
    }
    update.enabled = b.enabled;
  }

  if ("config" in b) {
    if (typeof b.config !== "object" || b.config === null || Array.isArray(b.config)) {
      return json({ error: "config: must be a JSON object" }, 400);
    }
    const serialized = JSON.stringify(b.config);
    if (new TextEncoder().encode(serialized).length > 4096) {
      return json({ error: "config: must be at most 4KB when JSON-serialized" }, 400);
    }
    update.config = b.config as Record<string, unknown>;
  }

  if (update.enabled === undefined && update.config === undefined) {
    return json({ error: "body: must include enabled and/or config" }, 400);
  }

  const existing = await getSource(env.DB, sourceId);
  if (!existing) {
    return json({ error: "source not found" }, 404);
  }

  const ok = await updateSource(env.DB, sourceId, update);
  if (!ok) {
    return json({ error: "source not found" }, 404);
  }

  const fresh = await getSource(env.DB, sourceId);
  if (!fresh) {
    return json({ error: "source not found" }, 404);
  }

  return json({
    id: fresh.id,
    display_name: fresh.display_name,
    enabled: fresh.enabled,
    config: fresh.config,
    requires_secrets: fresh.requires_secrets,
    secrets_present: secretsPresent(env, fresh.requires_secrets),
    updated_at: fresh.updated_at,
  });
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  try {
    const path = url.pathname;

    if (path === "/api/jobs") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const jobs = await listRecentJobs(env.DB);
      return json({ jobs });
    }

    if (path === "/api/criteria") {
      if (request.method === "GET") {
        const criteria = await loadCriteria(env.DB);
        return json(criteria);
      }
      if (request.method === "PUT") {
        const authFailure = requireAdmin(request, env);
        if (authFailure) return authFailure;

        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch (err) {
          return json({ error: (err as Error).message }, 400);
        }

        let validated: Criteria;
        try {
          validated = validateCriteriaBody(body);
        } catch (err) {
          if (err instanceof ValidationError) {
            return json({ error: err.message }, 400);
          }
          throw err;
        }

        const fresh = await updateCriteria(env.DB, validated);
        return json(fresh);
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (path === "/api/sources") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const sources = await loadSources(env.DB);
      return json({
        sources: sources.map((s) => ({
          id: s.id,
          display_name: s.display_name,
          enabled: s.enabled,
          config: s.config,
          requires_secrets: s.requires_secrets,
          secrets_present: secretsPresent(env, s.requires_secrets),
          updated_at: s.updated_at,
        })),
      });
    }

    const sourceMatch = /^\/api\/sources\/([^/]+)$/.exec(path);
    if (sourceMatch) {
      return handleSourcesRoute(request, env, decodeURIComponent(sourceMatch[1]));
    }

    return json({ error: "not found" }, 404);
  } catch (err) {
    console.error("api error", err);
    return json({ error: "internal error" }, 500);
  }
}
