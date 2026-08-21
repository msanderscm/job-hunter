import { useEffect, useRef, useState } from "react";
import { ApiError, getResume, putResume, rescore, scoreNext, type ResumeInfo } from "../api";
import type { UseAdminToken } from "../hooks/useAdminToken";
import { timeAgo } from "../utils/time";

type LoadState = "loading" | "error" | "ready";

interface ResumeCardProps {
  adminToken: UseAdminToken;
}

/** Jobs rated per `/api/score` call — matches the server's batch size, so one step is one AI call. */
const RESCORE_BATCH = 8;

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function ResumeCard({ adminToken }: ResumeCardProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [resume, setResume] = useState<ResumeInfo | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<{ kind: "success" | "error"; text: string } | null>(
    null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [rescoring, setRescoring] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [rescoreResult, setRescoreResult] = useState<{ done: number; total: number } | null>(null);
  const [rescoreError, setRescoreError] = useState<string | null>(null);

  useEffect(() => {
    getResume()
      .then((data) => {
        setResume(data.resume);
        setState("ready");
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : "Failed to load resume.");
        setState("error");
      });
  }, []);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setUploadMessage(null);
    setSelectedFile(file);
  }

  async function handleUpload() {
    if (!selectedFile) return;
    if (!isPdf(selectedFile)) {
      setUploadMessage({ kind: "error", text: "Please choose a PDF file." });
      return;
    }
    setUploading(true);
    setUploadMessage(null);
    try {
      const { resume: updated } = await adminToken.withAuth((token) =>
        putResume(selectedFile, token)
      );
      setResume(updated);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setUploadMessage({
        kind: "success",
        text: 'Resume saved. Use “Re-evaluate all matches” to re-rate existing jobs.',
      });
    } catch (err) {
      setUploadMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "Failed to upload resume.",
      });
    } finally {
      setUploading(false);
    }
  }

  async function handleRescore() {
    setRescoring(true);
    setRescoreError(null);
    setRescoreResult(null);
    // The whole loop runs inside a single withAuth call: withAuth's `token` argument
    // is fresh, but the `token` React state it closes over can be stale (or still
    // null) between renders, so calling withAuth once per step would re-prompt for
    // the admin token on every batch.
    try {
      const { total, done, remaining } = await adminToken.withAuth(async (token) => {
        const { pending: total } = await rescore(token);
        let done = 0;
        let remaining = total;
        let stalls = 0;
        setProgress(total > 0 ? { current: 1, total } : null);
        while (remaining > 0) {
          const r = await scoreNext(token, RESCORE_BATCH);
          done += r.scored;
          remaining = r.pending;
          if (r.scored === 0) {
            // A batch the AI failed on stays pending forever; without this the
            // loop would spin indefinitely instead of surfacing the failure.
            stalls += 1;
            if (stalls >= 2) break;
          } else {
            stalls = 0;
          }
          setProgress({ current: Math.min(done + 1, total), total });
        }
        return { total, done, remaining };
      });

      if (remaining > 0) {
        setRescoreError(
          `Rated ${done} of ${total} — ${remaining} could not be rated (AI error); press again to retry the rest.`
        );
      } else {
        setRescoreResult({ done, total });
      }
    } catch (err) {
      // Keep whatever progress was already shown; just report the failure.
      setRescoreError(err instanceof ApiError ? err.message : "Failed to re-evaluate matches.");
    } finally {
      setRescoring(false);
    }
  }

  return (
    <section className="card">
      <h2>Resume &amp; match scoring</h2>
      <p className="section-note">
        Each imported job is compared to your resume by Workers AI and rated 1–5. The colored bar
        along the bottom of each job tile shows the rating (5 = strongest match).
      </p>

      {state === "loading" && <p>Loading…</p>}
      {state === "error" && <p className="error-text">{loadError}</p>}
      {state === "ready" && (
        <p className="resume-current">
          {resume ? (
            <>
              Current resume: <strong>{resume.filename}</strong> · uploaded{" "}
              {timeAgo(resume.uploaded_at)} · {resume.chars.toLocaleString()} characters
            </>
          ) : (
            "No resume uploaded yet — jobs aren't being rated."
          )}
        </p>
      )}

      <div className="field-row">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          onChange={handleFileChange}
        />
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleUpload}
          disabled={!selectedFile || uploading || rescoring}
        >
          {uploading ? "Uploading…" : "Upload resume"}
        </button>
        {uploadMessage && (
          <span className={uploadMessage.kind === "success" ? "save-success" : "error-text"}>
            {uploadMessage.text}
          </span>
        )}
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleRescore}
          disabled={!resume || rescoring}
        >
          {rescoring
            ? progress
              ? `Reevaluating ${progress.current} of ${progress.total}`
              : "Reevaluating…"
            : "Re-evaluate all matches"}
        </button>
        {rescoreResult && (
          <span className="save-success">
            Rated {rescoreResult.done} of {rescoreResult.total} · <a href="#/">view jobs</a>
          </span>
        )}
        {rescoreError && <span className="error-text">{rescoreError}</span>}
      </div>
      <p className="field-helper">
        Clears every rating from the last 7 days, then rates the jobs again against the current
        resume in batches of 8, showing progress as it goes.
      </p>
    </section>
  );
}
