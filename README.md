# elm-lsp-rust

A fast Elm Language Server written in Rust, designed for Claude Code integration via MCP.

## Installation

### Via Claude Code Marketplace (Recommended)

This plugin is distributed through the [elm-marketplace](https://github.com/CharlonTank/elm-lsp-plugin):

```bash
# Add the Elm marketplace
/plugin marketplace add CharlonTank/elm-lsp-plugin

# Install this plugin
/plugin install elm-lsp-rust@CharlonTank/elm-lsp-plugin
```

Then restart Claude Code.

### Alternative: Interactive Installation

1. Run `/plugin` to open the plugin manager
2. Navigate to the **Discover** tab
3. Add the marketplace if not already added
4. Browse and install `elm-lsp-rust`

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
│          source: "CharlonTank/elm-lsp-rust" }                   │
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
| **Go to Definition** | Jump to symbol definitions |
| **Find References** | All usages across workspace |
| **Rename** | Safe rename across all files (functions, types, variants, fields) |
| **Document Symbols** | List all symbols in a file |
| **Diagnostics** | Compiler errors via `elm make` / `lamdera make` |
| **Formatting** | Via `elm-format` |
| **Code Actions** | Quick fixes and refactorings |
| **Move Function** | Move function to another module with import updates |
| **File Rename/Move** | Rename or move Elm files with module/import updates |
| **Add Variant** | Add variant to custom type with auto case branch updates |
| **Remove Variant** | Smart union type variant removal |
| **Remove Field** | Remove field from type alias with usage updates |
| **ERD Generation** | Generate Mermaid diagrams from types |

### Smart Type Operations

**Add Variant**: Adds a variant and automatically inserts branches in all case expressions:
```elm
-- elm_add_variant with custom branch code for each case expression
type Route = HomeRoute | AboutRoute | NewRoute
-- All case expressions get new branches with your specified code
```

**Remove Variant**: Intelligently removes variants:
- Replaces constructor usages with `Debug.todo`
- Auto-removes pattern match branches
- Errors if removing the only variant

**Remove Field**: Removes fields from type aliases:
- Updates record literals, patterns, and field accesses
- Replaces field access with `Debug.todo`

## MCP Tools (22 total)

| Tool | Description |
|------|-------------|
| `elm_definition` | Go to definition |
| `elm_references` | Find all references |
| `elm_symbols` | List file symbols |
| `elm_diagnostics` | Get compiler errors |
| `elm_code_actions` | Get available actions |
| `elm_apply_code_action` | Apply a code action |
| `elm_format` | Format file |
| `elm_rename_variant` | Rename a variant |
| `elm_rename_type` | Rename a type |
| `elm_rename_function` | Rename a function |
| `elm_rename_field` | Rename a record field |
| `elm_move_function` | Move function to module |
| `elm_rename_file` | Rename an Elm file |
| `elm_move_file` | Move an Elm file |
| `elm_notify_file_changed` | Notify LSP of external file changes |
| `elm_prepare_add_variant` | Check what adding a variant would affect |
| `elm_add_variant` | Add variant with auto case branch updates |
| `elm_prepare_remove_variant` | Check what removing a variant would affect |
| `elm_remove_variant` | Remove variant with auto pattern removal |
| `elm_prepare_remove_field` | Check what removing a field would affect |
| `elm_remove_field` | Remove field from type alias |
| `elm_generate_erd` | Generate Mermaid ERD from type |

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
└── tests/               # Test suite (228 tests)
```

### Key Design Decisions

1. **Workspace Indexing**: Indexes all `.elm` files at startup for immediate cross-file operations
2. **Tree-sitter Parsing**: Fast, incremental, error-tolerant parsing
3. **Compiler Diagnostics**: Uses `elm make --report=json` for 100% accurate errors
4. **Evergreen Exclusion**: Skips `src/Evergreen/` migration files in refactoring

## Testing

```bash
# Run all tests (228 tests total)
node tests/run_tests.mjs && node tests/test_meetdown_comprehensive.mjs
```

Tests cover: definition, references, symbols, rename (functions, types, variants, fields), diagnostics, code actions, move function, file rename/move, add/remove variant, add/remove field, and ERD generation.

## Related

- [elm-lsp-plugin](https://github.com/CharlonTank/elm-lsp-plugin) - Marketplace that distributes this plugin
- [elm-language-server](https://github.com/elm-tooling/elm-language-server) - Original TypeScript LSP
- [tree-sitter-elm](https://github.com/elm-tooling/tree-sitter-elm) - Elm grammar
- [tower-lsp](https://github.com/ebkalderon/tower-lsp) - Rust LSP framework

## Issues

Report bugs at: https://github.com/CharlonTank/elm-lsp-rust/issues
