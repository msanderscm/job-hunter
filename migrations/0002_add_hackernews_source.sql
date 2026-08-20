-- Hacker News "Ask HN: Who is hiring?" monthly thread, screened with Workers AI.
-- No secrets: uses the Worker's AI binding. Config keys are all optional.
INSERT OR IGNORE INTO sources (id, display_name, enabled, config, requires_secrets)
VALUES ('hackernews', 'Hacker News — Who is hiring?', 1,
        '{"model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast","batch_size":20,"max_posts":60,"max_chars":2500}',
        '[]');
