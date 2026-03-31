# Schrute Tool Reference

Detailed input/output examples for the three primary Schrute MCP tools.

## mcp_schrute_search_skills

Find pre-learned skills by keyword or site ID.

### Input

```json
{ "query": "bitcoin price" }
```

```json
{ "query": "coingecko", "siteId": "www.coingecko.com" }
```

### Output

Returns an object with `results` (array of `SkillSearchResult`), optional `matchType`, and optional `inactiveMatches`:

```json
{
  "results": [
    {
      "id": "www_coingecko_com.get_24_hours_json.v1",
      "name": "get_24_hours_json",
      "siteId": "www.coingecko.com",
      "method": "GET",
      "pathTemplate": "/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc",
      "description": "Fetch top coins by market cap from CoinGecko",
      "inputSchema": { "type": "object", "properties": { "vs_currency": { "type": "string" } } },
      "status": "active",
      "successRate": 0.98,
      "currentTier": "tier_1",
      "executable": true,
      "avgLatencyMs": 5,
      "provenance": "learned"
    }
  ],
  "matchType": "fts",
  "inactiveMatches": []
}
```

When no skills match, `results` is an empty array. Fall back to browser automation.

---

## mcp_schrute_execute

Run a pre-learned skill by its ID. Optionally pass params to override defaults.

### Input (no params)

```json
{ "skillId": "www_coingecko_com.get_24_hours_json.v1" }
```

### Input (with params)

```json
{
  "skillId": "www_coingecko_com.get_24_hours_json.v1",
  "params": {
    "vs_currency": "eur",
    "per_page": 10
  }
}
```

### Output

Returns a `SkillExecutionResult`:

```json
{
  "success": true,
  "data": [
    {
      "id": "bitcoin",
      "symbol": "btc",
      "name": "Bitcoin",
      "current_price": 67234.00,
      "market_cap": 1324567890123,
      "price_change_percentage_24h": 2.34
    }
  ],
  "latencyMs": 5
}
```

On failure:

```json
{
  "success": false,
  "error": "HTTP 403 Forbidden",
  "failureCause": "auth_expired",
  "failureDetail": "Site returned 403 — API key may have expired",
  "latencyMs": 120
}
```

If execution fails, fall back to browser automation.

---

## mcp_schrute_status

Check whether Schrute is running, the engine mode, and a summary of available skills.

### Input

No parameters required.

```json
{}
```

### Output

Returns `EngineStatus`. The `mode` field is one of `idle`, `exploring`, `recording`, or `replaying`:

```json
{
  "mode": "idle",
  "activeSession": null,
  "currentRecording": null,
  "uptime": 3600,
  "skillSummary": {
    "total": 12,
    "executable": 10,
    "blocked": 2
  }
}
```
