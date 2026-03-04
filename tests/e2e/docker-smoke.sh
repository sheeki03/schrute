#!/usr/bin/env bash
set -euo pipefail

echo "=== Docker Smoke Test ==="

# Build
docker compose build

# Start
ONEAGENT_AUTH_TOKEN=test-token-123 docker compose up -d

# Wait for health
echo "Waiting for health check..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "Health check passed!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Health check failed after 30s"
    docker compose logs
    docker compose down
    exit 1
  fi
  sleep 1
done

# Verify auth required
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/status)
if [ "$HTTP_CODE" != "401" ]; then
  echo "Expected 401 without auth, got $HTTP_CODE"
  docker compose down
  exit 1
fi
echo "Auth check passed (401 without token)"

# Cleanup
docker compose down
echo "=== Docker Smoke Test PASSED ==="
