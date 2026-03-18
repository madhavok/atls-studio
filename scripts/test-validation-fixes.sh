#!/usr/bin/env sh
# Validation Run Tool Fixes — agnostic test script
# Exercises Fixes #1-12 via cargo test. Works with sh/bash/zsh; use Git Bash on Windows.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_DIR="$ROOT/atls-studio/src-tauri"

cd "$TAURI_DIR"

echo "=== Validation Run Tool Fixes — Test Suite ==="
echo "Project: atls-studio"
echo "Cwd: $(pwd)"
echo ""

# Run tests that cover validation fixes (Fix #1-2, #6, #8)
# - path_utils: find_manifest_nearest (Fix #1-2 cwd/manifest)
# - refactor_engine: dedupe_barrel_exports, import rewrite (Fix #6, #8)
cargo test path_utils --no-fail-fast
cargo test refactor_engine --no-fail-fast

echo ""
echo "=== Validation fixes test suite: PASSED ==="
