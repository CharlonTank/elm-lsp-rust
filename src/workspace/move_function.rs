//! Move function operations for the Elm workspace.
//!
//! Contains functions for moving Elm functions between modules, including
//! import cycle detection, code extraction, and reference updates.

use std::collections::HashMap;
use std::path::Path;
use tower_lsp::lsp_types::*;

use super::{MoveResult, Workspace, LAMDERA_PROTECTED_TYPES};

impl Workspace {
    /// Check if moving a function from source to target would create an import cycle.
    /// After a move, source will import target (so existing usages of the moved function work).
    /// If target already imports source (directly or indirectly), adding source→target creates a cycle.
    pub(super) fn would_create_import_cycle(
        &self,
        source_module_name: &str,
        target_module_name: &str,
    ) -> bool {
        // Check: can target reach source through imports?
        // If yes, adding source→target would create a cycle
        let mut visited = std::collections::HashSet::new();
        let mut stack = vec![target_module_name.to_string()];

        while let Some(current) = stack.pop() {
            if current == source_module_name {
                return true; // target can reach source, cycle would be created
            }
            if visited.contains(&current) {
                continue;
            }
            visited.insert(current.clone());

            // Get imports of current module
            if let Some(module) = self.modules.get(&current) {
                for import in &module.imports {
                    if !visited.contains(&import.module_name) {
                        stack.push(import.module_name.clone());
                    }
                }
            }
        }

        false // No path from target to source, safe to move
    }

    /// Move a function from one module to another
    /// Returns the workspace edits needed to perform the move
    pub fn move_function(
        &self,
        source_uri: &Url,
        function_name: &str,
        target_path: &Path,
    ) -> anyhow::Result<MoveResult> {
        // Block moving protected Lamdera types
        if self.is_lamdera_project && LAMDERA_PROTECTED_TYPES.contains(&function_name) {
            return Err(anyhow::anyhow!(
                "Cannot move {} in a Lamdera project - this type is required by Lamdera",
                function_name
            ));
        }

        let source_path = source_uri
            .to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid source URI"))?;

        // Find source module
        let source_module = self
            .find_module_by_path(&source_path)
            .ok_or_else(|| anyhow::anyhow!("Source module not found"))?;

        let source_module_name = source_module.module_name.clone();

        // Find target module
        let target_module = self
            .find_module_by_path(target_path)
            .ok_or_else(|| anyhow::anyhow!("Target module not found"))?;

        let target_module_name = target_module.module_name.clone();

        // Check for import cycle before proceeding
        if self.would_create_import_cycle(&source_module_name, &target_module_name) {
            return Err(anyhow::anyhow!(
                "Cannot move function: would create import cycle ({} imports {} directly or indirectly)",
                source_module_name,
                target_module_name
            ));
        }

        // Find the function in source module
        let function = source_module
            .symbols
            .iter()
            .find(|s| s.name == function_name && s.kind == SymbolKind::FUNCTION)
            .ok_or_else(|| anyhow::anyhow!("Function not found in source module"))?;

        // Read source file content
        let source_content = std::fs::read_to_string(&source_path)?;
        let source_lines: Vec<&str> = source_content.lines().collect();

        // Extract function definition (type signature + body)
        let (func_start_line, func_end_line) = find_function_bounds(
            &source_content,
            function_name,
            function.range.start.line as usize,
        );

        // Get the function text (including type signature if present)
        let function_text: String = source_lines[func_start_line..=func_end_line].join("\n");

        // Read target file content
        let target_content = std::fs::read_to_string(target_path)?;

        // Find insertion point in target (after imports, before first definition)
        let target_insert_line = find_insertion_point(&target_content);

        // Create target URI
        let target_uri =
            Url::from_file_path(target_path).map_err(|_| anyhow::anyhow!("Invalid target path"))?;

        // Find all references to this function
        let refs = self.find_references(function_name, Some(&source_module_name));

        // Build the result
        let mut source_edits = Vec::new();
        let mut target_edits = Vec::new();
        let mut reference_edits: HashMap<Url, Vec<TextEdit>> = HashMap::new();

        // 1. Remove function from source file
        source_edits.push(TextEdit {
            range: Range {
                start: Position {
                    line: func_start_line as u32,
                    character: 0,
                },
                end: Position {
                    line: (func_end_line + 1) as u32,
                    character: 0,
                },
            },
            new_text: String::new(),
        });

        // 2. Add import for the moved function in source file (so existing local usages still work)
        let import_text = format!(
            "import {} exposing ({})\n",
            target_module_name, function_name
        );
        let source_import_line = find_import_insertion_point(&source_content);
        source_edits.push(TextEdit {
            range: Range {
                start: Position {
                    line: source_import_line as u32,
                    character: 0,
                },
                end: Position {
                    line: source_import_line as u32,
                    character: 0,
                },
            },
            new_text: import_text,
        });

        // 2b. Remove function from source file's exposing list
        if let Some(unexpose_edit) = create_unexpose_edit(&source_content, function_name) {
            source_edits.push(unexpose_edit);
        }

        // 3. Add function to target file
        let target_text = format!("\n\n{}\n", function_text);
        target_edits.push(TextEdit {
            range: Range {
                start: Position {
                    line: target_insert_line as u32,
                    character: 0,
                },
                end: Position {
                    line: target_insert_line as u32,
                    character: 0,
                },
            },
            new_text: target_text,
        });

        // 4. Update target module's exposing list to include the new function
        if let Some(exposing_edit) = create_expose_edit(&target_content, function_name) {
            target_edits.push(exposing_edit);
        }

        // 4b. Add import for source module types/functions used in the moved function
        let target_module_ref = self.find_module_by_path(target_path);
        let source_symbols: Vec<String> = source_module
            .symbols
            .iter()
            .filter(|s| {
                // Check if the symbol name appears in the function text
                // Skip the function we're moving itself
                s.name != function_name && is_symbol_used_in_text(&function_text, &s.name)
            })
            .map(|s| s.name.clone())
            .collect();

        if !source_symbols.is_empty() {
            // Check if target already imports source module
            let already_imports_source = target_module_ref
                .map(|tm| {
                    tm.imports
                        .iter()
                        .any(|i| i.module_name == source_module_name)
                })
                .unwrap_or(false);

            if !already_imports_source {
                // Add import for the source module with the needed symbols
                let import_line = find_import_insertion_point(&target_content);
                let import_text = format!(
                    "import {} exposing ({})\n",
                    source_module_name,
                    source_symbols.join(", ")
                );
                target_edits.push(TextEdit {
                    range: Range {
                        start: Position {
                            line: import_line as u32,
                            character: 0,
                        },
                        end: Position {
                            line: import_line as u32,
                            character: 0,
                        },
                    },
                    new_text: import_text,
                });
            }
        }

        // 5. Update references in other files to use qualified name
        for r in &refs {
            // Skip references in source and target files (handled separately)
            if r.uri == *source_uri || r.uri == target_uri {
                continue;
            }

            // Check if the file already imports from target module
            let ref_path = match r.uri.to_file_path() {
                Ok(p) => p,
                Err(_) => continue,
            };

            let ref_module = self.find_module_by_path(&ref_path);

            if let Some(rm) = ref_module {
                let has_target_import = rm
                    .imports
                    .iter()
                    .any(|i| i.module_name == target_module_name);

                if has_target_import {
                    // Already imports target, just update the reference
                    reference_edits
                        .entry(r.uri.clone())
                        .or_default()
                        .push(TextEdit {
                            range: r.range,
                            new_text: function_name.to_string(),
                        });
                } else {
                    // Need to add import and potentially qualify the reference
                    let ref_content = std::fs::read_to_string(&ref_path)?;
                    let import_line = find_import_insertion_point(&ref_content);

                    reference_edits
                        .entry(r.uri.clone())
                        .or_default()
                        .push(TextEdit {
                            range: Range {
                                start: Position {
                                    line: import_line as u32,
                                    character: 0,
                                },
                                end: Position {
                                    line: import_line as u32,
                                    character: 0,
                                },
                            },
                            new_text: format!(
                                "import {} exposing ({})\n",
                                target_module_name, function_name
                            ),
                        });
                }
            }
        }

        // Combine all edits
        let mut all_changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();
        all_changes.insert(source_uri.clone(), source_edits);
        all_changes.insert(target_uri.clone(), target_edits);
        for (uri, edits) in reference_edits {
            all_changes.entry(uri).or_default().extend(edits);
        }

        Ok(MoveResult {
            changes: all_changes,
            source_module: source_module_name,
            target_module: target_module_name,
            function_name: function_name.to_string(),
            references_updated: refs.len(),
        })
    }
}

/// Find the start and end lines of a function definition
fn find_function_bounds(content: &str, name: &str, approx_line: usize) -> (usize, usize) {
    let lines: Vec<&str> = content.lines().collect();
    let mut start_line = approx_line;
    let mut end_line = approx_line;

    // Look backwards for type signature
    if start_line > 0 {
        for i in (0..start_line).rev() {
            let line = lines[i].trim();
            if line.is_empty() {
                break;
            }
            // Check if this is a type signature for our function
            if line.starts_with(&format!("{} :", name)) {
                start_line = i;
                break;
            }
            // If we hit another definition, stop
            if line.contains(" =") && !line.starts_with(&format!("{} ", name)) {
                break;
            }
        }
    }

    // Look forwards for end of function
    let mut indent_level = None;
    for i in approx_line..lines.len() {
        let line = lines[i];

        if line.is_empty() {
            // Empty line might be end of function
            if i > approx_line {
                // Check if next non-empty line is a new definition
                for next_line in lines[(i + 1)..].iter().map(|l| l.trim()) {
                    if next_line.is_empty() {
                        continue;
                    }
                    // If next non-empty line is a top-level definition, we're done
                    if !next_line.starts_with(' ') && !next_line.starts_with('\t') {
                        end_line = i - 1;
                        return (start_line, end_line);
                    }
                    break;
                }
            }
            continue;
        }

        // Track indentation to find end of function
        let trimmed = line.trim_start();
        let current_indent = line.len() - trimmed.len();

        if indent_level.is_none() && !line.is_empty() && line.contains('=') {
            // Found the function definition line, track its indent
            indent_level = Some(current_indent);
        }

        if let Some(base_indent) = indent_level {
            // If we hit a line with same or less indentation that's not empty
            // and it looks like a new definition, stop
            if current_indent <= base_indent && i > approx_line {
                let trimmed = line.trim();
                let is_elm_keyword = trimmed.starts_with("else")
                    || trimmed.starts_with("then")
                    || trimmed.starts_with("in ")
                    || trimmed == "in"
                    || trimmed.starts_with("of")
                    || trimmed.starts_with("let")
                    || trimmed.starts_with("case")
                    || trimmed.starts_with("if ")
                    || trimmed.starts_with("->")
                    || trimmed.starts_with("|")
                    || trimmed.starts_with(",")
                    || trimmed.starts_with("}")
                    || trimmed.starts_with("]")
                    || trimmed.starts_with(")");
                if !is_elm_keyword
                    && (trimmed
                        .chars()
                        .next()
                        .map(|c| c.is_lowercase())
                        .unwrap_or(false)
                        || trimmed.starts_with("type ")
                        || trimmed.starts_with("port "))
                {
                    end_line = i - 1;
                    while end_line > start_line && lines[end_line].trim().is_empty() {
                        end_line -= 1;
                    }
                    return (start_line, end_line);
                }
            }
        }

        end_line = i;
    }

    // Trim trailing empty lines
    while end_line > start_line && lines[end_line].trim().is_empty() {
        end_line -= 1;
    }

    (start_line, end_line)
}

/// Check if a symbol name is used in a piece of text (as a word boundary)
fn is_symbol_used_in_text(text: &str, symbol_name: &str) -> bool {
    // Use word boundary matching to avoid false positives
    // e.g., "Log" should match "Log" but not "Login"
    for word in text.split(|c: char| !c.is_alphanumeric() && c != '_') {
        if word == symbol_name {
            return true;
        }
    }
    false
}

/// Find where to insert a new function in a file (after imports)
fn find_insertion_point(content: &str) -> usize {
    let lines: Vec<&str> = content.lines().collect();
    let mut last_import_line = 0;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("import ") {
            last_import_line = i;
        } else if trimmed.starts_with("type ")
            || trimmed.starts_with("port ")
            || (trimmed
                .chars()
                .next()
                .map(|c| c.is_lowercase())
                .unwrap_or(false)
                && trimmed.contains('='))
        {
            // Found first definition after imports
            return i;
        }
    }

    // Return line after last import
    last_import_line + 2
}

/// Find where to insert a new import
fn find_import_insertion_point(content: &str) -> usize {
    let lines: Vec<&str> = content.lines().collect();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("import ") {
            return i; // Insert before first import
        }
    }

    // If no imports, insert after module declaration
    for (i, line) in lines.iter().enumerate() {
        if line.trim().starts_with("module ") {
            return i + 2; // Skip module line and empty line
        }
    }

    2 // Default to line 3
}

/// Create an edit to remove a function from the module's exposing list
fn create_unexpose_edit(content: &str, function_name: &str) -> Option<TextEdit> {
    let lines: Vec<&str> = content.lines().collect();

    // Find the module declaration line
    let mut module_start_line = None;
    for (line_num, line) in lines.iter().enumerate() {
        if line.contains("module ") && line.contains(" exposing ") {
            module_start_line = Some(line_num);
            break;
        }
    }

    let start_line = module_start_line?;

    // If exposing (..), nothing to do
    if lines[start_line].contains("exposing (..)") {
        return None;
    }

    // Find the full exposing list (may span multiple lines)
    let mut exposing_end_line = start_line;
    for (i, line) in lines[start_line..].iter().enumerate() {
        if line.contains(')') {
            exposing_end_line = start_line + i;
            break;
        }
    }

    // Get the full exposing text
    let exposing_text: String = lines[start_line..=exposing_end_line].join("\n");

    // Find "exposing (" position
    let exposing_start = exposing_text.find("exposing (")?;
    let list_start = exposing_start + "exposing (".len();
    let list_end = exposing_text.rfind(')')?;

    // Get just the list content
    let list_content = &exposing_text[list_start..list_end];

    // Parse the items (handle multi-line)
    let items: Vec<&str> = list_content
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    // Find the function in the list
    let func_idx = items.iter().position(|&item| {
        // Handle items like "Type(..)" or just "funcName"
        item == function_name || item.starts_with(&format!("{}(", function_name))
    })?;

    // If this is the only item, we can't remove it (would break the module)
    if items.len() == 1 {
        return None;
    }

    // Rebuild the list without this function
    let new_items: Vec<&str> = items
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != func_idx)
        .map(|(_, item)| *item)
        .collect();

    // Rebuild the exposing clause
    let new_list = format!("exposing ({})", new_items.join(", "));

    // Replace the old exposing clause with the new one
    let old_exposing_start = exposing_text.find("exposing")?;
    let _old_exposing = &exposing_text[old_exposing_start..=list_end];

    // Calculate the actual range in the file
    // Find where "exposing" starts in the original lines
    let mut char_offset = 0;
    for (i, line) in lines[start_line..=exposing_end_line].iter().enumerate() {
        if i == 0 {
            if let Some(pos) = line.find("exposing") {
                char_offset = pos;
                break;
            }
        }
    }

    Some(TextEdit {
        range: Range {
            start: Position {
                line: start_line as u32,
                character: char_offset as u32,
            },
            end: Position {
                line: exposing_end_line as u32,
                character: lines[exposing_end_line]
                    .find(')')
                    .map(|p| p + 1)
                    .unwrap_or(0) as u32,
            },
        },
        new_text: new_list,
    })
}

/// Create an edit to add a function to the module's exposing list
fn create_expose_edit(content: &str, function_name: &str) -> Option<TextEdit> {
    let lines: Vec<&str> = content.lines().collect();

    for (line_num, line) in lines.iter().enumerate() {
        if line.contains("module ") && line.contains(" exposing ") {
            // Find the exposing list
            if line.contains("exposing (..)") {
                // Already exposes everything
                return None;
            }

            // Find closing paren of exposing list
            let mut paren_line = line_num;
            let mut found_close = false;

            for (i, l) in lines[line_num..].iter().enumerate() {
                if l.contains(')') {
                    paren_line = line_num + i;
                    found_close = true;
                    break;
                }
            }

            if found_close {
                let closing_line = lines[paren_line];
                if let Some(pos) = closing_line.rfind(')') {
                    return Some(TextEdit {
                        range: Range {
                            start: Position {
                                line: paren_line as u32,
                                character: pos as u32,
                            },
                            end: Position {
                                line: paren_line as u32,
                                character: pos as u32,
                            },
                        },
                        new_text: format!(", {}", function_name),
                    });
                }
            }
        }
    }

    None
}
