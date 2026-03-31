#!/bin/bash
SKILL_ID="$1"
shift
schrute execute "$SKILL_ID" "$@" --json
