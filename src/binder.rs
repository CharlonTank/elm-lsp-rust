//! Symbol binding for Elm source files.
//!
//! The binder creates a map from AST nodes to the symbols they contain,
//! tracking lexical scopes for variable resolution.

use std::collections::HashMap;
use tree_sitter::Node;

/// Symbol kind as bound in the AST
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoundSymbolKind {
    Function,
    FunctionParameter,
    CasePattern,
    AnonymousFunctionParameter,
    Type,
    TypeAlias,
    UnionConstructor,
    TypeVariable,
    Port,
    Operator,
    Import,
    FieldType,
}

/// A bound symbol with its location and kind
#[derive(Debug, Clone)]
pub struct BoundSymbol {
    pub name: String,
    pub node_id: usize,
    pub kind: BoundSymbolKind,
    /// For types and type aliases, the constructors they expose
    pub constructors: Vec<Constructor>,
}

/// A constructor for a type
#[derive(Debug, Clone)]
pub struct Constructor {
    pub name: String,
    pub node_id: usize,
    pub kind: ConstructorKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstructorKind {
    UnionConstructor,
    TypeAlias,
}

/// Map from symbol name to symbols with that name
pub type SymbolMap = HashMap<String, Vec<BoundSymbol>>;

/// Symbol links map container node IDs to their local symbols
#[derive(Debug, Clone, Default)]
pub struct SymbolLinks {
    /// Map from container node ID to symbols defined in that container
    containers: HashMap<usize, SymbolMap>,
    /// Names that cannot be shadowed (top-level definitions)
    non_shadowable_names: std::collections::HashSet<String>,
    /// Exposed symbols from module declaration
    exposing: HashMap<String, BoundSymbol>,
}

impl SymbolLinks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get symbols defined in a specific container
    pub fn get_container(&self, node_id: usize) -> Option<&SymbolMap> {
        self.containers.get(&node_id)
    }

    /// Get a symbol by name from a container
    pub fn get_symbol(&self, container_id: usize, name: &str) -> Option<&BoundSymbol> {
        self.containers
            .get(&container_id)
            .and_then(|map| map.get(name))
            .and_then(|symbols| symbols.first())
    }

    /// Get all symbols with a given name from a container
    pub fn get_all_symbols(&self, container_id: usize, name: &str) -> Vec<&BoundSymbol> {
        self.containers
            .get(&container_id)
            .and_then(|map| map.get(name))
            .map(|symbols| symbols.iter().collect())
            .unwrap_or_default()
    }

    /// Check if a name cannot be shadowed
    pub fn is_non_shadowable(&self, name: &str) -> bool {
        self.non_shadowable_names.contains(name)
    }

    /// Get the exposed symbols
    pub fn exposing(&self) -> &HashMap<String, BoundSymbol> {
        &self.exposing
    }
}

/// Bind an Elm source file, creating symbol links
pub fn bind_tree(source: &str, tree: &tree_sitter::Tree) -> SymbolLinks {
    let mut binder = Binder::new(source);
    binder.bind(tree.root_node());
    binder.symbol_links
}

struct Binder<'a> {
    source: &'a str,
    symbol_links: SymbolLinks,
    /// Stack of container node IDs
    container_stack: Vec<usize>,
}

impl<'a> Binder<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            symbol_links: SymbolLinks::new(),
            container_stack: Vec::new(),
        }
    }

    fn current_container(&self) -> Option<usize> {
        self.container_stack.last().copied()
    }

    fn add_symbol(&mut self, symbol: BoundSymbol) {
        if let Some(container_id) = self.current_container() {
            self.symbol_links
                .containers
                .entry(container_id)
                .or_default()
                .entry(symbol.name.clone())
                .or_default()
                .push(symbol);
        }
    }

    fn push_container(&mut self, node_id: usize) {
        self.container_stack.push(node_id);
        self.symbol_links.containers.entry(node_id).or_default();
    }

    fn pop_container(&mut self) {
        self.container_stack.pop();
    }

    fn node_text(&self, node: Node) -> &str {
        node.utf8_text(self.source.as_bytes()).unwrap_or("")
    }

    fn bind(&mut self, node: Node) {
        match node.kind() {
            "file" => self.bind_file(node),
            "let_in_expr" => self.bind_container(node),
            "anonymous_function_expr" => self.bind_anonymous_function(node),
            "case_of_branch" => self.bind_case_branch(node),
            "value_declaration" => self.bind_value_declaration(node),
            "type_declaration" => self.bind_type_declaration(node),
            "type_alias_declaration" => self.bind_type_alias_declaration(node),
            "lower_type_name" => self.bind_lower_type_name(node),
            "port_annotation" => self.bind_port_annotation(node),
            "infix_declaration" => self.bind_infix_declaration(node),
            "pattern" => self.bind_pattern(node),
            "import_clause" => self.bind_import_clause(node),
            _ => self.bind_children(node),
        }
    }

    fn bind_children(&mut self, node: Node) {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.bind(child);
        }
    }

    fn bind_file(&mut self, node: Node) {
        self.push_container(node.id());
        self.bind_default_imports();
        self.bind_children(node);
        self.bind_exposing(node);
        self.pop_container();
    }

    fn bind_container(&mut self, node: Node) {
        self.push_container(node.id());
        self.bind_children(node);
        self.pop_container();
    }

    fn bind_value_declaration(&mut self, node: Node) {
        // Bind the function name from function_declaration_left
        if let Some(func_decl_left) = node.child_by_field_name("functionDeclarationLeft") {
            if let Some(name_node) = func_decl_left.child(0) {
                if name_node.kind() == "lower_case_identifier" {
                    let name = self.node_text(name_node).to_string();
                    self.add_symbol(BoundSymbol {
                        name: name.clone(),
                        node_id: func_decl_left.id(),
                        kind: BoundSymbolKind::Function,
                        constructors: vec![],
                    });

                    // Top-level functions cannot be shadowed
                    if node.parent().map(|p| p.kind()) == Some("file") {
                        self.symbol_links.non_shadowable_names.insert(name);
                    }
                }
            }
        } else if let Some(pattern) = node.child_by_field_name("pattern") {
            // Destructuring pattern at top level
            self.bind_lower_patterns_as_functions(pattern);
        }

        // Bind the rest as a container (for let bindings)
        self.push_container(node.id());
        self.bind_children(node);
        self.pop_container();
    }

    fn bind_lower_patterns_as_functions(&mut self, node: Node) {
        let mut cursor = node.walk();
        for desc in node.children(&mut cursor) {
            if desc.kind() == "lower_pattern" {
                let name = self.node_text(desc).to_string();
                self.add_symbol(BoundSymbol {
                    name,
                    node_id: desc.id(),
                    kind: BoundSymbolKind::Function,
                    constructors: vec![],
                });
            } else {
                self.bind_lower_patterns_as_functions(desc);
            }
        }
    }

    fn bind_anonymous_function(&mut self, node: Node) {
        self.push_container(node.id());

        // Bind parameters from patterns
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "pattern" {
                self.bind_pattern_as_anonymous_params(child);
            }
        }

        self.bind_children(node);
        self.pop_container();
    }

    fn bind_pattern_as_anonymous_params(&mut self, node: Node) {
        let mut cursor = node.walk();
        for desc in node.children(&mut cursor) {
            if desc.kind() == "lower_pattern" {
                let name = self.node_text(desc).to_string();
                self.add_symbol(BoundSymbol {
                    name,
                    node_id: desc.id(),
                    kind: BoundSymbolKind::AnonymousFunctionParameter,
                    constructors: vec![],
                });
            } else {
                self.bind_pattern_as_anonymous_params(desc);
            }
        }
    }

    fn bind_case_branch(&mut self, node: Node) {
        self.push_container(node.id());

        // Bind pattern variables as case patterns
        if let Some(pattern) = node.child_by_field_name("pattern") {
            self.bind_pattern_as_case_patterns(pattern);
        }

        self.bind_children(node);
        self.pop_container();
    }

    fn bind_pattern_as_case_patterns(&mut self, node: Node) {
        let mut cursor = node.walk();
        for desc in node.children(&mut cursor) {
            if desc.kind() == "lower_pattern" {
                let name = self.node_text(desc).to_string();
                self.add_symbol(BoundSymbol {
                    name,
                    node_id: desc.id(),
                    kind: BoundSymbolKind::CasePattern,
                    constructors: vec![],
                });
            } else {
                self.bind_pattern_as_case_patterns(desc);
            }
        }
    }

    fn bind_type_declaration(&mut self, node: Node) {
        // Get union variants
        let mut constructors = Vec::new();
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "union_variant" {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let name = self.node_text(name_node).to_string();
                    constructors.push(Constructor {
                        name: name.clone(),
                        node_id: child.id(),
                        kind: ConstructorKind::UnionConstructor,
                    });

                    // Also bind constructors to the container
                    self.add_symbol(BoundSymbol {
                        name,
                        node_id: child.id(),
                        kind: BoundSymbolKind::UnionConstructor,
                        constructors: vec![],
                    });
                }
            }
        }

        // Bind the type name
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.node_text(name_node).to_string();
            self.add_symbol(BoundSymbol {
                name,
                node_id: node.id(),
                kind: BoundSymbolKind::Type,
                constructors,
            });
        }

        // Bind type variables in a container
        self.push_container(node.id());
        self.bind_children(node);
        self.pop_container();
    }

    fn bind_type_alias_declaration(&mut self, node: Node) {
        // Check if this is a record type alias (has a constructor)
        let is_record_constructor = node
            .child_by_field_name("typeExpression")
            .and_then(|te| te.child(0))
            .map(|c| c.kind() == "record_type")
            .unwrap_or(false);

        if let Some(name_node) = node.child_by_field_name("name") {
            let name = self.node_text(name_node).to_string();
            let constructors = if is_record_constructor {
                vec![Constructor {
                    name: name.clone(),
                    node_id: node.id(),
                    kind: ConstructorKind::TypeAlias,
                }]
            } else {
                vec![]
            };

            self.add_symbol(BoundSymbol {
                name,
                node_id: node.id(),
                kind: BoundSymbolKind::TypeAlias,
                constructors,
            });
        }

        // Bind type variables in a container
        self.push_container(node.id());
        self.bind_children(node);
        self.pop_container();
    }

    fn bind_lower_type_name(&mut self, node: Node) {
        let name = self.node_text(node).to_string();
        self.add_symbol(BoundSymbol {
            name,
            node_id: node.id(),
            kind: BoundSymbolKind::TypeVariable,
            constructors: vec![],
        });
    }

    fn bind_port_annotation(&mut self, node: Node) {
        // Find the lower_case_identifier child
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "lower_case_identifier" {
                let name = self.node_text(child).to_string();
                self.add_symbol(BoundSymbol {
                    name,
                    node_id: node.id(),
                    kind: BoundSymbolKind::Port,
                    constructors: vec![],
                });
                break;
            }
        }
    }

    fn bind_infix_declaration(&mut self, node: Node) {
        if let Some(operator) = node.child_by_field_name("operator") {
            let name = self.node_text(operator).to_string();
            self.add_symbol(BoundSymbol {
                name,
                node_id: node.id(),
                kind: BoundSymbolKind::Operator,
                constructors: vec![],
            });
        }

        // Also bind the function name
        if let Some(last) = node.named_child(node.named_child_count().saturating_sub(1)) {
            let name = self.node_text(last).to_string();
            self.add_symbol(BoundSymbol {
                name,
                node_id: node.id(),
                kind: BoundSymbolKind::Operator,
                constructors: vec![],
            });
        }
    }

    fn bind_pattern(&mut self, node: Node) {
        // Patterns can introduce bindings in the current container
        if let Some(parent) = node.parent() {
            match parent.kind() {
                "function_declaration_left" => {
                    // These are function parameters
                    self.bind_function_parameters(node);
                }
                _ => {
                    // Just traverse children
                    self.bind_children(node);
                }
            }
        }
    }

    fn bind_function_parameters(&mut self, node: Node) {
        let mut cursor = node.walk();
        for desc in node.children(&mut cursor) {
            if desc.kind() == "lower_pattern" {
                let name = self.node_text(desc).to_string();
                self.add_symbol(BoundSymbol {
                    name,
                    node_id: desc.id(),
                    kind: BoundSymbolKind::FunctionParameter,
                    constructors: vec![],
                });
            } else {
                self.bind_function_parameters(desc);
            }
        }
    }

    fn bind_import_clause(&mut self, node: Node) {
        // Get the module name or alias
        let name = if let Some(as_clause) = node.child_by_field_name("asClause") {
            as_clause.child_by_field_name("name").map(|n| self.node_text(n).to_string())
        } else {
            node.child_by_field_name("moduleName").map(|n| self.node_text(n).to_string())
        };

        if let Some(name) = name {
            self.add_symbol(BoundSymbol {
                name,
                node_id: node.id(),
                kind: BoundSymbolKind::Import,
                constructors: vec![],
            });
        }
    }

    fn bind_default_imports(&mut self) {
        // Elm has default imports for Basics, List, Maybe, etc.
        // We don't need to create real import nodes, just mark them as available
        let default_modules = [
            "Basics", "List", "Maybe", "Result", "String", "Char",
            "Tuple", "Debug", "Platform", "Cmd", "Sub",
        ];

        for module in default_modules {
            self.add_symbol(BoundSymbol {
                name: module.to_string(),
                node_id: 0, // Special ID for virtual imports
                kind: BoundSymbolKind::Import,
                constructors: vec![],
            });
        }
    }

    fn bind_exposing(&mut self, file_node: Node) {
        // Find module declaration and its exposing list
        let mut cursor = file_node.walk();
        for child in file_node.children(&mut cursor) {
            if child.kind() == "module_declaration" {
                if let Some(exposing) = child.child_by_field_name("exposing") {
                    self.process_exposing_list(exposing, file_node.id());
                }
                break;
            }
        }
    }

    fn process_exposing_list(&mut self, exposing: Node, file_id: usize) {
        // Check for exposing all (..)
        let mut cursor = exposing.walk();
        for child in exposing.children(&mut cursor) {
            if child.kind() == "double_dot" {
                // Expose all top-level symbols
                if let Some(symbols) = self.symbol_links.containers.get(&file_id) {
                    for (name, symbol_list) in symbols {
                        if let Some(symbol) = symbol_list.first() {
                            match symbol.kind {
                                BoundSymbolKind::Function
                                | BoundSymbolKind::TypeAlias
                                | BoundSymbolKind::Type
                                | BoundSymbolKind::Port => {
                                    self.symbol_links.exposing.insert(name.clone(), symbol.clone());
                                }
                                _ => {}
                            }
                        }
                    }
                }
                return;
            }
        }

        // Process explicit exposing list
        for child in exposing.children(&mut cursor) {
            match child.kind() {
                "exposed_value" => {
                    let name = self.node_text(child).to_string();
                    if let Some(symbols) = self.symbol_links.containers.get(&file_id) {
                        if let Some(symbol_list) = symbols.get(&name) {
                            if let Some(symbol) = symbol_list.first() {
                                self.symbol_links.exposing.insert(name, symbol.clone());
                            }
                        }
                    }
                }
                "exposed_type" => {
                    let name = self.node_text(child).to_string();
                    if let Some(symbols) = self.symbol_links.containers.get(&file_id) {
                        if let Some(symbol_list) = symbols.get(&name) {
                            if let Some(symbol) = symbol_list.first() {
                                self.symbol_links.exposing.insert(name, symbol.clone());
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(source: &str) -> tree_sitter::Tree {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&tree_sitter_elm::LANGUAGE.into()).unwrap();
        parser.parse(source, None).unwrap()
    }

    #[test]
    fn test_bind_simple_function() {
        let source = r#"
module Test exposing (..)

hello : String -> String
hello name = name
"#;
        let tree = parse(source);
        let links = bind_tree(source, &tree);

        // Root should have the function
        let root_id = tree.root_node().id();
        let symbols = links.get_container(root_id).unwrap();
        assert!(symbols.contains_key("hello"));
    }

    #[test]
    fn test_bind_type_alias() {
        let source = r#"
module Test exposing (..)

type alias User = { name : String }
"#;
        let tree = parse(source);
        let links = bind_tree(source, &tree);

        let root_id = tree.root_node().id();
        let symbols = links.get_container(root_id).unwrap();
        assert!(symbols.contains_key("User"));

        let user_symbols = symbols.get("User").unwrap();
        assert_eq!(user_symbols[0].kind, BoundSymbolKind::TypeAlias);
        assert!(!user_symbols[0].constructors.is_empty());
    }

    #[test]
    fn test_bind_union_type() {
        let source = r#"
module Test exposing (..)

type Maybe a
    = Just a
    | Nothing
"#;
        let tree = parse(source);
        let links = bind_tree(source, &tree);

        let root_id = tree.root_node().id();
        let symbols = links.get_container(root_id).unwrap();

        // Type should be bound
        assert!(symbols.contains_key("Maybe"));

        // Constructors should be bound
        assert!(symbols.contains_key("Just"));
        assert!(symbols.contains_key("Nothing"));
    }
}
