# elm-lsp-rust

A fast Elm Language Server written in Rust, designed for Claude Code integration via MCP.

## Installation

### Via Claude Code Marketplace (Recommended)

This plugin is distributed through the [elm-marketplace](https://github.com/CharlonTank/elm-lsp-plugin):

```bash
# Add the Elm marketplace
claude plugin marketplace add https://github.com/CharlonTank/elm-lsp-plugin

# Install this plugin
claude plugin install elm-lsp-rust@elm-marketplace
```

Then restart Claude Code.

### How Plugin Distribution Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     elm-lsp-plugin                              │
│            (Marketplace Repository)                             │
│     https://github.com/CharlonTank/elm-lsp-plugin              │
│                                                                 │
│  .claude-plugin/marketplace.json                                │
│  └── plugins: [                                                 │
│        { name: "elm-lsp-rust",                                  │
│          source: "CharlonTank/elm-lsp-rust",                   │
│          version: "0.3.8" }                                     │
│      ]                                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ references
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     elm-lsp-rust                                │
│              (This Repository - Plugin)                         │
│      https://github.com/CharlonTank/elm-lsp-rust               │
│                                                                 │
│  .claude-plugin/plugin.json ─► Plugin metadata                  │
│  src/                       ─► Rust LSP server                  │
│  mcp-wrapper/               ─► MCP server (bridges MCP↔LSP)     │
│  scripts/setup.sh           ─► Builds Rust binary on install    │
└─────────────────────────────────────────────────────────────────┘
```

When you install via the marketplace:
1. Claude Code fetches plugin metadata from `elm-lsp-plugin/marketplace.json`
2. The marketplace points to this repository (`elm-lsp-rust`)
3. Claude Code clones this repo and runs `scripts/setup.sh` to build the Rust binary
4. The MCP wrapper (`mcp-wrapper/index.mjs`) becomes available as `elm-lsp-rust` MCP server

## Features

| Feature | Description |
|---------|-------------|
| **Hover** | Type signatures and documentation |
| **Go to Definition** | Jump to symbol definitions |
| **Find References** | All usages across workspace |
| **Rename** | Safe rename across all files (including exposing lists) |
| **Document Symbols** | List all symbols in a file |
| **Workspace Symbols** | Search symbols across project |
| **Diagnostics** | Compiler errors via `elm make` / `lamdera make` |
| **Formatting** | Via `elm-format` |
| **Code Actions** | Quick fixes and refactorings |
| **Move Function** | Move function to another module with import updates |
| **File Rename/Move** | Rename or move Elm files with module/import updates |
| **Remove Variant** | Smart union type variant removal |

### Remove Variant (Unique Feature)

Intelligently removes union type variants:

- **Replaces** constructor usages with `Debug.todo "VARIANT REMOVAL DONE: <original>"`
- **Auto-removes** pattern match branches using the variant
- **Auto-removes** useless wildcards that would cover nothing after removal
- **Errors** if trying to remove the only variant from a type

```elm
type Color = Red | Green | Blue | Unused

-- Remove "Unused": automatically removes pattern branches
-- Remove "Blue": constructor usages replaced with Debug.todo
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `elm_hover` | Get type at position |
| `elm_definition` | Go to definition |
| `elm_references` | Find all references |
| `elm_symbols` | List file symbols |
| `elm_rename_variant` | Rename a variant |
| `elm_rename_type` | Rename a type |
| `elm_rename_function` | Rename a function |
| `elm_rename_field` | Rename a record field |
| `elm_diagnostics` | Get compiler errors |
| `elm_format` | Format file |
| `elm_code_actions` | Get available actions |
| `elm_apply_code_action` | Apply a code action by title |
| `elm_move_function` | Move function to module |
| `elm_rename_file` | Rename an Elm file |
| `elm_move_file` | Move an Elm file to a new location |
| `elm_prepare_remove_variant` | Analyze variant usages |
| `elm_remove_variant` | Remove variant from type |

## Building from Source

```bash
cd elm-lsp-rust
cargo build --release

# Binary at: target/release/elm_lsp
```

## Architecture

```
elm-lsp-rust/
├── .claude-plugin/
│   └── plugin.json      # Plugin metadata for marketplace
├── src/
│   ├── main.rs          # Entry point
│   ├── server.rs        # LSP protocol (tower-lsp)
│   ├── workspace.rs     # Indexing, symbols, refactoring
│   ├── document.rs      # Single file representation
│   ├── parser.rs        # Tree-sitter parsing
│   └── diagnostics.rs   # Elm compiler integration
├── mcp-wrapper/         # MCP server (Node.js)
│   └── index.mjs        # Translates MCP <-> LSP
├── scripts/
│   └── setup.sh         # Build script run on plugin install
├── skills/              # Claude Code skills
└── tests/               # Test suite (122 tests)
```

### Key Design Decisions

1. **Workspace Indexing**: Indexes all `.elm` files at startup for immediate cross-file operations
2. **Tree-sitter Parsing**: Fast, incremental, error-tolerant parsing
3. **Compiler Diagnostics**: Uses `elm make --report=json` for 100% accurate errors
4. **Evergreen Exclusion**: Skips `src/Evergreen/` migration files in refactoring

## Testing

```bash
# Run fixture tests (23 tests)
node tests/run_tests.mjs

# Run comprehensive tests on real-world codebase (99 tests)
node tests/test_meetdown_comprehensive.mjs

# Run all tests
node tests/run_tests.mjs && node tests/test_meetdown_comprehensive.mjs
```

All 122 tests cover: hover, definition, references, symbols, rename, diagnostics, completion, code actions, move function, file rename/move, and remove variant (including edge cases).

## Related

- [elm-lsp-plugin](https://github.com/CharlonTank/elm-lsp-plugin) - Marketplace that distributes this plugin
- [elm-language-server](https://github.com/elm-tooling/elm-language-server) - Original TypeScript LSP
- [tree-sitter-elm](https://github.com/elm-tooling/tree-sitter-elm) - Elm grammar
- [tower-lsp](https://github.com/ebkalderon/tower-lsp) - Rust LSP framework

## Issues

Report bugs at: https://github.com/CharlonTank/elm-lsp-rust/issues
