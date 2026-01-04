//! Type inference engine for Elm.
//!
//! Implements Hindley-Milner style type inference with support for:
//! - Value declarations and function parameters
//! - Record types and field access
//! - Pattern matching and binding
//! - Let expressions
//!
//! Based on elm-language-server's typeInference.ts

use std::collections::HashMap;
use tree_sitter::Node;

use crate::binder::{bind_tree, SymbolLinks};
use crate::disjoint_set::DisjointSet;
use crate::types::{
    FieldReference, MutableRecordType, RecordFieldReferenceTable, RecordType, Type, TypeVar,
};

/// Result of type inference
#[derive(Debug, Clone)]
pub struct InferenceResult {
    /// The inferred type of the expression/declaration
    pub ty: Type,
    /// Map from AST node ID to its inferred type
    pub expression_types: HashMap<usize, Type>,
    /// Field references discovered during inference
    pub field_references: RecordFieldReferenceTable,
}

/// The main type inference engine
pub struct InferenceScope<'a> {
    /// Source code
    source: &'a str,
    /// URI of the file being inferred
    uri: String,
    /// Symbol bindings from the binder (reserved for future type inference)
    _symbol_links: &'a SymbolLinks,
    /// Type variable substitutions
    substitutions: DisjointSet,
    /// Expression types discovered during inference
    expression_types: HashMap<usize, Type>,
    /// Local variable bindings (name -> type)
    bindings: HashMap<String, Type>,
    /// Field references collected during inference
    field_references: RecordFieldReferenceTable,
    /// Types from annotations (rigid type variables, reserved for future)
    _annotation_vars: Vec<TypeVar>,
    /// Parent scope for nested inferences
    parent: Option<&'a InferenceScope<'a>>,
}

impl<'a> InferenceScope<'a> {
    pub fn new(source: &'a str, uri: String, symbol_links: &'a SymbolLinks) -> Self {
        Self {
            source,
            uri,
            _symbol_links: symbol_links,
            substitutions: DisjointSet::new(),
            expression_types: HashMap::new(),
            bindings: HashMap::new(),
            field_references: RecordFieldReferenceTable::new(),
            _annotation_vars: Vec::new(),
            parent: None,
        }
    }

    #[allow(dead_code)]
    fn child(&'a self) -> Self {
        Self {
            source: self.source,
            uri: self.uri.clone(),
            _symbol_links: self._symbol_links,
            substitutions: self.substitutions.clone(),
            expression_types: HashMap::new(),
            bindings: HashMap::new(),
            field_references: RecordFieldReferenceTable::new(),
            _annotation_vars: Vec::new(),
            parent: Some(self),
        }
    }

    fn node_text(&self, node: Node) -> &str {
        node.utf8_text(self.source.as_bytes()).unwrap_or("")
    }

    /// Look up a binding by name, checking parent scopes
    fn get_binding(&self, name: &str) -> Option<Type> {
        if let Some(ty) = self.bindings.get(name) {
            return Some(ty.clone());
        }
        if let Some(parent) = self.parent {
            return parent.get_binding(name);
        }
        None
    }

    /// Set a binding in the current scope
    fn set_binding(&mut self, name: String, ty: Type) {
        self.bindings.insert(name, ty.clone());
    }

    /// Record an expression's type
    fn set_expr_type(&mut self, node_id: usize, ty: Type) {
        self.expression_types.insert(node_id, ty);
    }

    /// Get an expression's type
    pub fn get_expr_type(&self, node_id: usize) -> Option<Type> {
        self.expression_types.get(&node_id).cloned()
    }

    /// Infer the type of a value declaration
    pub fn infer_value_declaration(&mut self, node: Node) -> Type {
        // Check for type annotation
        let annotation_type = self.get_annotation_type(node);

        // Bind function parameters
        if let Some(func_decl_left) = node.child_by_field_name("functionDeclarationLeft") {
            self.bind_function_parameters(func_decl_left, annotation_type.as_ref());
        }

        // Infer the body
        let body = node.child_by_field_name("body");
        let body_type = if let Some(body_node) = body {
            self.infer(body_node)
        } else {
            Type::Unknown
        };

        // If we have an annotation, use that; otherwise use inferred type
        if let Some(ann_type) = annotation_type.clone() {
            // Unify body type with annotation
            self.unify(&body_type, &ann_type);

            // Propagate type alias from annotation to record literals in body
            // This enables type-aware field renaming for record construction
            if let Some(body_node) = body {
                self.propagate_alias_to_record(body_node, &ann_type);
            }

            ann_type
        } else {
            // Build function type from parameters if any
            if let Some(func_decl_left) = node.child_by_field_name("functionDeclarationLeft") {
                let params: Vec<Type> = self.collect_parameter_types(func_decl_left);
                if params.is_empty() {
                    body_type
                } else {
                    Type::function(params, body_type)
                }
            } else {
                body_type
            }
        }
    }

    fn get_annotation_type(&self, value_decl: Node) -> Option<Type> {
        // Look for a type annotation preceding this declaration
        if let Some(prev) = value_decl.prev_sibling() {
            if prev.kind() == "type_annotation" {
                return Some(self.parse_type_expression(prev));
            }
        }
        None
    }

    /// Propagate type alias from annotation to record literals in the body.
    /// This enables type-aware field renaming for record construction like:
    ///   createPerson : String -> Person
    ///   createPerson n = { name = n, email = "..." }
    fn propagate_alias_to_record(&mut self, body: Node, annotation: &Type) {
        // Extract the return type from the annotation
        let return_type = match annotation {
            Type::Function(f) => f.ret.as_ref().clone(),
            other => other.clone(),
        };

        // Only propagate if the return type is a Union (type alias)
        if let Type::Union(union_type) = &return_type {
            // Find record_expr nodes in the body and annotate them
            self.propagate_alias_to_record_recursive(body, union_type);
        }
    }

    fn propagate_alias_to_record_recursive(
        &mut self,
        node: Node,
        alias_type: &crate::types::UnionType,
    ) {
        if node.kind() == "record_expr" {
            // Check if this is a record literal (no base identifier)
            let has_base = node
                .children(&mut node.walk())
                .any(|c| c.kind() == "record_base_identifier");

            if !has_base {
                // This is a record construction - annotate it with the alias
                if let Some(Type::Record(mut record_type)) =
                    self.expression_types.get(&node.id()).cloned()
                {
                    record_type.alias = Some(crate::types::Alias {
                        module: alias_type.module.clone(),
                        name: alias_type.name.clone(),
                        parameters: alias_type.params.clone(),
                    });
                    self.expression_types
                        .insert(node.id(), Type::Record(record_type));
                    tracing::debug!(
                        "propagate_alias_to_record: annotated record at node {} with alias {}",
                        node.id(),
                        alias_type.name
                    );
                }
            }
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.propagate_alias_to_record_recursive(child, alias_type);
        }
    }

    fn parse_type_expression(&self, node: Node) -> Type {
        let type_expr = node.child_by_field_name("typeExpression").or_else(|| {
            // For direct type expressions
            let mut cursor = node.walk();
            let result = node
                .children(&mut cursor)
                .find(|child| child.kind().contains("type") || child.kind() == "type_ref");
            result
        });

        if let Some(te) = type_expr {
            self.parse_type_node(te)
        } else {
            Type::Unknown
        }
    }

    fn parse_type_node(&self, node: Node) -> Type {
        match node.kind() {
            "type_ref" => {
                // Get the type name
                let mut cursor = node.walk();
                let children: Vec<_> = node.children(&mut cursor).collect();
                for child in &children {
                    if child.kind() == "upper_case_qid" {
                        let name = self.node_text(*child);
                        // Parse type arguments if any
                        let args: Vec<Type> = children
                            .iter()
                            .filter(|c| c.kind().contains("type"))
                            .map(|c| self.parse_type_node(*c))
                            .collect();
                        return self.resolve_type_name(name, args);
                    }
                }
                Type::Unknown
            }
            "type_variable" => {
                let name = self.node_text(node);
                Type::rigid_var(name)
            }
            "record_type" => self.parse_record_type(node),
            "tuple_type" => {
                let mut cursor = node.walk();
                let types: Vec<Type> = node
                    .children(&mut cursor)
                    .filter(|c| c.kind().contains("type") && c.kind() != "tuple_type")
                    .map(|c| self.parse_type_node(c))
                    .collect();
                Type::tuple(types)
            }
            "function_type" | "type_expression" => {
                // Parse a -> b -> c as Function([a, b], c)
                let mut types: Vec<Type> = Vec::new();
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind().contains("type") {
                        types.push(self.parse_type_node(child));
                    }
                }
                if types.len() < 2 {
                    types.pop().unwrap_or(Type::Unknown)
                } else {
                    let ret = types.pop().unwrap();
                    Type::function(types, ret)
                }
            }
            "unit_expr" => Type::unit(),
            _ => Type::Unknown,
        }
    }

    fn parse_record_type(&self, node: Node) -> Type {
        let mut fields = HashMap::new();
        let mut base_type = None;

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "field_type" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name = self.node_text(name_node).to_string();
                        if let Some(type_node) = child.child_by_field_name("typeExpression") {
                            let ty = self.parse_type_node(type_node);
                            fields.insert(name, ty);
                        }
                    }
                }
                "record_base_identifier" => {
                    let name = self.node_text(child);
                    base_type = Some(Box::new(Type::var(name)));
                }
                _ => {}
            }
        }

        Type::Record(RecordType {
            fields,
            base_type,
            alias: None,
            field_references: RecordFieldReferenceTable::new(),
        })
    }

    fn resolve_type_name(&self, name: &str, args: Vec<Type>) -> Type {
        // Handle built-in types
        match name {
            "Int" => Type::int(),
            "Float" => Type::float(),
            "Bool" => Type::bool(),
            "String" => Type::string(),
            "Char" => Type::char(),
            "List" => {
                let elem = args.into_iter().next().unwrap_or(Type::fresh_var());
                Type::list(elem)
            }
            "Maybe" => {
                let inner = args.into_iter().next().unwrap_or(Type::fresh_var());
                Type::maybe(inner)
            }
            _ => {
                // Try to resolve from imports or local definitions
                let parts: Vec<&str> = name.split('.').collect();
                let simple_name = parts.last().unwrap_or(&name);
                let module = if parts.len() > 1 {
                    parts[..parts.len() - 1].join(".")
                } else {
                    String::new()
                };
                Type::union(module, *simple_name, args)
            }
        }
    }

    fn bind_function_parameters(&mut self, func_decl_left: Node, annotation: Option<&Type>) {
        let mut param_types: Vec<Type> = Vec::new();

        // Extract parameter types from annotation if available
        if let Some(Type::Function(func)) = annotation {
            param_types = func.params.clone();
        }

        // Bind each parameter pattern
        let mut cursor = func_decl_left.walk();
        let mut param_idx = 0;
        for child in func_decl_left.children(&mut cursor) {
            if child.kind() == "pattern"
                || child.kind() == "lower_pattern"
                || child.kind() == "record_pattern"
            {
                let param_type = param_types
                    .get(param_idx)
                    .cloned()
                    .unwrap_or_else(Type::fresh_var);
                self.bind_pattern(child, &param_type);
                param_idx += 1;
            }
        }
    }

    fn collect_parameter_types(&self, func_decl_left: Node) -> Vec<Type> {
        let mut types = Vec::new();
        let mut cursor = func_decl_left.walk();
        for child in func_decl_left.children(&mut cursor) {
            if child.kind() == "pattern"
                || child.kind() == "lower_pattern"
                || child.kind() == "record_pattern"
            {
                let name = self.node_text(child);
                if let Some(ty) = self.bindings.get(name) {
                    types.push(ty.clone());
                }
            }
        }
        types
    }

    /// Bind a pattern to a type
    fn bind_pattern(&mut self, pattern: Node, ty: &Type) {
        match pattern.kind() {
            "lower_pattern" => {
                let name = self.node_text(pattern).to_string();
                self.set_binding(name, ty.clone());
                self.set_expr_type(pattern.id(), ty.clone());
            }
            "record_pattern" => {
                // Record the type for this pattern node
                self.set_expr_type(pattern.id(), ty.clone());
                self.bind_record_pattern(pattern, ty);
            }
            "tuple_pattern" => {
                if let Type::Tuple(tuple) = ty {
                    let mut cursor = pattern.walk();
                    let patterns: Vec<Node> = pattern
                        .children(&mut cursor)
                        .filter(|c| c.kind() == "pattern" || c.kind() == "lower_pattern")
                        .collect();
                    for (i, pat) in patterns.into_iter().enumerate() {
                        if let Some(elem_type) = tuple.types.get(i) {
                            self.bind_pattern(pat, elem_type);
                        }
                    }
                }
            }
            "union_pattern" | "nullary_constructor_argument_pattern" => {
                // Bind nested patterns
                let mut cursor = pattern.walk();
                for child in pattern.children(&mut cursor) {
                    if child.kind() == "pattern" || child.kind() == "lower_pattern" {
                        // For union patterns, we'd need to look up constructor types
                        self.bind_pattern(child, &Type::fresh_var());
                    }
                }
            }
            "list_pattern" => {
                if let Type::Union(u) = ty {
                    if u.name == "List" {
                        let elem_type = u.params.first().cloned().unwrap_or(Type::fresh_var());
                        let mut cursor = pattern.walk();
                        for child in pattern.children(&mut cursor) {
                            if child.kind() == "pattern" || child.kind() == "lower_pattern" {
                                self.bind_pattern(child, &elem_type);
                            }
                        }
                    }
                }
            }
            "pattern" => {
                // Recurse into the pattern
                if let Some(child) = pattern.child(0) {
                    self.bind_pattern(child, ty);
                }
            }
            "anything_pattern" | "unit_expr" => {
                // Wildcard - no binding needed
            }
            _ => {}
        }
    }

    /// Bind a record pattern, tracking field references
    fn bind_record_pattern(&mut self, pattern: Node, record_type: &Type) {
        let fields = match record_type {
            Type::Record(r) => &r.fields,
            Type::MutableRecord(mr) => &mr.fields,
            _ => return,
        };

        let mut cursor = pattern.walk();
        for child in pattern.children(&mut cursor) {
            if child.kind() == "lower_pattern" {
                let field_name = self.node_text(child).to_string();

                // Track the field reference
                self.field_references.add(
                    &field_name,
                    FieldReference {
                        node_id: child.id(),
                        uri: self.uri.clone(),
                    },
                );

                // Bind the variable to the field type
                let field_type = fields
                    .get(&field_name)
                    .cloned()
                    .unwrap_or_else(Type::fresh_var);
                self.set_binding(field_name, field_type.clone());
                self.set_expr_type(child.id(), field_type);
            }
        }
    }

    /// Main inference entry point
    pub fn infer(&mut self, node: Node) -> Type {
        let ty = match node.kind() {
            "value_declaration" => self.infer_value_declaration(node),
            "function_call_expr" => self.infer_function_call(node),
            "field_access_expr" => self.infer_field_access(node),
            "field_accessor_function_expr" => self.infer_field_accessor(node),
            "record_expr" => self.infer_record(node),
            "if_else_expr" => self.infer_if_else(node),
            "case_of_expr" => self.infer_case(node),
            "let_in_expr" => self.infer_let_in(node),
            "anonymous_function_expr" => self.infer_lambda(node),
            "list_expr" => self.infer_list(node),
            "tuple_expr" => self.infer_tuple(node),
            "value_expr" => self.infer_value_expr(node),
            "record_base_identifier" => {
                // Record update base: { person | ... } - get the type of the base
                if let Some(child) = node.child(0) {
                    self.infer(child)
                } else {
                    Type::Unknown
                }
            }
            "lower_case_identifier" => {
                // Bare identifier - look up in bindings
                let name = self.node_text(node);
                self.get_binding(name).unwrap_or_else(Type::fresh_var)
            }
            "lower_case_qid" => {
                // Qualified identifier - look up the base name
                if let Some(child) = node.child(0) {
                    self.infer(child)
                } else {
                    Type::Unknown
                }
            }
            "parenthesized_expr" => {
                if let Some(inner) = node.named_child(0) {
                    self.infer(inner)
                } else {
                    Type::Unknown
                }
            }
            "number_constant_expr" => {
                // Check if it's a float or int
                let text = self.node_text(node);
                if text.contains('.') {
                    Type::float()
                } else {
                    Type::var("number")
                }
            }
            "string_constant_expr" => Type::string(),
            "char_constant_expr" => Type::char(),
            "unit_expr" => Type::unit(),
            "negate_expr" => {
                if let Some(inner) = node.named_child(0) {
                    let inner_type = self.infer(inner);
                    // Number constraint
                    self.unify(&inner_type, &Type::var("number"));
                    inner_type
                } else {
                    Type::Unknown
                }
            }
            "bin_op_expr" => self.infer_bin_op(node),
            "operator_as_function_expr" => self.infer_operator_as_function(node),
            _ => Type::Unknown,
        };

        self.set_expr_type(node.id(), ty.clone());
        ty
    }

    fn infer_value_expr(&mut self, node: Node) -> Type {
        // Look up the referenced value
        if let Some(qid) = node.child_by_field_name("name").or_else(|| node.child(0)) {
            let name = self.node_text(qid);

            // Check local bindings first
            if let Some(ty) = self.get_binding(name) {
                return ty;
            }

            // Check symbol links
            // For now, return a fresh type variable
            Type::fresh_var()
        } else {
            Type::Unknown
        }
    }

    fn infer_function_call(&mut self, node: Node) -> Type {
        let mut cursor = node.walk();
        let children: Vec<Node> = node.children(&mut cursor).collect();

        if children.is_empty() {
            return Type::Unknown;
        }

        // First child is the function
        let func_type = self.infer(children[0]);

        // Extract parameter types from function type (if available) for propagation
        let param_types: Vec<Option<&Type>> = match &func_type {
            Type::Function(f) => f.params.iter().map(Some).collect(),
            _ => vec![],
        };

        // Infer argument types, propagating expected type to record expressions
        let arg_types: Vec<Type> = children[1..]
            .iter()
            .enumerate()
            .map(|(i, arg)| {
                // Check if this argument is a record expression and we have an expected type
                if arg.kind() == "record_expr" {
                    if let Some(Some(Type::Union(union_type))) = param_types.get(i) {
                        // If expected type is a Union (type alias for record), propagate it
                        self.propagate_alias_to_record_recursive(*arg, union_type);
                    }
                }
                self.infer(*arg)
            })
            .collect();

        // Apply arguments to function type
        match func_type {
            Type::Function(f) => {
                // Unify argument types with parameter types
                for (i, arg_type) in arg_types.iter().enumerate() {
                    if let Some(param_type) = f.params.get(i) {
                        self.unify(arg_type, param_type);
                    }
                }

                // Return type, curried if partial application
                if arg_types.len() >= f.params.len() {
                    (*f.ret).clone()
                } else {
                    Type::function(f.params[arg_types.len()..].to_vec(), (*f.ret).clone())
                }
            }
            Type::Var(_) => {
                // Unknown function, create constraints
                let ret_type = Type::fresh_var();
                let _func_type = Type::function(arg_types, ret_type.clone());
                // Would need to unify with the original here
                ret_type
            }
            _ => Type::Unknown,
        }
    }

    fn infer_field_access(&mut self, node: Node) -> Type {
        // Get target and field
        let target = node.child_by_field_name("target").or_else(|| node.child(0));
        let field_node = node
            .children(&mut node.walk())
            .find(|c| c.kind() == "lower_case_identifier");

        let (target_node, field_name) = match (target, field_node) {
            (Some(t), Some(f)) => (t, self.node_text(f).to_string()),
            _ => return Type::Unknown,
        };

        // Infer the target type
        let target_type = self.infer(target_node);
        let resolved = self.substitutions.get(&target_type);

        // Track the field reference
        if let Some(f) = field_node {
            self.field_references.add(
                &field_name,
                FieldReference {
                    node_id: f.id(),
                    uri: self.uri.clone(),
                },
            );
        }

        // Look up field in the record type
        match &resolved {
            Type::Record(r) => r
                .fields
                .get(&field_name)
                .cloned()
                .unwrap_or(Type::fresh_var()),
            Type::MutableRecord(mr) => mr
                .fields
                .get(&field_name)
                .cloned()
                .unwrap_or(Type::fresh_var()),
            Type::Var(v) => {
                // Constrain the variable to be a record with this field
                let field_type = Type::fresh_var();
                let mut fields = HashMap::new();
                fields.insert(field_name, field_type.clone());
                let record_constraint = Type::MutableRecord(MutableRecordType::new(
                    fields,
                    Some(Box::new(Type::fresh_var())),
                ));
                self.substitutions.set(v.id, record_constraint);
                field_type
            }
            _ => Type::Unknown,
        }
    }

    fn infer_field_accessor(&mut self, node: Node) -> Type {
        // .fieldName is a function that takes any record with that field
        if let Some(field_node) = node
            .children(&mut node.walk())
            .find(|c| c.kind() == "lower_case_identifier")
        {
            let field_name = self.node_text(field_node).to_string();
            let field_type = Type::fresh_var();
            let mut fields = HashMap::new();
            fields.insert(field_name.clone(), field_type.clone());

            // Track as a field reference
            self.field_references.add(
                &field_name,
                FieldReference {
                    node_id: field_node.id(),
                    uri: self.uri.clone(),
                },
            );

            Type::function(
                vec![Type::MutableRecord(MutableRecordType::new(
                    fields,
                    Some(Box::new(Type::fresh_var())),
                ))],
                field_type,
            )
        } else {
            Type::Unknown
        }
    }

    fn infer_record(&mut self, node: Node) -> Type {
        let mut fields = HashMap::new();
        let mut base_type = None;

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "field" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name = self.node_text(name_node).to_string();

                        // Track field reference
                        self.field_references.add(
                            &name,
                            FieldReference {
                                node_id: name_node.id(),
                                uri: self.uri.clone(),
                            },
                        );

                        if let Some(expr) = child.child_by_field_name("expression") {
                            let ty = self.infer(expr);
                            fields.insert(name, ty);
                        }
                    }
                }
                "record_base_identifier" => {
                    let base_name = self.node_text(child);
                    if let Some(ty) = self.get_binding(base_name) {
                        // Record the type for this node so it can be looked up later
                        self.set_expr_type(child.id(), ty.clone());
                        base_type = Some(Box::new(ty));
                    }
                }
                _ => {}
            }
        }

        if let Some(base) = base_type {
            // Record update
            match *base {
                Type::Record(ref r) => {
                    let mut merged_fields = r.fields.clone();
                    merged_fields.extend(fields);
                    Type::Record(RecordType {
                        fields: merged_fields,
                        base_type: r.base_type.clone(),
                        alias: r.alias.clone(),
                        field_references: r.field_references.merge(&self.field_references),
                    })
                }
                _ => Type::record(fields),
            }
        } else {
            Type::record(fields)
        }
    }

    fn infer_if_else(&mut self, node: Node) -> Type {
        let mut cursor = node.walk();
        let mut types = Vec::new();

        for child in node.children(&mut cursor) {
            if child.kind() != "if" && child.kind() != "then" && child.kind() != "else" {
                types.push(self.infer(child));
            }
        }

        // Conditions should be Bool
        // Branches should have the same type
        if types.len() >= 3 {
            // First is condition, should be Bool
            self.unify(&types[0], &Type::bool());

            // Return the type of the first branch
            types.get(1).cloned().unwrap_or(Type::Unknown)
        } else {
            Type::Unknown
        }
    }

    fn infer_case(&mut self, node: Node) -> Type {
        // Get the expression being matched
        let expr_node = node
            .child_by_field_name("expr")
            .or_else(|| node.named_child(0));

        let expr_type = if let Some(e) = expr_node {
            self.infer(e)
        } else {
            Type::fresh_var()
        };

        // Infer each branch
        let mut branch_type: Option<Type> = None;
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "case_of_branch" {
                // Bind pattern
                if let Some(pattern) = child.child_by_field_name("pattern") {
                    self.bind_pattern(pattern, &expr_type);
                }
                // Infer branch expression
                if let Some(expr) = child
                    .child_by_field_name("expr")
                    .or_else(|| child.named_child(child.named_child_count().saturating_sub(1)))
                {
                    let ty = self.infer(expr);
                    if branch_type.is_none() {
                        branch_type = Some(ty);
                    }
                }
            }
        }

        branch_type.unwrap_or(Type::Unknown)
    }

    fn infer_let_in(&mut self, node: Node) -> Type {
        // Infer all let bindings
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "value_declaration" {
                let ty = self.infer_value_declaration(child);
                // Bind the function name
                if let Some(func_decl) = child.child_by_field_name("functionDeclarationLeft") {
                    if let Some(name_node) = func_decl.child(0) {
                        if name_node.kind() == "lower_case_identifier" {
                            let name = self.node_text(name_node).to_string();
                            self.set_binding(name, ty);
                        }
                    }
                }
            }
        }

        // Infer the body (last expression)
        if let Some(body) = node
            .child_by_field_name("body")
            .or_else(|| node.named_child(node.named_child_count().saturating_sub(1)))
        {
            self.infer(body)
        } else {
            Type::Unknown
        }
    }

    fn infer_lambda(&mut self, node: Node) -> Type {
        // Collect parameter patterns
        let mut params = Vec::new();
        let mut cursor = node.walk();

        for child in node.children(&mut cursor) {
            if child.kind() == "pattern" {
                let param_type = Type::fresh_var();
                self.bind_pattern(child, &param_type);
                params.push(param_type);
            }
        }

        // Infer body
        let body_type = if let Some(body) = node
            .child_by_field_name("expr")
            .or_else(|| node.named_child(node.named_child_count().saturating_sub(1)))
        {
            self.infer(body)
        } else {
            Type::Unknown
        };

        Type::function(params, body_type)
    }

    fn infer_list(&mut self, node: Node) -> Type {
        let elem_type = Type::fresh_var();
        let mut cursor = node.walk();

        for child in node.children(&mut cursor) {
            if child.is_named() && child.kind() != "[" && child.kind() != "]" && child.kind() != ","
            {
                let ty = self.infer(child);
                self.unify(&ty, &elem_type);
            }
        }

        Type::list(elem_type)
    }

    fn infer_tuple(&mut self, node: Node) -> Type {
        let mut types = Vec::new();
        let mut cursor = node.walk();

        for child in node.children(&mut cursor) {
            if child.is_named() {
                types.push(self.infer(child));
            }
        }

        Type::tuple(types)
    }

    fn infer_bin_op(&mut self, node: Node) -> Type {
        let mut cursor = node.walk();
        let children: Vec<Node> = node.children(&mut cursor).collect();

        // Binary expression: left op right
        if children.len() >= 3 {
            let left_type = self.infer(children[0]);
            // children[1] is the operator
            let right_type = self.infer(children[2]);

            // For now, unify left and right and return that type
            self.unify(&left_type, &right_type);
            left_type
        } else {
            Type::Unknown
        }
    }

    fn infer_operator_as_function(&mut self, _node: Node) -> Type {
        // Operators like (+) are functions a -> a -> a
        let var = Type::fresh_var();
        Type::function(vec![var.clone(), var.clone()], var)
    }

    /// Unify two types, updating substitutions
    fn unify(&mut self, t1: &Type, t2: &Type) -> bool {
        let t1 = self.substitutions.get(t1);
        let t2 = self.substitutions.get(t2);

        match (&t1, &t2) {
            // Same type
            _ if std::mem::discriminant(&t1) == std::mem::discriminant(&t2) => match (&t1, &t2) {
                (Type::Var(v1), Type::Var(v2)) if v1.id == v2.id => true,
                (Type::Union(u1), Type::Union(u2)) => {
                    u1.module == u2.module
                        && u1.name == u2.name
                        && u1.params.len() == u2.params.len()
                        && u1
                            .params
                            .iter()
                            .zip(&u2.params)
                            .all(|(p1, p2)| self.unify(p1, p2))
                }
                (Type::Function(f1), Type::Function(f2)) => {
                    f1.params.len() == f2.params.len()
                        && f1
                            .params
                            .iter()
                            .zip(&f2.params)
                            .all(|(p1, p2)| self.unify(p1, p2))
                        && self.unify(&f1.ret, &f2.ret)
                }
                (Type::Tuple(t1), Type::Tuple(t2)) => {
                    t1.types.len() == t2.types.len()
                        && t1
                            .types
                            .iter()
                            .zip(&t2.types)
                            .all(|(e1, e2)| self.unify(e1, e2))
                }
                (Type::Record(r1), Type::Record(r2)) => self.unify_records(&r1.fields, &r2.fields),
                (Type::Unit(_), Type::Unit(_)) => true,
                (Type::Unknown, Type::Unknown) => true,
                _ => false,
            },
            // Variable unification
            (Type::Var(v), other) | (other, Type::Var(v)) if !v.rigid => {
                self.substitutions.set(v.id, other.clone());
                true
            }
            // Mutable record with concrete record
            (Type::MutableRecord(mr), Type::Record(r))
            | (Type::Record(r), Type::MutableRecord(mr)) => {
                self.unify_records(&mr.fields, &r.fields)
            }
            // Different types
            _ => false,
        }
    }

    fn unify_records(
        &mut self,
        fields1: &HashMap<String, Type>,
        fields2: &HashMap<String, Type>,
    ) -> bool {
        for (name, ty1) in fields1 {
            if let Some(ty2) = fields2.get(name) {
                if !self.unify(ty1, ty2) {
                    return false;
                }
            }
        }
        true
    }

    /// Apply all substitutions and return the final result
    pub fn finalize(self) -> InferenceResult {
        let mut expression_types = HashMap::new();
        for (id, ty) in self.expression_types {
            expression_types.insert(id, self.substitutions.apply(&ty));
        }

        let ty = if let Some(first_type) = expression_types.values().next() {
            first_type.clone()
        } else {
            Type::Unknown
        };

        InferenceResult {
            ty,
            expression_types,
            field_references: self.field_references,
        }
    }
}

/// High-level inference function for a source file
pub fn infer_file(source: &str, tree: &tree_sitter::Tree, uri: &str) -> InferenceResult {
    let symbol_links = bind_tree(source, tree);
    let mut scope = InferenceScope::new(source, uri.to_string(), &symbol_links);

    // Infer all top-level declarations
    let mut cursor = tree.root_node().walk();
    for child in tree.root_node().children(&mut cursor) {
        if child.kind() == "value_declaration" {
            scope.infer(child);
        }
    }

    scope.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(source: &str) -> tree_sitter::Tree {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_elm::LANGUAGE.into())
            .unwrap();
        parser.parse(source, None).unwrap()
    }

    #[test]
    fn test_infer_simple_function() {
        let source = r#"
module Test exposing (..)

add : Int -> Int -> Int
add a b = a
"#;
        let tree = parse(source);
        let result = infer_file(source, &tree, "test.elm");
        assert!(!result.expression_types.is_empty());
    }

    #[test]
    fn test_infer_record_field_access() {
        let source = r#"
module Test exposing (..)

type alias User = { name : String }

getName : User -> String
getName user = user.name
"#;
        let tree = parse(source);
        let result = infer_file(source, &tree, "test.elm");
        assert!(!result.field_references.is_empty());
    }
}
