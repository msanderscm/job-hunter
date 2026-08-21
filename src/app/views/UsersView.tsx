import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, createUser, getUsers } from "../api";
import type { User } from "../api";
import { useAuth } from "../auth";
import { formatDate } from "../utils/time";

type LoadState = "loading" | "error" | "ready";

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/i;

function validateUsername(value: string): string | null {
  return USERNAME_RE.test(value)
    ? null
    : "username: must be 3-32 characters of a-z, 0-9, ., _, -";
}

function validatePassword(value: string): string | null {
  return value.length >= 10 && value.length <= 128
    ? null
    : "password: must be 10-128 characters";
}

function validateFirstName(value: string): string | null {
  return value.length >= 1 && value.length <= 60 ? null : "first_name: must be 1-60 characters";
}

export function UsersView() {
  const auth = useAuth();
  const [state, setState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [users, setUsers] = useState<User[]>([]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function load() {
    setState("loading");
    getUsers()
      .then((data) => {
        setUsers(data.users);
        setState("ready");
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : "Failed to load users.");
        setState("error");
      });
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSuccessMessage(null);
    const clientError =
      validateUsername(username) ?? validatePassword(password) ?? validateFirstName(firstName);
    if (clientError) {
      setFieldError(clientError);
      return;
    }
    setFieldError(null);
    setSaving(true);
    try {
      const { user } = await auth.guard(() =>
        createUser({ username, password, first_name: firstName })
      );
      setSuccessMessage(`Created ${user.username}`);
      setUsername("");
      setPassword("");
      setFirstName("");
      load();
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Failed to create user.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="view">
      <h1>Users</h1>
      <section className="card">
        <h2>Create user</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="new-username">Username</label>
            <input
              id="new-username"
              type="text"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="new-password">Password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="new-first-name">First name</label>
            <input
              id="new-first-name"
              type="text"
              autoComplete="off"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : "Create user"}
            </button>
            {fieldError && <span className="error-text">{fieldError}</span>}
            {successMessage && <span className="save-success">{successMessage}</span>}
          </div>
        </form>
      </section>
      <section className="card">
        <h2>Existing users</h2>
        {state === "loading" && <p>Loading…</p>}
        {state === "error" && <p className="error-text">{loadError}</p>}
        {state === "ready" && (
          <ul className="users-list">
            {users.map((u) => (
              <li key={u.id}>
                <span>
                  {u.username} — {u.first_name}
                </span>
                {u.created_at && <span className="muted">{formatDate(u.created_at)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
