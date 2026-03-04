#!/usr/bin/env bash
set -euo pipefail

mkdir -p build/bin/addons
cp node_modules/better-sqlite3/build/Release/better_sqlite3.node build/bin/addons/
# Native module (napi-rs output is native/index.node, if present)
if [ -f native/index.node ]; then
  cp native/index.node build/bin/addons/oneagent_native.node
fi
echo "Addons packaged into build/bin/addons/"
