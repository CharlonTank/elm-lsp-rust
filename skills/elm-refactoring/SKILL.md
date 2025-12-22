---
name: elm-refactoring
description: Use elm-lsp-rust MCP tools for all Elm code operations. Provides completion, hover, navigation, refactoring, diagnostics, and smart variant removal - prefer these over manual text edits.
---

# Elm Language Server Tools (elm-lsp-rust)

When working in an Elm project (has `elm.json`), use these MCP tools instead of manual text search/replace or file edits.

## When to Use This Skill

Activate automatically when the user works with Elm code and needs to:
- **Navigate**: Go to definition, find references, get symbols
- **Understand**: Get type info, hover documentation, completions
- **Refactor**: Rename symbols, move functions, rename/move files
- **Maintain types**: Remove unused variants from custom types
- **Check code**: Get diagnostics, code actions

## Available MCP Tools (16 total)

All tools use the `mcp__plugin_elm-lsp-rust_elr__` prefix.

---

### Code Intelligence

#### elm_completion
Get code completions at a position.
```
file_path: "/path/to/File.elm"
line: 28        # 0-indexed
character: 10   # 0-indexed
```

#### elm_hover
Get type information and documentation.
```
file_path: "/path/to/File.elm"
line: 28
character: 5
```

#### elm_definition
Go to where a symbol is defined.
```
file_path: "/path/to/File.elm"
line: 28
character: 5
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
Get compile errors and warnings for a file.
```
file_path: "/path/to/File.elm"
```

#### elm_code_actions
Get available code actions for a range (e.g., "Expose function").
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

#### elm_prepare_rename
Check if a symbol can be renamed.
```
file_path: "/path/to/File.elm"
line: 28
character: 0
```

#### elm_rename_variant
Rename a variant across all files in the project.
```
file_path: "/path/to/File.elm"
line: 28
character: 0
old_name: "OldVariantName"   # REQUIRED: safety check
newName: "NewVariantName"
```

#### elm_rename_type
Rename a type across all files in the project.
```
file_path: "/path/to/File.elm"
line: 28
character: 0
old_name: "OldTypeName"   # REQUIRED: safety check
newName: "NewTypeName"
```

#### elm_rename_function
Rename a function across all files in the project.
```
file_path: "/path/to/File.elm"
line: 28
character: 0
old_name: "oldFunctionName"   # REQUIRED: safety check
newName: "newFunctionName"
```

#### elm_rename_field
Rename a record field across all files in the project.
```
file_path: "/path/to/File.elm"
line: 28
character: 0
old_name: "oldFieldName"   # REQUIRED: safety check
newName: "newFieldName"
```

---

### Moving Code

#### elm_move_function
Move a function from one module to another.
```
file_path: "/path/to/Source.elm"
line: 28           # line where function is defined
character: 0
function_name: "myFunction"   # REQUIRED: safety check
target_module: "/path/to/Target.elm"
```

#### elm_rename_file
Rename an Elm file and update module declaration + all imports.
```
file_path: "/path/to/OldName.elm"
new_name: "NewName.elm"
```

#### elm_move_file
Move an Elm file to a new location and update everything.
```
file_path: "/path/to/File.elm"
target_path: "src/Utils/File.elm"
```

---

### Smart Variant Removal

#### elm_prepare_remove_variant
Analyze a variant before removal - shows blocking usages vs auto-removable patterns.
```
file_path: "/path/to/Types.elm"
line: 15           # line of the variant (e.g., "| MyVariant")
character: 4       # position within variant name
variant_name: "MyVariant"   # optional: safety check
```

Returns:
- `canRemove`: true if no blocking (constructor) usages
- `blockingUsages`: constructor usages that must be replaced manually
- `patternUsages`: pattern matches that will be auto-removed
- `otherVariants`: alternative variants to use

#### elm_remove_variant
Remove a variant and auto-remove its pattern match branches.
```
file_path: "/path/to/Types.elm"
line: 15
character: 4
variant_name: "MyVariant"   # REQUIRED: safety check
```

**Workflow:**
1. Call `elm_prepare_remove_variant` to check feasibility
2. If blocked: user must replace constructor usages with other variants
3. If clear: call `elm_remove_variant` to remove variant + patterns

---

## Important Notes

- **Line/character positions are 0-indexed** (subtract 1 from editor display)
- **Always verify compilation** after refactoring: `lamdera make src/Frontend.elm src/Backend.elm`
- These tools understand Elm's scope and semantics - safer than text replace

## Why Use LSP Tools

| Manual Edit | LSP Tool |
|-------------|----------|
| Misses references | Finds ALL references |
| Breaks qualified imports | Updates `Module.func` correctly |
| Can rename wrong symbols | Scope-aware, precise |
| Multiple file edits | Single operation |
| Error-prone | Safe and verified |
