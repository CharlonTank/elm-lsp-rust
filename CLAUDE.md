# elm-lsp-rust

Fast Elm Language Server (Rust) for Claude Code. **Not for text editors** - this is an MCP plugin.

## Commands

```bash
cargo build --release
node tests/run_tests.mjs && node tests/test_meetdown_comprehensive.mjs  # 227 tests
```

## Key Files

- `src/workspace.rs` - Core logic: indexing, references, rename, remove variant
- `src/server.rs` - LSP protocol handlers
- `src/type_checker.rs` - Type inference for field rename
- `mcp-wrapper/index.mjs` - MCP tool definitions

## MCP Tools

`elm_definition`, `elm_references`, `elm_symbols`, `elm_hover`, `elm_completion`, `elm_diagnostics`, `elm_format`, `elm_code_actions`, `elm_apply_code_action`, `elm_rename_function`, `elm_rename_type`, `elm_rename_variant`, `elm_rename_field`, `elm_move_function`, `elm_rename_file`, `elm_move_file`, `elm_prepare_remove_variant`, `elm_remove_variant`, `elm_notify_file_changed`

## Release

1. Update version in `.claude-plugin/plugin.json`
2. Commit, push, tag: `git tag vX.Y.Z && git push origin vX.Y.Z`
3. Update `elm-lsp-plugin` marketplace
