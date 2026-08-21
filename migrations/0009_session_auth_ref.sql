-- Ties a bootstrap-admin session to the ADMIN_TOKEN it was opened with.
--
-- The 'admin' row in users (see 0008) has no password_hash: its password is
-- the ADMIN_TOKEN Wrangler secret. Rotating that secret must also end any
-- session that was opened with the old value, otherwise a leaked token keeps
-- working for up to 30 days after rotation. auth_ref holds the SHA-256
-- (base64url) of the token the session was minted with, and authenticate()
-- (src/worker/auth.ts) rejects the session once it no longer matches the
-- current secret. NULL for sessions of users with a real password hash.

ALTER TABLE sessions ADD COLUMN auth_ref TEXT;
