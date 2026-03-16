#!/usr/bin/env bash
# Rebuild better-sqlite3 native module for the current Node version.
# Works around node-gyp failures when the project path contains spaces
# by creating a temporary symlink in /tmp.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODULE_DIR="$PROJECT_DIR/node_modules/better-sqlite3"

if [ ! -d "$MODULE_DIR" ]; then
  echo "better-sqlite3 not found — run npm install first" >&2
  exit 1
fi

# Check if the path contains spaces (node-gyp bug trigger)
if [[ "$PROJECT_DIR" == *" "* ]]; then
  LINK="/tmp/schrute-rebuild-$$"
  ln -sfn "$PROJECT_DIR" "$LINK"
  trap 'rm -f "$LINK"' EXIT

  echo "Path contains spaces — using symlink: $LINK"
  cd "$LINK/node_modules/better-sqlite3"
else
  cd "$MODULE_DIR"
fi

npx --yes node-gyp rebuild
echo "better-sqlite3 rebuilt for Node $(node -v)"
