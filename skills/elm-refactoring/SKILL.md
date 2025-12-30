---
name: elm-refactoring
description: Use elm-lsp-rust MCP tools for all Elm code operations. Provides navigation, refactoring, diagnostics, and smart variant removal - prefer these over manual text edits.
---

# Elm Language Server Tools (elm-lsp-rust)

When working in an Elm project (has `elm.json`), use these MCP tools instead of manual text search/replace or file edits.

## When to Use This Skill

Activate automatically when the user works with Elm code and needs to:
- **Navigate**: Go to definition, find references, get symbols
- **Refactor**: Rename symbols, move functions, rename/move files
- **Maintain types**: Add/remove variants, add/remove fields
- **Check code**: Get diagnostics, code actions, format

## Available MCP Tools

All tools use the `mcp__plugin_elm-lsp-rust_elr__` prefix.

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
Get compile errors and warnings for a file.
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

- **Line/character positions are 0-indexed**
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
