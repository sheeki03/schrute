#!/bin/bash
schrute skills search "$1" --limit "${2:-10}" --json
