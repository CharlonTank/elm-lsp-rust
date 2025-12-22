//! Type checker for definition resolution.
//!
//! Uses the binder and type inference to resolve what definition
//! a given AST node refers to. Critical for accurate field renaming.

use std::collections::HashMap;
use std::path::Path;
use tree_sitter::{Node, Tree};

use crate::binder::{SymbolLinks, bind_tree};
use crate::inference::{InferenceScope, InferenceResult, infer_file};
use crate::types::Type;

/// Result of finding a definition
#[derive(Debug, Clone)]
pub struct DefinitionResult {
    /// The symbol that was found
    pub symbol: Option<FieldDefinition>,
    /// The type at this location
    pub ty: Option<Type>,
}

/// A field definition with its location
#[derive(Debug, Clone)]
pub struct FieldDefinition {
    pub name: String,
    pub node_id: usize,
    pub type_alias_name: Option<String>,
    pub type_alias_node_id: Option<usize>,
    pub module_name: String,
    pub uri: String,
}

/// Type checker that resolves definitions using type inference
pub struct TypeChecker {
    /// Cached inference results per file
    inference_cache: HashMap<String, InferenceResult>,
    /// Cached symbol links per file
    symbol_links_cache: HashMap<String, SymbolLinks>,
    /// Cached parsed trees per file
    tree_cache: HashMap<String, Tree>,
    /// Cached source code per file
    source_cache: HashMap<String, String>,
}

impl TypeChecker {
    pub fn new() -> Self {
        Self {
            inference_cache: HashMap::new(),
            symbol_links_cache: HashMap::new(),
            tree_cache: HashMap::new(),
            source_cache: HashMap::new(),
        }
    }

    /// Index a file for type checking
    pub fn index_file(&mut self, uri: &str, source: &str, tree: Tree) {
        // Store source and tree
        self.source_cache.insert(uri.to_string(), source.to_string());
        self.tree_cache.insert(uri.to_string(), tree.clone());

        // Bind symbols
        let symbol_links = bind_tree(source, &tree);
        self.symbol_links_cache.insert(uri.to_string(), symbol_links);

        // Run type inference
        let result = infer_file(source, &tree, uri);
        self.inference_cache.insert(uri.to_string(), result);
    }

    /// Get the type of an expression at a given node
    pub fn get_type(&self, uri: &str, node_id: usize) -> Option<Type> {
        self.inference_cache.get(uri)
            .and_then(|result| result.expression_types.get(&node_id).cloned())
    }

    /// Find the definition of a field at a given position
    pub fn find_field_definition(
        &self,
        uri: &str,
        node: Node,
        source: &str,
    ) -> Option<FieldDefinition> {
        let node_kind = node.kind();
        let parent_kind = node.parent().map(|p| p.kind());
        let node_text = node.utf8_text(source.as_bytes()).unwrap_or("");

        tracing::debug!(
            "find_field_definition: node_kind={}, parent_kind={:?}, text={}",
            node_kind, parent_kind, node_text
        );

        // Check if this is a field reference
        let field_name = match (node_kind, parent_kind) {
            // Field in type definition
            ("lower_case_identifier", Some("field_type")) => {
                Some(node.utf8_text(source.as_bytes()).ok()?.to_string())
            }
            // Field access: user.name
            ("lower_case_identifier", Some("field_access_expr")) => {
                Some(node.utf8_text(source.as_bytes()).ok()?.to_string())
            }
            // Field accessor: .name
            ("lower_case_identifier", Some("field_accessor_function_expr")) => {
                Some(node.utf8_text(source.as_bytes()).ok()?.to_string())
            }
            // Field in record expression: { name = value }
            ("lower_case_identifier", Some("field")) => {
                // Check if this is the field name (first child, not the value)
                let parent = node.parent()?;
                let first_child = parent.child(0)?;
                if first_child.id() == node.id() && first_child.kind() == "lower_case_identifier" {
                    Some(node.utf8_text(source.as_bytes()).ok()?.to_string())
                } else {
                    None
                }
            }
            // Field in record pattern: { name }
            ("lower_pattern", Some("record_pattern")) => {
                Some(node.utf8_text(source.as_bytes()).ok()?.to_string())
            }
            _ => None,
        }?;

        // Try to resolve to the field's type alias definition
        self.resolve_field_to_definition(uri, &field_name, node, source)
    }

    /// Resolve a field reference to its type alias definition
    fn resolve_field_to_definition(
        &self,
        uri: &str,
        field_name: &str,
        node: Node,
        source: &str,
    ) -> Option<FieldDefinition> {
        let parent = node.parent()?;

        match parent.kind() {
            "field_type" => {
                // This is the definition itself
                // Find the enclosing type alias
                let type_alias = self.find_enclosing_type_alias(parent)?;
                let alias_name = self.get_type_alias_name(&type_alias, source)?;

                Some(FieldDefinition {
                    name: field_name.to_string(),
                    node_id: node.id(),
                    type_alias_name: Some(alias_name.clone()),
                    type_alias_node_id: Some(type_alias.id()),
                    module_name: self.get_module_name(uri, source),
                    uri: uri.to_string(),
                })
            }
            "field_access_expr" => {
                // Get the target's type
                let target = parent.child_by_field_name("target")?;
                let target_type = self.infer_type_of_node(uri, target, source)?;

                self.field_definition_from_type(&target_type, field_name, uri)
            }
            "field" => {
                // Record expression - try to find the record type
                let record_expr = parent.parent()?;
                tracing::debug!("field: record_expr kind={}", record_expr.kind());
                if record_expr.kind() == "record_expr" {
                    // Check if there's a base record
                    if let Some(base) = record_expr.children(&mut record_expr.walk())
                        .find(|c| c.kind() == "record_base_identifier") {
                        tracing::debug!("field: found base record, inferring type");
                        let base_type = self.infer_type_of_node(uri, base, source);
                        tracing::debug!("field: base type = {:?}", base_type);
                        let base_type = base_type?;
                        return self.field_definition_from_type(&base_type, field_name, uri);
                    }
                    // Otherwise, try to infer from context (e.g., function return type)
                    let record_type = self.get_type(uri, record_expr.id());
                    tracing::debug!("field: record_expr type = {:?}", record_type);
                    let record_type = record_type?;
                    return self.field_definition_from_type(&record_type, field_name, uri);
                }
                None
            }
            "record_pattern" => {
                // Try to get the type being matched
                let pattern_type = self.get_type(uri, parent.id());
                tracing::debug!("record_pattern: pattern type = {:?}", pattern_type);
                let pattern_type = pattern_type?;
                self.field_definition_from_type(&pattern_type, field_name, uri)
            }
            "field_accessor_function_expr" => {
                // Polymorphic accessor - can't determine specific type alias
                // Return None to indicate this is polymorphic
                None
            }
            _ => None,
        }
    }

    /// Find the enclosing type alias declaration
    fn find_enclosing_type_alias<'a>(&self, node: Node<'a>) -> Option<Node<'a>> {
        let mut current = Some(node);
        while let Some(n) = current {
            if n.kind() == "type_alias_declaration" {
                return Some(n);
            }
            current = n.parent();
        }
        None
    }

    /// Get the name of a type alias
    fn get_type_alias_name<'a>(&self, type_alias: &Node, source: &'a str) -> Option<String> {
        type_alias.child_by_field_name("name")
            .and_then(|n| n.utf8_text(source.as_bytes()).ok())
            .map(|s| s.to_string())
    }

    /// Get module name from the file
    fn get_module_name(&self, uri: &str, source: &str) -> String {
        // Try to parse from source
        if let Some(tree) = self.tree_cache.get(uri) {
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
        }

        // Fall back to deriving from path
        Path::new(uri)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string()
    }

    /// Infer the type of a specific node
    fn infer_type_of_node(&self, uri: &str, node: Node, source: &str) -> Option<Type> {
        // First check cache
        if let Some(ty) = self.get_type(uri, node.id()) {
            return Some(ty);
        }

        // Otherwise do local inference
        let tree = self.tree_cache.get(uri)?;
        let symbol_links = self.symbol_links_cache.get(uri)?;

        let mut scope = InferenceScope::new(source, uri.to_string(), symbol_links);
        Some(scope.infer(node))
    }

    /// Get field definition from a resolved type
    fn field_definition_from_type(
        &self,
        ty: &Type,
        field_name: &str,
        _current_uri: &str,
    ) -> Option<FieldDefinition> {
        match ty {
            Type::Record(r) => {
                if r.fields.contains_key(field_name) {
                    // Try to find the alias
                    if let Some(alias) = &r.alias {
                        // Look up the type alias in the codebase
                        return self.find_field_in_type_alias(
                            &alias.module,
                            &alias.name,
                            field_name,
                        );
                    }
                }
                None
            }
            Type::MutableRecord(mr) => {
                if mr.fields.contains_key(field_name) {
                    // Mutable records don't have a fixed alias
                    None
                } else {
                    None
                }
            }
            Type::Union(u) => {
                // This might be a type alias - try to resolve it
                // Type aliases like "Person" are stored as Union types
                self.find_field_in_type_alias(&u.module, &u.name, field_name)
            }
            _ => None,
        }
    }

    /// Find a field definition in a type alias by name
    fn find_field_in_type_alias(
        &self,
        module: &str,
        type_name: &str,
        field_name: &str,
    ) -> Option<FieldDefinition> {
        // Search through all indexed files
        for (uri, tree) in &self.tree_cache {
            let source = self.source_cache.get(uri)?;

            // Check if this is the right module
            let file_module = self.get_module_name(uri, source);
            if !module.is_empty() && file_module != module {
                continue;
            }

            // Find the type alias
            let mut cursor = tree.root_node().walk();
            for child in tree.root_node().children(&mut cursor) {
                if child.kind() == "type_alias_declaration" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name = name_node.utf8_text(source.as_bytes()).ok()?;
                        if name == type_name {
                            // Found the type alias, now find the field
                            if let Some(type_expr) = child.child_by_field_name("typeExpression") {
                                return self.find_field_in_record_type(
                                    type_expr,
                                    field_name,
                                    uri,
                                    source,
                                    type_name,
                                    child.id(),
                                );
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Find a field in a record type expression
    fn find_field_in_record_type(
        &self,
        node: Node,
        field_name: &str,
        uri: &str,
        source: &str,
        type_alias_name: &str,
        type_alias_node_id: usize,
    ) -> Option<FieldDefinition> {
        if node.kind() == "record_type" {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "field_type" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name = name_node.utf8_text(source.as_bytes()).ok()?;
                        if name == field_name {
                            return Some(FieldDefinition {
                                name: field_name.to_string(),
                                node_id: name_node.id(),
                                type_alias_name: Some(type_alias_name.to_string()),
                                type_alias_node_id: Some(type_alias_node_id),
                                module_name: self.get_module_name(uri, source),
                                uri: uri.to_string(),
                            });
                        }
                    }
                }
            }
        }
        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(def) = self.find_field_in_record_type(
                child, field_name, uri, source, type_alias_name, type_alias_node_id
            ) {
                return Some(def);
            }
        }
        None
    }

    /// Check if a node is a field definition (in a type alias)
    pub fn is_field_definition(&self, node: Node) -> bool {
        node.parent()
            .map(|p| p.kind() == "field_type")
            .unwrap_or(false)
    }

    /// Get all files that have been indexed
    pub fn indexed_files(&self) -> impl Iterator<Item = &str> {
        self.source_cache.keys().map(|s| s.as_str())
    }

    /// Get the cached tree for a file
    pub fn get_tree(&self, uri: &str) -> Option<&Tree> {
        self.tree_cache.get(uri)
    }

    /// Get the cached source for a file
    pub fn get_source(&self, uri: &str) -> Option<&str> {
        self.source_cache.get(uri).map(|s| s.as_str())
    }

    /// Clear cached data for a file
    pub fn invalidate_file(&mut self, uri: &str) {
        self.inference_cache.remove(uri);
        self.symbol_links_cache.remove(uri);
        self.tree_cache.remove(uri);
        self.source_cache.remove(uri);
    }

    /// Get all field usages for a given field name
    pub fn find_all_field_usages(
        &self,
        uri: &str,
        field_name: &str,
    ) -> Vec<(String, usize)> {
        let mut usages = Vec::new();

        if let Some(result) = self.inference_cache.get(uri) {
            for ref_info in result.field_references.get(field_name) {
                usages.push((ref_info.uri.clone(), ref_info.node_id));
            }
        }

        usages
    }
}

impl Default for TypeChecker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(source: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&tree_sitter_elm::LANGUAGE.into()).unwrap();
        parser.parse(source, None).unwrap()
    }

    #[test]
    fn test_find_field_definition_in_type_alias() {
        let source = r#"
module Test exposing (..)

type alias User =
    { name : String
    , email : String
    }
"#;
        let tree = parse(source);
        let mut checker = TypeChecker::new();
        checker.index_file("test.elm", source, tree.clone());

        // Find the "name" field node
        let root = tree.root_node();
        let field = find_field_node(root, source, "name").expect("Could not find name field");
        let def = checker.find_field_definition("test.elm", field, source);
        assert!(def.is_some());
        let def = def.unwrap();
        assert_eq!(def.name, "name");
        assert_eq!(def.type_alias_name, Some("User".to_string()));
    }

    fn find_field_node<'a>(node: Node<'a>, source: &str, field_name: &str) -> Option<Node<'a>> {
        if node.kind() == "lower_case_identifier" {
            if let Ok(text) = node.utf8_text(source.as_bytes()) {
                if text == field_name && node.parent().map(|p| p.kind()) == Some("field_type") {
                    return Some(node);
                }
            }
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = find_field_node(child, source, field_name) {
                return Some(found);
            }
        }
        None
    }

    fn find_node_at_point(node: Node, point: tree_sitter::Point) -> Option<Node> {
        fn point_in_range(point: tree_sitter::Point, start: tree_sitter::Point, end: tree_sitter::Point) -> bool {
            if point.row < start.row || point.row > end.row {
                return false;
            }
            if point.row == start.row && point.column < start.column {
                return false;
            }
            if point.row == end.row && point.column > end.column {
                return false;
            }
            true
        }

        if !point_in_range(point, node.start_position(), node.end_position()) {
            return None;
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = find_node_at_point(child, point) {
                return Some(found);
            }
        }

        Some(node)
    }

    #[test]
    fn test_find_node_at_field_position() {
        let source = r#"module FieldRename exposing (..)


type alias Person =
    { name : String
    , email : String
    }
"#;
        let tree = parse(source);

        // Line 4 (0-indexed), character 6 - should be 'n' of 'name'
        let point = tree_sitter::Point::new(4, 6);

        let node = find_node_at_point(tree.root_node(), point).expect("Should find node");

        println!("Found node kind: {}", node.kind());
        println!("Found node text: {:?}", node.utf8_text(source.as_bytes()));
        println!("Found node position: {:?} - {:?}", node.start_position(), node.end_position());
        if let Some(parent) = node.parent() {
            println!("Parent kind: {}", parent.kind());
        }

        assert_eq!(node.kind(), "lower_case_identifier", "Expected lower_case_identifier");
        assert_eq!(node.utf8_text(source.as_bytes()).unwrap(), "name", "Expected 'name'");
        assert_eq!(node.parent().map(|p| p.kind()), Some("field_type"), "Parent should be field_type");
    }

}
