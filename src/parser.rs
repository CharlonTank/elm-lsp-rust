use tower_lsp::lsp_types::*;
use tree_sitter::{Language, Parser, Tree};

use crate::document::ElmSymbol;

fn elm_language() -> Language {
    tree_sitter_elm::LANGUAGE.into()
}

pub struct ElmParser {
    _parser: Parser,
}

impl ElmParser {
    pub fn new() -> Self {
        let mut parser = Parser::new();
        parser
            .set_language(&elm_language())
            .expect("Failed to load Elm grammar");
        Self { _parser: parser }
    }

    pub fn parse(&self, source: &str) -> Option<Tree> {
        let mut parser = Parser::new();
        parser.set_language(&elm_language()).ok()?;
        parser.parse(source, None)
    }

    pub fn extract_symbols(&self, tree: &Tree, source: &str) -> Vec<ElmSymbol> {
        let mut symbols = Vec::new();
        let root = tree.root_node();

        // First pass: collect type annotations (they're siblings to value_declaration)
        let mut type_annotations: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut cursor = root.walk();
        for child in root.children(&mut cursor) {
            if child.kind() == "type_annotation" {
                if let Some((name, sig)) = self.parse_type_annotation(child, source) {
                    type_annotations.insert(name, sig);
                }
            }
        }

        // Second pass: extract all symbols
        self.walk_node(root, source, &mut symbols, &type_annotations);

        symbols
    }

    fn parse_type_annotation(&self, node: tree_sitter::Node, source: &str) -> Option<(String, String)> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "lower_case_identifier" {
                let name = self.node_text(child, source).to_string();
                let sig = self.node_text(node, source).to_string();
                return Some((name, sig));
            }
        }
        None
    }

    fn walk_node(
        &self,
        node: tree_sitter::Node,
        source: &str,
        symbols: &mut Vec<ElmSymbol>,
        type_annotations: &std::collections::HashMap<String, String>,
    ) {
        match node.kind() {
            "value_declaration" => {
                if let Some(symbol) = self.parse_value_declaration(node, source, type_annotations) {
                    symbols.push(symbol);
                }
            }
            "type_declaration" => {
                if let Some(symbol) = self.parse_type_declaration(node, source) {
                    symbols.push(symbol);
                }
            }
            "type_alias_declaration" => {
                if let Some(symbol) = self.parse_type_alias_declaration(node, source) {
                    symbols.push(symbol);
                }
            }
            "port_annotation" => {
                if let Some(symbol) = self.parse_port_annotation(node, source) {
                    symbols.push(symbol);
                }
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.walk_node(child, source, symbols, type_annotations);
        }
    }

    fn parse_value_declaration(
        &self,
        node: tree_sitter::Node,
        source: &str,
        type_annotations: &std::collections::HashMap<String, String>,
    ) -> Option<ElmSymbol> {
        let mut name = None;
        let mut name_range = None;

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "function_declaration_left" {
                if let Some(name_node) = child.child(0) {
                    name = Some(self.node_text(name_node, source).to_string());
                    name_range = Some(self.node_to_range(name_node));
                }
            }
        }

        let name = name?;
        let range = name_range.unwrap_or_else(|| self.node_to_range(node));

        // Look up the type annotation from the pre-collected map
        let signature = type_annotations.get(&name).cloned();

        let mut symbol = ElmSymbol::new(name, SymbolKind::FUNCTION, range);
        symbol.signature = signature;
        symbol.definition_range = Some(self.node_to_range(node));

        Some(symbol)
    }

    fn parse_type_declaration(
        &self,
        node: tree_sitter::Node,
        source: &str,
    ) -> Option<ElmSymbol> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "upper_case_identifier" {
                let name = self.node_text(child, source).to_string();
                let range = self.node_to_range(child);
                let mut symbol = ElmSymbol::new(name, SymbolKind::ENUM, range);
                symbol.definition_range = Some(self.node_to_range(node));
                symbol.signature = Some(self.node_text(node, source).to_string());

                self.extract_type_constructors(node, source, &mut symbol);

                return Some(symbol);
            }
        }
        None
    }

    fn extract_type_constructors(
        &self,
        node: tree_sitter::Node,
        source: &str,
        _parent_symbol: &mut ElmSymbol,
    ) {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "union_variant" {
                if let Some(name_node) = child.child(0) {
                    let _name = self.node_text(name_node, source);
                    let _range = self.node_to_range(name_node);
                }
            }
        }
    }

    fn parse_type_alias_declaration(
        &self,
        node: tree_sitter::Node,
        source: &str,
    ) -> Option<ElmSymbol> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "upper_case_identifier" {
                let name = self.node_text(child, source).to_string();
                let range = self.node_to_range(child);
                let mut symbol = ElmSymbol::new(name, SymbolKind::STRUCT, range);
                symbol.definition_range = Some(self.node_to_range(node));
                symbol.signature = Some(self.node_text(node, source).to_string());
                return Some(symbol);
            }
        }
        None
    }

    fn parse_port_annotation(
        &self,
        node: tree_sitter::Node,
        source: &str,
    ) -> Option<ElmSymbol> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "lower_case_identifier" {
                let name = self.node_text(child, source).to_string();
                let range = self.node_to_range(child);
                let mut symbol = ElmSymbol::new(name, SymbolKind::INTERFACE, range);
                symbol.definition_range = Some(self.node_to_range(node));
                symbol.signature = Some(self.node_text(node, source).to_string());
                return Some(symbol);
            }
        }
        None
    }

    fn node_text<'a>(&self, node: tree_sitter::Node, source: &'a str) -> &'a str {
        &source[node.byte_range()]
    }

    fn node_to_range(&self, node: tree_sitter::Node) -> Range {
        let start = node.start_position();
        let end = node.end_position();
        Range {
            start: Position::new(start.row as u32, start.column as u32),
            end: Position::new(end.row as u32, end.column as u32),
        }
    }
}

impl Default for ElmParser {
    fn default() -> Self {
        Self::new()
    }
}
