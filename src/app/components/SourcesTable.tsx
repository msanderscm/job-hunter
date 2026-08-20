import { useEffect, useState } from "react";
import { ApiError, getSources, putSource } from "../api";
import type { Source } from "../api";
import type { UseAdminToken } from "../hooks/useAdminToken";

type LoadState = "loading" | "error" | "ready";

interface SourcesTableProps {
  adminToken: UseAdminToken;
}

interface RowState {
  configDraft: string;
  configError: string | null;
  savingConfig: boolean;
  configSaveMessage: string | null;
  togglingEnabled: boolean;
}

function buildRowState(source: Source): RowState {
  return {
    configDraft: JSON.stringify(source.config, null, 2),
    configError: null,
    savingConfig: false,
    configSaveMessage: null,
    togglingEnabled: false,
  };
}

export function SourcesTable({ adminToken }: SourcesTableProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  useEffect(() => {
    getSources()
      .then((data) => {
        setSources(data.sources);
        const next: Record<string, RowState> = {};
        for (const source of data.sources) next[source.id] = buildRowState(source);
        setRowStates(next);
        setState("ready");
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : "Failed to load sources.");
        setState("error");
      });
  }, []);

  function updateRow(id: string, patch: Partial<RowState>) {
    setRowStates((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function handleToggle(source: Source) {
    const previous = sources;
    setSources((prev) =>
      prev.map((s) => (s.id === source.id ? { ...s, enabled: !s.enabled } : s))
    );
    updateRow(source.id, { togglingEnabled: true });
    try {
      const updated = await adminToken.withAuth((token) =>
        putSource(source.id, { enabled: !source.enabled }, token)
      );
      setSources((prev) => prev.map((s) => (s.id === source.id ? updated : s)));
    } catch (err) {
      setSources(previous);
      updateRow(source.id, {
        configSaveMessage:
          err instanceof ApiError ? err.message : "Failed to update source.",
      });
    } finally {
      updateRow(source.id, { togglingEnabled: false });
    }
  }

  async function handleSaveConfig(source: Source) {
    const row = rowStates[source.id];
    if (!row) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.configDraft);
    } catch (err) {
      updateRow(source.id, {
        configError: err instanceof Error ? err.message : "Invalid JSON.",
      });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      updateRow(source.id, { configError: "Config must be a JSON object." });
      return;
    }
    updateRow(source.id, { configError: null, savingConfig: true, configSaveMessage: null });
    try {
      const updated = await adminToken.withAuth((token) =>
        putSource(source.id, { config: parsed as Record<string, unknown> }, token)
      );
      setSources((prev) => prev.map((s) => (s.id === source.id ? updated : s)));
      updateRow(source.id, {
        configDraft: JSON.stringify(updated.config, null, 2),
        configSaveMessage: "Saved ✓",
      });
    } catch (err) {
      updateRow(source.id, {
        configSaveMessage: err instanceof ApiError ? err.message : "Failed to save config.",
      });
    } finally {
      updateRow(source.id, { savingConfig: false });
    }
  }

  if (state === "loading") {
    return (
      <section className="card">
        <h2>Sources</h2>
        <p>Loading…</p>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section className="card">
        <h2>Sources</h2>
        <p className="error-text">{loadError}</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Sources</h2>
      <p className="section-note">
        Sources map to code modules; add new ones via a migration + fetcher module.
      </p>
      <div className="sources-table">
        {sources.map((source) => {
          const row = rowStates[source.id];
          if (!row) return null;
          return (
            <div className="source-row" key={source.id}>
              <div className="source-cell source-cell-name" data-label="Source">
                <div className="source-display-name">{source.display_name}</div>
                <div className="source-id">{source.id}</div>
              </div>
              <div className="source-cell" data-label="Enabled">
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={source.enabled}
                    disabled={row.togglingEnabled}
                    onChange={() => handleToggle(source)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div className="source-cell source-cell-config" data-label="Config">
                <textarea
                  className="config-textarea"
                  value={row.configDraft}
                  onChange={(e) =>
                    updateRow(source.id, { configDraft: e.target.value, configError: null })
                  }
                  spellCheck={false}
                  rows={4}
                />
                {row.configError && <p className="error-text">{row.configError}</p>}
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleSaveConfig(source)}
                    disabled={row.savingConfig}
                  >
                    {row.savingConfig ? "Saving…" : "Save config"}
                  </button>
                  {row.configSaveMessage && (
                    <span
                      className={
                        row.configSaveMessage === "Saved ✓" ? "save-success" : "error-text"
                      }
                    >
                      {row.configSaveMessage}
                    </span>
                  )}
                </div>
              </div>
              <div className="source-cell" data-label="Status">
                {source.secrets_present ? (
                  <span className="badge badge-ready">Ready</span>
                ) : (
                  <div>
                    <span className="badge badge-warning">Missing secrets</span>
                    <p className="secrets-hint">
                      This source needs {source.requires_secrets.join(", ")} — set with{" "}
                      <code>wrangler secret put &lt;NAME&gt;</code>
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
