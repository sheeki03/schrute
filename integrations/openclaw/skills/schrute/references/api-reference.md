# Schrute CLI Reference

## schrute skills search

Search the skill library for skills matching a query.

```bash
schrute skills search <query> [--limit N] [--site <siteId>] --json
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<query>` | No | Natural language search query (e.g., "bitcoin price"). If omitted, lists all active skills. |

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--limit N` | 20 | Maximum number of results to return |
| `--site <siteId>` | - | Filter results to a specific site (e.g., `www.coingecko.com`) |
| `--json` | - | Output results as JSON |

### Output (JSON)

Returns an object with `results` (array of skill summaries) and optional `inactiveMatches`:

```json
{
  "results": [
    {
      "id": "www_coingecko_com.get_24_hours_json.v1",
      "name": "get_24_hours_json",
      "method": "GET",
      "pathTemplate": "/api/v3/coins/markets",
      "successRate": 0.98
    }
  ],
  "inactiveMatches": []
}
```

---

## schrute execute

Execute a pre-learned skill by its ID. Supports `key=value` params after the skill ID.

```bash
schrute execute <skillId> [key=value ...] [--json]
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<skillId>` | Yes | The skill ID to execute (e.g., `www_coingecko_com.get_24_hours_json.v1`) |
| `key=value` | No | Parameter overrides (e.g., `vs_currency=eur per_page=10`) |

### Flags

| Flag | Description |
|------|-------------|
| `--json` | Output results as JSON |

### Output (JSON)

Returns a `SkillExecutionResult` with `success`, `data`, `latencyMs`, and on failure `error`/`failureCause`/`failureDetail`:

```json
{
  "success": true,
  "data": { ... },
  "latencyMs": 5
}
```

---

## schrute status

Check the status of the Schrute daemon and loaded skills.

```bash
schrute status --json
```

### Flags

| Flag | Description |
|------|-------------|
| `--json` | Output results as JSON |

### Output (JSON)

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
