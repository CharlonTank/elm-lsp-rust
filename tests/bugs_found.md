# Bugs Found During Deep Manual Testing

Testing on **real meetdown codebase** at `/Users/charles-andreassus/projects/meetdown/` with `lamdera make` compilation.

## Test Protocol

1. **Backup**: `cp -r /Users/charles-andreassus/projects/meetdown /tmp/meetdown_real_backup`
2. **Restore**: `rm -rf /Users/charles-andreassus/projects/meetdown && cp -r /tmp/meetdown_real_backup /Users/charles-andreassus/projects/meetdown`
3. **Compile**: `cd /Users/charles-andreassus/projects/meetdown && lamdera make src/Backend.elm src/Frontend.elm`

---

## Bug 1: `elm_rename_field` ne renomme pas toutes les occurrences

**Status**: 🔴 OPEN

**Steps to reproduce**:
1. Open `/Users/charles-andreassus/projects/meetdown/src/Types.elm`
2. Find `navigationKey` field at line 43 (0-indexed: 42)
3. Call `elm_rename_field` with newName="navKey"

**Expected**: All 8+ usages of `navigationKey` in Frontend.elm renamed

**Actual**: Only 2 edits applied. Line 115 still has `navigationKey` instead of `navKey`.

**Compilation error**:
```
-- TYPE MISMATCH ---------------------------------------------- src/Frontend.elm
Hint: Seems like a record field typo. Maybe navigationKey should be navKey?
```

**Impact**: Critical - field renaming leaves code in non-compiling state

---

## Fixed Bugs

### Bug 2: `elm_remove_variant` Debug.todo missing parentheses (FIXED)

**Fix**: Wrapped Debug.todo in parentheses in `workspace.rs:1377`

---

## Test Results (with lamdera make compilation)

| Tool | Test | Compiles? |
|------|------|-----------|
| `elm_rename_variant` | `PressedLogin` → `ClickedLogin` | ✅ YES |
| `elm_rename_type` | `FrontendUser` → `AppUser` (23 edits in 5 files) | ✅ YES |
| `elm_rename_function` | `newEvent` → `createEvent` (4 edits in 2 files) | ✅ YES |
| `elm_rename_field` | `navigationKey` → `navKey` | ❌ NO - missing usages |
| `elm_remove_variant` | Remove `NoOpFrontendMsg` | ✅ YES |

---

*Last updated: 2025-12-22*
