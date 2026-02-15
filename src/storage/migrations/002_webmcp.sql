-- OneAgent v0.2 WebMCP tool cache
-- Stores discovered WebMCP tools per site for cold-start discovery

CREATE TABLE IF NOT EXISTS webmcp_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  description TEXT,
  input_schema TEXT,
  discovered_at INTEGER NOT NULL,
  last_verified INTEGER,
  UNIQUE(site_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_webmcp_tools_site ON webmcp_tools(site_id);
