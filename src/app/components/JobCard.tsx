import { useState } from "react";
import { ApiError } from "../api";
import type { Job, JobStatus } from "../api";
import { formatDate, timeAgo } from "../utils/time";

interface JobCardProps {
  job: Job;
  onStatusChange: (job: Job, status: JobStatus) => Promise<void>;
}

/** 5-point star path, shared by the solid (remote) and outline (hybrid) markers. */
const STAR_PATH = "M12 2 L14.9 8.5 L22 9.2 L16.8 14.1 L18.4 21 L12 17.3 L5.6 21 L7.2 14.1 L2 9.2 L9.1 8.5 Z";

/** Remote/hybrid marker for the top-right of a job tile; renders nothing for onsite/unknown/null. */
function WorkModeBadge({ workMode }: { workMode: Job["work_mode"] }) {
  if (workMode === "remote") {
    return (
      <svg
        className="job-card-work-mode"
        viewBox="0 0 24 24"
        role="img"
        aria-label="Remote"
      >
        <title>Remote</title>
        <path d={STAR_PATH} fill="#ee3e32" stroke="#ee3e32" strokeLinejoin="round" />
      </svg>
    );
  }
  if (workMode === "hybrid") {
    return (
      <svg
        className="job-card-work-mode"
        viewBox="0 0 24 24"
        role="img"
        aria-label="Hybrid (remote with some on-site)"
      >
        <title>Hybrid (remote with some on-site)</title>
        <path d={STAR_PATH} fill="none" stroke="#ee3e32" strokeWidth="1.75" strokeLinejoin="round" />
      </svg>
    );
  }
  return null;
}

/** Check icon used for Save/Unsave. */
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 12.5 L10 17 L19 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** X icon used for Delete. */
function DeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6 L18 18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M18 6 L6 18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Counter-clockwise arrow used for Undelete. */
function UndeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 12a8 8 0 1 0 2.3-5.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 4v5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function JobCard({ job, onStatusChange }: JobCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const companyUrl =
    job.company_url ||
    `https://www.google.com/search?q=${encodeURIComponent(job.company)}`;
  const isFallbackCompanyLink = !job.company_url;

  async function handle(status: JobStatus) {
    setBusy(true);
    setError(null);
    try {
      await onStatusChange(job, status);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="job-card" data-score={job.match_score ?? "none"} data-status={job.status}>
      <WorkModeBadge workMode={job.work_mode} />
      <h3 className="job-card-title">
        <a href={job.listing_url} target="_blank" rel="noopener noreferrer">
          {job.title}
        </a>
      </h3>
      <p className="job-card-company">
        <a
          href={companyUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={isFallbackCompanyLink ? "Search for this company" : undefined}
        >
          {job.company}
        </a>
        {isFallbackCompanyLink && (
          <span className="search-hint" title="Search for this company">
            🔍
          </span>
        )}
      </p>
      <div className="job-card-meta">
        <span className="job-card-location">{job.location || "—"}</span>
        <span className="pill">{job.source}</span>
        {job.match_score !== null && (
          <span
            className="pill pill-match"
            title={
              job.duplicate_of
                ? `Rating copied from an identical earlier listing.${job.match_reason ? ` ${job.match_reason}` : ""}`
                : job.match_reason ?? undefined
            }
            aria-label={`match ${job.match_score} out of 5${
              job.duplicate_of ? " (rating copied from an identical earlier listing)" : ""
            }${job.match_reason ? `: ${job.match_reason}` : ""
            }`}
          >
            match {job.match_score}/5
          </span>
        )}
      </div>
      <p className="job-card-timing">
        first seen {timeAgo(job.first_seen_at)}
        {job.posted_at && <> · posted {formatDate(job.posted_at)}</>}
      </p>
      <div className="job-card-footer">
        {job.status === "new" && (
          <>
            <button
              type="button"
              className="icon-btn icon-btn-save"
              title="Save"
              aria-label="Save"
              disabled={busy}
              onClick={() => handle("saved")}
            >
              <CheckIcon />
              <span>Save</span>
            </button>
            <button
              type="button"
              className="icon-btn icon-btn-delete"
              title="Delete"
              aria-label="Delete"
              disabled={busy}
              onClick={() => handle("deleted")}
            >
              <DeleteIcon />
              <span>Delete</span>
            </button>
          </>
        )}
        {job.status === "saved" && (
          <>
            <button
              type="button"
              className="icon-btn icon-btn-unsave"
              title="Unsave"
              aria-label="Unsave"
              disabled={busy}
              onClick={() => handle("new")}
            >
              <CheckIcon />
              <span>Unsave</span>
            </button>
            <button
              type="button"
              className="icon-btn icon-btn-delete"
              title="Delete"
              aria-label="Delete"
              disabled={busy}
              onClick={() => handle("deleted")}
            >
              <DeleteIcon />
              <span>Delete</span>
            </button>
          </>
        )}
        {job.status === "deleted" && (
          <button
            type="button"
            className="icon-btn icon-btn-undelete"
            title="Undelete"
            aria-label="Undelete"
            disabled={busy}
            onClick={() => handle("new")}
          >
            <UndeleteIcon />
            <span>Undelete</span>
          </button>
        )}
        {error && (
          <span className="error-text job-card-footer-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </article>
  );
}
