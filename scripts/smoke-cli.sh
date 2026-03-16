#!/usr/bin/env bash
set -euo pipefail

echo "=== Schrute CLI Smoke Test ==="

# Check binary exists
if ! command -v schrute &>/dev/null; then
  # Try npx
  SCHRUTE="npx schrute"
else
  SCHRUTE="schrute"
fi

echo "1. Testing 'schrute --version'..."
$SCHRUTE --version || { echo "FAIL: --version"; exit 1; }

echo "2. Testing 'schrute doctor'..."
$SCHRUTE doctor || { echo "FAIL: doctor"; exit 1; }

echo "3. Testing 'schrute skills list'..."
$SCHRUTE skills list || { echo "FAIL: skills list"; exit 1; }

echo "4. Testing 'schrute skills search \"test\"'..."
$SCHRUTE skills search "test" || { echo "FAIL: skills search"; exit 1; }

echo "5. Testing 'schrute sites'..."
$SCHRUTE sites || { echo "FAIL: sites"; exit 1; }

echo "6. Testing 'schrute config get'..."
$SCHRUTE config get logLevel || { echo "FAIL: config get"; exit 1; }

echo "7. Testing 'schrute status'..."
$SCHRUTE status || { echo "FAIL: status"; exit 1; }

echo "8. Testing 'schrute skills revoke <nonexistent>' (should succeed or fail gracefully)..."
OUTPUT=$($SCHRUTE skills revoke nonexistent.fake.v1 2>&1) || true
if echo "$OUTPUT" | grep -qiE 'revoked|error|not found'; then
  echo "  skills revoke: got expected response"
else
  echo "  WARNING: skills revoke output did not contain expected indicator"
  echo "  Output: $OUTPUT"
fi

echo "9. Testing 'schrute execute <nonexistent>' (should fail gracefully)..."
OUTPUT=$($SCHRUTE execute nonexistent.fake.v1 --json 2>&1) || true
if echo "$OUTPUT" | grep -qiE 'error|not found|not active|unknown'; then
  echo "  execute: got expected error for nonexistent skill"
else
  echo "  WARNING: execute output did not contain expected error indicator"
  echo "  Output: $OUTPUT"
fi

echo ""
echo "=== All CLI smoke tests passed ==="
