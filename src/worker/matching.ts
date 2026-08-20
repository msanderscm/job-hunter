import type { Criteria, NormalizedJob } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle.toLowerCase()));
}

/**
 * Decides whether a normalized job satisfies the user's criteria.
 *
 * required_keywords uses OR semantics: despite the name, the job only needs
 * to match at least ONE of the listed keywords (not all of them) to pass.
 * An empty list imposes no requirement.
 */
export function matchesCriteria(job: NormalizedJob, criteria: Criteria, now: Date = new Date()): boolean {
  const text = `${job.title} ${job.company} ${job.location ?? ""}`.toLowerCase();

  if (criteria.required_keywords.length > 0 && !includesAny(text, criteria.required_keywords)) {
    return false;
  }

  if (criteria.excluded_keywords.length > 0 && includesAny(text, criteria.excluded_keywords)) {
    return false;
  }

  const locationText = (job.location ?? "").toLowerCase();
  const isRemote = locationText.includes("remote") || job.source === "remoteok";

  let locationOk: boolean;
  if (criteria.remote_ok && isRemote) {
    // Remote is acceptable and this job is remote: no further location check needed.
    locationOk = true;
  } else if (criteria.locations.length === 0) {
    // No location constraint configured (this also covers remote_ok === false
    // combined with a remote job: with no explicit locations, that's allowed).
    locationOk = true;
  } else {
    locationOk = includesAny(locationText, criteria.locations);
  }
  if (!locationOk) return false;

  if (job.posted_at) {
    const posted = new Date(job.posted_at);
    if (!Number.isNaN(posted.getTime())) {
      const cutoff = now.getTime() - criteria.max_age_days * MS_PER_DAY;
      if (posted.getTime() < cutoff) return false;
    }
    // Unparsable posted_at falls through and passes.
  }

  return true;
}
