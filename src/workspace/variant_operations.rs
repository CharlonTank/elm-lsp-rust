//! Variant operations for the Elm workspace.
//!
//! Contains functions for removing variants from custom types and
//! finding variant usages across the workspace.

use std::collections::HashMap;
use tower_lsp::lsp_types::*;

use super::{ExposingInfo, RemoveVariantResult, UsageType, VariantUsage, Workspace};

impl Workspace {
    /// Remove a variant from a custom type
    pub fn remove_variant(
        &self,
        uri: &Url,
        _type_name: &str,
        variant_name: &str,
        _variant_index: usize,
        total_variants: usize,
    ) -> anyhow::Result<RemoveVariantResult> {
        // 1. Validate: can't remove if only 1 variant
        if total_variants <= 1 {
            return Ok(RemoveVariantResult::error("Cannot remove the only variant from a type"));
        }

        // Get the source module name for proper filtering
        let source_module = self.get_module_name_from_uri(uri);

        // 2. Check for usages and separate by type
        let usages = self.get_variant_usages(uri, variant_name, Some(&source_module));

        // Constructor usages - will be replaced with Debug.todo
        let constructor_usages: Vec<_> = usages
            .iter()
            .filter(|u| u.usage_type == UsageType::Constructor)
            .collect();

        // Pattern match usages can be auto-removed
        let pattern_usages: Vec<_> = usages
            .iter()
            .filter(|u| u.usage_type == UsageType::PatternMatch)
            .collect();

        // 3. Read file and find the variant line
        let path = uri.to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid URI"))?;
        let content = std::fs::read_to_string(&path)?;
        let lines: Vec<&str> = content.lines().collect();

        // Find the variant in the source
        let mut variant_line = None;
        let mut is_first_variant = false;
        let mut next_variant_line = None;

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();
            // Look for the variant name in a type declaration context
            if (trimmed.starts_with('=') || trimmed.starts_with('|')) && trimmed.contains(variant_name) {
                // Check if this is actually our variant (not just containing the name)
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 2 && parts[1] == variant_name {
                    variant_line = Some(i);
                    is_first_variant = trimmed.starts_with('=');

                    // Find next variant line if exists
                    for (offset, next_line) in lines[(i + 1)..].iter().enumerate() {
                        let next_trimmed = next_line.trim();
                        if next_trimmed.starts_with('|') {
                            next_variant_line = Some(i + 1 + offset);
                            break;
                        } else if !next_trimmed.is_empty() && !next_trimmed.starts_with('|') {
                            // Hit something else (not a variant continuation)
                            break;
                        }
                    }
                    break;
                } else if !parts.is_empty() && parts[0] == variant_name {
                    // variant without = or | prefix (shouldn't happen but handle it)
                    variant_line = Some(i);
                    break;
                }
            }
        }

        let variant_line = variant_line.ok_or_else(|| anyhow::anyhow!("Variant line not found in source"))?;

        // 4. Create TextEdits to remove the variant from type definition
        let mut changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();
        let type_def_edits = if is_first_variant {
            // First variant: need to change next | to =
            if let Some(next_line) = next_variant_line {
                // Delete from start of variant line to start of next variant line
                // and replace the | with =
                let next_line_content = lines[next_line];
                let new_next_line = next_line_content.replacen('|', "=", 1);

                vec![
                    TextEdit {
                        range: Range {
                            start: Position { line: variant_line as u32, character: 0 },
                            end: Position { line: next_line as u32, character: 0 },
                        },
                        new_text: String::new(),
                    },
                    TextEdit {
                        range: Range {
                            start: Position { line: next_line as u32, character: 0 },
                            end: Position { line: next_line as u32, character: next_line_content.len() as u32 },
                        },
                        new_text: new_next_line,
                    },
                ]
            } else {
                // Only variant (shouldn't happen - we checked total_variants > 1)
                return Ok(RemoveVariantResult::error("Cannot determine next variant"));
            }
        } else {
            // Middle or last variant: just delete the line
            vec![TextEdit {
                range: Range {
                    start: Position { line: variant_line as u32, character: 0 },
                    end: Position { line: (variant_line + 1) as u32, character: 0 },
                },
                new_text: String::new(),
            }]
        };

        changes.insert(uri.clone(), type_def_edits);

        // 4b. Replace constructor usages with Debug.todo
        for usage in &constructor_usages {
            if let Some(range) = usage.constructor_usage_range {
                let usage_uri = Url::parse(&usage.uri)
                    .map_err(|_| anyhow::anyhow!("Invalid usage URI"))?;

                let replacement = format!("(Debug.todo \"FIXME: Variant Removal: {}\")", variant_name);

                changes
                    .entry(usage_uri)
                    .or_default()
                    .push(TextEdit {
                        range,
                        new_text: replacement,
                    });
            }
        }

        // 5. Add edits to remove all pattern match branches
        // Also collect removed pattern lines for useless wildcard detection
        let mut removed_pattern_lines: Vec<u32> = Vec::new();

        for usage in &pattern_usages {
            if let Some(range) = usage.pattern_branch_range {
                let usage_uri = Url::parse(&usage.uri)
                    .map_err(|_| anyhow::anyhow!("Invalid usage URI"))?;

                removed_pattern_lines.push(range.start.line);

                changes
                    .entry(usage_uri)
                    .or_default()
                    .push(TextEdit {
                        range,
                        new_text: String::new(),
                    });
            }
        }

        // 5b. Find and remove useless wildcards
        // A wildcard is useless if after removal it would cover 0 remaining variants
        let useless_wildcards = self.find_useless_wildcards(
            &content,
            variant_name,
            total_variants,
            &removed_pattern_lines,
        );

        let useless_wildcard_count = useless_wildcards.len();
        for wc_range in useless_wildcards {
            changes
                .entry(uri.clone())
                .or_default()
                .push(TextEdit {
                    range: wc_range,
                    new_text: String::new(),
                });
        }

        // 6. Sort edits in reverse order within each file to avoid offset issues
        Self::sort_edits_reverse(&mut changes);

        let removed_branches = usages
            .iter()
            .filter(|u| u.usage_type == UsageType::PatternMatch && u.pattern_branch_range.is_some())
            .count();

        let replaced_constructors = constructor_usages.len();

        let message = {
            let mut parts = vec![format!("Removed variant '{}'", variant_name)];

            if replaced_constructors > 0 {
                parts.push(format!("replaced {} constructor usage(s) with Debug.todo", replaced_constructors));
            }
            if removed_branches > 0 {
                parts.push(format!("removed {} pattern match branch(es)", removed_branches));
            }
            if useless_wildcard_count > 0 {
                parts.push(format!("removed {} useless wildcard(s)", useless_wildcard_count));
            }

            if parts.len() == 1 {
                parts[0].clone()
            } else {
                format!("{}, {}", parts[0], parts[1..].join(", "))
            }
        };

        Ok(RemoveVariantResult::success(&message, changes))
    }

    /// Find the enclosing function for a given position in a file
    fn find_enclosing_function(&self, uri: &Url, position: Position) -> Option<(String, String)> {
        // Find the module for this URI
        let path = uri.to_file_path().ok()?;

        for (module_name, module) in &self.modules {
            if module.path == path {
                // Find the function that contains this position
                for symbol in &module.symbols {
                    if symbol.kind == SymbolKind::FUNCTION {
                        // Check if position is within this function's range
                        if position.line >= symbol.range.start.line
                            && position.line <= symbol.range.end.line
                        {
                            return Some((symbol.name.clone(), module_name.clone()));
                        }
                    }
                }
                break;
            }
        }
        None
    }

    /// Get usages of a variant and determine if they are blocking
    /// source_module_name: The module where the variant is defined (e.g., "Router" for Router.RentReceipts)
    pub fn get_variant_usages(&self, source_uri: &Url, variant_name: &str, source_module_name: Option<&str>) -> Vec<VariantUsage> {
        let refs = self.find_references(variant_name, None);
        let mut usages = Vec::new();

        // Get the source module name if not provided
        let source_module = source_module_name
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.get_module_name_from_uri(source_uri));

        // Get the variant definition line to skip it
        let source_path = source_uri.to_file_path().ok();
        let source_content = source_path.as_ref().and_then(|p| std::fs::read_to_string(p).ok());

        // Group references by file for efficient batch processing
        let mut refs_by_file: HashMap<String, Vec<&super::SymbolReference>> = HashMap::new();
        for r in &refs {
            // Skip the definition itself
            if r.is_definition {
                continue;
            }

            // Skip Evergreen migration files - they are historical snapshots
            if r.uri.path().contains("/Evergreen/") {
                continue;
            }

            // Skip the variant declaration in the type definition
            if r.uri == *source_uri {
                if let Some(ref content) = source_content {
                    let lines: Vec<&str> = content.lines().collect();
                    if let Some(line) = lines.get(r.range.start.line as usize) {
                        let trimmed = line.trim();
                        if (trimmed.starts_with('=') || trimmed.starts_with('|'))
                            && trimmed.contains(variant_name)
                        {
                            continue;
                        }
                    }
                }
            }

            refs_by_file
                .entry(r.uri.to_string())
                .or_default()
                .push(r);
        }

        // Process each file once
        for (uri_str, file_refs) in refs_by_file {
            let uri = match Url::parse(&uri_str) {
                Ok(u) => u,
                Err(_) => continue,
            };

            // Read content once per file
            let content = match self.read_file_content(&uri) {
                Some(c) => c,
                None => continue,
            };

            // Parse once per file
            let tree = match self.parser.parse(&content) {
                Some(t) => t,
                None => continue,
            };

            let ref_module_name = self.get_module_name_from_uri(&uri);

            // Get imports for this file to check if variant is imported from source module
            let uri_path = uri.to_file_path().unwrap_or_default();
            let file_imports = self.find_module_by_path(&uri_path)
                .map(|m| m.imports.clone())
                .unwrap_or_default();

            // Check if this file imports the variant from the source module
            let imports_from_source = file_imports.iter().any(|import| {
                if import.module_name == source_module {
                    match &import.exposing {
                        ExposingInfo::All => true,
                        ExposingInfo::Explicit(exposed) => {
                            // Check if variant is exposed directly or via type(..)
                            exposed.iter().any(|e| {
                                e == variant_name || e.contains("(..)")
                            })
                        }
                    }
                } else {
                    false
                }
            });

            // Check if this file has a LOCAL type definition with the same variant name
            // This is important for shadowing: a local type shadows an imported type
            let has_local_type_with_variant = self.find_module_by_path(&uri_path)
                .map(|m| {
                    m.symbols.iter().any(|sym| {
                        sym.kind == SymbolKind::ENUM &&
                        sym.variants.iter().any(|v| v.name == variant_name)
                    })
                })
                .unwrap_or(false);

            // Get the alias used for the source module (if any)
            let source_module_alias = file_imports.iter()
                .find(|import| import.module_name == source_module)
                .and_then(|import| import.alias.clone());

            // Process all refs in this file with the cached tree
            for r in file_refs {
                let position = Position {
                    line: r.range.start.line,
                    character: r.range.start.character,
                };

                // Check if this reference is actually from the source module
                let line = content.lines().nth(position.line as usize).unwrap_or("");
                let col = position.character as usize;
                let before_pos = if col > 0 && col <= line.len() { &line[..col] } else { "" };

                let is_from_source_module = if uri == *source_uri {
                    // Same file as definition - it's our variant
                    true
                } else if before_pos.ends_with('.') {
                    // Qualified reference - extract the qualifier and check
                    let qualifier = before_pos.trim_end_matches('.')
                        .rsplit(|c: char| !c.is_alphanumeric() && c != '.')
                        .next()
                        .unwrap_or("");

                    // Check if qualifier matches source module or its alias
                    qualifier == source_module
                        || qualifier == source_module.rsplit('.').next().unwrap_or(&source_module)
                        || source_module_alias.as_ref().map(|a| a == qualifier).unwrap_or(false)
                } else {
                    // Unqualified reference - only valid if imported from source module
                    // BUT if this file has a local type with the same variant, the local shadows the import
                    imports_from_source && !has_local_type_with_variant
                };

                if !is_from_source_module {
                    continue;
                }

                // Get context from cached content
                let context = content
                    .lines()
                    .nth(r.range.start.line as usize)
                    .map(|l| l.trim().to_string())
                    .unwrap_or_default();

                // Use helper to create usage (handles classification and skipping)
                if let Some(usage) = self.create_variant_usage(
                    &tree,
                    &content,
                    position,
                    &uri,
                    &ref_module_name,
                    &context,
                ) {
                    usages.push(usage);
                }
            }
        }

        // Supplemental grep-based search to catch references missed by the indexed search
        // This is especially important for qualified references like Module.Variant
        let existing_locations: std::collections::HashSet<(String, u32, u32)> = usages
            .iter()
            .map(|u| (u.uri.clone(), u.line, u.character))
            .collect();

        for (module, module_uri) in self.iter_non_evergreen_modules() {
            let content = match std::fs::read_to_string(&module.path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Check if this module has a LOCAL type with the same variant name
            let module_has_local_variant = module.symbols.iter().any(|sym| {
                sym.kind == SymbolKind::ENUM &&
                sym.variants.iter().any(|v| v.name == variant_name)
            });

            // For modules with local shadowing types, only search for qualified references
            // For other modules, search for both qualified and unqualified
            let patterns = if module_has_local_variant && module_uri != *source_uri {
                // Only qualified references like Event.MeetOnline
                vec![format!("{}.{}", source_module, variant_name)]
            } else {
                vec![
                    variant_name.to_string(),
                    format!("{}.{}", source_module, variant_name),
                ]
            };

            // Parse once per file for efficiency
            let tree = match self.parser.parse(&content) {
                Some(t) => t,
                None => continue,
            };

            for (line_num, line) in content.lines().enumerate() {
                // Skip type definitions (lines starting with = or |)
                let trimmed = line.trim();
                if (trimmed.starts_with('=') || trimmed.starts_with('|'))
                    && trimmed.contains(variant_name)
                {
                    continue;
                }

                // Skip import statements
                if trimmed.starts_with("import ") {
                    continue;
                }

                for pattern in &patterns {
                    // Find all occurrences of the pattern on this line
                    let mut search_start = 0;
                    while let Some(rel_col) = line[search_start..].find(pattern.as_str()) {
                        let col = search_start + rel_col;
                        search_start = col + 1; // Move past this match for next iteration

                        // For qualified patterns, calculate where the variant name starts
                        let variant_col = if pattern.contains('.') {
                            col + pattern.rfind('.').map(|p| p + 1).unwrap_or(0)
                        } else {
                            col
                        };

                        // Skip if already in usages (check at variant position)
                        let key = (module_uri.to_string(), line_num as u32, variant_col as u32);
                        if existing_locations.contains(&key) {
                            continue;
                        }

                        // Check if it's actually our variant (word boundary check)
                        let after_match = col + pattern.len();
                        let char_after = line.chars().nth(after_match);
                        let is_word_boundary = char_after.map(|c| !c.is_alphanumeric() && c != '_').unwrap_or(true);

                        if !is_word_boundary {
                            continue;
                        }

                        // Also check char before for word boundary (avoid matching inside another identifier)
                        if col > 0 {
                            let char_before = line.chars().nth(col - 1);
                            let is_start_boundary = char_before.map(|c| !c.is_alphanumeric() && c != '_').unwrap_or(true);
                            if !is_start_boundary {
                                continue;
                            }
                        }

                        let position = Position {
                            line: line_num as u32,
                            character: variant_col as u32,
                        };

                        // Use helper to create usage (handles classification and skipping)
                        if let Some(usage) = self.create_variant_usage(
                            &tree,
                            &content,
                            position,
                            &module_uri,
                            &module.module_name,
                            trimmed,
                        ) {
                            usages.push(usage);
                        }
                    }
                }
            }
        }

        usages
    }

    /// Classify a variant usage using a pre-parsed tree (for performance)
    fn classify_usage_with_tree(
        &self,
        tree: &tree_sitter::Tree,
        _content: &str,
        position: Position,
    ) -> UsageType {
        let point = tree_sitter::Point {
            row: position.line as usize,
            column: position.character as usize,
        };

        let node = match tree.root_node().descendant_for_point_range(point, point) {
            Some(n) => n,
            None => return UsageType::Constructor,
        };

        // Walk up the tree to find context
        let mut current = Some(node);
        while let Some(n) = current {
            match n.kind() {
                // String literals and comments - the match is inside a string/comment, not actual code
                "string_constant_expr" | "regular_string_part" | "open_quote"
                | "close_quote" | "string_escape" | "line_comment" | "block_comment" => {
                    return UsageType::StringLiteral;
                }
                "case_of_branch" | "pattern" | "union_pattern" => {
                    return UsageType::PatternMatch;
                }
                "type_annotation" | "type_expression" => {
                    return UsageType::TypeSignature;
                }
                "function_call_expr" | "value_expr" | "let_in_expr" | "if_else_expr"
                | "tuple_expr" | "list_expr" | "record_expr" => {
                    return UsageType::Constructor;
                }
                "type_declaration" | "union_variant" => {
                    if n.parent().is_some_and(|p| p.kind() == "type_declaration") {
                        return UsageType::Definition;
                    }
                }
                _ => {}
            }
            current = n.parent();
        }

        UsageType::Constructor
    }

    /// Get pattern branch range using a pre-parsed tree (for performance)
    fn get_pattern_branch_range_with_tree(
        &self,
        tree: &tree_sitter::Tree,
        content: &str,
        position: Position,
    ) -> Option<Range> {
        let point = tree_sitter::Point {
            row: position.line as usize,
            column: position.character as usize,
        };

        let node = tree.root_node().descendant_for_point_range(point, point)?;

        let mut current = Some(node);
        while let Some(n) = current {
            if n.kind() == "case_of_branch" {
                let start = n.start_position();
                let end = n.end_position();

                let lines: Vec<&str> = content.lines().collect();
                let end_line = end.row;
                let end_char = if end_line + 1 < lines.len() {
                    0
                } else {
                    lines.get(end_line).map(|l| l.len()).unwrap_or(0)
                };

                // Start at column 0 to delete the entire line including indentation
                // This prevents leaving orphaned whitespace-only lines inside case expressions
                return Some(Range {
                    start: Position {
                        line: start.row as u32,
                        character: 0,
                    },
                    end: Position {
                        line: (end_line + 1) as u32,
                        character: end_char as u32,
                    },
                });
            }
            current = n.parent();
        }

        None
    }

    /// Get constructor usage range using a pre-parsed tree (for Debug.todo replacement)
    fn get_constructor_usage_range_with_tree(
        &self,
        tree: &tree_sitter::Tree,
        _content: &str,
        position: Position,
    ) -> Option<Range> {
        let point = tree_sitter::Point {
            row: position.line as usize,
            column: position.character as usize,
        };

        let node = tree.root_node().descendant_for_point_range(point, point)?;

        // First, check if this node is part of a qualified identifier (like Event.EventCancelled)
        // We need to capture the full qualified name, not just the last part
        let mut qualified_node = node;
        let mut current = Some(node);
        while let Some(n) = current {
            if n.kind() == "upper_case_qid" || n.kind() == "value_qid" {
                qualified_node = n;
                break;
            }
            current = n.parent();
        }

        // Check if this is part of a function call (variant with args)
        current = Some(qualified_node);
        while let Some(n) = current {
            if n.kind() == "function_call_expr" {
                // Check if the function being called is our variant
                if let Some(func_node) = n.child(0) {
                    if func_node.start_position().row == qualified_node.start_position().row
                        && func_node.start_position().column == qualified_node.start_position().column
                    {
                        // This is a function call where our variant is the function
                        return Some(Range {
                            start: Position {
                                line: n.start_position().row as u32,
                                character: n.start_position().column as u32,
                            },
                            end: Position {
                                line: n.end_position().row as u32,
                                character: n.end_position().column as u32,
                            },
                        });
                    }
                }
            }
            current = n.parent();
        }

        // Simple variant without arguments - use the qualified node range
        Some(Range {
            start: Position {
                line: qualified_node.start_position().row as u32,
                character: qualified_node.start_position().column as u32,
            },
            end: Position {
                line: qualified_node.end_position().row as u32,
                character: qualified_node.end_position().column as u32,
            },
        })
    }

    /// Helper to create a VariantUsage from a position, returns None if usage should be skipped
    fn create_variant_usage(
        &self,
        tree: &tree_sitter::Tree,
        content: &str,
        position: Position,
        uri: &Url,
        module_name: &str,
        context: &str,
    ) -> Option<VariantUsage> {
        let usage_type = self.classify_usage_with_tree(tree, content, position);

        // Skip type signatures, definitions, and string literals
        if matches!(
            usage_type,
            UsageType::TypeSignature | UsageType::Definition | UsageType::StringLiteral
        ) {
            return None;
        }

        let pattern_branch_range = if usage_type == UsageType::PatternMatch {
            self.get_pattern_branch_range_with_tree(tree, content, position)
        } else {
            None
        };

        let constructor_usage_range = if usage_type == UsageType::Constructor {
            self.get_constructor_usage_range_with_tree(tree, content, position)
        } else {
            None
        };

        let function_name = self
            .find_enclosing_function(uri, position)
            .map(|(fn_name, _)| fn_name)
            .unwrap_or_default();

        Some(VariantUsage {
            uri: uri.to_string(),
            line: position.line,
            character: position.character,
            is_blocking: usage_type == UsageType::Constructor,
            context: context.to_string(),
            function_name: if function_name.is_empty() {
                None
            } else {
                Some(function_name)
            },
            module_name: module_name.to_string(),
            call_chain: Vec::new(),
            usage_type,
            pattern_branch_range,
            constructor_usage_range,
        })
    }

    /// Find useless wildcards in case expressions after removing a variant.
    /// A wildcard becomes useless when it was only covering the variant being removed.
    ///
    /// Returns a list of (case_start_line, wildcard_branch_range) for wildcards that should be removed.
    fn find_useless_wildcards(
        &self,
        content: &str,
        _variant_name: &str,
        total_variants: usize,
        removed_pattern_lines: &[u32],
    ) -> Vec<Range> {
        let mut useless_wildcards = Vec::new();

        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&tree_sitter_elm::LANGUAGE.into()).ok();
        let tree = match parser.parse(content, None) {
            Some(t) => t,
            None => return useless_wildcards,
        };

        // Find all case_of_expr nodes in the tree
        let mut cursor = tree.walk();
        let mut case_exprs = Vec::new();
        Self::collect_case_expressions(&mut cursor, &mut case_exprs);

        for case_node in case_exprs {
            // Find all branches in this case expression
            let mut branches = Vec::new();
            let mut has_wildcard = false;
            let mut wildcard_branch: Option<tree_sitter::Node> = None;
            let mut explicit_count = 0;

            for i in 0..case_node.named_child_count() {
                if let Some(child) = case_node.named_child(i) {
                    if child.kind() == "case_of_branch" {
                        branches.push(child);

                        // Check if this branch is being removed (matched by pattern line)
                        let branch_start = child.start_position().row as u32;
                        if removed_pattern_lines.contains(&branch_start) {
                            continue;
                        }

                        // Check if this is a wildcard pattern
                        if let Some(pattern) = child.child_by_field_name("pattern") {
                            if Self::is_wildcard_pattern(&pattern, content) {
                                has_wildcard = true;
                                wildcard_branch = Some(child);
                            } else if Self::is_union_pattern(&pattern) {
                                explicit_count += 1;
                            }
                        }
                    }
                }
            }

            // Check if wildcard becomes useless after removal
            // A wildcard is useless if:
            // - There is a wildcard
            // - After removal, (total_variants - 1) == explicit_count
            // This means the wildcard would cover 0 remaining variants
            let remaining_variants = total_variants.saturating_sub(1);
            if has_wildcard && remaining_variants == explicit_count {
                if let Some(wc_branch) = wildcard_branch {
                    let start = wc_branch.start_position();
                    let end = wc_branch.end_position();

                    // Include the newline after if present
                    let lines: Vec<&str> = content.lines().collect();
                    let end_line = end.row;
                    let end_char = if end_line + 1 < lines.len() {
                        0 // Start of next line
                    } else {
                        lines.get(end_line).map(|l| l.len()).unwrap_or(0)
                    };

                    useless_wildcards.push(Range {
                        start: Position {
                            line: start.row as u32,
                            character: start.column as u32,
                        },
                        end: Position {
                            line: (end_line + 1) as u32,
                            character: end_char as u32,
                        },
                    });
                }
            }
        }

        useless_wildcards
    }

    /// Recursively collect all case_of_expr nodes in the tree
    fn collect_case_expressions<'a>(cursor: &mut tree_sitter::TreeCursor<'a>, cases: &mut Vec<tree_sitter::Node<'a>>) {
        let node = cursor.node();
        if node.kind() == "case_of_expr" {
            cases.push(node);
        }

        if cursor.goto_first_child() {
            loop {
                Self::collect_case_expressions(cursor, cases);
                if !cursor.goto_next_sibling() {
                    break;
                }
            }
            cursor.goto_parent();
        }
    }

    /// Check if a pattern is a wildcard (_) or catchall (lowercase name without constructor)
    fn is_wildcard_pattern(pattern: &tree_sitter::Node, content: &str) -> bool {
        let pattern_text = pattern.utf8_text(content.as_bytes()).unwrap_or("");
        let trimmed = pattern_text.trim();

        // Check for underscore wildcard
        if trimmed == "_" {
            return true;
        }

        // Check for lowercase name (catchall like `other` or `x`)
        // Must be a single lowercase identifier, not a constructor pattern
        if pattern.kind() == "lower_pattern" || pattern.kind() == "anything_pattern" {
            return true;
        }

        // Check if it's just a lowercase word
        if trimmed.chars().next().map(|c| c.is_lowercase()).unwrap_or(false)
            && !trimmed.contains(' ')
            && !trimmed.contains('(')
        {
            return true;
        }

        false
    }

    /// Check if a pattern is a union/constructor pattern (uppercase name)
    fn is_union_pattern(pattern: &tree_sitter::Node) -> bool {
        pattern.kind() == "union_pattern" || pattern.kind() == "upper_case_qid"
    }
}
