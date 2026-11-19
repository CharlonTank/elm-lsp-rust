# elm-lsp-rust

A fast Elm language server written in Rust, for coding agents. It gives an agent go to definition, find references, compiler diagnostics and project-wide refactorings as tools, over MCP or from the command line.

It is a stdio MCP server, so a harness with an MCP client can register it. [docs/harnesses.md](docs/harnesses.md) has the entry for Claude Code, OpenAI Codex, GitHub Copilot, Cursor, OpenCode, Gemini CLI, Google Antigravity, Cline, Goose, Pi and Oh My Pi. The Claude Code and Codex entries are tested in those harnesses. The other nine follow each harness's documentation and have not been run there. Aider, which has no MCP client, and any script can call the same tools through the command-line interface.

## Installation

### Any harness

```bash
git clone https://github.com/CharlonTank/elm-lsp-rust
cd elm-lsp-rust
scripts/setup.sh                            # builds the language server (needs cargo and Node.js 18+)
node mcp-wrapper/cli.mjs doctor             # checks the installation
node mcp-wrapper/cli.mjs config             # lists the harnesses
node mcp-wrapper/cli.mjs config <harness>   # prints where your harness keeps its MCP servers and the entry to add
```

[docs/harnesses.md](docs/harnesses.md) shows the entry for every harness. A harness that is not listed needs a stdio MCP server whose command is `node` and whose argument is the absolute path of `mcp-wrapper/index.mjs`.

You can also hand the job to your agent. Tell it to read [docs/agent-install.md](docs/agent-install.md) in the clone and follow it.

The server starts from any directory, and each tool finds the Elm project from the file it is given. One registration therefore serves every Elm project on the machine. Pass absolute file paths, because a relative path resolves against the directory the harness started the server in.

The skill in `skills/elm-refactoring` tells an agent when and how to use the tools. Copy it into the project's `.agents/skills/` directory, or `.claude/skills/` for Claude Code.

### Claude Code plugin

In Claude Code, run:

```bash
/plugin marketplace add CharlonTank/elm-lsp-plugin
/plugin install elm-lsp-rust@CharlonTank/elm-lsp-plugin
```

Then restart Claude Code.

#### How plugin distribution works

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

The plugin starts the server with `--elm-projects-only`, so its tools appear only in sessions opened in an Elm project.

## Command line

`mcp-wrapper/cli.mjs` runs one tool per call and prints its result. Each argument of the tool is a flag.

```bash
node mcp-wrapper/cli.mjs tools                 # list the tools, add --json for their arguments
node mcp-wrapper/cli.mjs elm_references --file_path src/Main.elm --line 10 --character 4
node mcp-wrapper/cli.mjs elm_rename_function --help
```

`--args '<json>'` passes all arguments as one JSON object. `--project-tools` works as it does for the server, see below. The exit status is 0 on success, 1 when the tool fails and 2 when the command line is wrong.

## Server options

Append these to the arguments of `mcp-wrapper/index.mjs` in your harness's config.

| Option | Effect |
|--------|--------|
| `--read-only` | Offers only the nine tools that never edit a source file |
| `--project-tools` | Takes the compiler and `elm-format` from a project's `node_modules/.bin` when they are there. Only for projects you trust |
| `--elm-projects-only` | Exits at once unless the working directory, or a direct child of it, holds an `elm.json`. The harness then lists the server as not connected |
| `--http`, `--host`, `--port` | Serves over HTTP instead of stdio, see [Shared MCP server](#shared-mcp-server-manual-http). `--host` and `--port` need `--http` |

Every tool carries MCP annotations. Nine are marked read-only: `elm_definition`, `elm_references`, `elm_symbols`, `elm_diagnostics`, `elm_code_actions`, `elm_notify_file_changed` and the three `elm_prepare_*` previews. The rest are marked as writing to disk, so a harness that reads annotations asks before it runs them. Read-only means that a tool edits no source file. `elm_diagnostics` still runs the compiler, which writes its cache to `elm-stuff/` and downloads packages it does not have yet.

Diagnostics build a Lamdera project with `lamdera` and any other project with `elm`. The compiler and `elm-format` are found on `PATH`. With `--project-tools`, a copy in the project's `node_modules/.bin` wins, so a project gets the versions it pins. That also lets a repository choose the program these tools run, and a harness may call `elm_diagnostics` without asking first. Turn it on only for code you trust.

The server starts one language server per Elm project on first use and stops it after ten idle minutes. Before each call the language server compares its index with the project on disk. It reads the source files that changed, and builds the index anew when `elm.json` did, so edits an agent made with its own tools are taken into account. While `elm.json`, a source file or a directory of source files cannot be read, every tool that asks the language server fails and says which one and why, because a refactoring would pass over what the index could not read. `elm_format` asks it nothing, and formats the file it is given all the same.

The index covers the source directories that `elm.json` lists, also one outside the project root such as `../shared`. A file in none of them, such as a test, joins the index when a tool is called on that file. The language server then follows it like the rest, also when it builds its index anew. Such a file is gone from the index again once the language server restarts, which it does after ten idle minutes. Until a tool is called on the file again, a rename does not reach it. From the command line every call starts a new language server, so a rename there never reaches a file outside the source directories.

Two files can declare one module: a copy of `Utils.elm` says `module Utils` until its first line is edited. The index keeps one file for each module name, the one whose path spells the name, `src/Utils.elm`. Below a source directory that is the compiler's rule too, so the other file is no module of the project. A rename, or a change to a type, leaves it alone, and a tool that is called on it says so and names both files. `elm_rename_file` and `elm_move_file` give it a name of its own, and `elm_diagnostics` and `elm_format` take it like any file. Two things are less tidy. A file in no source directory that declares the name of a module in one, such as `examples/Demo/Main.elm` beside `src/Main.elm`, compiles when the compiler is given its path, and the tools refuse it all the same. And `elm_move_function` works on the text of every Elm file below the project, so it changes the import in a copy as well.

A refactoring reads every file it changes, and checks that it may write each of them, before it writes the first. A file that cannot be read or written leaves the project as it was, and the error names the file. A file move also checks first that its two directories take the change. These are checks ahead of the work and no transaction: a disk that fills up half way still leaves a refactoring half done.

The calls for one project run one at a time, in the order they arrive, whether they come from one client or from several clients of an HTTP server. Two servers that work on the same project know nothing of each other, so do not let two of them refactor at once.

When the harness closes the server's input, the server answers the requests it has already received, stops its language servers and exits.

### Known limitations

- **Columns on lines with non-ASCII text.** The language server counts columns in bytes. On a line with a non-ASCII character before the symbol, a column in a result is larger than the count of characters by the extra bytes: in `"café " ++ formatName name`, `formatName` is at column 12 and not at 11. Pass a column to a tool as a result gave it. Edits land where they belong, on such a line as on any other. `elm_diagnostics` is the exception: it prints the line and the column of the compiler's own report, which count from 1 and by characters.
- **Linked directories.** A directory below a source directory that is a link to another directory is not followed, though the compiler follows it. The modules behind it are not in the index, and a rename passes them over. A link to a single file is followed.
- **Source directories outside the project root.** A refactoring that starts inside the project changes the files in a directory such as `../shared` too. A call cannot name a file there itself, because the project is found from the path of the file a call names, and that path leads to no `elm.json`. Two projects that share such a directory are not kept from refactoring it at the same time.
- **What a moved function leaves behind.** `elm_move_function` moves the text of one function and points the imports that list it by name, as in `import Utils exposing (greet)`, at its new module. A use by qualified name, through an alias or through `exposing (..)` stays as it was. The imports that the function needs, and the functions of its old module that it calls, do not follow it either: moving `greet : User -> String` into a module that does not import `User` leaves that module with an error. And the old module gets an import of the new one, which closes a circle when the new one imports the old. It also rewrites the import in a copy of a module, which the other refactorings leave alone. Run `elm_diagnostics` on the project's entry module afterwards, which compiles every module in use, and repair what it reports.
- **A module's name in a comment or a string.** `elm_rename_file` and `elm_move_file` change the module's name wherever a file that imports the module writes it in front of a dot. They read text for that, so `Utils.greet` in a comment or a string of such a file becomes `Helpers.greet` along with the code.
- **A name that several modules have.** `elm_definition` and `elm_references` look a name up without the module it belongs to. Where `Aaa`, `Other` and `Utils` each have a `helper`, the definition asked for at `Other.helper` can be the one of `Aaa`, and the references of one of them list the uses of all three. Look at the path of such an answer before you rely on it. Three refactorings write by the same lookup, and each reports success. `elm_rename_variant` also renames a variant of that name which another module declares on a type of its own, such as the `NoOp` in every page module of an application. `elm_add_variant` writes a branch for the bare new variant into a `case` over another type, where a pattern of that `case` holds a variant of the type that changed, as in `Home Page.Home.NoOp ->`. `elm_rename_field` on a record alias whose name and field another module has as well, a `Model` with a `title` in two page modules, renames the other module's field too or stops at the definition, and which of the two differs from run to run. The project does not compile after any of these, so run `elm_diagnostics` on its entry module after one of the three.
- **Windows.** File paths and the setup script assume a POSIX system.

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

### Smart type operations

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

## MCP tools (22 total)

| Tool | Description |
|------|-------------|
| `elm_definition` | Go to definition |
| `elm_references` | Find all references |
| `elm_symbols` | List file symbols |
| `elm_diagnostics` | Get compiler errors for a file and what it imports |
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

## Building from source

```bash
cd elm-lsp-rust
cargo build --release --locked

# Binary at: target/release/elm_lsp
```

## Shared MCP server (manual HTTP)

Run one MCP server yourself and point multiple sessions to it.

```bash
/path/to/elm-lsp-rust/scripts/setup.sh
node /path/to/elm-lsp-rust/mcp-wrapper/index.mjs --http --host 127.0.0.1 --port 3333
```

Claude Code config example (in `~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "elm-lsp-rust": {
      "type": "http",
      "url": "http://127.0.0.1:3333/mcp"
    }
  }
}
```

Notes:
- Sessions share one language server per Elm project.
- Disable the stdio server entry to avoid duplicates.
- On a loopback address, which is the default, the server refuses a request whose `Host` or `Origin` names another site. That is how a web page in a browser on the same machine would reach it. On any other address it answers every client that can connect, and the tools write files, so bind it only on a network you trust.

## Architecture

```
elm-lsp-rust/
├── .claude-plugin/
│   └── plugin.json      # Plugin metadata for marketplace
├── src/
│   ├── main.rs          # Entry point
│   ├── server.rs        # LSP protocol (tower-lsp)
│   ├── workspace/       # Indexing, symbols, refactoring
│   ├── document.rs      # Single file representation
│   ├── parser.rs        # Tree-sitter parsing
│   └── diagnostics.rs   # Elm compiler integration
├── mcp-wrapper/         # Agent-facing layer (Node.js)
│   ├── tools.mjs        # The tools, defined once
│   ├── index.mjs        # MCP server over stdio or HTTP
│   ├── cli.mjs          # Command-line interface
│   ├── lsp-client.mjs   # Runs the Rust binary, one per Elm project
│   └── harnesses.mjs    # Registration for each harness
├── docs/                # Harness configuration, agent install guide
├── scripts/
│   └── setup.sh         # Builds the language server
├── skills/              # Agent skill
└── tests/               # Test suites
```

### Key design decisions

1. **Workspace Indexing**: Indexes all `.elm` files at startup for immediate cross-file operations
2. **Tree-sitter Parsing**: Fast, incremental, error-tolerant parsing
3. **Compiler Diagnostics**: Uses `elm make --report=json` for 100% accurate errors
4. **Evergreen Exclusion**: Skips `src/Evergreen/` migration files in refactoring

## Testing

```bash
# Once per clone: the suites' own dependencies
(cd tests && npm ci --ignore-scripts)

# Tools and language server, against the fixture and a real project
node tests/run_tests.mjs && node tests/test_meetdown_comprehensive.mjs

# MCP server, command line and harness configuration
node --test tests/*.test.mjs
```

The suites need `elm` 0.19.1 and `elm-format` on `PATH`, and Node.js 20.4 or newer, two major versions past what the server itself needs. The meetdown suite also needs `lamdera`.

Tests cover: definition, references, symbols, rename (functions, types, variants, fields), diagnostics, code actions, move function, file rename/move, add/remove variant, add/remove field, and ERD generation.

## Related

- [elm-lsp-plugin](https://github.com/CharlonTank/elm-lsp-plugin) - Marketplace that distributes this plugin
- [elm-language-server](https://github.com/elm-tooling/elm-language-server) - Original TypeScript LSP
- [tree-sitter-elm](https://github.com/elm-tooling/tree-sitter-elm) - Elm grammar
- [tower-lsp](https://github.com/ebkalderon/tower-lsp) - Rust LSP framework

## Issues

Report bugs at: https://github.com/CharlonTank/elm-lsp-rust/issues
