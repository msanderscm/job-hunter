export interface Job {
  id: string;
  title: string;
  company: string;
  company_url: string | null;
  listing_url: string;
  location: string | null;
  posted_at: string | null;
  first_seen_at: string;
  source: string;
}

export interface Criteria {
  required_keywords: string[];
  excluded_keywords: string[];
  locations: string[];
  remote_ok: boolean;
  max_age_days: number;
  updated_at?: string;
}

export interface Source {
  id: string;
  display_name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  requires_secrets: string[];
  secrets_present: boolean;
  updated_at?: string;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = res.statusText || `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // response body wasn't JSON; keep the default message
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

function authHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

export function getJobs(): Promise<{ jobs: Job[] }> {
  return request<{ jobs: Job[] }>("/api/jobs");
}

export function getCriteria(): Promise<Criteria> {
  return request<Criteria>("/api/criteria");
}

export function putCriteria(
  criteria: Omit<Criteria, "updated_at">,
  token: string
): Promise<Criteria> {
  return request<Criteria>("/api/criteria", {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(criteria),
  });
}

export function getSources(): Promise<{ sources: Source[] }> {
  return request<{ sources: Source[] }>("/api/sources");
}

export function putSource(
  id: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> },
  token: string
): Promise<Source> {
  return request<Source>(`/api/sources/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(patch),
  });
}
