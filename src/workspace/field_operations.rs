//! Field operations for the Elm workspace.
//!
//! Contains functions for removing fields from type aliases and
//! finding field usages across the workspace.

use std::collections::HashMap;
use tower_lsp::lsp_types::*;

use crate::binder::BoundSymbolKind;
use crate::type_checker::{FieldDefinition, TargetTypeAlias};

use super::{FieldInfo, FieldUsage, FieldUsageType, RemoveFieldResult, SymbolReference, Workspace};

impl Workspace {
    /// Get all usages of a field across the workspace
    pub fn get_field_usages(
        &self,
        field_name: &str,
        definition: &FieldDefinition,
    ) -> Vec<FieldUsage> {
        let mut usages = Vec::new();

        // Get all field references using the type checker
        let references = self.find_field_references(field_name, definition);

        for r in &references {
            // Skip Evergreen migration files
            if r.uri.path().contains("/Evergreen/") {
                continue;
            }

            let path = match r.uri.to_file_path() {
                Ok(p) => p,
                Err(_) => continue,
            };

            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Classify the usage type
            let (usage_type, full_range, replacement_text) =
                self.classify_field_usage(&content, r.range.start, field_name);

            // Get context line
            let context = content
                .lines()
                .nth(r.range.start.line as usize)
                .map(|l| l.trim().to_string())
                .unwrap_or_default();

            // Get module name
            let module_name = self
                .find_module_by_path(&path)
                .map(|m| m.module_name.clone())
                .unwrap_or_default();

            usages.push(FieldUsage {
                uri: r.uri.to_string(),
                line: r.range.start.line,
                character: r.range.start.character,
                usage_type,
                context,
                module_name,
                full_range,
                replacement_text,
            });
        }

        usages
    }

    /// Classify a field usage and determine its full range for removal
    /// Returns (usage_type, range, optional_replacement_text)
    fn classify_field_usage(
        &self,
        content: &str,
        position: Position,
        field_name: &str,
    ) -> (FieldUsageType, Option<Range>, Option<String>) {
        let tree = match self.parser.parse(content) {
            Some(t) => t,
            None => {
                return (FieldUsageType::FieldAccess, None, None);
            }
        };

        let point = tree_sitter::Point {
            row: position.line as usize,
            column: position.character as usize,
        };

        let node = match tree.root_node().descendant_for_point_range(point, point) {
            Some(n) => n,
            None => {
                return (FieldUsageType::FieldAccess, None, None);
            }
        };

        // Walk up to find the context
        let mut current = Some(node);
        while let Some(n) = current {
            match n.kind() {
                "field_type" => {
                    // Field in type definition: { name : String }
                    let (range, replacement) = self.get_field_definition_range(&n, content);
                    return (FieldUsageType::Definition, Some(range), replacement);
                }
                "field" => {
                    // Could be record literal or record update
                    if let Some(parent) = n.parent() {
                        if parent.kind() == "record_expr" {
                            // Check if it's a record update
                            if self.is_record_update(&parent, content) {
                                let (range, replacement) = self.get_record_update_field_range(
                                    &parent, &n, content, field_name,
                                );
                                return (FieldUsageType::RecordUpdate, Some(range), replacement);
                            } else {
                                let range =
                                    self.get_field_assignment_range(&n, content, field_name);
                                return (FieldUsageType::RecordLiteral, Some(range), None);
                            }
                        }
                    }
                }
                "record_pattern" => {
                    // Field in record pattern: { name }
                    let range = self.get_pattern_field_range(&n, content, field_name);
                    return (FieldUsageType::RecordPattern, Some(range), None);
                }
                "field_access_expr" => {
                    // Field access: user.name
                    let range = Range {
                        start: Position::new(
                            n.start_position().row as u32,
                            n.start_position().column as u32,
                        ),
                        end: Position::new(
                            n.end_position().row as u32,
                            n.end_position().column as u32,
                        ),
                    };
                    return (FieldUsageType::FieldAccess, Some(range), None);
                }
                "field_accessor_function_expr" => {
                    // Field accessor: .name
                    let range = Range {
                        start: Position::new(
                            n.start_position().row as u32,
                            n.start_position().column as u32,
                        ),
                        end: Position::new(
                            n.end_position().row as u32,
                            n.end_position().column as u32,
                        ),
                    };
                    return (FieldUsageType::FieldAccessor, Some(range), None);
                }
                _ => {}
            }
            current = n.parent();
        }

        // Default to field access if we can't determine
        (FieldUsageType::FieldAccess, None, None)
    }

    /// Check if a record_expr is a record update (has a | in it)
    fn is_record_update(&self, node: &tree_sitter::Node, content: &str) -> bool {
        let text = &content[node.byte_range()];
        text.contains('|')
    }

    /// Get the range for a field in a type definition, including comma if necessary
    /// Returns (range, optional_replacement_text) - replacement_text is used when removing first field
    fn get_field_definition_range(
        &self,
        field_node: &tree_sitter::Node,
        content: &str,
    ) -> (Range, Option<String>) {
        let lines: Vec<&str> = content.lines().collect();
        let start_line = field_node.start_position().row;
        let end_line = field_node.end_position().row;

        // Check if there's a comma after this field on the same line
        if let Some(line) = lines.get(end_line) {
            let after_field = &line[field_node.end_position().column..];
            if let Some(comma_pos) = after_field.find(',') {
                // Include the comma
                return (
                    Range {
                        start: Position::new(start_line as u32, 0),
                        end: Position::new(
                            end_line as u32,
                            (field_node.end_position().column + comma_pos + 1) as u32,
                        ),
                    },
                    None,
                );
            }
        }

        // Check if there's a comma before this field (previous line ends with comma)
        if start_line > 0 {
            if let Some(prev_line) = lines.get(start_line - 1) {
                if prev_line.trim().ends_with(',') {
                    // Remove the entire line including the previous comma
                    let prev_comma_col = prev_line.rfind(',').unwrap();
                    return (
                        Range {
                            start: Position::new((start_line - 1) as u32, prev_comma_col as u32),
                            end: Position::new((end_line + 1) as u32, 0),
                        },
                        None,
                    );
                }
            }
        }

        // Check if this is the first field (line trimmed starts with '{')
        // and the next line starts with ', ' - this is the first field case
        if let Some(line) = lines.get(start_line) {
            let line_trimmed = line.trim_start();
            if line_trimmed.starts_with('{') {
                // This is the first field, check if next line starts with ', '
                if let Some(next_line) = lines.get(end_line + 1) {
                    let next_trimmed = next_line.trim_start();
                    if let Some(after_comma) = next_trimmed.strip_prefix(',') {
                        // Find the indentation of the next line
                        let indent = next_line.len() - next_trimmed.len();
                        // Skip any whitespace after the comma
                        let space_after = after_comma.len() - after_comma.trim_start().len();
                        let field_start_col = indent + 1 + space_after;

                        // Return a range that removes the first field line and the ", " on next line
                        // Replace with "{ " (preserving indentation)
                        let replacement = format!("{}{{ ", &next_line[..indent]);
                        return (
                            Range {
                                start: Position::new(start_line as u32, 0),
                                end: Position::new((end_line + 1) as u32, field_start_col as u32),
                            },
                            Some(replacement),
                        );
                    }
                }
            }
        }

        // Just remove the line
        (
            Range {
                start: Position::new(start_line as u32, 0),
                end: Position::new((end_line + 1) as u32, 0),
            },
            None,
        )
    }

    /// Get the range for a field assignment (in record literal or update)
    fn get_field_assignment_range(
        &self,
        field_node: &tree_sitter::Node,
        content: &str,
        _field_name: &str,
    ) -> Range {
        let lines: Vec<&str> = content.lines().collect();
        let start_line = field_node.start_position().row;
        let start_col = field_node.start_position().column;
        let end_line = field_node.end_position().row;
        let end_col = field_node.end_position().column;

        // Check if there's a comma after
        if let Some(line) = lines.get(end_line) {
            let after_field = &line[end_col..];
            if let Some(comma_pos) = after_field.find(',') {
                // Include comma and any whitespace after
                let end_pos = end_col + comma_pos + 1;
                let remaining = &line[end_pos..];
                let extra_space = remaining.len() - remaining.trim_start().len();
                return Range {
                    start: Position::new(start_line as u32, start_col as u32),
                    end: Position::new(end_line as u32, (end_pos + extra_space) as u32),
                };
            }
        }

        // Check if there's a comma before
        if let Some(line) = lines.get(start_line) {
            let before_field = &line[..start_col];
            if let Some(comma_pos) = before_field.rfind(',') {
                // Remove from comma to end of field
                return Range {
                    start: Position::new(start_line as u32, comma_pos as u32),
                    end: Position::new(end_line as u32, end_col as u32),
                };
            }
        }

        Range {
            start: Position::new(start_line as u32, start_col as u32),
            end: Position::new(end_line as u32, end_col as u32),
        }
    }

    /// Get the range for a field in a record update, handling the case where it's the only field
    /// Returns (range, optional_replacement_text)
    fn get_record_update_field_range(
        &self,
        record_node: &tree_sitter::Node,
        field_node: &tree_sitter::Node,
        content: &str,
        field_name: &str,
    ) -> (Range, Option<String>) {
        // Count fields in this record update
        let mut field_count = 0;
        let mut cursor = record_node.walk();
        if cursor.goto_first_child() {
            loop {
                let node = cursor.node();
                if node.kind() == "field" {
                    field_count += 1;
                }
                if !cursor.goto_next_sibling() {
                    break;
                }
            }
        }

        // If this is the only field, we need to replace the entire record update with just the base expression
        if field_count == 1 {
            // Find the base expression (the identifier before the |)
            let record_text = &content[record_node.byte_range()];
            // Record update format: { base | field = value }
            // We need to extract "base" and replace the whole thing with it
            if let Some(pipe_pos) = record_text.find('|') {
                let before_pipe = &record_text[1..pipe_pos]; // Skip the '{'
                let base_expr = before_pipe.trim();

                // Return the range of the entire record update and the replacement (just the base)
                return (
                    Range {
                        start: Position::new(
                            record_node.start_position().row as u32,
                            record_node.start_position().column as u32,
                        ),
                        end: Position::new(
                            record_node.end_position().row as u32,
                            record_node.end_position().column as u32,
                        ),
                    },
                    Some(base_expr.to_string()),
                );
            }
        }

        // Multiple fields - use regular field removal logic
        (
            self.get_field_assignment_range(field_node, content, field_name),
            None,
        )
    }

    /// Get the range for a field in a record pattern
    fn get_pattern_field_range(
        &self,
        record_pattern_node: &tree_sitter::Node,
        content: &str,
        field_name: &str,
    ) -> Range {
        // Find the field within the record pattern
        let pattern_text = &content[record_pattern_node.byte_range()];

        // Parse the fields in the pattern
        let inner = pattern_text
            .trim_start_matches('{')
            .trim_end_matches('}')
            .trim();
        let fields: Vec<&str> = inner.split(',').map(|s| s.trim()).collect();

        // Count how many fields
        let field_count = fields.len();

        // Find our field's position in the list
        let field_index = fields.iter().position(|f| {
            let name = f.split_whitespace().next().unwrap_or("");
            name == field_name
        });

        let base_start = record_pattern_node.start_position();
        let base_end = record_pattern_node.end_position();

        if field_count == 1 {
            // Only field - return the whole pattern range (it will be replaced with _)
            return Range {
                start: Position::new(base_start.row as u32, base_start.column as u32),
                end: Position::new(base_end.row as u32, base_end.column as u32),
            };
        }

        // Multiple fields - need to find exact position of this field in the source
        // and remove it along with appropriate comma
        if let Some(_idx) = field_index {
            let mut cursor = record_pattern_node.walk();
            let mut field_nodes: Vec<tree_sitter::Node> = Vec::new();

            // Collect all lower_pattern children
            if cursor.goto_first_child() {
                loop {
                    let node = cursor.node();
                    if node.kind() == "lower_pattern" || node.kind() == "record_base_identifier" {
                        field_nodes.push(node);
                    }
                    if !cursor.goto_next_sibling() {
                        break;
                    }
                }
            }

            // Find the node for our field
            for (i, node) in field_nodes.iter().enumerate() {
                let node_text = &content[node.byte_range()];
                if node_text.trim() == field_name {
                    let start = node.start_position();
                    let end = node.end_position();

                    // Determine comma handling
                    if i < field_nodes.len() - 1 {
                        // Not last - remove field and trailing comma
                        // Find the comma after this field
                        let line = content.lines().nth(end.row).unwrap_or("");
                        let after = &line[end.column..];
                        if let Some(comma_pos) = after.find(',') {
                            let extra = after[comma_pos + 1..].len()
                                - after[comma_pos + 1..].trim_start().len();
                            return Range {
                                start: Position::new(start.row as u32, start.column as u32),
                                end: Position::new(
                                    end.row as u32,
                                    (end.column + comma_pos + 1 + extra) as u32,
                                ),
                            };
                        }
                    } else {
                        // Last field - remove leading comma
                        let line = content.lines().nth(start.row).unwrap_or("");
                        let before = &line[..start.column];
                        if let Some(comma_pos) = before.rfind(',') {
                            return Range {
                                start: Position::new(start.row as u32, comma_pos as u32),
                                end: Position::new(end.row as u32, end.column as u32),
                            };
                        }
                    }

                    return Range {
                        start: Position::new(start.row as u32, start.column as u32),
                        end: Position::new(end.row as u32, end.column as u32),
                    };
                }
            }
        }

        // Fallback
        Range {
            start: Position::new(base_start.row as u32, base_start.column as u32),
            end: Position::new(base_end.row as u32, base_end.column as u32),
        }
    }

    /// Prepare to remove a field - analyze usages and return info
    pub fn prepare_remove_field(
        &self,
        uri: &Url,
        line: u32,
        character: u32,
    ) -> Option<(String, String, Vec<String>, Vec<FieldUsage>)> {
        // Find the field at this position
        let path = uri.to_file_path().ok()?;
        let content = std::fs::read_to_string(&path).ok()?;

        let tree = self.parser.parse(&content)?;
        let point = tree_sitter::Point {
            row: line as usize,
            column: character as usize,
        };

        let node = tree.root_node().descendant_for_point_range(point, point)?;

        // Find the type alias and field name
        let (type_alias_name, field_name, all_fields) =
            self.find_field_at_position(node, &content)?;

        // Get field definition
        let definition = self
            .type_checker
            .find_field_definition(uri.as_str(), node, &content)?;

        // Get all usages
        let usages = self.get_field_usages(&field_name, &definition);

        Some((type_alias_name, field_name, all_fields, usages))
    }

    /// Find the type alias name, field name, and all fields at a position
    fn find_field_at_position(
        &self,
        node: tree_sitter::Node,
        content: &str,
    ) -> Option<(String, String, Vec<String>)> {
        // Walk up to find field_type and type_alias_declaration
        let mut current = Some(node);
        let mut field_name = None;

        while let Some(n) = current {
            if n.kind() == "lower_case_identifier" && field_name.is_none() {
                field_name = Some(content[n.byte_range()].to_string());
            }

            if n.kind() == "type_alias_declaration" {
                // Found the type alias
                let type_name = n
                    .child_by_field_name("name")
                    .map(|name_node| content[name_node.byte_range()].to_string())?;

                // Find all fields in this type
                let mut all_fields = Vec::new();
                let mut cursor = n.walk();
                Self::collect_fields_in_type(&mut cursor, content, &mut all_fields);

                return Some((type_name, field_name?, all_fields));
            }

            current = n.parent();
        }

        None
    }

    /// Collect all field names in a type alias
    fn collect_fields_in_type(
        cursor: &mut tree_sitter::TreeCursor,
        content: &str,
        fields: &mut Vec<String>,
    ) {
        loop {
            let node = cursor.node();
            if node.kind() == "field_type" {
                // Get the field name (first lower_case_identifier child)
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        if child.kind() == "lower_case_identifier" {
                            fields.push(content[child.byte_range()].to_string());
                            break;
                        }
                    }
                }
            }

            if cursor.goto_first_child() {
                Self::collect_fields_in_type(cursor, content, fields);
                cursor.goto_parent();
            }

            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }

    /// Remove a field from a type alias and update all usages
    pub fn remove_field(
        &self,
        uri: &Url,
        type_name: &str,
        field_name: &str,
        total_fields: usize,
    ) -> anyhow::Result<RemoveFieldResult> {
        // 1. Validate: can't remove if only 1 field
        if total_fields <= 1 {
            return Ok(RemoveFieldResult::error(
                "Cannot remove the only field from a type alias",
            ));
        }

        // 2. Get field definition - use type_checker for proper module/uri info
        let path = uri
            .to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid URI"))?;
        let content = std::fs::read_to_string(&path)?;

        let tree = self
            .parser
            .parse(&content)
            .ok_or_else(|| anyhow::anyhow!("Failed to parse file"))?;

        // Find the field node in the type definition
        let field_node = self
            .find_field_node_in_type(&tree, &content, type_name, field_name)
            .ok_or_else(|| anyhow::anyhow!("Field not found in type definition"))?;

        // Use type_checker to get proper definition with module/uri info
        let definition = self
            .type_checker
            .find_field_definition(uri.as_str(), field_node, &content)
            .ok_or_else(|| anyhow::anyhow!("Could not resolve field definition"))?;

        // 3. Get all usages
        let usages = self.get_field_usages(field_name, &definition);

        // 4. Create text edits
        let mut changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();

        // Count usages by type for the message
        let mut replaced_accesses = 0;
        let mut replaced_accessors = 0;
        let mut removed_patterns = 0;
        let mut removed_literals = 0;
        let mut removed_updates = 0;

        for usage in &usages {
            let usage_uri =
                Url::parse(&usage.uri).map_err(|_| anyhow::anyhow!("Invalid usage URI"))?;

            if let Some(range) = usage.full_range {
                let edit = match usage.usage_type {
                    FieldUsageType::Definition => {
                        // Use replacement_text if provided (for first field case), otherwise remove
                        TextEdit {
                            range,
                            new_text: usage.replacement_text.clone().unwrap_or_default(),
                        }
                    }
                    FieldUsageType::FieldAccess => {
                        // Replace with Debug.todo
                        replaced_accesses += 1;
                        TextEdit {
                            range,
                            new_text: format!(
                                "(Debug.todo \"FIXME: Field Removal: {}\")",
                                field_name
                            ),
                        }
                    }
                    FieldUsageType::FieldAccessor => {
                        // Replace with lambda that returns Debug.todo
                        replaced_accessors += 1;
                        TextEdit {
                            range,
                            new_text: format!(
                                "(\\_ -> Debug.todo \"FIXME: Field Removal: {}\")",
                                field_name
                            ),
                        }
                    }
                    FieldUsageType::RecordPattern => {
                        removed_patterns += 1;
                        // Check if this is the only field (range covers entire pattern)
                        let usage_path = Url::parse(&usage.uri)
                            .ok()
                            .and_then(|u| u.to_file_path().ok());
                        let usage_content = usage_path
                            .as_ref()
                            .and_then(|p| std::fs::read_to_string(p).ok());

                        if let Some(ref c) = usage_content {
                            let line = c.lines().nth(range.start.line as usize).unwrap_or("");
                            let pattern_text =
                                &line[range.start.character as usize..range.end.character as usize];
                            if pattern_text.starts_with('{') && pattern_text.ends_with('}') {
                                // Single field pattern - replace with _
                                TextEdit {
                                    range,
                                    new_text: "_".to_string(),
                                }
                            } else {
                                // Multi-field pattern - just remove this field
                                TextEdit {
                                    range,
                                    new_text: String::new(),
                                }
                            }
                        } else {
                            TextEdit {
                                range,
                                new_text: String::new(),
                            }
                        }
                    }
                    FieldUsageType::RecordLiteral => {
                        removed_literals += 1;
                        TextEdit {
                            range,
                            new_text: String::new(),
                        }
                    }
                    FieldUsageType::RecordUpdate => {
                        removed_updates += 1;
                        // Use replacement_text if provided (for single-field update case)
                        TextEdit {
                            range,
                            new_text: usage.replacement_text.clone().unwrap_or_default(),
                        }
                    }
                };

                changes.entry(usage_uri).or_default().push(edit);
            }
        }

        // 5. Sort edits in reverse order within each file to avoid offset issues
        Self::sort_edits_reverse(&mut changes);

        // 6. Build message
        let message = {
            let mut parts = vec![format!(
                "Removed field '{}' from '{}'",
                field_name, type_name
            )];

            if replaced_accesses > 0 {
                parts.push(format!(
                    "replaced {} field access(es) with Debug.todo",
                    replaced_accesses
                ));
            }
            if replaced_accessors > 0 {
                parts.push(format!(
                    "replaced {} field accessor(s) with Debug.todo",
                    replaced_accessors
                ));
            }
            if removed_patterns > 0 {
                parts.push(format!(
                    "removed from {} record pattern(s)",
                    removed_patterns
                ));
            }
            if removed_literals > 0 {
                parts.push(format!(
                    "removed from {} record literal(s)",
                    removed_literals
                ));
            }
            if removed_updates > 0 {
                parts.push(format!("removed from {} record update(s)", removed_updates));
            }

            if parts.len() == 1 {
                parts[0].clone()
            } else {
                format!("{}, {}", parts[0], parts[1..].join(", "))
            }
        };

        Ok(RemoveFieldResult::success(&message, changes))
    }

    /// Find a field node in a type alias by type name and field name
    fn find_field_node_in_type<'a>(
        &self,
        tree: &'a tree_sitter::Tree,
        content: &str,
        type_name: &str,
        field_name: &str,
    ) -> Option<tree_sitter::Node<'a>> {
        self.find_field_node_recursive(tree.root_node(), content, type_name, field_name)
    }

    fn find_field_node_recursive<'a>(
        &self,
        node: tree_sitter::Node<'a>,
        content: &str,
        type_name: &str,
        field_name: &str,
    ) -> Option<tree_sitter::Node<'a>> {
        if node.kind() == "type_alias_declaration" {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = &content[name_node.byte_range()];
                if name == type_name {
                    // Found the type, now find the field
                    return self.find_field_node_in_children(node, content, field_name);
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) =
                self.find_field_node_recursive(child, content, type_name, field_name)
            {
                return Some(found);
            }
        }
        None
    }

    fn find_field_node_in_children<'a>(
        &self,
        node: tree_sitter::Node<'a>,
        content: &str,
        field_name: &str,
    ) -> Option<tree_sitter::Node<'a>> {
        if node.kind() == "field_type" {
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    if child.kind() == "lower_case_identifier" {
                        let name = &content[child.byte_range()];
                        if name == field_name {
                            return Some(child);
                        }
                    }
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = self.find_field_node_in_children(child, content, field_name) {
                return Some(found);
            }
        }
        None
    }

    /// Get field info at a given position in a file
    pub fn get_field_at_position(
        &self,
        uri: &Url,
        position: Position,
        content: &str,
    ) -> Option<FieldInfo> {
        // Use the cached tree from the type checker to ensure node IDs match
        let tree = match self.type_checker.get_tree(uri.as_str()) {
            Some(t) => t,
            None => {
                return None;
            }
        };
        let root = tree.root_node();

        // Find the node at the position
        let point = tree_sitter::Point::new(position.line as usize, position.character as usize);
        let node = match Self::find_node_at_point(root, point) {
            Some(n) => n,
            None => {
                return None;
            }
        };

        // Check if this is a field reference
        let field_def = self
            .type_checker
            .find_field_definition(uri.as_str(), node, content);
        let field_def = field_def?;

        // Calculate the range for just the field name
        let range = Range {
            start: Position::new(
                node.start_position().row as u32,
                node.start_position().column as u32,
            ),
            end: Position::new(
                node.end_position().row as u32,
                node.end_position().column as u32,
            ),
        };

        Some(FieldInfo {
            name: field_def.name.clone(),
            range,
            definition: field_def,
        })
    }

    /// Find all references to a record field using type inference
    pub fn find_field_references(
        &self,
        field_name: &str,
        definition: &FieldDefinition,
    ) -> Vec<SymbolReference> {
        let mut references = Vec::new();

        // Create target for filtering structural matches
        let target = definition
            .type_alias_name
            .as_ref()
            .map(|name| TargetTypeAlias {
                name: name.clone(),
                module: definition.module_name.clone(),
            });

        // Include the definition itself - use cached tree for correct node IDs
        if let Some(tree) = self.type_checker.get_tree(&definition.uri) {
            if let Some(node) = Self::find_node_by_id(tree.root_node(), definition.node_id) {
                let range = Range {
                    start: Position::new(
                        node.start_position().row as u32,
                        node.start_position().column as u32,
                    ),
                    end: Position::new(
                        node.end_position().row as u32,
                        node.end_position().column as u32,
                    ),
                };
                if let Ok(def_uri) = Url::parse(&definition.uri) {
                    references.push(SymbolReference {
                        uri: def_uri,
                        range,
                        is_definition: true,
                        kind: Some(BoundSymbolKind::FieldType),
                        type_context: definition.type_alias_name.clone(),
                    });
                }
            }
        }

        // Search through all indexed files for field usages
        for (_module, file_uri) in self.iter_non_evergreen_modules() {
            // Use cached tree and source for correct node IDs
            let tree = match self.type_checker.get_tree(file_uri.as_str()) {
                Some(t) => t,
                None => continue,
            };

            let content = match self.type_checker.get_source(file_uri.as_str()) {
                Some(c) => c,
                None => continue,
            };

            // Find all field usages in this file
            let usages = self.find_field_usages_in_tree(tree, content, field_name);

            for (node_id, range) in usages {
                // Skip the definition itself (already added)
                if file_uri.as_str() == definition.uri && node_id == definition.node_id {
                    continue;
                }

                // Find the node to check if it resolves to the same definition
                if let Some(node) = Self::find_node_by_id(tree.root_node(), node_id) {
                    // Use type checker to resolve this field reference
                    // Pass target to filter structural matches to only the type alias we're renaming
                    let ref_def = if let Some(ref target) = target {
                        self.type_checker.find_field_definition_with_target(
                            file_uri.as_str(),
                            node,
                            content,
                            target,
                        )
                    } else {
                        self.type_checker
                            .find_field_definition(file_uri.as_str(), node, content)
                    };

                    tracing::info!(
                        "find_field_references: checking {} in {}, ref_def={:?}",
                        field_name,
                        file_uri.path(),
                        ref_def
                            .as_ref()
                            .map(|d| (&d.type_alias_name, &d.module_name))
                    );

                    if let Some(ref_def) = ref_def {
                        // Check if it resolves to the same type alias
                        if ref_def.type_alias_name == definition.type_alias_name
                            && ref_def.module_name == definition.module_name
                        {
                            tracing::info!("find_field_references: MATCH - adding reference");
                            // Determine the kind based on parent node
                            let is_record_pattern =
                                node.parent().map(|p| p.kind()) == Some("record_pattern");
                            let kind = if is_record_pattern {
                                BoundSymbolKind::RecordPatternField
                            } else {
                                BoundSymbolKind::FieldType
                            };
                            references.push(SymbolReference {
                                uri: file_uri.clone(),
                                range,
                                is_definition: false,
                                kind: Some(kind),
                                type_context: definition.type_alias_name.clone(),
                            });

                            // For record pattern fields, also find all variable usages
                            // of this name within the enclosing function scope.
                            // BUT ONLY if there are no OTHER bindings for the same name
                            // (case patterns, let bindings, lambda params, etc.)
                            if is_record_pattern {
                                if let Some(scope_node) = Self::find_enclosing_scope(node) {
                                    // Check if the scope has other bindings that would shadow this variable
                                    let has_other_bindings = Self::scope_has_other_bindings(
                                        scope_node,
                                        content,
                                        field_name,
                                        node.id(),
                                    );

                                    if !has_other_bindings {
                                        let var_usages = self.find_variable_usages_in_scope(
                                            scope_node, content, field_name,
                                            node, // Exclude the pattern field itself
                                        );
                                        for (var_range, _) in var_usages {
                                            references.push(SymbolReference {
                                                uri: file_uri.clone(),
                                                range: var_range,
                                                is_definition: false,
                                                kind: Some(BoundSymbolKind::FunctionParameter), // Treated as local variable
                                                type_context: definition.type_alias_name.clone(),
                                            });
                                        }
                                    }
                                }
                            }
                        } else {
                            tracing::info!(
                                "find_field_references: NO MATCH - expected {:?}/{:?}, got {:?}/{:?}",
                                definition.type_alias_name, definition.module_name,
                                ref_def.type_alias_name, ref_def.module_name
                            );
                        }
                    }
                }
            }
        }

        Self::deduplicate_references(&mut references);
        references
    }

    /// Find all field usages in a tree that match the given field name
    fn find_field_usages_in_tree(
        &self,
        tree: &tree_sitter::Tree,
        source: &str,
        field_name: &str,
    ) -> Vec<(usize, Range)> {
        let mut usages = Vec::new();
        self.walk_for_field_usages(tree.root_node(), source, field_name, &mut usages);
        usages
    }

    fn walk_for_field_usages(
        &self,
        node: tree_sitter::Node,
        source: &str,
        field_name: &str,
        usages: &mut Vec<(usize, Range)>,
    ) {
        let node_kind = node.kind();
        let parent_kind = node.parent().map(|p| p.kind());

        // Check if this is a field reference matching our name
        let is_field = match (node_kind, parent_kind) {
            // Field in type definition: { name : String }
            ("lower_case_identifier", Some("field_type")) => true,
            // Field access: user.name
            ("lower_case_identifier", Some("field_access_expr")) => true,
            // Field accessor: .name
            ("lower_case_identifier", Some("field_accessor_function_expr")) => true,
            // Field in record expression: { name = value }
            ("lower_case_identifier", Some("field")) => {
                // Check if this is the field name (first child, not the value)
                if let Some(parent) = node.parent() {
                    // The field name is the first lower_case_identifier child
                    parent
                        .child(0)
                        .is_some_and(|n| n.id() == node.id() && n.kind() == "lower_case_identifier")
                } else {
                    false
                }
            }
            // Field in record pattern: { name }
            ("lower_pattern", Some("record_pattern")) => true,
            _ => false,
        };

        if is_field {
            if let Ok(text) = node.utf8_text(source.as_bytes()) {
                if text == field_name {
                    let range = Range {
                        start: Position::new(
                            node.start_position().row as u32,
                            node.start_position().column as u32,
                        ),
                        end: Position::new(
                            node.end_position().row as u32,
                            node.end_position().column as u32,
                        ),
                    };
                    usages.push((node.id(), range));
                }
            }
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.walk_for_field_usages(child, source, field_name, usages);
        }
    }
}
