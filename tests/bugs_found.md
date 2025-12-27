# Bugs Found During Deep Manual Testing

Testing on **real meetdown codebase** with `lamdera make` compilation.

## Test Protocol

1. **Backup**: `cp -r $PROJECT_DIR /tmp/project_backup`
2. **Restore**: `rm -rf $PROJECT_DIR && cp -r /tmp/project_backup $PROJECT_DIR`
3. **Compile**: `cd $PROJECT_DIR && lamdera make src/Backend.elm src/Frontend.elm`

---

## Fixed Bugs

### Bug 1: `elm_rename_field` ne renomme pas toutes les occurrences (FIXED)

**Original issue**: Only 2 edits applied when renaming `navigationKey` field.

**Root cause**: The `references` endpoint wasn't using type-aware reference finding.

**Fix**: Updated `references` function in `server.rs` to use `classify_definition_at_position`
and call type-specific reference finders (`find_field_references_typed` for fields).

**Note**: This is actually correct behavior - there are TWO `navigationKey` fields:
- `LoadingFrontend.navigationKey` → 3 references (1 definition + 2 usages)
- `LoadedFrontend.navigationKey` → 6 references (1 definition + 5 usages)

Type-aware renaming correctly renames only the specific field being targeted.

### Bug 2: `elm_remove_variant` Debug.todo missing parentheses (FIXED)

**Fix**: Wrapped Debug.todo in parentheses in `workspace.rs:1377`

---

## Test Results (with lamdera make compilation)

| Tool | Test | Compiles? |
|------|------|-----------|
| `elm_rename_variant` | `PressedLogin` → `ClickedLogin` | ✅ YES |
| `elm_rename_type` | `FrontendUser` → `AppUser` (23 edits in 5 files) | ✅ YES |
| `elm_rename_function` | `newEvent` → `createEvent` (4 edits in 2 files) | ✅ YES |
| `elm_rename_field` | `navigationKey` → `navKey` (type-aware: 3 edits) | ✅ YES |
| `elm_remove_variant` | Remove `NoOpFrontendMsg` | ✅ YES |

---

*Last updated: 2025-12-25*
