# Claude Code Instructions for elm-lsp-rust

## Project Overview

This is the **elm-lsp-rust** plugin - a fast Elm Language Server written in Rust for Claude Code.

### Architecture

- **Rust LSP Server** (`src/`): Core language server with tree-sitter parsing
- **MCP Wrapper** (`mcp-wrapper/index.mjs`): Bridges MCP protocol to LSP
- **Plugin Config** (`.claude-plugin/plugin.json`): Claude Code plugin metadata

### Related Repository

This plugin is distributed via the **elm-lsp-plugin** marketplace:
- Marketplace: https://github.com/CharlonTank/elm-lsp-plugin
- The marketplace's `marketplace.json` references this repository

## Development Commands

```bash
# Build the Rust binary
cargo build --release

# Run tests (122 total)
node tests/run_tests.mjs              # 23 fixture tests
node tests/test_meetdown_comprehensive.mjs  # 99 real-world tests

# Run all tests
node tests/run_tests.mjs && node tests/test_meetdown_comprehensive.mjs
```

## Key Files

- `src/workspace.rs` - Core logic: indexing, references, rename, remove variant
- `src/server.rs` - LSP protocol handlers
- `mcp-wrapper/index.mjs` - MCP tool definitions
- `.claude-plugin/plugin.json` - Version and metadata
- `scripts/setup.sh` - Build script run on plugin install

## Versioning

When releasing a new version:
1. Update version in `.claude-plugin/plugin.json`
2. Commit and push to main
3. Tag with `git tag vX.Y.Z && git push origin vX.Y.Z`
4. Update `elm-lsp-plugin` marketplace's `marketplace.json` with new version

## Testing Requirements

All changes must pass the full test suite (122 tests) before committing.
The pre-commit hook automatically runs tests.

## MCP Tools Available

- `elm_hover`, `elm_definition`, `elm_references`, `elm_symbols`
- `elm_rename_variant`, `elm_rename_type`, `elm_rename_function`, `elm_rename_field`
- `elm_format`, `elm_diagnostics`
- `elm_code_actions`, `elm_apply_code_action`
- `elm_move_function`, `elm_rename_file`, `elm_move_file`
- `elm_prepare_remove_variant`, `elm_remove_variant`
