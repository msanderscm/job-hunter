-- Tavily web-search job source (https://docs.tavily.com). Requires the
-- TAVILY_API_KEY secret; skipped by the cron until it is set.
INSERT OR IGNORE INTO sources (id, display_name, enabled, config, requires_secrets)
VALUES ('tavily', 'Tavily', 1,
        '{"query":"job opening hiring","max_results":20,"search_depth":"basic","include_domains":["boards.greenhouse.io","job-boards.greenhouse.io","jobs.lever.co","jobs.ashbyhq.com","apply.workable.com"],"exclude_domains":[],"min_score":0}',
        '["TAVILY_API_KEY"]');
