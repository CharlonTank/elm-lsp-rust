//! ERD (Entity-Relationship Diagram) generation for Elm types.
//!
//! Generates Mermaid ERD syntax from Elm type definitions.

use std::collections::HashSet;
use tower_lsp::lsp_types::Url;

use super::Workspace;

// ============================================================================
// ERD Types
// ============================================================================

/// Represents an entity in the ERD (a record type alias)
#[derive(Debug, Clone)]
pub struct ErdEntity {
    /// The type name (e.g., "BackendModel")
    pub name: String,
    /// The module where this type is defined
    pub module: String,
    /// Fields with their type names for display (field_name, type_display)
    pub fields: Vec<(String, String)>,
}

/// Represents a relationship between two entities
#[derive(Debug, Clone)]
pub struct ErdRelationship {
    /// Source entity name
    pub from: String,
    /// Target entity name
    pub to: String,
    /// Field name that creates this relationship
    pub field_name: String,
    /// Cardinality of the relationship
    pub cardinality: ErdCardinality,
}

/// Cardinality of a relationship in the ERD
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ErdCardinality {
    /// Direct reference: ||--||
    OneToOne,
    /// List, Dict, Set, Array, etc.: ||--o{
    OneToMany,
    /// Maybe: ||--o|
    ZeroOrOne,
}

/// Result of ERD generation
#[derive(Debug)]
pub struct ErdResult {
    /// Root type name (e.g., "BackendModel") - excluded from diagram
    pub root_type: String,
    /// All entities (record type aliases) found
    pub entities: Vec<ErdEntity>,
    /// Relationships between entities
    pub relationships: Vec<ErdRelationship>,
    /// Any warnings during generation
    pub warnings: Vec<String>,
}

impl ErdResult {
    /// Generate Mermaid ERD syntax
    pub fn to_mermaid(&self) -> String {
        let mut output = String::new();
        output.push_str("erDiagram\n");

        // Build set of entity names (excluding root type) and deduplicate
        let mut seen_entities: HashSet<&str> = HashSet::new();
        let mut unique_entities: Vec<&ErdEntity> = Vec::new();

        for entity in &self.entities {
            if entity.name == self.root_type {
                continue;
            }
            if !seen_entities.contains(entity.name.as_str()) {
                seen_entities.insert(&entity.name);
                unique_entities.push(entity);
            }
        }

        let entity_names: HashSet<&str> = seen_entities.clone();

        // Add entities with their fields (deduplicated, skip root type)
        for entity in &unique_entities {
            output.push_str(&format!("    {} {{\n", entity.name));
            for (field_name, field_type) in &entity.fields {
                let sanitized_type = Self::sanitize_type_name(field_type);
                output.push_str(&format!("        {} {}\n", sanitized_type, field_name));
            }
            output.push_str("    }\n");
        }

        // Add relationships only between actual entities (skip root type and scalar types)
        // Use a set to deduplicate relationships
        let mut seen_relationships: HashSet<String> = HashSet::new();

        for rel in &self.relationships {
            // Skip relationships from root type
            if rel.from == self.root_type {
                continue;
            }
            let sanitized_to = Self::sanitize_type_name(&rel.to);
            // Skip if target is empty or not an actual entity
            if sanitized_to.is_empty() || !entity_names.contains(sanitized_to.as_str()) {
                continue;
            }
            let cardinality_label = match rel.cardinality {
                ErdCardinality::OneToOne => "1:1",
                ErdCardinality::OneToMany => "1:N",
                ErdCardinality::ZeroOrOne => "1:0..1",
            };

            // Deduplicate by (from, to, field_name)
            let rel_key = format!("{}:{}:{}", rel.from, sanitized_to, rel.field_name);
            if seen_relationships.contains(&rel_key) {
                continue;
            }
            seen_relationships.insert(rel_key);

            output.push_str(&format!(
                "    {} ||--|| {} : \"{} {}\"\n",
                rel.from, sanitized_to, cardinality_label, rel.field_name
            ));
        }

        output
    }

    /// Sanitize type name for Mermaid display (use underscores)
    fn sanitize_type_name(type_name: &str) -> String {
        #[allow(clippy::double_ended_iterator_last)]
        let base = type_name.split('.').last().unwrap_or(type_name);
        base.chars()
            .filter_map(|c| match c {
                ' ' | ',' | '-' => Some('_'),
                '(' | ')' | '{' | '}' | ':' | '\n' | '\r' => None,
                _ => Some(c),
            })
            .collect()
    }
}

// ============================================================================
// ERD Generation Methods for Workspace
// ============================================================================

impl Workspace {
    /// Generate an ERD for a given type name
    pub fn generate_erd(&self, type_name: &str, file_uri: &Url) -> Result<ErdResult, String> {
        let mut visited: HashSet<String> = HashSet::new();
        let mut entities: Vec<ErdEntity> = Vec::new();
        let mut relationships: Vec<ErdRelationship> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();

        // Find the starting module from the file URI
        let starting_module = self.get_module_name_from_uri(file_uri);

        // Start recursive collection
        self.collect_erd_entities(
            type_name,
            &starting_module,
            &mut visited,
            &mut entities,
            &mut relationships,
            &mut warnings,
        );

        if entities.is_empty() {
            return Err(format!("Could not find type '{}' in module '{}'", type_name, starting_module));
        }

        Ok(ErdResult {
            root_type: type_name.to_string(),
            entities,
            relationships,
            warnings,
        })
    }

    /// Recursively collect ERD entities and relationships
    fn collect_erd_entities(
        &self,
        type_name: &str,
        module_hint: &str,
        visited: &mut HashSet<String>,
        entities: &mut Vec<ErdEntity>,
        relationships: &mut Vec<ErdRelationship>,
        warnings: &mut Vec<String>,
    ) {
        // Create qualified name for tracking
        let qualified_name = format!("{}.{}", module_hint, type_name);

        // Skip if already visited
        if visited.contains(&qualified_name) {
            return;
        }

        // Skip primitive types
        if self.is_erd_primitive_type(type_name) {
            return;
        }

        // Skip wrapper types
        if self.is_erd_wrapper_type(type_name) {
            return;
        }

        visited.insert(qualified_name.clone());

        // Find the type alias across all modules
        if let Some((module_name, fields)) = self.find_type_alias_fields(type_name, module_hint) {
            // Create entity
            let entity = ErdEntity {
                name: type_name.to_string(),
                module: module_name.clone(),
                fields: fields.iter().map(|(n, t)| (n.clone(), t.clone())).collect(),
            };
            entities.push(entity);

            // Process each field for relationships
            for (field_name, field_type_str) in &fields {
                self.process_erd_field(
                    type_name,
                    field_name,
                    field_type_str,
                    &module_name,
                    visited,
                    entities,
                    relationships,
                    warnings,
                );
            }
        }
    }

    /// Find a type (alias or custom type with record) and return its fields
    fn find_type_alias_fields(&self, type_name: &str, module_hint: &str) -> Option<(String, Vec<(String, String)>)> {
        // Collect all URIs first to avoid borrowing issues
        let uris: Vec<String> = self.type_checker.indexed_files().map(|s| s.to_string()).collect();

        // First try to find in the hinted module
        for uri in &uris {
            let tree = match self.type_checker.get_tree(uri) {
                Some(t) => t,
                None => continue,
            };
            let source = match self.type_checker.get_source(uri) {
                Some(s) => s,
                None => continue,
            };

            let module_name = self.get_module_name_from_source(source, tree);

            // Check if this is the module we're looking for (or any module if no hint)
            let is_target_module = module_name == module_hint ||
                                   module_name.ends_with(&format!(".{}", module_hint)) ||
                                   module_hint.is_empty();

            if !is_target_module {
                continue;
            }

            if let Some(fields) = self.find_type_fields_in_tree(tree, source, type_name) {
                return Some((module_name, fields));
            }
        }

        // If not found in hinted module, search all modules
        for uri in &uris {
            let tree = match self.type_checker.get_tree(uri) {
                Some(t) => t,
                None => continue,
            };
            let source = match self.type_checker.get_source(uri) {
                Some(s) => s,
                None => continue,
            };

            let module_name = self.get_module_name_from_source(source, tree);

            if let Some(fields) = self.find_type_fields_in_tree(tree, source, type_name) {
                return Some((module_name, fields));
            }
        }

        None
    }

    /// Find fields for a type in a parsed tree - handles both type aliases and custom types with record constructors
    fn find_type_fields_in_tree(&self, tree: &tree_sitter::Tree, source: &str, type_name: &str) -> Option<Vec<(String, String)>> {
        let root = tree.root_node();
        let mut cursor = root.walk();

        for child in root.children(&mut cursor) {
            // Check type alias declarations: type alias Foo = { ... }
            if child.kind() == "type_alias_declaration" {
                let alias_name = child.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source.as_bytes()).ok());

                if alias_name == Some(type_name) {
                    if let Some(type_expr) = child.child_by_field_name("typeExpression") {
                        if let Some(record_type) = self.find_record_type_node_erd(type_expr) {
                            return Some(self.extract_record_fields_erd(record_type, source));
                        }
                    }
                }
            }

            // Check custom type declarations: type Foo = Foo { ... }
            if child.kind() == "type_declaration" {
                let custom_type_name = child.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source.as_bytes()).ok());

                if custom_type_name == Some(type_name) {
                    // Look for a single constructor with a record argument
                    if let Some(fields) = self.extract_custom_type_record_fields(child, source) {
                        return Some(fields);
                    }
                }
            }
        }

        None
    }

    /// Extract record fields from a custom type with a single constructor containing a record
    /// e.g., type Group = Group { ownerId : Id UserId, name : GroupName, ... }
    fn extract_custom_type_record_fields(&self, type_decl: tree_sitter::Node, source: &str) -> Option<Vec<(String, String)>> {
        let mut cursor = type_decl.walk();
        let mut variants: Vec<tree_sitter::Node> = Vec::new();

        // Collect all union variants
        for child in type_decl.children(&mut cursor) {
            if child.kind() == "union_variant" {
                variants.push(child);
            }
        }

        // Only process if there's exactly one variant (opaque type pattern)
        if variants.len() != 1 {
            return None;
        }

        let variant = variants[0];
        let mut variant_cursor = variant.walk();

        // Look for a record type in the variant's arguments
        for child in variant.children(&mut variant_cursor) {
            if child.kind() == "record_type" {
                return Some(self.extract_record_fields_erd(child, source));
            }
        }

        None
    }

    /// Find a record_type node within a type expression
    fn find_record_type_node_erd<'a>(&self, node: tree_sitter::Node<'a>) -> Option<tree_sitter::Node<'a>> {
        if node.kind() == "record_type" {
            return Some(node);
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = self.find_record_type_node_erd(child) {
                return Some(found);
            }
        }
        None
    }

    /// Extract field names and types from a record_type node (ERD version)
    fn extract_record_fields_erd(&self, record_type: tree_sitter::Node, source: &str) -> Vec<(String, String)> {
        let mut fields = Vec::new();
        let mut cursor = record_type.walk();

        for child in record_type.children(&mut cursor) {
            if child.kind() == "field_type" {
                let field_name = child.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source.as_bytes()).ok())
                    .map(|s| s.to_string());

                let field_type = child.child_by_field_name("typeExpression")
                    .and_then(|n| n.utf8_text(source.as_bytes()).ok())
                    .map(|s| s.to_string());

                if let (Some(name), Some(ty)) = (field_name, field_type) {
                    fields.push((name, ty));
                }
            }
        }

        fields
    }

    /// Get module name from source code (used by ERD)
    fn get_module_name_from_source(&self, source: &str, tree: &tree_sitter::Tree) -> String {
        let mut cursor = tree.root_node().walk();
        for child in tree.root_node().children(&mut cursor) {
            if child.kind() == "module_declaration" {
                if let Some(name) = child.child_by_field_name("name")
                    .or_else(|| child.children(&mut child.walk())
                        .find(|c| c.kind() == "upper_case_qid")) {
                    if let Ok(text) = name.utf8_text(source.as_bytes()) {
                        return text.to_string();
                    }
                }
            }
        }
        "Main".to_string()
    }

    /// Process a field type for ERD relationships
    fn process_erd_field(
        &self,
        parent_type: &str,
        field_name: &str,
        field_type_str: &str,
        current_module: &str,
        visited: &mut HashSet<String>,
        entities: &mut Vec<ErdEntity>,
        relationships: &mut Vec<ErdRelationship>,
        warnings: &mut Vec<String>,
    ) {
        // Detect container and cardinality
        let (cardinality, inner_type) = self.detect_erd_cardinality(field_type_str);

        // Check for Id foreign key pattern: "Id XxxId" -> relationship to "Xxx"
        if let Some(target_entity) = self.extract_id_fk_target(&inner_type) {
            // Skip self-references via "id" field (primary key, not FK)
            if field_name == "id" && target_entity == parent_type {
                return;
            }

            relationships.push(ErdRelationship {
                from: parent_type.to_string(),
                to: target_entity.clone(),
                field_name: field_name.to_string(),
                cardinality,
            });

            // Recursively process the target entity
            self.collect_erd_entities(
                &target_entity,
                current_module,
                visited,
                entities,
                relationships,
                warnings,
            );
            return;
        }

        // Extract the entity type name from inner_type
        if let Some(entity_name) = self.extract_erd_entity_type(&inner_type) {
            // Skip primitive types
            if self.is_erd_primitive_type(&entity_name) {
                return;
            }

            // Skip wrapper types
            if self.is_erd_wrapper_type(&entity_name) {
                return;
            }

            // Add relationship
            relationships.push(ErdRelationship {
                from: parent_type.to_string(),
                to: entity_name.clone(),
                field_name: field_name.to_string(),
                cardinality,
            });

            // Recursively process the entity type
            self.collect_erd_entities(
                &entity_name,
                current_module,
                visited,
                entities,
                relationships,
                warnings,
            );
        }
    }

    /// Extract FK target from "Id XxxId" pattern -> "Xxx"
    fn extract_id_fk_target(&self, type_str: &str) -> Option<String> {
        let trimmed = type_str.trim();

        // Handle parenthesized: "(Id XxxId)"
        let inner = if trimmed.starts_with('(') && trimmed.ends_with(')') {
            &trimmed[1..trimmed.len()-1]
        } else {
            trimmed
        };

        // Match "Id XxxId" pattern (e.g., "Id UserId", "Id Id.BlogSectionId")
        let parts: Vec<&str> = inner.split_whitespace().collect();
        if parts.len() == 2 && parts[0] == "Id" {
            let phantom_type = parts[1];
            // Strip module prefix if present (e.g., "Id.BlogSectionId" -> "BlogSectionId")
            let phantom_type = phantom_type.rsplit('.').next().unwrap_or(phantom_type);
            // XxxId -> Xxx (strip "Id" suffix)
            if phantom_type.ends_with("Id") && phantom_type.len() > 2 {
                let entity_name = &phantom_type[..phantom_type.len() - 2];
                if entity_name.chars().next().is_some_and(|c| c.is_uppercase()) {
                    return Some(entity_name.to_string());
                }
            }
        }

        None
    }

    /// Detect cardinality from type string
    fn detect_erd_cardinality(&self, type_str: &str) -> (ErdCardinality, String) {
        let trimmed = type_str.trim();

        // One-to-many containers
        let one_to_many_prefixes = [
            "List ", "Array ", "Set ", "SeqSet ", "Dict ", "SeqDict ",
            "AssocList.Dict ", "AssocSet.Set ", "BiDict ", "BiDict.Assoc ",
            "BiDict.Assoc2 ", "Cache ", "List.Nonempty.Nonempty ",
            "Nonempty ",
        ];

        for prefix in &one_to_many_prefixes {
            if let Some(inner) = trimmed.strip_prefix(prefix) {
                return (ErdCardinality::OneToMany, self.extract_last_type_param(inner));
            }
        }

        // Handle parenthesized container types like "SeqDict (Id GroupId) Group"
        let paren_containers = ["SeqDict", "Dict", "AssocList.Dict", "BiDict", "Cache"];
        for container in &paren_containers {
            if trimmed.starts_with(container) && trimmed.len() > container.len() {
                let rest = trimmed[container.len()..].trim();
                if rest.starts_with('(') {
                    // This is Dict/SeqDict with parenthesized key type
                    return (ErdCardinality::OneToMany, self.extract_last_type_param(rest));
                }
            }
        }

        // Zero-or-one (Maybe)
        if let Some(inner) = trimmed.strip_prefix("Maybe ") {
            return (ErdCardinality::ZeroOrOne, inner.trim().to_string());
        }

        // Direct reference
        (ErdCardinality::OneToOne, trimmed.to_string())
    }

    /// Extract the last type parameter (for Dict-like types, this is the value type)
    fn extract_last_type_param(&self, type_str: &str) -> String {
        let trimmed = type_str.trim();

        // Handle balanced parentheses to find the last type
        let mut paren_depth: i32 = 0;
        let mut last_space_at_depth_0 = None;

        for (i, c) in trimmed.char_indices() {
            match c {
                '(' => paren_depth += 1,
                ')' => paren_depth = paren_depth.saturating_sub(1),
                ' ' if paren_depth == 0 => last_space_at_depth_0 = Some(i),
                _ => {}
            }
        }

        if let Some(pos) = last_space_at_depth_0 {
            return trimmed[pos + 1..].to_string();
        }

        // No space found at depth 0, return as-is (might be parenthesized)
        if trimmed.starts_with('(') && trimmed.ends_with(')') {
            return trimmed[1..trimmed.len()-1].to_string();
        }

        trimmed.to_string()
    }

    /// Extract entity type name from a type expression
    fn extract_erd_entity_type(&self, type_str: &str) -> Option<String> {
        let trimmed = type_str.trim();

        // Handle parenthesized types
        if trimmed.starts_with('(') && trimmed.ends_with(')') {
            return self.extract_erd_entity_type(&trimmed[1..trimmed.len()-1]);
        }

        // Get the first identifier (type name)
        let first_word = trimmed.split_whitespace().next()?;

        // Handle qualified names like "Group.Event"
        let type_name = first_word.rsplit('.').next()?;

        // Must start with uppercase (Elm type convention)
        if type_name.chars().next()?.is_uppercase() {
            Some(type_name.to_string())
        } else {
            None
        }
    }

    /// Check if a type is a primitive (shouldn't be an entity)
    fn is_erd_primitive_type(&self, type_name: &str) -> bool {
        matches!(
            type_name,
            "String" | "Int" | "Float" | "Bool" | "Char" |
            "Posix" | "Zone" | "Time" |
            "Key" | "Url" |
            "ClientId" | "SessionId" |
            "Cmd" | "Sub" | "Task" |
            "Json" | "Value" | "Decoder" | "Encoder" |
            "Never" | "Order" |
            "Quantity" | "Pixels" |
            "Result" | "Http" | "Error"
        )
    }

    /// Check if a type is a wrapper type (Id, Name, etc.)
    fn is_erd_wrapper_type(&self, type_name: &str) -> bool {
        matches!(
            type_name,
            "Id" | "Name" | "Description" | "EmailAddress" | "GroupName" |
            "ProfileImage" | "Address" | "EventName" | "Link" | "MaxAttendees" |
            "Untrusted"
        )
    }
}
