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

# Run tests (224 total)
node tests/run_tests.mjs              # 23 fixture tests
node tests/test_meetdown_comprehensive.mjs  # 201 real-world tests

# Run all tests
node tests/run_tests.mjs && node tests/test_meetdown_comprehensive.mjs
```

## Key Files

- `src/workspace.rs` - Core logic: indexing, references, rename, remove variant, field rename
- `src/server.rs` - LSP protocol handlers (including `did_change_watched_files`)
- `src/type_checker.rs` - Type inference for field rename resolution
- `mcp-wrapper/index.mjs` - MCP tool definitions
- `.claude-plugin/plugin.json` - Version and metadata
- `scripts/setup.sh` - Build script run on plugin install

## Current Feature Status (2024-12-25)

### All Features Working (✅)
| Feature | Notes |
|---------|-------|
| `elm_definition` | Go-to-definition |
| `elm_references` | Find all references |
| `elm_symbols` | Document symbols |
| `elm_hover` | Type info on hover |
| `elm_completion` | Code completion |
| `elm_diagnostics` | Error/warning detection |
| `elm_code_actions` | Get available refactorings |
| `elm_apply_code_action` | Apply a code action |
| `elm_format` | elm-format integration |
| `elm_move_function` | Move function between modules |
| `elm_rename_file` | Rename .elm file + update imports |
| `elm_move_file` | Move file to new path |
| `elm_prepare_remove_variant` | Analyze if variant can be removed |
| `elm_remove_variant` | Remove variant + cleanup patterns |
| `elm_rename_function` | Rename function across project |
| `elm_rename_type` | Rename type alias or custom type |
| `elm_rename_variant` | Rename custom type variant |
| `elm_rename_field` | Rename record field across project |

### Test Results (2024-12-25)
- Fixture: 23/23 (100%)
- Meetdown: 201/201 (100%)
- **Total: 224/224 (100%)**

## Recent Changes (2024-12-25)

### Fixed `elm_rename_field` for common field names
- **Files**: `src/type_checker.rs`
- **Problem**: Field rename failed for fields like `name` or `description` that exist in 10+ types
- **Fixes applied**:
  1. Lambda parameter type inference: When mapping over collections (Cache.map, List.map), infer the lambda parameter type from the collection element type
  2. Pattern binding resolution: When a variable is bound via pattern (e.g., `(Event event)`), don't fall through to structural matching if the type doesn't match
  3. Lambda parameter detection: For single-field record updates like `{ a | name = ... }`, only accept if the base variable is actually a lambda parameter (not just "in a lambda")

### Added `did_change_watched_files` handler
- **File**: `src/server.rs:655-686`
- **Why**: Tests restore files from backup but LSP cache wasn't refreshed
- **Fix**: Server now handles `workspace/didChangeWatchedFiles` to re-index files

## Versioning

When releasing a new version:
1. Update version in `.claude-plugin/plugin.json`
2. Commit and push to main
3. Tag with `git tag vX.Y.Z && git push origin vX.Y.Z`
4. Update `elm-lsp-plugin` marketplace's `marketplace.json` with new version

## MCP Tools Available

- `elm_hover`, `elm_definition`, `elm_references`, `elm_symbols`
- `elm_rename_variant`, `elm_rename_type`, `elm_rename_function`, `elm_rename_field`
- `elm_format`, `elm_diagnostics`
- `elm_code_actions`, `elm_apply_code_action`
- `elm_move_function`, `elm_rename_file`, `elm_move_file`
- `elm_prepare_remove_variant`, `elm_remove_variant`
- `elm_notify_file_changed`
