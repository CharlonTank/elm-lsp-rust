# elm-lsp-rust

A fast Elm Language Server written in Rust, designed for Claude Code integration via MCP.

## Features

| Feature | Description |
|---------|-------------|
| **Hover** | Type signatures and documentation |
| **Go to Definition** | Jump to symbol definitions |
| **Find References** | All usages across workspace |
| **Rename** | Safe rename across all files |
| **Document Symbols** | List all symbols in a file |
| **Workspace Symbols** | Search symbols across project |
| **Diagnostics** | Compiler errors via `elm make` / `lamdera make` |
| **Formatting** | Via `elm-format` |
| **Code Actions** | Quick fixes and refactorings |
| **Move Function** | Move function to another module with import updates |
| **Remove Variant** | Smart union type variant removal |

### Remove Variant (Unique Feature)

Intelligently removes union type variants:

- **Blocks** if variant is used as a constructor (you must replace manually)
- **Auto-removes** pattern match branches using the variant
- **Auto-removes** useless wildcards that would cover nothing after removal
- **Errors** if trying to remove the only variant from a type

```elm
type Color = Red | Green | Blue | Unused

-- Remove "Unused": automatically removes pattern branches
-- Remove "Blue": blocked if `Blue` is used as constructor anywhere
```

## Installation

### As Claude Code Plugin

The LSP is bundled with the elm-lsp-rust plugin:

```bash
# Plugin is installed at:
~/.claude/plugins/marketplaces/elm-marketplace/plugins/elm-lsp-rust/
```

### Building from Source

```bash
cd elm-lsp-rust
cargo build --release

# Binary at: target/release/elm_lsp
```

## Usage

### With Claude Code

The MCP wrapper exposes these tools:

| Tool | Description |
|------|-------------|
| `elm_hover` | Get type at position |
| `elm_definition` | Go to definition |
| `elm_references` | Find all references |
| `elm_symbols` | List file symbols |
| `elm_rename` | Rename symbol |
| `elm_diagnostics` | Get compiler errors |
| `elm_format` | Format file |
| `elm_code_actions` | Get available actions |
| `elm_move_function` | Move function to module |
| `elm_prepare_remove_variant` | Analyze variant usages |
| `elm_remove_variant` | Remove variant from type |

### Standalone LSP

```bash
./target/release/elm_lsp
```

Communicates via stdio using LSP JSON-RPC protocol.

## Architecture

```
elm-lsp-rust/
├── src/
│   ├── main.rs          # Entry point
│   ├── server.rs        # LSP protocol (tower-lsp)
│   ├── workspace.rs     # Indexing, symbols, refactoring
│   ├── document.rs      # Single file representation
│   ├── parser.rs        # Tree-sitter parsing
│   └── diagnostics.rs   # Elm compiler integration
├── mcp-wrapper/         # MCP server (Node.js)
│   └── index.mjs        # Translates MCP <-> LSP
├── commands/            # Slash commands
└── tests/               # Test suite
```

### Key Design Decisions

1. **Workspace Indexing**: Indexes all `.elm` files at startup for immediate cross-file operations
2. **Tree-sitter Parsing**: Fast, incremental, error-tolerant parsing
3. **Compiler Diagnostics**: Uses `elm make --report=json` for 100% accurate errors
4. **Evergreen Exclusion**: Skips `src/Evergreen/` migration files in refactoring

## Testing

```bash
# Run unit tests
node tests/run_tests.mjs

# Run comprehensive tests (real-world codebase)
node tests/test_meetdown_comprehensive.mjs
```

### Test Coverage

- 21 unit tests (basic LSP operations)
- 61 comprehensive tests (real Elm project)

Tests cover: hover, definition, references, symbols, rename, diagnostics, completion, code actions, move function, remove variant (including edge cases).

## Development

### Deploying to Plugin

```bash
cargo build --release
cp target/release/elm_lsp ~/.claude/plugins/marketplaces/elm-marketplace/plugins/elm-lsp-rust/target/release/
cp mcp-wrapper/index.mjs ~/.claude/plugins/marketplaces/elm-marketplace/plugins/elm-lsp-rust/server/
```

Then restart Claude Code.

### Running Benchmarks

```bash
cargo run --release --bin benchmark -- /path/to/elm/project
```

## Related

- [elm-claude-improvements](https://github.com/CharlonTank/elm-lsp-rust) - Parent project with full architecture docs
- [elm-language-server](https://github.com/elm-tooling/elm-language-server) - Original TypeScript LSP
- [tree-sitter-elm](https://github.com/elm-tooling/tree-sitter-elm) - Elm grammar
- [tower-lsp](https://github.com/ebkalderon/tower-lsp) - Rust LSP framework

## Issues

Report bugs at: https://github.com/CharlonTank/elm-lsp-rust/issues
