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

/// Target type alias info for filtering structural matches
#[derive(Debug, Clone)]
pub struct TargetTypeAlias {
    pub name: String,
    pub module: String,
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
        self.find_field_definition_impl(uri, node, source, None)
    }

    /// Find the definition of a field at a given position, with target type alias for filtering
    /// When target is provided, structural matching will only return matches for that type alias
    pub fn find_field_definition_with_target(
        &self,
        uri: &str,
        node: Node,
        source: &str,
        target: &TargetTypeAlias,
    ) -> Option<FieldDefinition> {
        self.find_field_definition_impl(uri, node, source, Some(target))
    }

    fn find_field_definition_impl(
        &self,
        uri: &str,
        node: Node,
        source: &str,
        target_alias: Option<&TargetTypeAlias>,
    ) -> Option<FieldDefinition> {
        let node_kind = node.kind();
        let parent_kind = node.parent().map(|p| p.kind());
        let node_text = node.utf8_text(source.as_bytes()).unwrap_or("");

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
            // Fallback: walk up the tree to find if this is inside a field_type
            ("lower_case_identifier", _) => {
                // Check if any ancestor is a field_type
                let mut current = node.parent();
                while let Some(ancestor) = current {
                    if ancestor.kind() == "field_type" {
                        // Found it - this is a field in a type definition
                        // But we need to verify we're the field name, not a type reference
                        if let Some(first_child) = ancestor.child(0) {
                            // The field name should be the first child of field_type
                            if first_child.kind() == "lower_case_identifier" {
                                // Check if node is this first child or a descendant of it
                                if Self::is_same_or_ancestor(first_child, node) {
                                    return Some(node.utf8_text(source.as_bytes()).ok()?.to_string())
                                        .and_then(|name| self.resolve_field_to_definition_impl(uri, &name, node, source, target_alias));
                                }
                            }
                        }
                        break;
                    }
                    current = ancestor.parent();
                }
                None
            }
            _ => None,
        }?;

        // Try to resolve to the field's type alias definition
        self.resolve_field_to_definition_impl(uri, &field_name, node, source, target_alias)
    }

    /// Resolve a field reference to its type alias definition
    fn resolve_field_to_definition(
        &self,
        uri: &str,
        field_name: &str,
        node: Node,
        source: &str,
    ) -> Option<FieldDefinition> {
        self.resolve_field_to_definition_impl(uri, field_name, node, source, None)
    }

    fn resolve_field_to_definition_impl(
        &self,
        uri: &str,
        field_name: &str,
        node: Node,
        source: &str,
        target_alias: Option<&TargetTypeAlias>,
    ) -> Option<FieldDefinition> {
        use std::io::Write;
        let parent = node.parent()?;

        match parent.kind() {
            "field_type" => {
                // This is the definition itself
                // Find the enclosing type alias
                let type_alias_opt = self.find_enclosing_type_alias(parent);
                let type_alias = type_alias_opt?;
                let alias_name = self.get_type_alias_name(&type_alias, source)?;
                let module_name = self.get_module_name(uri, source);

                // If target is specified, only return if this field belongs to the target type alias
                if let Some(target) = target_alias {
                    if alias_name != target.name || module_name != target.module {
                        return None;
                    }
                }

                Some(FieldDefinition {
                    name: field_name.to_string(),
                    node_id: node.id(),
                    type_alias_name: Some(alias_name.clone()),
                    type_alias_node_id: Some(type_alias.id()),
                    module_name,
                    uri: uri.to_string(),
                })
            }
            "field_access_expr" => {
                use std::io::Write;
                // Get the target's type
                let target = parent.child_by_field_name("target")?;
                let target_text = target.utf8_text(source.as_bytes()).unwrap_or("?");
                let target_type = self.infer_type_of_node(uri, target, source);

                if let Some(target_type) = target_type {
                    let result = self.field_definition_from_type_impl(&target_type, field_name, uri, target_alias);

                    // If type-based resolution failed and target is a simple variable,
                    // try to collect all field accesses on that variable in the scope
                    if result.is_none() && target.kind() == "value_expr" {
                        // First, try to resolve the type from pattern binding (e.g., `(Group a)`)
                        if let Some(decl) = Self::find_containing_value_declaration(target) {
                            if let Some(pattern_type) = self.try_resolve_from_pattern_binding(target_text, decl, uri, source) {
                                // Found a constructor pattern - use the constructor's record fields
                                if let Some(def) = self.find_field_in_custom_type(&pattern_type, field_name, uri, target_alias) {
                                    return Some(def);
                                }
                            }
                        }

                        if let Some(scope) = self.find_enclosing_scope(parent) {
                            let scope_text = scope.utf8_text(source.as_bytes()).unwrap_or("?");
                            let scope_preview: String = scope_text.chars().take(50).collect();
                            let all_fields = self.collect_field_accesses_on_variable(target_text, scope, source);
                            // If we found at least 2 fields, use structural matching
                            if all_fields.len() >= 2 {
                                // For structural matching, find the ACTUAL type first (without target filter)
                                // then verify it matches the target
                                let result = self.find_type_alias_by_fields(&all_fields, field_name, uri, None);
                                if let Some(ref def) = result {
                                    // If we have a target, only return if the found type matches
                                    if let Some(target) = target_alias {
                                        if def.type_alias_name.as_deref() == Some(target.name.as_str())
                                            && def.module_name == target.module
                                        {
                                            return result;
                                        }
                                        // Found a different type - don't return it
                                    } else {
                                        return result;
                                    }
                                }
                            }
                        } else {
                        }
                    }

                    // Handle chained field access (e.g., model.form.name)
                    // If target is itself a field_access_expr, recursively resolve it
                    if result.is_none() && target.kind() == "field_access_expr" {
                        // Get the field name from the target (e.g., "form" from "model.form")
                        if let Some(target_field) = target.child_by_field_name("field") {
                            let target_field_name = target_field.utf8_text(source.as_bytes()).unwrap_or("");
                            // Recursively resolve the target field_access_expr to get its type
                            // We don't filter by target here - we want the actual type
                            if let Some(target_def) = self.find_field_definition(uri, target_field, source) {
                                // Get the field's type from the target type
                                if let Some(ref type_alias_name) = target_def.type_alias_name {
                                    // Look up the type alias and find the field's type
                                    if let Some(field_type) = self.get_field_type_from_type_alias(
                                        type_alias_name, &target_def.module_name, target_field_name, uri
                                    ) {
                                        // Now look for our field in that type
                                        if let Some(def) = self.find_field_in_type_alias_or_custom_type(&field_type, field_name, uri, target_alias) {
                                            return Some(def);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    result
                } else {
                    None
                }
            }
            "field" => {
                use std::io::Write;
                // Record expression - try to find the record type
                let record_expr = match parent.parent() {
                    Some(r) => r,
                    None => {
                        return None;
                    }
                };
                tracing::debug!("find_field_definition(field): record_expr kind = {:?}", record_expr.kind());
                if record_expr.kind() == "record_expr" {
                    // Check if there's a base record (record update syntax like { a | name = ... })
                    let base_opt = record_expr.children(&mut record_expr.walk())
                        .find(|c| c.kind() == "record_base_identifier");
                    if let Some(base) = base_opt {
                        let base_text = base.utf8_text(source.as_bytes()).unwrap_or("?");
                        let base_type = self.infer_type_of_node(uri, base, source);
                        tracing::debug!("find_field_definition(field): base type = {:?}", base_type);
                        if let Some(ref base_type) = base_type {
                            let result = self.field_definition_from_type_impl(base_type, field_name, uri, target_alias);
                            if result.is_some() {
                                return result;
                            }
                        }

                        // Try pattern binding resolution (e.g., `(Group a)` -> a is Group)
                        if let Some(decl) = Self::find_containing_value_declaration(record_expr) {
                            if let Some(pattern_type) = self.try_resolve_from_pattern_binding(base_text, decl, uri, source) {
                                // Found a constructor pattern - use the constructor's record fields
                                // Try to find the field in this custom type
                                // If we have a target and the pattern type is NOT the target,
                                // we should NOT fall through to structural matching
                                if let Some(def) = self.find_field_in_custom_type(&pattern_type, field_name, uri, target_alias) {
                                    return Some(def);
                                }
                                // If we found a pattern type but couldn't find the field matching our target,
                                // it means this field belongs to a different type. Don't fall through to structural matching.
                                if target_alias.is_some() {
                                    return None;
                                }
                            }
                        }

                        // Try lambda parameter type resolution (e.g., Cache.map (\a -> { a | name = ... }) cache)
                        if let Some(lambda_type) = self.try_resolve_lambda_param_type(base_text, record_expr, uri, source) {
                            // Found a type from lambda context - look for the field in that type
                            if let Some(def) = self.find_field_in_type_alias_by_name(&lambda_type, field_name, uri, target_alias) {
                                return Some(def);
                            }
                        }

                        // If type-based resolution failed, try scope-based field collection
                        // (similar to field_access_expr case)
                        if let Some(scope) = self.find_enclosing_scope(parent) {
                            let all_fields = self.collect_field_accesses_on_variable(base_text, scope, source);
                            // Also collect fields from the record update itself
                            let record_fields = self.collect_record_expr_fields(record_expr, source);
                            let mut combined_fields = all_fields;
                            for f in record_fields {
                                if !combined_fields.contains(&f) {
                                    combined_fields.push(f);
                                }
                            }

                            // For structural matching, require at least 2 fields normally
                            // BUT for single-field with a target, use stricter candidate counting
                            let min_fields = if target_alias.is_some() { 1 } else { 2 };
                            if combined_fields.len() >= min_fields {
                                if combined_fields.len() == 1 && target_alias.is_some() {
                                    // For single-field with target: count all candidates first
                                    // Only accept if target is a candidate AND there are few alternatives
                                    let (target_matches, other_count) = self.count_field_candidates(field_name, target_alias.unwrap());

                                    // Check if the BASE of the record update is a lambda parameter.
                                    // This is a stronger check than just "in a lambda" because the base
                                    // might be a variable from outer scope (not the lambda param).
                                    let base_is_lambda_param = {
                                        if let Some(lambda) = Self::find_containing_node_of_kind(record_expr, "anonymous_function_expr") {
                                            // Check if base_text matches any of the lambda's parameters
                                            let mut is_param = false;
                                            let mut cursor = lambda.walk();
                                            for child in lambda.children(&mut cursor) {
                                                if child.kind() == "pattern" {
                                                    let param_text = child.utf8_text(source.as_bytes()).unwrap_or("");
                                                    if param_text == base_text {
                                                        is_param = true;
                                                        break;
                                                    }
                                                }
                                            }
                                            is_param
                                        } else {
                                            false
                                        }
                                    };

                                    // For single-field matches:
                                    // - If base is a lambda parameter: accept if target matches (trust mapping context)
                                    // - Otherwise: only accept if there are 3 or fewer alternatives (conservative)
                                    let should_accept = target_matches && (base_is_lambda_param || other_count <= 3);

                                    if should_accept {
                                        // Return definition for the target type
                                        return self.find_field_in_type_alias_by_name(
                                            &target_alias.unwrap().name,
                                            field_name,
                                            uri,
                                            target_alias,
                                        );
                                    }
                                } else {
                                    // For 2+ fields: find the ACTUAL type first (not filtered by target)
                                    // then verify it matches the target
                                    let result = self.find_type_alias_by_fields(&combined_fields, field_name, uri, None);
                                    if let Some(ref def) = result {
                                        // If we have a target, only return if the found type matches
                                        if let Some(target) = target_alias {
                                            if def.type_alias_name.as_deref() == Some(target.name.as_str())
                                                && def.module_name == target.module
                                            {
                                                return result;
                                            }
                                            // Found a different type - this field belongs to a different type alias
                                        } else {
                                            return result;
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Try to get cached type from inference
                    let record_type = self.get_type(uri, record_expr.id());
                    tracing::debug!("find_field_definition(field): cached type = {:?}", record_type);
                    if let Some(record_type) = record_type {
                        // Only return if we found a definition - otherwise fall through to structural matching
                        if let Some(def) = self.field_definition_from_type_impl(&record_type, field_name, uri, target_alias) {
                            return Some(def);
                        }
                    }

                    // Fallback: structural matching - collect fields from record_expr and match against type aliases
                    let record_fields = self.collect_record_expr_fields(record_expr, source);
                    tracing::debug!("find_field_definition(field): collected fields = {:?}", record_fields);
                    // Require at least 2 fields to avoid false positives (many types share common field names)
                    if record_fields.len() >= 2 {
                        // For structural matching, find the ACTUAL type first (without target filter)
                        // then verify it matches the target
                        let result = self.find_type_alias_by_fields(&record_fields, field_name, uri, None);
                        tracing::debug!("find_field_definition(field): structural match result = {:?}", result.as_ref().map(|d| &d.type_alias_name));
                        if let Some(ref def) = result {
                            // If we have a target, only return if the found type matches
                            if let Some(target) = target_alias {
                                if def.type_alias_name.as_deref() == Some(target.name.as_str())
                                    && def.module_name == target.module
                                {
                                    return result;
                                }
                                // Found a different type - don't return it
                            } else {
                                return result;
                            }
                        }
                    }
                }
                None
            }
            "record_pattern" => {
                // Try to get the type being matched
                let pattern_type = self.get_type(uri, parent.id());
                if let Some(ref pattern_type) = pattern_type {
                    let def = self.field_definition_from_type_impl(pattern_type, field_name, uri, target_alias);
                    if let Some(def) = def {
                        return Some(def);
                    }
                }

                // Fallback: collect fields from the record pattern and use structural matching
                let record_fields = self.collect_pattern_fields(parent, source);
                // Require at least 2 fields to avoid false positives
                if record_fields.len() >= 2 {
                    // For structural matching, find the ACTUAL type first (without target filter)
                    let result = self.find_type_alias_by_fields(&record_fields, field_name, uri, None);
                    if let Some(ref def) = result {
                        // If we have a target, only return if the found type matches
                        if let Some(target) = target_alias {
                            if def.type_alias_name.as_deref() == Some(target.name.as_str())
                                && def.module_name == target.module
                            {
                                return result;
                            }
                            // Found a different type - don't return it
                        } else {
                            return result;
                        }
                    }
                }
                None
            }
            "field_accessor_function_expr" => {
                // Polymorphic accessor - can't determine specific type alias
                // Return None to indicate this is polymorphic
                None
            }
            _ => None,
        }
    }

    /// Find the enclosing type alias or custom type declaration
    /// Returns the type_alias_declaration or type_declaration node
    fn find_enclosing_type_alias<'a>(&self, node: Node<'a>) -> Option<Node<'a>> {
        let mut current = Some(node);
        while let Some(n) = current {
            if n.kind() == "type_alias_declaration" || n.kind() == "type_declaration" {
                return Some(n);
            }
            current = n.parent();
        }
        None
    }

    /// Check if `ancestor` is the same node as `node` or an ancestor of it
    fn is_same_or_ancestor(ancestor: Node, node: Node) -> bool {
        if ancestor.id() == node.id() {
            return true;
        }
        let mut current = node.parent();
        while let Some(n) = current {
            if n.id() == ancestor.id() {
                return true;
            }
            current = n.parent();
        }
        false
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
        tracing::info!("infer_type_of_node: node kind={}, id={}", node.kind(), node.id());

        // First check cache
        if let Some(ty) = self.get_type(uri, node.id()) {
            tracing::info!("infer_type_of_node: cache hit {:?}", ty);
            return Some(ty);
        }

        // Otherwise do local inference
        let tree = self.tree_cache.get(uri)?;
        let symbol_links = self.symbol_links_cache.get(uri)?;

        let mut scope = InferenceScope::new(source, uri.to_string(), symbol_links);

        // Find the containing value_declaration to establish parameter bindings
        // This is needed for field access like user.name where user is a function parameter
        if let Some(containing_decl) = Self::find_containing_value_declaration(node) {
            tracing::info!("infer_type_of_node: found containing decl, running inference");
            // Run inference on the whole declaration first to bind parameters
            scope.infer(containing_decl);
            // Now get the type of the specific node from the expression_types cache
            if let Some(ty) = scope.get_expr_type(node.id()) {
                tracing::info!("infer_type_of_node: got type from decl inference: {:?}", ty);
                return Some(ty);
            }
            tracing::info!("infer_type_of_node: node {} not in expression_types after decl inference", node.id());
        }

        let ty = scope.infer(node);
        tracing::info!("infer_type_of_node: direct infer result: {:?}", ty);
        Some(ty)
    }

    /// Find the containing value_declaration for a node
    fn find_containing_value_declaration(node: Node) -> Option<Node> {
        let mut current = node.parent();
        while let Some(n) = current {
            if n.kind() == "value_declaration" {
                return Some(n);
            }
            current = n.parent();
        }
        None
    }

    /// Try to resolve the type of a variable by looking at how it's bound in patterns.
    /// For example, if we see `(Group a)` pattern, and we're looking for `a`, return "Group".
    fn try_resolve_from_pattern_binding(
        &self,
        var_name: &str,
        value_decl: Node,
        _uri: &str,
        source: &str,
    ) -> Option<String> {
        // Find the function clause pattern (left side of function definition)
        // value_declaration has a function_declaration_left child
        let func_decl_left = value_decl.child_by_field_name("functionDeclarationLeft")?;

        // Look for patterns in the function arguments
        let mut cursor = func_decl_left.walk();
        for child in func_decl_left.children(&mut cursor) {
            if child.kind() == "pattern" || child.kind() == "parenthesized_expr" {
                if let Some(constructor_name) = self.find_var_in_union_pattern(child, var_name, source) {
                    return Some(constructor_name);
                }
            }
        }
        None
    }

    /// Recursively search for a variable in a union pattern and return the constructor name
    fn find_var_in_union_pattern(&self, node: Node, var_name: &str, source: &str) -> Option<String> {
        match node.kind() {
            "union_pattern" => {
                // Get the constructor name (first child, usually upper_case_qid)
                let mut constructor_name: Option<String> = None;
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "upper_case_qid" {
                        constructor_name = child.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
                    }
                    // Check if the variable is in this pattern's arguments
                    if child.kind() == "pattern" || child.kind() == "lower_pattern" {
                        let text = child.utf8_text(source.as_bytes()).unwrap_or("");
                        if text == var_name {
                            return constructor_name;
                        }
                        // Also recurse into nested patterns
                        if let Some(result) = self.find_var_in_union_pattern(child, var_name, source) {
                            return Some(result);
                        }
                    }
                }
            }
            "pattern" | "parenthesized_expr" => {
                // Recurse into children
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if let Some(result) = self.find_var_in_union_pattern(child, var_name, source) {
                        return Some(result);
                    }
                }
            }
            "lower_pattern" => {
                // This is a simple variable binding - check if it matches
                // But we only care if it's inside a union_pattern, which is handled above
            }
            _ => {}
        }
        None
    }

    /// Find a field definition in a custom type by constructor name
    fn find_field_in_custom_type(
        &self,
        constructor_name: &str,
        field_name: &str,
        _current_uri: &str,
        target_alias: Option<&TargetTypeAlias>,
    ) -> Option<FieldDefinition> {
        // Search all indexed files for custom types with this constructor
        for (uri, tree) in &self.tree_cache {
            let source = match self.source_cache.get(uri) {
                Some(s) => s,
                None => continue,
            };
            let root = tree.root_node();

            let mut cursor = root.walk();
            for child in root.children(&mut cursor) {
                if child.kind() == "type_declaration" {
                    let type_name = child.child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source.as_bytes()).ok());

                    if type_name.is_none() { continue; }
                    let type_name = type_name.unwrap();

                    // Check each variant
                    let mut vc = child.walk();
                    for variant in child.children(&mut vc) {
                        if variant.kind() == "union_variant" {
                            // Get variant/constructor name
                            if let Some(variant_name_node) = variant.child_by_field_name("name") {
                                let variant_name = variant_name_node.utf8_text(source.as_bytes()).unwrap_or("");
                                if variant_name == constructor_name {
                                    // Found the constructor - now look for the record field
                                    if let Some(record_type) = self.find_record_in_union_variant(variant) {
                                        let mut fc = record_type.walk();
                                        for field_child in record_type.children(&mut fc) {
                                            if field_child.kind() == "field_type" {
                                                if let Some(name_node) = field_child.child_by_field_name("name") {
                                                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                                                        if name == field_name {
                                                            // Check target filter if specified
                                                            if let Some(target) = target_alias {
                                                                let module_name = self.get_module_name(uri, source);
                                                                if type_name != target.name || module_name != target.module {
                                                                    continue;
                                                                }
                                                            }
                                                            return Some(FieldDefinition {
                                                                name: field_name.to_string(),
                                                                node_id: name_node.id(),
                                                                type_alias_name: Some(type_name.to_string()),
                                                                type_alias_node_id: Some(child.id()),
                                                                module_name: self.get_module_name(uri, source),
                                                                uri: uri.to_string(),
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Try to resolve the type of a lambda parameter by looking at the function call context.
    /// For example: `Cache.map (\a -> { a | name = name }) model.cachedUsers`
    /// where `cachedUsers : SeqDict (Id UserId) (Cache FrontendUser)`.
    /// The lambda parameter `a` should be typed as `FrontendUser`.
    fn try_resolve_lambda_param_type(
        &self,
        var_name: &str,
        node: Node,
        uri: &str,
        source: &str,
    ) -> Option<String> {
        use std::io::Write;

        // Find the containing lambda (anonymous_function_expr)
        let lambda = Self::find_containing_node_of_kind(node, "anonymous_function_expr")?;

        // Check if var_name is a parameter of this lambda
        // Lambda structure: anonymous_function_expr -> pattern* -> arrow -> expr
        let mut param_index = None;
        let mut param_count = 0;
        {
            let mut cursor = lambda.walk();
            for (idx, child) in lambda.children(&mut cursor).enumerate() {
                if child.kind() == "pattern" {
                    let param_text = child.utf8_text(source.as_bytes()).unwrap_or("");
                    if param_text == var_name {
                        param_index = Some(param_count);
                    }
                    param_count += 1;
                }
            }
        }

        if param_index.is_none() {
            return None;
        }
        let param_index = param_index.unwrap();

        // Find the containing function_call_expr
        let inner_func_call = Self::find_containing_node_of_kind(lambda, "function_call_expr")?;

        // Check if the function call is wrapped in parentheses and applied to more arguments
        // e.g., (Cache.map (\a -> ...)) model.cachedUsers
        // In this case, the lambda is in the inner call, but we need to look at the outer call
        // to find model.cachedUsers
        let (func_call, look_at_outer) = {
            // Check if parent of func_call is parenthesized_expr
            if let Some(parent) = inner_func_call.parent() {
                if parent.kind() == "parenthesized_expr" {
                    // Check if grandparent is function_call_expr
                    if let Some(grandparent) = parent.parent() {
                        if grandparent.kind() == "function_call_expr" {
                            (grandparent, true)
                        } else {
                            (inner_func_call, false)
                        }
                    } else {
                        (inner_func_call, false)
                    }
                } else {
                    (inner_func_call, false)
                }
            } else {
                (inner_func_call, false)
            }
        };

        // Find the function being called and the lambda's position in the arguments
        let mut func_name: Option<String> = None;
        let mut lambda_arg_index = 0;
        let mut other_args: Vec<Node> = Vec::new();

        {
            let mut cursor = func_call.walk();
            let mut saw_func = false;
            let mut arg_idx = 0;
            for child in func_call.children(&mut cursor) {
                if !saw_func {
                    // First meaningful child is the function
                    if child.kind() == "value_expr" || child.kind() == "value_qid" ||
                       child.kind() == "field_access_expr" || child.kind() == "upper_case_qid" {
                        func_name = Some(child.utf8_text(source.as_bytes()).unwrap_or("").to_string());
                        saw_func = true;
                    } else if child.kind() == "parenthesized_expr" && look_at_outer {
                        // When looking at outer call, the parenthesized inner call IS the function
                        // Extract the function name from inside
                        if let Some(inner_call) = Self::find_child_of_kind(child, "function_call_expr") {
                            if let Some(inner_func) = inner_call.child(0) {
                                func_name = Some(inner_func.utf8_text(source.as_bytes()).unwrap_or("").to_string());
                            }
                        }
                        saw_func = true;
                    }
                } else {
                    // Subsequent children are arguments
                    // Skip the lambda itself (identified by ancestry, not direct id comparison)
                    let contains_lambda = Self::node_contains_node(child, lambda);
                    if contains_lambda {
                        lambda_arg_index = arg_idx;
                    } else if child.kind() != "(" && child.kind() != ")" && child.kind() != "," {
                        other_args.push(child);
                    }
                    arg_idx += 1;
                }
            }
        }

        // Try to infer from specific known function patterns
        if let Some(ref fname) = func_name {
            // For Cache.map (\a -> ...) cache, the lambda param type is the inner type of Cache
            // For List.map (\a -> ...) list, the lambda param type is the element type
            // For Dict.map (\k v -> ...) dict, param 0 is key type, param 1 is value type

            // Get the type of the collection argument (usually the last one)
            for arg in &other_args {
                let arg_type = self.infer_type_of_node(uri, *arg, source);

                if let Some(ref arg_ty) = arg_type {
                    // Extract the inner type from common collection patterns
                    if let Some(inner_type) = self.extract_element_type_for_map(fname, arg_ty, param_index) {
                        return Some(inner_type);
                    }
                }
            }
        }

        None
    }

    /// Extract the element type for common map-like function patterns.
    /// For `Cache.map` with `Cache a` argument, returns the type `a`.
    /// For `List.map` with `List a` argument, returns the type `a`.
    fn extract_element_type_for_map(&self, func_name: &str, arg_type: &Type, param_index: usize) -> Option<String> {
        // Handle qualified names like Cache.map, List.map, SeqDict.map, etc.
        let func_parts: Vec<&str> = func_name.split('.').collect();
        let simple_name = func_parts.last().unwrap_or(&func_name);

        // Check for map-like functions where first lambda param is the element type
        if *simple_name == "map" || *simple_name == "filterMap" || *simple_name == "foldl" ||
           *simple_name == "foldr" || *simple_name == "filter" || *simple_name == "any" ||
           *simple_name == "all" || *simple_name == "member" {
            // For these functions, extract element type from the collection
            return self.extract_inner_type_from_collection(arg_type, param_index);
        }

        None
    }

    /// Extract inner type from a collection type like Cache a, List a, SeqDict k v, etc.
    fn extract_inner_type_from_collection(&self, ty: &Type, param_index: usize) -> Option<String> {
        match ty {
            Type::Union(union_type) => {
                let name = &union_type.name;
                let args = &union_type.params;

                // For Cache a, List a, Maybe a: return the inner type (first arg)
                // For SeqDict k v, Dict k v: return value type (second arg) for index 0,
                //   or key type (first arg) for index 0 in Dict.keys-like scenarios

                // Check for Cache specifically - it wraps another type
                if name == "Cache" && !args.is_empty() {
                    // Cache contains another type, extract from it
                    return self.extract_inner_type_from_collection(&args[0], param_index);
                }

                // Check for SeqDict, Dict - they have key-value pairs
                if (name == "SeqDict" || name == "Dict") && args.len() >= 2 {
                    // For map over SeqDict/Dict values, we want the value type (second arg)
                    // param_index 0 usually means the value in most map scenarios
                    return self.extract_inner_type_from_collection(&args[1], param_index);
                }

                // For simple containers like List, Array, Maybe, Set - use first arg
                if !args.is_empty() {
                    // The inner type could be a Named type itself
                    return Some(self.type_to_simple_name(&args[0]));
                }

                None
            }
            Type::Record(_) => {
                // For record types, not a collection
                None
            }
            Type::MutableRecord(_) => {
                None
            }
            _ => None,
        }
    }

    /// Convert a Type to a simple name string (just the type name without module prefix)
    fn type_to_simple_name(&self, ty: &Type) -> String {
        match ty {
            Type::Union(union_type) => union_type.name.clone(),
            Type::Var(type_var) => type_var.name.clone(),
            Type::Function(_) => "Function".to_string(),
            Type::Record(_) => "Record".to_string(),
            Type::MutableRecord(_) => "MutableRecord".to_string(),
            Type::Unit(_) => "()".to_string(),
            Type::Tuple(tuple_type) => format!("Tuple{}", tuple_type.types.len()),
            Type::InProgressBinding => "InProgress".to_string(),
            Type::Unknown => "Unknown".to_string(),
        }
    }

    /// Find a containing node of a specific kind
    fn find_containing_node_of_kind<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
        let mut current = Some(node);
        while let Some(n) = current {
            if n.kind() == kind {
                return Some(n);
            }
            current = n.parent();
        }
        None
    }

    /// Find a field definition in a type alias by the type alias name.
    /// This searches all indexed files for a type alias with the given name
    /// and returns the field definition if found.
    fn find_field_in_type_alias_by_name(
        &self,
        type_name: &str,
        field_name: &str,
        _current_uri: &str,
        target_alias: Option<&TargetTypeAlias>,
    ) -> Option<FieldDefinition> {
        use std::io::Write;

        // Search all indexed files for type aliases with this name
        for (uri, tree) in &self.tree_cache {
            let source = match self.source_cache.get(uri) {
                Some(s) => s,
                None => continue,
            };
            let root = tree.root_node();
            let module_name = self.get_module_name(uri, source);

            let mut cursor = root.walk();
            for child in root.children(&mut cursor) {
                if child.kind() == "type_alias_declaration" {
                    let decl_name = child.child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source.as_bytes()).ok());

                    if decl_name == Some(type_name) {
                        // Check target filter
                        if let Some(target) = target_alias {
                            if type_name != target.name || module_name != target.module {
                                continue;
                            }
                        }

                        // Found the type alias - look for the field
                        if let Some(type_expr) = child.child_by_field_name("typeExpression") {
                            // Find the record_type within the type expression
                            let record_node = if type_expr.kind() == "record_type" {
                                Some(type_expr)
                            } else {
                                Self::find_child_of_kind(type_expr, "record_type")
                            };

                            if let Some(record) = record_node {
                                let mut fc = record.walk();
                                for field_child in record.children(&mut fc) {
                                    if field_child.kind() == "field_type" {
                                        if let Some(name_node) = field_child.child_by_field_name("name") {
                                            if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                                                if name == field_name {
                                                    return Some(FieldDefinition {
                                                        name: field_name.to_string(),
                                                        node_id: name_node.id(),
                                                        type_alias_name: Some(type_name.to_string()),
                                                        type_alias_node_id: Some(child.id()),
                                                        module_name: module_name.clone(),
                                                        uri: uri.to_string(),
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Find a child node of a specific kind (non-recursive single level search)
    fn find_child_of_kind<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == kind {
                return Some(child);
            }
            // Also check one level deep
            let mut c2 = child.walk();
            for grandchild in child.children(&mut c2) {
                if grandchild.kind() == kind {
                    return Some(grandchild);
                }
            }
        }
        None
    }

    /// Check if a node contains another node (by id)
    fn node_contains_node(parent: Node, target: Node) -> bool {
        if parent.id() == target.id() {
            return true;
        }
        let mut cursor = parent.walk();
        for child in parent.children(&mut cursor) {
            if Self::node_contains_node(child, target) {
                return true;
            }
        }
        false
    }

    /// Get field definition from a resolved type
    fn field_definition_from_type(
        &self,
        ty: &Type,
        field_name: &str,
        _current_uri: &str,
    ) -> Option<FieldDefinition> {
        self.field_definition_from_type_impl(ty, field_name, _current_uri, None)
    }

    /// Get the type of a field in a type alias (as a type name string)
    /// E.g., for Model type with field `form : Form`, returns "Form"
    fn get_field_type_from_type_alias(
        &self,
        type_alias_name: &str,
        module_name: &str,
        field_name: &str,
        _current_uri: &str,
    ) -> Option<String> {
        // Search for the type alias or custom type
        for (uri, tree) in &self.tree_cache {
            let source = match self.source_cache.get(uri) {
                Some(s) => s,
                None => continue,
            };
            let root = tree.root_node();
            let file_module = self.get_module_name(uri, source);

            // Check if module matches
            if file_module != module_name {
                continue;
            }

            let mut cursor = root.walk();
            for child in root.children(&mut cursor) {
                if child.kind() == "type_alias_declaration" {
                    let name = child.child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source.as_bytes()).ok());
                    if name == Some(type_alias_name) {
                        // Found the type alias - look for the field
                        if let Some(type_expr) = child.child_by_field_name("typeExpression") {
                            return self.find_field_type_in_record(type_expr, field_name, source);
                        }
                    }
                } else if child.kind() == "type_declaration" {
                    let name = child.child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source.as_bytes()).ok());
                    if name == Some(type_alias_name) {
                        // Custom type - look in each variant's record
                        let mut vc = child.walk();
                        for variant in child.children(&mut vc) {
                            if variant.kind() == "union_variant" {
                                if let Some(record_type) = self.find_record_in_union_variant(variant) {
                                    if let Some(field_type) = self.find_field_type_in_record(record_type, field_name, source) {
                                        return Some(field_type);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Find field type in a record type expression
    fn find_field_type_in_record(
        &self,
        record: tree_sitter::Node,
        field_name: &str,
        source: &str,
    ) -> Option<String> {
        // Look for record_type or the record itself
        let record_type = if record.kind() == "record_type" {
            record
        } else {
            // Descend to find record_type
            let mut cursor = record.walk();
            let result = record.children(&mut cursor)
                .find(|c| c.kind() == "record_type");
            match result {
                Some(r) => r,
                None => return None,
            }
        };

        let mut cursor = record_type.walk();
        for child in record_type.children(&mut cursor) {
            if child.kind() == "field_type" {
                let name = child.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source.as_bytes()).ok());
                if name == Some(field_name) {
                    // Found the field - get its type expression
                    if let Some(type_expr) = child.child_by_field_name("typeExpression") {
                        // Get the first type reference (could be a type name or upper_case_qid)
                        let mut tc = type_expr.walk();
                        for type_child in type_expr.children(&mut tc) {
                            if type_child.kind() == "type_ref" {
                                if let Some(qid) = type_child.child_by_field_name("name") {
                                    // Get the last part of the qualified name
                                    let mut qc = qid.walk();
                                    if let Some(last) = qid.children(&mut qc).last() {
                                        return last.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
                                    }
                                }
                            } else if type_child.kind() == "upper_case_qid" {
                                let mut qc = type_child.walk();
                                if let Some(last) = type_child.children(&mut qc).last() {
                                    return last.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
                                }
                            }
                        }
                        // Fallback - get the whole text
                        return type_expr.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
                    }
                }
            }
        }
        None
    }

    /// Find a field in a type alias or custom type by type name
    fn find_field_in_type_alias_or_custom_type(
        &self,
        type_name: &str,
        field_name: &str,
        _current_uri: &str,
        target_alias: Option<&TargetTypeAlias>,
    ) -> Option<FieldDefinition> {
        // Search all indexed files
        for (uri, tree) in &self.tree_cache {
            let source = match self.source_cache.get(uri) {
                Some(s) => s,
                None => continue,
            };
            let root = tree.root_node();
            let module_name = self.get_module_name(uri, source);

            let mut cursor = root.walk();
            for child in root.children(&mut cursor) {
                if child.kind() == "type_alias_declaration" {
                    let name = child.child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source.as_bytes()).ok());
                    if name == Some(type_name) {
                        // Check target filter
                        if let Some(target) = target_alias {
                            if type_name != target.name || module_name != target.module {
                                continue;
                            }
                        }
                        // Found the type alias - look for the field
                        if let Some(type_expr) = child.child_by_field_name("typeExpression") {
                            if let Some(def) = self.find_field_in_record_type_simple(type_expr, field_name, source, uri, type_name, &module_name) {
                                return Some(def);
                            }
                        }
                    }
                } else if child.kind() == "type_declaration" {
                    let name = child.child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source.as_bytes()).ok());
                    if name == Some(type_name) {
                        // Check target filter
                        if let Some(target) = target_alias {
                            if type_name != target.name || module_name != target.module {
                                continue;
                            }
                        }
                        // Custom type - look in variant's record
                        let mut vc = child.walk();
                        for variant in child.children(&mut vc) {
                            if variant.kind() == "union_variant" {
                                if let Some(record_type) = self.find_record_in_union_variant(variant) {
                                    if let Some(def) = self.find_field_in_record_type_simple(record_type, field_name, source, uri, type_name, &module_name) {
                                        return Some(def);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Find a field definition in a record_type node (simple version without node id)
    fn find_field_in_record_type_simple(
        &self,
        record_type: tree_sitter::Node,
        field_name: &str,
        source: &str,
        uri: &str,
        type_name: &str,
        module_name: &str,
    ) -> Option<FieldDefinition> {
        // First find the actual record_type node
        let record = if record_type.kind() == "record_type" {
            record_type
        } else {
            // Descend to find record_type
            let mut cursor = record_type.walk();
            let result = record_type.children(&mut cursor)
                .find(|c| c.kind() == "record_type");
            match result {
                Some(r) => r,
                None => return None,
            }
        };

        let mut cursor = record.walk();
        for child in record.children(&mut cursor) {
            if child.kind() == "field_type" {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = name_node.utf8_text(source.as_bytes()).ok()?;
                    if name == field_name {
                        return Some(FieldDefinition {
                            name: field_name.to_string(),
                            node_id: name_node.id(),
                            type_alias_name: Some(type_name.to_string()),
                            type_alias_node_id: None,
                            module_name: module_name.to_string(),
                            uri: uri.to_string(),
                        });
                    }
                }
            }
        }
        None
    }

    fn field_definition_from_type_with_target(
        &self,
        ty: &Type,
        field_name: &str,
        current_uri: &str,
        target: &TargetTypeAlias,
    ) -> Option<FieldDefinition> {
        self.field_definition_from_type_impl(ty, field_name, current_uri, Some(target))
    }

    fn field_definition_from_type_impl(
        &self,
        ty: &Type,
        field_name: &str,
        _current_uri: &str,
        target: Option<&TargetTypeAlias>,
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
                if let Some(field_type) = mr.fields.get(field_name) {
                    // Check if the field type is a concrete Union type (like Name, Description, etc.)
                    if let Type::Union(u) = field_type {
                        // We have a concrete field type - find type alias with matching field name AND type
                        return self.find_type_alias_by_field_type(field_name, &u.name);
                    }

                    // Only use structural matching if we have enough context to disambiguate:
                    // - At least 2 fields (provides more unique identification)
                    if mr.fields.len() >= 2 {
                        let fields: Vec<String> = mr.fields.keys().cloned().collect();
                        // For structural matching, find the ACTUAL type first (without target filter)
                        // then verify it matches the target
                        let result = self.find_type_alias_by_fields(&fields, field_name, _current_uri, None);
                        if let Some(ref def) = result {
                            // If we have a target, only return if the found type matches
                            if let Some(t) = target {
                                if def.type_alias_name.as_deref() == Some(t.name.as_str())
                                    && def.module_name == t.module
                                {
                                    return result;
                                }
                                // Found a different type - don't return it
                                None
                            } else {
                                result
                            }
                        } else {
                            None
                        }
                    } else {
                        // Not enough context to safely disambiguate
                        None
                    }
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
            let source = match self.source_cache.get(uri) {
                Some(s) => s,
                None => continue,
            };

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
                        let name = match name_node.utf8_text(source.as_bytes()) {
                            Ok(n) => n,
                            Err(_) => continue,
                        };
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

    /// Find a type alias that has a field with the given name AND type
    /// This is used when we have a MutableRecord with a concrete field type
    fn find_type_alias_by_field_type(
        &self,
        field_name: &str,
        field_type_name: &str,
    ) -> Option<FieldDefinition> {
        let mut candidates: Vec<FieldDefinition> = Vec::new();

        // Search through all indexed files for type aliases
        for (uri, tree) in &self.tree_cache {
            let source = match self.source_cache.get(uri) {
                Some(s) => s,
                None => continue,
            };

            let mut cursor = tree.root_node().walk();
            for child in tree.root_node().children(&mut cursor) {
                if child.kind() == "type_alias_declaration" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Ok(alias_name) = name_node.utf8_text(source.as_bytes()) {
                            // Get the record type
                            if let Some(type_expr) = child.child_by_field_name("typeExpression") {
                                // Check if this type alias has a field with matching name and type
                                if let Some(def) = self.check_field_type_match(
                                    type_expr,
                                    field_name,
                                    field_type_name,
                                    uri,
                                    source,
                                    alias_name,
                                    child.id(),
                                ) {
                                    candidates.push(def);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Return only if we have exactly one match (unambiguous)
        if candidates.len() == 1 {
            return candidates.pop();
        }

        // If multiple candidates, prefer the one where field type exactly matches
        // (not a more general type that could match)
        None
    }

    /// Check if a type expression has a field with the given name and type
    fn check_field_type_match(
        &self,
        node: Node,
        field_name: &str,
        field_type_name: &str,
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
                            // Check if the field type matches
                            if let Some(type_node) = child.child_by_field_name("typeExpression") {
                                let type_text = self.extract_type_name(type_node, source);
                                if type_text.as_deref() == Some(field_type_name) {
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
            }
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(def) = self.check_field_type_match(
                child, field_name, field_type_name, uri, source, type_alias_name, type_alias_node_id
            ) {
                return Some(def);
            }
        }
        None
    }

    /// Extract the simple type name from a type expression node
    fn extract_type_name(&self, node: Node, source: &str) -> Option<String> {
        // Handle simple type references like "Name", "Description"
        if node.kind() == "type_ref" {
            if let Some(child) = node.child(0) {
                if child.kind() == "upper_case_qid" {
                    return child.utf8_text(source.as_bytes()).ok().map(|s| s.to_string());
                }
            }
        }
        // Handle qualified identifiers
        if node.kind() == "upper_case_qid" {
            // Get just the last part of a qualified name
            let full_name = node.utf8_text(source.as_bytes()).ok()?;
            return Some(full_name.split('.').last()?.to_string());
        }
        None
    }

    /// Find all field accesses on the same variable within a scope
    /// Returns a set of field names accessed on the given variable
    fn collect_field_accesses_on_variable<'a>(
        &self,
        variable_name: &str,
        scope: Node<'a>,
        source: &str,
    ) -> Vec<String> {
        let mut fields = Vec::new();
        self.collect_field_accesses_recursive(variable_name, scope, source, &mut fields, 0);
        fields
    }

    fn collect_field_accesses_recursive<'a>(
        &self,
        variable_name: &str,
        node: Node<'a>,
        source: &str,
        fields: &mut Vec<String>,
        depth: usize,
    ) {
        // Check for field_access_expr (like `user.name`)
        if node.kind() == "field_access_expr" {
            if let Some(target) = node.child_by_field_name("target") {
                let target_text = target.utf8_text(source.as_bytes()).unwrap_or("?");
                // Check if target text matches the variable name we're looking for
                if target_text == variable_name {
                    // Get the field - it's the last child (lower_case_identifier after the dot)
                    let mut cursor = node.walk();
                    let last_child = node.children(&mut cursor).last();
                    if let Some(field_node) = last_child {
                        if field_node.kind() == "lower_case_identifier" {
                            if let Ok(field_name) = field_node.utf8_text(source.as_bytes()) {
                                if !fields.contains(&field_name.to_string()) {
                                    fields.push(field_name.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // Check for record_expr with base identifier (like `{ a | name = ... }`)
        if node.kind() == "record_expr" {
            let mut cursor = node.walk();
            let has_matching_base = node.children(&mut cursor)
                .any(|c| {
                    c.kind() == "record_base_identifier"
                        && c.utf8_text(source.as_bytes()).unwrap_or("?") == variable_name
                });
            if has_matching_base {
                // Collect all field names from this record update
                let record_fields = self.collect_record_expr_fields(node, source);
                for f in record_fields {
                    if !fields.contains(&f) {
                        fields.push(f);
                    }
                }
            }
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.collect_field_accesses_recursive(variable_name, child, source, fields, depth + 1);
        }
    }

    /// Find the enclosing scope for a node (lambda body, let binding, or function body)
    fn find_enclosing_scope<'a>(&self, node: Node<'a>) -> Option<Node<'a>> {
        let mut current = node.parent();
        while let Some(n) = current {
            match n.kind() {
                "anonymous_function_expr" | "let_in_expr" | "value_declaration" => {
                    return Some(n);
                }
                _ => {}
            }
            current = n.parent();
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

    /// Collect field names from a record expression
    fn collect_record_expr_fields(&self, record_expr: Node, source: &str) -> Vec<String> {
        let mut fields = Vec::new();
        let mut cursor = record_expr.walk();
        for child in record_expr.children(&mut cursor) {
            if child.kind() == "field" {
                // The field name is the first lower_case_identifier child
                if let Some(first_child) = child.child(0) {
                    if first_child.kind() == "lower_case_identifier" {
                        if let Ok(name) = first_child.utf8_text(source.as_bytes()) {
                            fields.push(name.to_string());
                        }
                    }
                }
            }
        }
        fields
    }

    /// Collect field names from a record pattern like { email, pressedSubmitEmail, emailSent }
    fn collect_pattern_fields(&self, record_pattern: Node, source: &str) -> Vec<String> {
        let mut fields = Vec::new();
        let mut cursor = record_pattern.walk();
        for child in record_pattern.children(&mut cursor) {
            // Record patterns have lower_pattern children for each field
            if child.kind() == "lower_pattern" {
                if let Ok(name) = child.utf8_text(source.as_bytes()) {
                    fields.push(name.to_string());
                }
            }
        }
        fields
    }

    /// Count how many type aliases have a specific field
    /// Returns (target_matches: bool, other_count: usize)
    fn count_field_candidates(&self, field_name: &str, target: &TargetTypeAlias) -> (bool, usize) {
        let mut target_matches = false;
        let mut other_count = 0;

        for (uri, tree) in &self.tree_cache {
            let source = match self.source_cache.get(uri) {
                Some(s) => s,
                None => continue,
            };

            let root = tree.root_node();
            let mut cursor = root.walk();
            for child in root.children(&mut cursor) {
                if child.kind() == "type_alias_declaration" {
                    // Get alias name
                    let alias_name = child.child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source.as_bytes()).ok());

                    if alias_name.is_none() { continue; }
                    let alias_name = alias_name.unwrap();

                    // Find the record_type within the type alias
                    let type_expr = match child.child_by_field_name("typeExpression") {
                        Some(t) => t,
                        None => continue,
                    };
                    let record_type = match self.find_record_type_node(type_expr) {
                        Some(r) => r,
                        None => continue,
                    };

                    // Check if this type has the field
                    let mut has_field = false;
                    let mut fc = record_type.walk();
                    for field_child in record_type.children(&mut fc) {
                        if field_child.kind() == "field_type" {
                            if let Some(name_node) = field_child.child_by_field_name("name") {
                                if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                                    if name == field_name {
                                        has_field = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    if has_field {
                        let module_name = self.get_module_name(uri, source);
                        if alias_name == target.name && module_name == target.module {
                            target_matches = true;
                        } else {
                            other_count += 1;
                        }
                    }
                } else if child.kind() == "type_declaration" {
                    // Also check custom types
                    let type_name = child.child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source.as_bytes()).ok());

                    if type_name.is_none() { continue; }
                    let type_name = type_name.unwrap();

                    // Check if any variant has a record with the field
                    let mut has_field = false;
                    let mut vc = child.walk();
                    for variant in child.children(&mut vc) {
                        if variant.kind() == "union_variant" {
                            if let Some(record_type) = self.find_record_in_union_variant(variant) {
                                let mut fc = record_type.walk();
                                for field_child in record_type.children(&mut fc) {
                                    if field_child.kind() == "field_type" {
                                        if let Some(name_node) = field_child.child_by_field_name("name") {
                                            if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                                                if name == field_name {
                                                    has_field = true;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                                if has_field { break; }
                            }
                        }
                    }

                    if has_field {
                        let module_name = self.get_module_name(uri, source);
                        if type_name == target.name && module_name == target.module {
                            target_matches = true;
                        } else {
                            other_count += 1;
                        }
                    }
                }
            }
        }

        (target_matches, other_count)
    }

    /// Find a type alias that contains all the given fields
    /// Returns the field definition if found
    /// Prefers type aliases with fewer extra fields (closer match)
    /// If target is provided, only returns a match if it's the target type alias
    fn find_type_alias_by_fields(
        &self,
        record_fields: &[String],
        target_field: &str,
        _current_uri: &str,
        target: Option<&TargetTypeAlias>,
    ) -> Option<FieldDefinition> {
        use std::io::Write;
        tracing::debug!("find_type_alias_by_fields: looking for {:?} with target field {}, target={:?}", record_fields, target_field, target.map(|t| &t.name));

        // Collect all matching candidates with their field counts
        let mut candidates: Vec<(FieldDefinition, usize)> = Vec::new();

        // Search all indexed files for type aliases
        for (uri, tree) in &self.tree_cache {
            let source = match self.source_cache.get(uri) {
                Some(s) => s,
                None => continue,  // Skip files without cached source
            };
            let root = tree.root_node();

            // Find all type alias declarations and custom types
            let mut cursor = root.walk();
            for child in root.children(&mut cursor) {
                if child.kind() == "type_alias_declaration" {
                    if let Some((def, field_count)) = self.check_type_alias_matches_with_count(
                        child, record_fields, target_field, uri, source
                    ) {
                        // If target is specified, filter to only matching type aliases
                        if let Some(target) = target {
                            let matches_target = def.type_alias_name.as_deref() == Some(target.name.as_str())
                                && def.module_name == target.module;
                            if !matches_target {
                                continue; // Skip non-matching candidates
                            }
                        }
                        candidates.push((def, field_count));
                    }
                } else if child.kind() == "type_declaration" {
                    // Also search custom types that wrap records
                    if let Some((def, field_count)) = self.check_custom_type_matches_with_count(
                        child, record_fields, target_field, uri, source
                    ) {
                        // If target is specified, filter to only matching types
                        if let Some(target) = target {
                            let matches_target = def.type_alias_name.as_deref() == Some(target.name.as_str())
                                && def.module_name == target.module;
                            if !matches_target {
                                continue; // Skip non-matching candidates
                            }
                        }
                        candidates.push((def, field_count));
                    }
                }
            }
        }

        if candidates.is_empty() {
            return None;
        }

        // Sort by field count (prefer type aliases with fewer fields - closer match)
        candidates.sort_by_key(|(_, count)| *count);

        candidates.into_iter().next().map(|(def, _)| def)
    }

    /// Check if a type alias contains all the given fields, return field count
    fn check_type_alias_matches_with_count(
        &self,
        type_alias: Node,
        record_fields: &[String],
        target_field: &str,
        uri: &str,
        source: &str,
    ) -> Option<(FieldDefinition, usize)> {
        // Get alias name
        let alias_name = type_alias.child_by_field_name("name")
            .and_then(|n| n.utf8_text(source.as_bytes()).ok())?;

        // Find the record_type within the type alias
        let type_expr = type_alias.child_by_field_name("typeExpression")?;
        let record_type = self.find_record_type_node(type_expr)?;

        // Collect fields from the type alias
        let mut type_fields = std::collections::HashSet::new();
        let mut target_field_node: Option<Node> = None;

        let mut cursor = record_type.walk();
        for child in record_type.children(&mut cursor) {
            if child.kind() == "field_type" {
                if let Some(name_node) = child.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        type_fields.insert(name.to_string());
                        if name == target_field {
                            target_field_node = Some(name_node);
                        }
                    }
                }
            }
        }

        // Check if all record fields exist in this type alias
        let all_fields_match = record_fields.iter().all(|f| type_fields.contains(f));

        use std::io::Write;
        if all_fields_match {
        }

        if all_fields_match {
            if let Some(field_node) = target_field_node {
                return Some((FieldDefinition {
                    name: target_field.to_string(),
                    node_id: field_node.id(),
                    type_alias_name: Some(alias_name.to_string()),
                    type_alias_node_id: Some(type_alias.id()),
                    module_name: self.get_module_name(uri, source),
                    uri: uri.to_string(),
                }, type_fields.len()));
            }
        }

        None
    }

    /// Check if a custom type constructor contains all the given fields (for record-wrapped types)
    fn check_custom_type_matches_with_count(
        &self,
        type_decl: Node,
        record_fields: &[String],
        target_field: &str,
        uri: &str,
        source: &str,
    ) -> Option<(FieldDefinition, usize)> {
        // Get type name
        let type_name = type_decl.child_by_field_name("name")
            .and_then(|n| n.utf8_text(source.as_bytes()).ok())?;

        // Find union variants within the type declaration
        let mut cursor = type_decl.walk();
        for child in type_decl.children(&mut cursor) {
            if child.kind() == "union_variant" {
                // Look for a record_type within the union variant's arguments
                if let Some(record_type) = self.find_record_in_union_variant(child) {
                    // Collect fields from the record
                    let mut type_fields = std::collections::HashSet::new();
                    let mut target_field_node: Option<Node> = None;

                    let mut field_cursor = record_type.walk();
                    for field_child in record_type.children(&mut field_cursor) {
                        if field_child.kind() == "field_type" {
                            if let Some(name_node) = field_child.child_by_field_name("name") {
                                if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                                    type_fields.insert(name.to_string());
                                    if name == target_field {
                                        target_field_node = Some(name_node);
                                    }
                                }
                            }
                        }
                    }

                    // Check if all record fields exist in this custom type
                    let all_fields_match = record_fields.iter().all(|f| type_fields.contains(f));

                    if all_fields_match {
                        if let Some(field_node) = target_field_node {
                            return Some((FieldDefinition {
                                name: target_field.to_string(),
                                node_id: field_node.id(),
                                type_alias_name: Some(type_name.to_string()),
                                type_alias_node_id: Some(type_decl.id()),
                                module_name: self.get_module_name(uri, source),
                                uri: uri.to_string(),
                            }, type_fields.len()));
                        }
                    }
                }
            }
        }

        None
    }

    /// Find a record_type node within a union variant
    fn find_record_in_union_variant<'a>(&self, variant: Node<'a>) -> Option<Node<'a>> {
        let mut cursor = variant.walk();
        for child in variant.children(&mut cursor) {
            // Record type might be directly in the variant
            if child.kind() == "record_type" {
                return Some(child);
            }
            // Or might be wrapped in a type reference
            if child.kind() == "type_ref" || child.kind() == "type_expression" {
                if let Some(record) = self.find_record_type_node(child) {
                    return Some(record);
                }
            }
        }
        None
    }

    /// Check if a type alias contains all the given fields
    fn check_type_alias_matches(
        &self,
        type_alias: Node,
        record_fields: &[String],
        target_field: &str,
        uri: &str,
        source: &str,
    ) -> Option<FieldDefinition> {
        // Get alias name
        let alias_name = type_alias.child_by_field_name("name")
            .and_then(|n| n.utf8_text(source.as_bytes()).ok())?;

        // Find the record_type within the type alias
        let type_expr = type_alias.child_by_field_name("typeExpression")?;
        let record_type = self.find_record_type_node(type_expr)?;

        // Collect fields from the type alias
        let mut type_fields = std::collections::HashSet::new();
        let mut target_field_node: Option<Node> = None;

        let mut cursor = record_type.walk();
        for child in record_type.children(&mut cursor) {
            if child.kind() == "field_type" {
                if let Some(name_node) = child.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        type_fields.insert(name.to_string());
                        if name == target_field {
                            target_field_node = Some(name_node);
                        }
                    }
                }
            }
        }

        // Check if all record fields exist in this type alias
        let all_fields_match = record_fields.iter().all(|f| type_fields.contains(f));

        use std::io::Write;
        if all_fields_match {
        }

        if all_fields_match {
            if let Some(field_node) = target_field_node {
                tracing::info!(
                    "check_type_alias_matches: MATCHED {} with type alias {}",
                    target_field, alias_name
                );
                return Some(FieldDefinition {
                    name: target_field.to_string(),
                    node_id: field_node.id(),
                    type_alias_name: Some(alias_name.to_string()),
                    type_alias_node_id: Some(type_alias.id()),
                    module_name: self.get_module_name(uri, source),
                    uri: uri.to_string(),
                });
            }
        }

        None
    }

    /// Find a record_type node within a type expression
    fn find_record_type_node<'a>(&self, node: Node<'a>) -> Option<Node<'a>> {
        if node.kind() == "record_type" {
            return Some(node);
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = self.find_record_type_node(child) {
                return Some(found);
            }
        }
        None
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
