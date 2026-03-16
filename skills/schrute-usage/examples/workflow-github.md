# Example: Recording GitHub API Skills

## Scenario
Record skills for searching repositories and viewing user profiles on GitHub.

## Step 1: Start Exploring
```
/schrute:explore https://github.com
```
This opens a browser session on GitHub and begins network monitoring.

## Step 2: Record Search Repos
```
/schrute:record search-repos --input query=typescript
```

Now perform the action in the browser:
1. Click the search bar
2. Type "typescript"
3. Press Enter
4. Wait for results to load

All API calls (e.g., `GET /search/repositories?q=typescript`) are captured.

## Step 3: Stop and Generate
Say "stop" or run `/schrute:record` again.

The capture pipeline processes the HAR:
- Filters out noise (analytics, tracking, static assets)
- Detects auth patterns (cookies, tokens)
- Discovers parameters (`q` as a required input)
- Generates a `search-repos` skill

## Step 4: Use the Skill
The generated skill appears as an MCP tool. Call it with parameters:
```
search-repos(query="rust")
```

It starts at Tier 3 (browser proxied) and promotes to Tier 1 after 5 successful runs.

## Step 5: Record Another Skill
Without closing the browser:
```
/schrute:record get-user --input username=octocat
```
Navigate to github.com/octocat, stop recording. Now you have two skills.

## Expected Output
```
Skills generated:
- search-repos (GET /search/repositories) — read-only
- get-user (GET /users/{username}) — read-only
```
