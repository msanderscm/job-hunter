-- Real login: named users with passwords, plus server-side sessions.
--
-- Users. `username` is always stored lowercase (the API normalizes with
-- normalizeUsername() before reading or writing, see src/worker/password.ts),
-- so the UNIQUE constraint is case-insensitive in practice. `first_name` is
-- only used to greet the user in the UI.
--
-- `password_hash` NULL means "authenticate this user against the ADMIN_TOKEN
-- Wrangler secret" — the bootstrap admin. The secret is never copied into the
-- DB, so rotating the secret rotates the admin password, and a DB dump never
-- reveals it. Every other user gets a real hash in the format
--   pbkdf2-sha256$<iterations>$<salt>$<hash>
-- (salt and hash base64url, no padding; see src/worker/password.ts). The
-- iteration count lives in the string, so it can be tuned later without
-- invalidating existing hashes.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  password_hash TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO users (username, first_name, password_hash) VALUES ('admin', 'Admin', NULL);

-- Sessions. `id` is the SHA-256 (base64url) of the cookie value, never the
-- cookie value itself: a stolen DB gives no usable cookies. `expires_at` is
-- SQLite datetime text ('YYYY-MM-DD HH:MM:SS', UTC) so it compares directly
-- with datetime('now'); expired rows are swept on login.

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
