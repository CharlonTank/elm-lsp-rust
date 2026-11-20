#!/bin/bash
# Build the language server when the binary is missing or older than a Rust
# source, Cargo.toml or Cargo.lock. Install the MCP wrapper's dependencies
# when mcp-wrapper/node_modules is missing. That directory is under version
# control, so in a clone the script installs nothing. The Claude Code plugin
# runs this on session start. For any other harness, run it once after
# cloning.

set -e

# The plugin sets CLAUDE_PLUGIN_ROOT. Otherwise the repository is one level above this script.
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BINARY="$ROOT/target/release/elm_lsp"
NODE_MODULES="$ROOT/mcp-wrapper/node_modules"

needs_rebuild() {
  # Rebuild if binary doesn't exist
  [ ! -f "$BINARY" ] && return 0

  # Rebuild if any .rs file is newer than the binary
  if find "$ROOT/src" -name "*.rs" -newer "$BINARY" 2>/dev/null | grep -q .; then
    return 0
  fi

  # Rebuild if the manifest or the locked dependency versions are newer than the binary
  [ "$ROOT/Cargo.toml" -nt "$BINARY" ] && return 0
  [ "$ROOT/Cargo.lock" -nt "$BINARY" ] && return 0

  return 1
}

if needs_rebuild; then
  echo "Building elm-lsp-rust..."
  # --locked builds exactly the dependency versions recorded in Cargo.lock
  (cd "$ROOT" && cargo build --release --locked)
  echo "elm-lsp-rust build complete"
fi

if [ ! -d "$NODE_MODULES" ]; then
  echo "Installing npm dependencies..."
  # npm ci installs exactly what package-lock.json records, without running install scripts
  (cd "$ROOT/mcp-wrapper" && npm ci --ignore-scripts)
  echo "npm install complete"
fi
