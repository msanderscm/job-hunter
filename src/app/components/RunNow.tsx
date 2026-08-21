import { useState } from "react";
import { runDigest, type RunSummary } from "../api";
import { useAuth } from "../auth";

/**
 * Manually triggers the same fetch the cron runs every morning, so the jobs
 * list can be refreshed on demand (handy for demos and after changing criteria).
 */
export function RunNow() {
  const auth = useAuth();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const summary = await auth.guard(() => runDigest());
      setResult(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="card">
      <h2>Fetch now</h2>
      <p className="section-note">
        Runs the same fetch the cron does, using the current criteria and enabled sources.
      </p>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={handleRun} disabled={running}>
          {running ? "Fetching…" : "Fetch now"}
        </button>
        {result && (
          <span className="save-success">
            Fetched {result.fetched}, matched {result.matched}, {result.inserted} new, scored{" "}
            {result.scored}
            {result.skipped.length > 0 && ` · skipped: ${result.skipped.join(", ")}`}
            {result.failed.length > 0 && ` · failed: ${result.failed.join(", ")}`}
            {" · "}
            <a href="#/">view jobs</a>
          </span>
        )}
        {error && <span className="error-text">{error}</span>}
      </div>
    </section>
  );
}
