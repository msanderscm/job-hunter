import type { Job } from "../api";
import { formatDate, timeAgo } from "../utils/time";

interface JobCardProps {
  job: Job;
}

export function JobCard({ job }: JobCardProps) {
  const companyUrl =
    job.company_url ||
    `https://www.google.com/search?q=${encodeURIComponent(job.company)}`;
  const isFallbackCompanyLink = !job.company_url;

  return (
    <article className="job-card">
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
      </div>
      <p className="job-card-timing">
        first seen {timeAgo(job.first_seen_at)}
        {job.posted_at && <> · posted {formatDate(job.posted_at)}</>}
      </p>
    </article>
  );
}
