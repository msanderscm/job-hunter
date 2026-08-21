import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "../api";
import { useAuth } from "../auth";
import { navigate, readHashQuery } from "../hooks/useHashRoute";

/** Only ever redirect within the app — an untrusted `next` value falls back to home. */
function resolveNext(): string {
  const next = readHashQuery().get("next");
  // "//host" is protocol-relative, so it's excluded even though it starts with "/".
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function LoginView() {
  const auth = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status === "in") {
      navigate(resolveNext());
    }
  }, [auth.status]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await auth.login(username, password);
      navigate(resolveNext());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to log in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="view">
      <section className="card login-card">
        <h1>Log in</h1>
        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="login-username">Username</label>
            <input
              id="login-username"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Logging in…" : "Log in"}
            </button>
            {error && <span className="error-text">{error}</span>}
          </div>
        </form>
        <p className="field-helper">
          First time? Log in as <code>admin</code> with the ADMIN_TOKEN secret, then create your
          own user on the Users page.
        </p>
      </section>
    </div>
  );
}
