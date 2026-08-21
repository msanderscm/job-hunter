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
  match_score: number | null;
  match_reason: string | null;
  scored_at: string | null;
  work_mode: "remote" | "hybrid" | "onsite" | "unknown" | null;
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

export interface RunSummary {
  fetched: number;
  matched: number;
  inserted: number;
  scored: number;
  skipped: string[];
  failed: string[];
}

export interface ResumeInfo {
  filename: string;
  uploaded_at: string;
  chars: number;
}

export function runDigest(token: string): Promise<RunSummary> {
  return request<RunSummary>("/api/run", { method: "POST", headers: authHeaders(token) });
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

export function getResume(): Promise<{ resume: ResumeInfo | null }> {
  return request<{ resume: ResumeInfo | null }>("/api/resume");
}

export function putResume(file: File, token: string): Promise<{ resume: ResumeInfo }> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  return request<{ resume: ResumeInfo }>("/api/resume", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
}

export function rescore(token: string): Promise<{ cleared: number; pending: number }> {
  return request<{ cleared: number; pending: number }>("/api/rescore", {
    method: "POST",
    headers: authHeaders(token),
  });
}

export function scoreNext(
  token: string,
  limit = 8
): Promise<{ scored: number; pending: number }> {
  return request<{ scored: number; pending: number }>(`/api/score?limit=${limit}`, {
    method: "POST",
    headers: authHeaders(token),
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
