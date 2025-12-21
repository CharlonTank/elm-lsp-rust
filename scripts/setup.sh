#!/bin/bash

SETUP_MARKER="${CLAUDE_PLUGIN_ROOT}/.setup-complete"

if [ ! -f "$SETUP_MARKER" ]; then
  echo "Building elm-lsp-rust..."

  cd "${CLAUDE_PLUGIN_ROOT}" || exit 1
  cargo build --release

  cd "${CLAUDE_PLUGIN_ROOT}/mcp-wrapper" || exit 1
  npm install

  touch "$SETUP_MARKER"
  echo "elm-lsp-rust setup complete"
fi

exit 0
