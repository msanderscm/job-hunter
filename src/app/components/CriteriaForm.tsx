import { useEffect, useState } from "react";
import { ApiError, getCriteria, putCriteria } from "../api";
import type { Criteria } from "../api";
import type { UseAdminToken } from "../hooks/useAdminToken";
import { TagInput } from "./TagInput";

type LoadState = "loading" | "error" | "ready";

interface CriteriaFormProps {
  adminToken: UseAdminToken;
}

const EMPTY_CRITERIA: Criteria = {
  required_keywords: [],
  excluded_keywords: [],
  locations: [],
  remote_ok: true,
  max_age_days: 7,
};

export function CriteriaForm({ adminToken }: CriteriaFormProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [criteria, setCriteria] = useState<Criteria>(EMPTY_CRITERIA);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ kind: "success" | "error"; text: string } | null>(
    null
  );

  useEffect(() => {
    getCriteria()
      .then((data) => {
        setCriteria(data);
        setState("ready");
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : "Failed to load criteria.");
        setState("error");
      });
  }, []);

  useEffect(() => {
    if (!saveMessage || saveMessage.kind !== "success") return;
    const timer = setTimeout(() => setSaveMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [saveMessage]);

  async function handleSave() {
    setSaving(true);
    setSaveMessage(null);
    try {
      const { updated_at, ...payload } = criteria;
      void updated_at;
      const updated = await adminToken.withAuth((token) => putCriteria(payload, token));
      setCriteria(updated);
      setSaveMessage({ kind: "success", text: "Saved ✓" });
    } catch (err) {
      setSaveMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "Failed to save criteria.",
      });
    } finally {
      setSaving(false);
    }
  }

  if (state === "loading") {
    return (
      <section className="card">
        <h2>Criteria</h2>
        <p>Loading…</p>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section className="card">
        <h2>Criteria</h2>
        <p className="error-text">{loadError}</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Criteria</h2>
      <TagInput
        label="Required keywords"
        values={criteria.required_keywords}
        onChange={(values) => setCriteria((c) => ({ ...c, required_keywords: values }))}
        helperText="Job must match at least one of these"
      />
      <TagInput
        label="Excluded keywords"
        values={criteria.excluded_keywords}
        onChange={(values) => setCriteria((c) => ({ ...c, excluded_keywords: values }))}
        helperText="Job is dropped if it matches any of these"
      />
      <TagInput
        label="Locations"
        values={criteria.locations}
        onChange={(values) => setCriteria((c) => ({ ...c, locations: values }))}
      />
      <div className="field-row">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={criteria.remote_ok}
            onChange={(e) => setCriteria((c) => ({ ...c, remote_ok: e.target.checked }))}
          />
          Remote jobs OK
        </label>
      </div>
      <div className="field-row">
        <label htmlFor="max-age-days">Max age (days)</label>
        <input
          id="max-age-days"
          type="number"
          min={1}
          max={30}
          value={criteria.max_age_days}
          onChange={(e) =>
            setCriteria((c) => ({ ...c, max_age_days: Number(e.target.value) }))
          }
        />
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saveMessage && (
          <span className={saveMessage.kind === "success" ? "save-success" : "error-text"}>
            {saveMessage.text}
          </span>
        )}
      </div>
    </section>
  );
}
