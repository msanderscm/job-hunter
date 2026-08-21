import { useEffect, useMemo, useState } from "react";
import { ApiError, getJobs, setJobStatus } from "../api";
import type { Job, JobStatus } from "../api";
import { JobCard } from "../components/JobCard";
import { useAuth } from "../auth";

type LoadState = "loading" | "error" | "ready";
type Tab = "current" | "saved" | "deleted";

/** Splits the full job list into the tab it belongs on. */
export function jobsForTab(jobs: Job[], tab: Tab): Job[] {
  if (tab === "saved") return jobs.filter((job) => job.status === "saved");
  if (tab === "deleted") return jobs.filter((job) => job.status === "deleted");
  return jobs.filter((job) => job.status !== "deleted");
}

export function JobsView() {
  const auth = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [filterText, setFilterText] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [tab, setTab] = useState<Tab>("current");

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

  const currentTabJobs = useMemo(() => jobsForTab(jobs, tab), [jobs, tab]);

  const tabCounts = useMemo(
    () => ({
      current: jobsForTab(jobs, "current").length,
      saved: jobsForTab(jobs, "saved").length,
      deleted: jobsForTab(jobs, "deleted").length,
    }),
    [jobs]
  );

  const filteredJobs = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return currentTabJobs.filter((job) => {
      if (sourceFilter && job.source !== sourceFilter) return false;
      if (!needle) return true;
      return (
        job.title.toLowerCase().includes(needle) ||
        job.company.toLowerCase().includes(needle) ||
        (job.location ?? "").toLowerCase().includes(needle)
      );
    });
  }, [currentTabJobs, filterText, sourceFilter]);

  // Applied on success rather than optimistically: a status change can move the
  // tile to another tab (unmounting it), and the card needs to stay put to show
  // an error if the request fails or the token prompt is cancelled.
  async function handleStatusChange(job: Job, status: JobStatus): Promise<void> {
    const updated = await auth.guard(() => setJobStatus(job.id, status));
    setJobs((prev) => prev.map((j) => (j.id === job.id ? updated : j)));
  }

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

  const tabEmptyMessage =
    tab === "current"
      ? "Nothing here — everything has been saved or deleted."
      : tab === "saved"
        ? "No saved jobs yet. Use the ✓ on a tile to save one."
        : "Nothing deleted.";

  return (
    <div className="view">
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "current"}
          className={"tab" + (tab === "current" ? " active" : "")}
          onClick={() => setTab("current")}
        >
          Current
          <span className="tab-count">{tabCounts.current}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "saved"}
          className={"tab" + (tab === "saved" ? " active" : "")}
          onClick={() => setTab("saved")}
        >
          Saved
          <span className="tab-count">{tabCounts.saved}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "deleted"}
          className={"tab" + (tab === "deleted" ? " active" : "")}
          onClick={() => setTab("deleted")}
        >
          Deleted
          <span className="tab-count">{tabCounts.deleted}</span>
        </button>
      </div>
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
          {filteredJobs.length} of {currentTabJobs.length} jobs
        </span>
      </div>
      {currentTabJobs.length === 0 ? (
        <div className="empty-state">
          <p>{tabEmptyMessage}</p>
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="empty-state">
          <p>No jobs match your filters.</p>
        </div>
      ) : (
        <div className="job-grid">
          {filteredJobs.map((job) => (
            <JobCard job={job} key={job.id} onStatusChange={handleStatusChange} />
          ))}
        </div>
      )}
    </div>
  );
}
