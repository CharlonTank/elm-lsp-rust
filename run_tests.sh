#!/bin/bash
# Run elm-lsp-rust test suite

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/tests"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing test dependencies..."
    # npm ci installs exactly what package-lock.json records, without running install scripts
    npm ci --ignore-scripts
fi

# Run tests
echo "Running elm-lsp-rust test suite..."
node run_tests.mjs
node --test *.test.mjs
