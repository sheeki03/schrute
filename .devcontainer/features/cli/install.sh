#!/usr/bin/env bash
set -euo pipefail

VERSION="${VERSION:-latest}"
INSTALLBROWSER="${INSTALLBROWSER:-true}"
BROWSERENGINE="${BROWSERENGINE:-playwright}"

echo "Installing Schrute CLI ${VERSION}..."

# Ensure Node.js >= 22 is available
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Add the node feature before schrute:"
  echo '  "ghcr.io/devcontainers/features/node:1": { "version": "22" }'
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node.js >= 22 required (found ${NODE_MAJOR}). Update the node feature version."
  exit 1
fi

# Install Schrute
if [ "$VERSION" = "latest" ]; then
  npm install -g schrute
else
  npm install -g "schrute@${VERSION}"
fi

# Install browser engine
if [ "$INSTALLBROWSER" = "true" ]; then
  echo "Installing ${BROWSERENGINE} browser..."

  # Install Playwright system dependencies (Debian/Ubuntu)
  if command -v apt-get &>/dev/null; then
    apt-get update -y
    apt-get install -y --no-install-recommends \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
      libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0
    rm -rf /var/lib/apt/lists/*
  fi

  case "$BROWSERENGINE" in
    playwright)
      npx playwright install chromium
      ;;
    patchright)
      npm install -g patchright
      npx patchright install chromium
      ;;
    camoufox)
      npm install -g camoufox-js
      npx camoufox-js fetch
      ;;
  esac
fi

# Verify installation
schrute --version
echo "Schrute installed successfully."
