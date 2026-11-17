# elm-lsp-rust

Fast Elm Language Server (Rust) for coding agents. **Not for text editors** - agents reach it through an MCP server or a command-line interface.

## IMPORTANT RULE TO ALWAYS KEEP IN MIND/CONTEXT

1. **Do not stop until you succeed your ultimate goal**:
   - Have ALL tests working
   - Holistic code review completed
   - Code is optimized, robust, with good design patterns
   - Codebase is DRY
   - Refactored where needed
   - No personal computer references (except test fixtures like meetdown)
2. **If a test is not passing because of an edge case**, good for you, that's gold for you, because it means you found the essence of the meaning of your life.
3. **Once tests pass**, look at the whole code and think: "Is this good code? Is it optimized? Is it robust? Does it have good overall design patterns? Can I try intricate tests to see if everything still holds? Can I DRY this codebase even more? Can I refactor it?"
4. **If you have ANY doubt, go for it** - even if it takes 1 year to complete this project. Quality over speed. Thoroughness over shortcuts.
5. **NEVER say "Final" anything** - the only final is when the user decides. NEVER STOP until the user explicitly says so.

## Commands

```bash
cargo build --release
node tests/run_tests.mjs && node tests/test_meetdown_comprehensive.mjs  # tools and language server
node --test tests/*.test.mjs                                            # MCP server, CLI, harness config
node mcp-wrapper/cli.mjs config --markdown > docs/harnesses.md          # after editing harnesses.mjs
```

The suites need `elm` 0.19.1 and `elm-format` on `PATH`. The meetdown suite also needs `lamdera`.

## Key Files

- `src/workspace/` - Core logic: indexing, references, rename, remove variant
- `src/server.rs` - LSP protocol handlers
- `src/type_checker.rs` - Type inference for field rename
- `mcp-wrapper/tools.mjs` - Tool definitions, shared by the MCP server and the CLI
- `mcp-wrapper/index.mjs` - MCP server (stdio and HTTP)
- `mcp-wrapper/cli.mjs` - Command-line interface
- `mcp-wrapper/lsp-client.mjs` - Starts the Rust binary and speaks LSP to it
- `mcp-wrapper/harnesses.mjs` - How each harness registers the server, source of `docs/harnesses.md`

## MCP Tools

`elm_definition`, `elm_references`, `elm_symbols`, `elm_diagnostics`, `elm_format`, `elm_code_actions`, `elm_apply_code_action`, `elm_rename_function`, `elm_rename_type`, `elm_rename_variant`, `elm_rename_field`, `elm_move_function`, `elm_rename_file`, `elm_move_file`, `elm_notify_file_changed`, `elm_prepare_add_variant`, `elm_add_variant`, `elm_prepare_remove_variant`, `elm_remove_variant`, `elm_prepare_remove_field`, `elm_remove_field`, `elm_generate_erd`

## Release

1. Update version in `.claude-plugin/plugin.json`
2. Commit, push, tag: `git tag vX.Y.Z && git push origin vX.Y.Z`
3. Update `elm-lsp-plugin` marketplace
