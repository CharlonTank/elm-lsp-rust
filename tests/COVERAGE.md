# Test Coverage Mapping

This document maps all MCP tools (features) to their corresponding tests.

## Feature Coverage Summary

| Feature | Fixture Tests | Meetdown Tests | Coverage |
|---------|---------------|----------------|----------|
| elm_completion | 1 | 2 | ✅ Good |
| elm_hover | 1 | 2 | ✅ Good |
| elm_definition | 1 | 2 | ✅ Good |
| elm_references | 1 | 2 | ✅ Good |
| elm_symbols | 1 | 2 | ✅ Good |
| elm_format | 1 | 2 | ✅ Good |
| elm_diagnostics | 2 | 2 | ✅ Excellent |
| elm_code_actions | 1 | 1 | ✅ Good |
| elm_apply_code_action | 0 | 0 | ❌ None |
| elm_prepare_rename | 1 | 2 | ✅ Good |
| elm_rename | 2 | 3 | ✅ Excellent |
| elm_move_function | 1 | 1 | ✅ Good |
| elm_prepare_remove_variant | 3 | 19 | ✅ Excellent |
| elm_remove_variant | 5 | 3 | ✅ Excellent |
| elm_rename_file | 1 | 3 | ✅ Excellent |
| elm_move_file | 1 | 3 | ✅ Excellent |

**Legend:**
- ✅ Excellent: Multiple test cases with comprehensive coverage
- ✅ Good: At least 2 tests covering different scenarios
- ⚠️ Basic: Only 1 test, needs more coverage
- ❌ None: No tests exist

---

## Detailed Test-to-Feature Mapping

### run_tests.mjs (Fixture Tests)

| Test Name | Features Used | Description |
|-----------|---------------|-------------|
| testHover | elm_hover | Get type info for User type |
| testDefinition | elm_definition | Go to definition of User in import |
| testReferences | elm_references | Find all references to User type |
| testSymbols | elm_symbols | List all symbols in Types.elm |
| testPrepareRename | elm_prepare_rename | Check if defaultUser can be renamed |
| testRename | elm_rename | Rename function helper → formatHelper |
| testRenameTypeAlias | elm_rename | Rename type alias Guest → Visitor |
| testDiagnostics | elm_diagnostics | Verify no errors in valid file |
| testDiagnosticsWithError | elm_diagnostics | Detect naming error in Bad.elm |
| testCompletion | elm_completion | Get completions in Main.elm |
| testCodeActions | elm_code_actions | Get available actions |
| testMoveFunction | elm_move_function | Move formatName from Utils to Types |
| testFormat | elm_format | Format Types.elm |
| testPrepareRemoveVariant | elm_prepare_remove_variant | Check Unused variant can be removed |
| testPrepareRemoveVariantWithUsages | elm_prepare_remove_variant | Check Blue has constructor usages |
| testRemoveVariant | elm_remove_variant | Remove Unused from Color type |
| testRemoveVariantWithDebugTodo | elm_remove_variant | Verify constructor replaced with Debug.todo |
| testRemoveVariantPatternAutoRemove | elm_remove_variant | Pattern branches auto-removed with Red |
| testRemoveVariantWithArgs | elm_remove_variant | All 4 TextMsg pattern branches removed |
| testRemoveVariantOnlyVariant | elm_prepare_remove_variant | Error when removing only variant |
| testRemoveVariantUselessWildcard | elm_remove_variant | Useless wildcard auto-removed |
| testRenameFile | elm_rename_file | Rename Utils.elm → Helper.elm |
| testMoveFile | elm_move_file | Move Utils.elm → Helpers/Utils.elm |

### test_meetdown_comprehensive.mjs (Real-World Tests)

| Test # | Features Used | Description |
|--------|---------------|-------------|
| 1 | elm_prepare_remove_variant | MeetOnlineAndInPerson blocking test |
| 2 | elm_prepare_remove_variant | EventCancelled usage analysis |
| 3 | elm_prepare_remove_variant | GroupVisibility variants analysis |
| 4 | elm_prepare_remove_variant | PastOngoingOrFuture 3 variants |
| 5 | elm_remove_variant | Try to remove EventCancelled |
| 6 | elm_remove_variant | MeetOnline constructor replaced with Debug.todo |
| 7 | elm_prepare_remove_variant | Error types analysis |
| 8 | elm_prepare_remove_variant | Large Msg type from GroupPage |
| 9 | elm_prepare_remove_variant | Response structure verification |
| 10 | elm_prepare_remove_variant | AdminStatus cross-file detection |
| 11 | elm_prepare_remove_variant | ColorTheme cross-file analysis |
| 12 | elm_prepare_remove_variant | Language type (4 variants) |
| 13 | elm_prepare_remove_variant | Route type (11 variants) |
| 14 | elm_prepare_remove_variant | EventName.Error (Err constructor) |
| 15 | elm_prepare_remove_variant | Performance timing on GroupPage |
| 16 | elm_remove_variant | Pattern-only variant removal |
| 17 | elm_prepare_remove_variant | FrontendMsg large union |
| 18 | elm_prepare_remove_variant | ToBackend message analysis |
| 19 | elm_prepare_remove_variant | Log type complex payloads |
| 20 | elm_prepare_remove_variant | Token type with Maybe payload |
| 21 | elm_prepare_remove_variant | FrontendModel 2-variant type |
| 22 | elm_prepare_remove_variant | Backend.elm performance |
| 23 | elm_prepare_remove_variant | LoginStatus variants |
| 24 | elm_prepare_remove_variant | GroupRequest nested type |
| 25 | elm_prepare_remove_variant | AdminCache 3 variants |
| 26 | elm_rename_file | HtmlId.elm → DomId.elm |
| 27 | elm_rename_file | Link.elm → WebLink.elm (with imports) |
| 28 | elm_move_file | Cache.elm → Utils/Cache.elm |
| 29 | elm_move_file | Privacy.elm → Types/Privacy.elm |
| 30 | elm_rename_file | Reject invalid extension |
| 31 | elm_move_file | Reject invalid target extension |
| 32 | elm_rename, elm_references | Rename function no corruption |
| 33 | elm_rename, elm_references | Rename type alias cross-file |
| 34 | elm_rename | Rename type alias same-file |
| 35 | elm_hover | Hover on FrontendModel type |
| 36 | elm_hover | Hover on cross-module function |
| 37 | elm_definition | Go to definition cross-file |
| 38 | elm_definition | Go to definition same file |
| 39 | elm_completion | Completion after module qualifier |
| 40 | elm_completion | Completion for local values |
| 41 | elm_symbols | Document symbols in large file |
| 42 | elm_symbols | Document symbols in Types.elm |
| 43 | elm_format | Format small file |
| 44 | elm_format | Format large file performance |
| 45 | elm_diagnostics | Diagnostics on valid file |
| 46 | elm_diagnostics | Diagnostics performance on large file |
| 47 | elm_code_actions | Code actions at function |
| 48 | elm_prepare_rename | Prepare rename on type |
| 49 | elm_prepare_rename | Prepare rename on local function |
| 50 | elm_move_function | Move function between modules |

---

## Features Needing More Tests

### High Priority (No tests)
1. **elm_apply_code_action** - No tests exist

### Well Covered
All other features now have at least 2 tests with both fixture and meetdown coverage:
- elm_completion, elm_hover, elm_definition (2-3 tests each)
- elm_references, elm_symbols, elm_format (3 tests each)
- elm_diagnostics, elm_code_actions (3-4 tests each)
- elm_prepare_rename, elm_move_function (2-3 tests each)
- elm_rename (5 tests)
- elm_prepare_remove_variant (22 tests)
- elm_remove_variant (8 tests)
- elm_rename_file, elm_move_file (4 tests each)

---

## Test Execution

```bash
# Run fixture tests (23 tests)
node tests/run_tests.mjs

# Run meetdown real-world tests (99 tests)
node tests/test_meetdown_comprehensive.mjs

# Run all tests
node tests/run_tests.mjs && node tests/test_meetdown_comprehensive.mjs
```

---

*Last updated: 2025-12-22 - All 123 tests passing ✅*
