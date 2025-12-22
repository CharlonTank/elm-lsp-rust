#!/bin/bash

BINARY="${CLAUDE_PLUGIN_ROOT}/target/release/elm_lsp"
SRC_DIR="${CLAUDE_PLUGIN_ROOT}/src"
NODE_MODULES="${CLAUDE_PLUGIN_ROOT}/mcp-wrapper/node_modules"

needs_rebuild() {
  # Rebuild if binary doesn't exist
  [ ! -f "$BINARY" ] && return 0

  # Rebuild if any .rs file is newer than the binary
  if find "$SRC_DIR" -name "*.rs" -newer "$BINARY" 2>/dev/null | grep -q .; then
    return 0
  fi

  # Rebuild if Cargo.toml is newer than the binary
  [ "${CLAUDE_PLUGIN_ROOT}/Cargo.toml" -nt "$BINARY" ] && return 0

  return 1
}

if needs_rebuild; then
  echo "Building elm-lsp-rust..."
  cd "${CLAUDE_PLUGIN_ROOT}" || exit 1
  cargo build --release
  echo "elm-lsp-rust build complete"
fi

if [ ! -d "$NODE_MODULES" ]; then
  echo "Installing npm dependencies..."
  cd "${CLAUDE_PLUGIN_ROOT}/mcp-wrapper" || exit 1
  npm install
  echo "npm install complete"
fi

exit 0
