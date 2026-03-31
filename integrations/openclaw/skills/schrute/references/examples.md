# Schrute Usage Examples

## Search for Skills

Search for bitcoin-related skills:

```bash
schrute skills search "bitcoin price" --json
```

Search filtered by a specific site:

```bash
schrute skills search "bitcoin" --site www.coingecko.com --json
```

Search with a result limit:

```bash
schrute skills search "ethereum" --limit 5 --json
```

## Execute a Skill

Execute a specific skill by ID:

```bash
schrute execute www_coingecko_com.get_24_hours_json.v1 --json
```

## Check Status

Check that the Schrute daemon is running and see loaded skills:

```bash
schrute status --json
```

## Full Workflow: Search, Execute, Handle Output

A typical workflow from an agent's perspective:

### Step 1: Search for a matching skill

```bash
$ schrute skills search "bitcoin price" --json
```

If results are returned, pick the best matching skill ID.

### Step 2: Execute the skill

```bash
$ schrute execute www_coingecko_com.get_24_hours_json.v1 --json
```

The response is an execution envelope with the API payload under `data` -- no browser needed.

### Step 3: If no skill is found

If `schrute skills search` returns no results, fall back to normal browser automation. This means no one has pre-learned skills for that site or action yet.

### Step 4: Check status (if something seems wrong)

```bash
$ schrute status --json
```

Verify the daemon is running and skills are loaded.
