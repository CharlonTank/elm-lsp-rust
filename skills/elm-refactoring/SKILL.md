---
name: elm-refactoring
description: Use the elm-lsp-rust tools (MCP server or command line) for all Elm code operations. Provides navigation, refactoring, diagnostics, and smart variant removal - prefer these over manual text edits.
---

# Elm Language Server Tools (elm-lsp-rust)

When working in an Elm project (has `elm.json`), use these tools instead of manual text search/replace or file edits.

## When to Use This Skill

Activate automatically when the user works with Elm code and needs to:
- **Navigate**: Go to definition, find references, get symbols
- **Refactor**: Rename symbols, move functions, rename/move files
- **Maintain types**: Add/remove variants, add/remove fields
- **Check code**: Get diagnostics, code actions, format

## Available Tools

The names below are the tools' own names. Your harness adds a prefix of its own, for example `mcp__plugin_elm-lsp-rust_elr__elm_definition` for the Claude Code plugin or `mcp__elm-lsp__elm_definition` for a server registered as `elm-lsp`.

If your harness has no MCP client, run the same tools from a shell. Each argument becomes a flag, and `tools` lists them all:

```bash
node /path/to/elm-lsp-rust/mcp-wrapper/cli.mjs elm_references --file_path /path/to/File.elm --line 28 --character 5
```

---

### Code Intelligence

#### elm_definition
Go to where a symbol is defined.
```
file_path: "/path/to/File.elm"
line: 28        # 0-indexed
character: 5    # 0-indexed
```

#### elm_references
Find all references to a symbol across the project.
```
file_path: "/path/to/File.elm"
line: 28
character: 5
```

#### elm_symbols
List all symbols in a file (with pagination).
```
file_path: "/path/to/File.elm"
offset: 0      # optional, default 0
limit: 50      # optional, default 50
```

---

### Diagnostics & Code Actions

#### elm_diagnostics
Compile a file and the modules it imports, and get the file's errors. When the build stops on errors in other files, the answer lists them by file, line and title. Modules that import the file are not compiled. "No errors or warnings" for the project's entry module, such as `src/Main.elm`, means the project compiles. For any other file it covers that file and what it imports.
```
file_path: "/path/to/File.elm"
```

#### elm_code_actions
Get available code actions for a range.
```
file_path: "/path/to/File.elm"
start_line: 28
start_char: 0
end_line: 28
end_char: 10
```

#### elm_apply_code_action
Apply a code action by its title.
```
file_path: "/path/to/File.elm"
start_line: 28
start_char: 0
end_line: 28
end_char: 10
action_title: "Expose newEvent"
```

#### elm_format
Format an Elm file using elm-format.
```
file_path: "/path/to/File.elm"
```

---

### Renaming

#### elm_rename_variant
Rename a custom type variant across all files.
```
file_path: "/path/to/File.elm"
line: 28
character: 0
old_name: "OldVariantName"   # REQUIRED: safety check
newName: "NewVariantName"
```

#### elm_rename_type
Rename a type across all files.
```
file_path: "/path/to/File.elm"
line: 28
character: 0
old_name: "OldTypeName"
newName: "NewTypeName"
```

#### elm_rename_function
Rename a function across all files.
```
file_path: "/path/to/File.elm"
line: 28
character: 0
old_name: "oldFunctionName"
newName: "newFunctionName"
```

#### elm_rename_field
Rename a record field across all files (type-aware).
```
file_path: "/path/to/File.elm"
line: 28
character: 0
old_name: "oldFieldName"
newName: "newFieldName"
```

---

### Moving Code

#### elm_move_function
Move a function from one module to another.
```
file_path: "/path/to/Source.elm"
line: 28
character: 0
function_name: "myFunction"
target_module: "/path/to/Target.elm"
```

#### elm_rename_file
Rename an Elm file and update module declaration + all imports. The new name is a file name without a directory, and it must be a module name: `NewName.elm`, not `newName.elm`.
```
file_path: "/path/to/OldName.elm"
new_name: "NewName.elm"
```

#### elm_move_file
Move an Elm file to a new location and update everything. The module is named after its path below the source directory, so the target has to be in a source directory of `elm.json`, and every directory below it needs an upper-case name. A relative `target_path` starts at the project root, the directory with `elm.json`.
```
file_path: "/path/to/File.elm"
target_path: "src/Utils/File.elm"
```

#### elm_notify_file_changed
Notify LSP after external file rename/move.
```
old_path: "/path/to/Old.elm"
new_path: "/path/to/New.elm"
```

---

### Smart Variant Operations

#### elm_prepare_add_variant
Check what happens when adding a variant - shows case expressions needing branches.
```
file_path: "/path/to/Types.elm"
type_name: "MyType"
new_variant_name: "NewVariant"
```

Returns:
- `existingVariants`: current variants
- `caseExpressions`: all case expressions on this type
- `casesNeedingBranch`: count of cases without wildcards

#### elm_add_variant
Add a variant to a custom type and update all case expressions.
```
file_path: "/path/to/Types.elm"
type_name: "MyType"
new_variant_name: "NewVariant"
variant_args: "String Int"           # optional
branches: [                          # optional, per-case code
  "AddDebug",                        # Debug.todo
  { "AddCode": "someExpression" },   # custom code
  { "AddCodeWithImports": { "imports": ["Module"], "code": "expr" } }
]
```

#### elm_prepare_remove_variant
Analyze a variant before removal - shows blocking vs auto-removable usages.
```
file_path: "/path/to/Types.elm"
line: 15
character: 4
variant_name: "MyVariant"   # optional safety check
```

Returns:
- `canRemove`: true if no blocking usages
- `blockingUsages`: constructor usages (replaced with Debug.todo)
- `patternUsages`: pattern matches (auto-removed)

#### elm_remove_variant
Remove a variant and auto-remove pattern match branches.
```
file_path: "/path/to/Types.elm"
line: 15
character: 4
variant_name: "MyVariant"   # REQUIRED
```

---

### Smart Field Operations

#### elm_prepare_remove_field
Check what happens when removing a field from a type alias.
```
file_path: "/path/to/Types.elm"
line: 15
character: 4
field_name: "myField"   # optional safety check
```

#### elm_remove_field
Remove a field from a type alias and update all usages.
```
file_path: "/path/to/Types.elm"
line: 15
character: 4
field_name: "myField"   # REQUIRED
```

---

### Visualization

#### elm_generate_erd
Generate a Mermaid ERD diagram from a type alias.
```
file_path: "/path/to/Types.elm"
type_name: "BackendModel"
```

---

## Important Notes

- **Line/character positions are 0-indexed** in arguments. Locations in results have 1-indexed lines.
- **Pass absolute file paths.** A relative path resolves against the directory the server was started in. The one exception is `target_path` of `elm_move_file`, which starts at the project root.
- **Refactoring tools write to disk.** Read a file again before editing it further.
- **Always verify compilation** after refactoring, with `elm_diagnostics` on the project's entry module or with the project's build command
- **Lines with non-ASCII text before the symbol.** Columns are counted in bytes there, so a column in a result is larger than the count of characters. Pass it to a tool as the result gave it. Edits land where they belong. `elm_diagnostics` prints the compiler's own line and column, which count from 1 and by characters.
- These tools understand Elm's scope and semantics - safer than text replace

## Why Use LSP Tools

| Manual Edit | LSP Tool |
|-------------|----------|
| Misses references | Finds ALL references |
| Breaks qualified imports | Updates `Module.func` correctly |
| Can rename wrong symbols | Scope-aware, precise |
| Multiple file edits | Single operation |
| Error-prone | Safe and verified |
