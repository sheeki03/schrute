#!/usr/bin/env bash
# Usage: ./scripts/release.sh [patch|minor|major]
# Bumps version, commits, tags, and pushes — GitHub Actions handles npm publish + GitHub Release.

set -euo pipefail

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

# Ensure clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Ensure on main
BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main branch (currently on '$BRANCH')"
  exit 1
fi

# Bump version in package.json (no git tag — we do it manually)
NEW_VERSION="$(node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
const [major,minor,patch] = pkg.version.split('.').map(Number);
const bump = '$BUMP';
if (bump === 'major') console.log((major+1)+'.0.0');
else if (bump === 'minor') console.log(major+'.'+(minor+1)+'.0');
else console.log(major+'.'+minor+'.'+(patch+1));
")"

echo "Bumping to v${NEW_VERSION}..."

# Update package.json version
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.version = '${NEW_VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Sync version to src/version.ts and plugin.json
node scripts/sync-version.js

# Build to verify
npm run build

# Type check
npx tsc --noEmit

# Commit, tag, push
git add package.json src/version.ts .claude-plugin/plugin.json
git commit -m "release: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin main "v${NEW_VERSION}"

echo ""
echo "Released v${NEW_VERSION}"
echo "GitHub Actions will now:"
echo "  1. Publish to npm"
echo "  2. Build standalone binaries (Linux + macOS)"
echo "  3. Create GitHub Release with binaries"
echo "  4. Publish Python SDK to PyPI"
echo "  5. Update Homebrew formula"
echo ""
echo "Track progress: https://github.com/sheeki03/schrute/actions"
