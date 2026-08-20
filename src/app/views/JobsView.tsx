import { useEffect, useMemo, useState } from "react";
import { ApiError, getJobs } from "../api";
import type { Job } from "../api";
import { JobCard } from "../components/JobCard";

type LoadState = "loading" | "error" | "ready";

export function JobsView() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [filterText, setFilterText] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");

  function load() {
    setState("loading");
    getJobs()
      .then((data) => {
        setJobs(data.jobs);
        setState("ready");
      })
      .catch((err) => {
        setErrorMessage(err instanceof ApiError ? err.message : "Failed to load jobs.");
        setState("error");
      });
  }

  useEffect(() => {
    load();
  }, []);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const job of jobs) set.add(job.source);
    return Array.from(set).sort();
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return jobs.filter((job) => {
      if (sourceFilter && job.source !== sourceFilter) return false;
      if (!needle) return true;
      return (
        job.title.toLowerCase().includes(needle) ||
        job.company.toLowerCase().includes(needle) ||
        (job.location ?? "").toLowerCase().includes(needle)
      );
    });
  }, [jobs, filterText, sourceFilter]);

  if (state === "loading") {
    return (
      <div className="view">
        <div className="skeleton-list" aria-busy="true" aria-live="polite">
          <p>Loading…</p>
          {[0, 1, 2].map((i) => (
            <div className="skeleton-card" key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="view">
        <div className="empty-state error-state">
          <p>Couldn't load jobs: {errorMessage}</p>
          <button type="button" className="btn btn-secondary" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="view">
        <div className="empty-state">
          <p>No new jobs yet — the fetch runs every morning.</p>
          <p className="empty-state-hint">
            Trigger it locally with <code>npm run cron:local</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="controls-row">
        <input
          type="search"
          className="filter-input"
          placeholder="Filter by title, company, or location…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          aria-label="Filter jobs"
        />
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          aria-label="Filter by source"
        >
          <option value="">All sources</option>
          {sources.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
        <span className="job-count">
          {filteredJobs.length} of {jobs.length} jobs
        </span>
      </div>
      {filteredJobs.length === 0 ? (
        <div className="empty-state">
          <p>No jobs match your filters.</p>
        </div>
      ) : (
        <div className="job-grid">
          {filteredJobs.map((job) => (
            <JobCard job={job} key={job.id} />
          ))}
        </div>
      )}
    </div>
  );
}
