-- Tavily's include_domains filter matches registrable root domains, not
-- specific subdomains: the 0010 default (boards.greenhouse.io, ...) filtered
-- out every result. Replace only that key, preserving other config edits.
UPDATE sources
SET config = json_set(config, '$.include_domains',
      json('["greenhouse.io","lever.co","ashbyhq.com","workable.com"]')),
    updated_at = datetime('now')
WHERE id = 'tavily';
