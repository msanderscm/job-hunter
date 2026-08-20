-- Default RemoteOK to dev jobs in the United States (HTML filter endpoint; see
-- src/worker/sources/remoteok.ts). Only touches rows still holding the original seed config.
UPDATE sources
SET config = '{"tags":["dev"],"location":"US","max_pages":2}', updated_at = datetime('now')
WHERE id = 'remoteok' AND config = '{"tags":[]}';
