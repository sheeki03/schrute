-- WebMCP declarative tool metadata (Chrome 146)
ALTER TABLE webmcp_tools ADD COLUMN declarative INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webmcp_tools ADD COLUMN auto_submit INTEGER NOT NULL DEFAULT 0;
