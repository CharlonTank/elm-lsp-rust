use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tower_lsp::lsp_types::*;
use walkdir::WalkDir;

use crate::binder::BoundSymbolKind;
use crate::document::ElmSymbol;
use crate::parser::ElmParser;
use crate::type_checker::{TypeChecker, FieldDefinition, TargetTypeAlias};

/// Represents an Elm module with its symbols and metadata
#[derive(Debug, Clone)]
pub struct ElmModule {
    pub path: PathBuf,
    pub module_name: String,
    pub symbols: Vec<ElmSymbol>,
    pub imports: Vec<ImportInfo>,
    pub exposing: ExposingInfo,
}

#[derive(Debug, Clone)]
pub struct ImportInfo {
    pub module_name: String,
    pub alias: Option<String>,
    pub exposing: ExposingInfo,
}

#[derive(Debug, Clone)]
pub enum ExposingInfo {
    All,
    Explicit(Vec<String>),
}

/// Cross-file symbol reference
#[derive(Debug, Clone)]
pub struct SymbolReference {
    pub uri: Url,
    pub range: Range,
    pub is_definition: bool,
    pub kind: Option<BoundSymbolKind>,
    /// For field references, the type alias that contains this field
    pub type_context: Option<String>,
}

/// A symbol definition at a specific position
/// Used by classify_definition_at_position for type-aware reference finding
#[derive(Debug, Clone)]
pub struct DefinitionSymbol {
    pub name: String,
    pub kind: BoundSymbolKind,
    pub uri: Url,
    pub range: Range,
    /// For fields: the type alias name; for constructors: the custom type name
    pub type_context: Option<String>,
    pub module_name: Option<String>,
}

/// Global symbol entry in the index
#[derive(Debug, Clone)]
pub struct GlobalSymbol {
    pub name: String,
    pub module_name: String,
    pub kind: SymbolKind,
    pub definition_uri: Url,
    pub definition_range: Range,
    pub signature: Option<String>,
}

/// Protected files in Lamdera projects that should not be renamed/moved
const LAMDERA_PROTECTED_FILES: &[&str] = &["Env.elm", "Types.elm", "Frontend.elm", "Backend.elm"];

/// Protected type names in Lamdera projects that should not be renamed
const LAMDERA_PROTECTED_TYPES: &[&str] = &["FrontendMsg", "BackendMsg", "ToBackend", "ToFrontend", "FrontendModel", "BackendModel"];

/// The workspace index - tracks all symbols across all files
pub struct Workspace {
    pub root_path: PathBuf,
    pub source_dirs: Vec<PathBuf>,
    pub modules: HashMap<String, ElmModule>,
    pub symbols: HashMap<String, Vec<GlobalSymbol>>,
    pub references: HashMap<String, Vec<SymbolReference>>,
    pub parser: ElmParser,
    pub type_checker: TypeChecker,
    pub is_lamdera_project: bool,
}

impl Workspace {
    pub fn new(root_path: PathBuf) -> Self {
        Self {
            root_path,
            source_dirs: Vec::new(),
            modules: HashMap::new(),
            symbols: HashMap::new(),
            references: HashMap::new(),
            parser: ElmParser::new(),
            type_checker: TypeChecker::new(),
            is_lamdera_project: false,
        }
    }

    /// Check if a symbol name is a protected Lamdera type that cannot be renamed
    pub fn is_protected_lamdera_type(&self, name: &str) -> bool {
        self.is_lamdera_project && LAMDERA_PROTECTED_TYPES.contains(&name)
    }

    /// Initialize workspace by reading elm.json and indexing all files
    pub fn initialize(&mut self) -> anyhow::Result<()> {
        // Read elm.json to find source directories
        let elm_json_path = self.root_path.join("elm.json");
        if elm_json_path.exists() {
            let content = std::fs::read_to_string(&elm_json_path)?;
            self.parse_elm_json(&content)?;
        } else {
            // Default to src/ if no elm.json
            let src_dir = self.root_path.join("src");
            if src_dir.exists() {
                self.source_dirs.push(src_dir);
            }
        }

        // Index all .elm files
        self.index_all_files()?;

        Ok(())
    }

    fn parse_elm_json(&mut self, content: &str) -> anyhow::Result<()> {
        let json: serde_json::Value = serde_json::from_str(content)?;

        // Detect Lamdera project by checking for lamdera/* dependencies
        self.is_lamdera_project = self.detect_lamdera_project(&json);
        if self.is_lamdera_project {
            tracing::info!("Detected Lamdera project");
        }

        // Handle both application and package elm.json formats
        if let Some(source_dirs) = json.get("source-directories") {
            if let Some(dirs) = source_dirs.as_array() {
                for dir in dirs {
                    if let Some(dir_str) = dir.as_str() {
                        let full_path = self.root_path.join(dir_str);
                        if full_path.exists() {
                            self.source_dirs.push(full_path);
                        }
                    }
                }
            }
        }

        // Package format uses "src" implicitly
        if self.source_dirs.is_empty() {
            let src_dir = self.root_path.join("src");
            if src_dir.exists() {
                self.source_dirs.push(src_dir);
            }
        }

        Ok(())
    }

    /// Detect if this is a Lamdera project by checking for lamdera dependencies
    fn detect_lamdera_project(&self, elm_json: &serde_json::Value) -> bool {
        // Check direct dependencies for lamdera/* packages
        if let Some(deps) = elm_json.get("dependencies") {
            if let Some(direct) = deps.get("direct") {
                if let Some(obj) = direct.as_object() {
                    for key in obj.keys() {
                        if key.starts_with("lamdera/") {
                            return true;
                        }
                    }
                }
            }
            // Also check indirect dependencies
            if let Some(indirect) = deps.get("indirect") {
                if let Some(obj) = indirect.as_object() {
                    for key in obj.keys() {
                        if key.starts_with("lamdera/") {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// Index all .elm files in the workspace
    pub fn index_all_files(&mut self) -> anyhow::Result<()> {
        let mut files_to_index = Vec::new();
        let is_lamdera = self.is_lamdera_project;

        for source_dir in &self.source_dirs {
            for entry in WalkDir::new(source_dir)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let path = entry.path();

                // Skip Evergreen directory in Lamdera projects
                if is_lamdera && self.is_evergreen_path(path) {
                    continue;
                }

                if path.extension().map_or(false, |ext| ext == "elm") {
                    files_to_index.push(path.to_path_buf());
                }
            }
        }

        tracing::info!("Indexing {} Elm files", files_to_index.len());

        for path in files_to_index {
            if let Err(e) = self.index_file(&path) {
                tracing::warn!("Failed to index {:?}: {}", path, e);
            }
        }

        // Build reference index after all files are parsed
        self.build_reference_index();

        Ok(())
    }

    /// Check if a path is in the Evergreen directory
    fn is_evergreen_path(&self, path: &Path) -> bool {
        path.components().any(|c| {
            if let std::path::Component::Normal(name) = c {
                name == "Evergreen"
            } else {
                false
            }
        })
    }

    /// Index a single file
    pub fn index_file(&mut self, path: &Path) -> anyhow::Result<()> {
        let content = std::fs::read_to_string(path)?;
        let uri = Url::from_file_path(path).map_err(|_| anyhow::anyhow!("Invalid path"))?;

        if let Some(tree) = self.parser.parse(&content) {
            let symbols = self.parser.extract_symbols(&tree, &content);
            let module_name = self.extract_module_name(&tree, &content)
                .unwrap_or_else(|| self.path_to_module_name(path));
            let imports = self.extract_imports(&tree, &content);
            let exposing = self.extract_exposing(&tree, &content);

            // Index for type checking
            self.type_checker.index_file(uri.as_str(), &content, tree.clone());

            // Index references from this file
            self.find_references_in_tree(&tree, &content, &uri, &module_name, &imports);

            // Add symbols to global index
            for symbol in &symbols {
                let qualified_name = format!("{}.{}", module_name, symbol.name);

                let global_symbol = GlobalSymbol {
                    name: symbol.name.clone(),
                    module_name: module_name.clone(),
                    kind: symbol.kind,
                    definition_uri: uri.clone(),
                    definition_range: symbol.definition_range.unwrap_or(symbol.range),
                    signature: symbol.signature.clone(),
                };

                self.symbols
                    .entry(symbol.name.clone())
                    .or_insert_with(Vec::new)
                    .push(global_symbol.clone());

                // Also index by qualified name
                self.symbols
                    .entry(qualified_name)
                    .or_insert_with(Vec::new)
                    .push(global_symbol);
            }

            let module = ElmModule {
                path: path.to_path_buf(),
                module_name: module_name.clone(),
                symbols,
                imports,
                exposing,
            };

            self.modules.insert(module_name, module);
        }

        Ok(())
    }

    /// Update a file in the index (called on didChange)
    pub fn update_file(&mut self, uri: &Url, content: &str) {
        let path = match uri.to_file_path() {
            Ok(p) => p,
            Err(_) => return,
        };

        // Remove old symbols for this file
        let old_module_name = self.modules.iter()
            .find(|(_, m)| m.path == path)
            .map(|(name, _)| name.clone());

        if let Some(module_name) = old_module_name {
            self.modules.remove(&module_name);
            // Clean up symbols from this module
            for symbols in self.symbols.values_mut() {
                symbols.retain(|s| s.module_name != module_name);
            }
        }

        // Invalidate type checker cache for this file
        self.type_checker.invalidate_file(uri.as_str());

        // Remove old references from this file
        for refs in self.references.values_mut() {
            refs.retain(|r| r.uri != *uri);
        }
        // Remove empty entries
        self.references.retain(|_, refs| !refs.is_empty());

        // Re-index the file
        if let Some(tree) = self.parser.parse(content) {
            let symbols = self.parser.extract_symbols(&tree, content);
            let module_name = self.extract_module_name(&tree, content)
                .unwrap_or_else(|| self.path_to_module_name(&path));
            let imports = self.extract_imports(&tree, content);
            let exposing = self.extract_exposing(&tree, content);

            // Re-index for type checking
            self.type_checker.index_file(uri.as_str(), content, tree.clone());

            // Re-index references for this file
            self.find_references_in_tree(&tree, content, uri, &module_name, &imports);

            for symbol in &symbols {
                let global_symbol = GlobalSymbol {
                    name: symbol.name.clone(),
                    module_name: module_name.clone(),
                    kind: symbol.kind,
                    definition_uri: uri.clone(),
                    definition_range: symbol.definition_range.unwrap_or(symbol.range),
                    signature: symbol.signature.clone(),
                };

                self.symbols
                    .entry(symbol.name.clone())
                    .or_insert_with(Vec::new)
                    .push(global_symbol);
            }

            let module = ElmModule {
                path,
                module_name: module_name.clone(),
                symbols,
                imports,
                exposing,
            };

            self.modules.insert(module_name, module);
        }
    }

    /// Remove a file from the index
    pub fn remove_file(&mut self, uri: &Url) {
        let path = match uri.to_file_path() {
            Ok(p) => p,
            Err(_) => return,
        };

        // Find and remove the module by path
        let module_name = self.modules.iter()
            .find(|(_, m)| m.path == path)
            .map(|(name, _)| name.clone());

        if let Some(module_name) = module_name {
            self.modules.remove(&module_name);
            // Clean up symbols from this module
            for symbols in self.symbols.values_mut() {
                symbols.retain(|s| s.module_name != module_name);
            }
        }

        // Invalidate type checker cache
        self.type_checker.invalidate_file(uri.as_str());

        // Remove references from this file
        for refs in self.references.values_mut() {
            refs.retain(|r| r.uri != *uri);
        }
        self.references.retain(|_, refs| !refs.is_empty());
    }

    /// Notify the workspace that a file was renamed/moved
    /// This removes the old file from the index and adds the new file
    pub fn notify_file_renamed(&mut self, old_path: &Path, new_path: &Path) -> anyhow::Result<()> {
        // Remove old file from index
        if let Ok(old_uri) = Url::from_file_path(old_path) {
            self.remove_file(&old_uri);
        }

        // Index the new file
        self.index_file(new_path)?;

        Ok(())
    }

    fn extract_module_name(&self, tree: &tree_sitter::Tree, source: &str) -> Option<String> {
        let root = tree.root_node();
        let mut cursor = root.walk();

        for child in root.children(&mut cursor) {
            if child.kind() == "module_declaration" {
                let mut inner_cursor = child.walk();
                for inner_child in child.children(&mut inner_cursor) {
                    if inner_child.kind() == "upper_case_qid" {
                        return Some(source[inner_child.byte_range()].to_string());
                    }
                }
            }
        }
        None
    }

    fn extract_imports(&self, tree: &tree_sitter::Tree, source: &str) -> Vec<ImportInfo> {
        let mut imports = Vec::new();
        let root = tree.root_node();
        let mut cursor = root.walk();

        for child in root.children(&mut cursor) {
            if child.kind() == "import_clause" {
                let mut module_name = None;
                let mut alias = None;
                let mut exposing = ExposingInfo::Explicit(Vec::new());

                let mut inner_cursor = child.walk();
                for inner_child in child.children(&mut inner_cursor) {
                    match inner_child.kind() {
                        "upper_case_qid" => {
                            module_name = Some(source[inner_child.byte_range()].to_string());
                        }
                        "as_clause" => {
                            let mut as_cursor = inner_child.walk();
                            for as_child in inner_child.children(&mut as_cursor) {
                                if as_child.kind() == "upper_case_identifier" {
                                    alias = Some(source[as_child.byte_range()].to_string());
                                }
                            }
                        }
                        "exposing_list" => {
                            exposing = self.parse_exposing_list(inner_child, source);
                        }
                        _ => {}
                    }
                }

                if let Some(name) = module_name {
                    imports.push(ImportInfo {
                        module_name: name,
                        alias,
                        exposing,
                    });
                }
            }
        }

        imports
    }

    fn extract_exposing(&self, tree: &tree_sitter::Tree, source: &str) -> ExposingInfo {
        let root = tree.root_node();
        let mut cursor = root.walk();

        for child in root.children(&mut cursor) {
            if child.kind() == "module_declaration" {
                let mut inner_cursor = child.walk();
                for inner_child in child.children(&mut inner_cursor) {
                    if inner_child.kind() == "exposing_list" {
                        return self.parse_exposing_list(inner_child, source);
                    }
                }
            }
        }

        ExposingInfo::Explicit(Vec::new())
    }

    fn parse_exposing_list(&self, node: tree_sitter::Node, source: &str) -> ExposingInfo {
        let mut cursor = node.walk();
        let mut exposed = Vec::new();

        for child in node.children(&mut cursor) {
            match child.kind() {
                "double_dot" => return ExposingInfo::All,
                "exposed_value" => {
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        if inner_child.kind() == "lower_case_identifier" {
                            exposed.push(source[inner_child.byte_range()].to_string());
                        }
                    }
                }
                "exposed_type" => {
                    // Capture the full exposed type including (..) if present
                    // e.g., "EventType(..)" should be stored as "EventType(..)"
                    let mut type_name = String::new();
                    let mut has_all_constructors = false;
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        match inner_child.kind() {
                            "upper_case_identifier" => {
                                type_name = source[inner_child.byte_range()].to_string();
                            }
                            "exposed_union_constructors" => {
                                // Check if it's (..) meaning all constructors
                                let text = &source[inner_child.byte_range()];
                                if text.contains("..") {
                                    has_all_constructors = true;
                                }
                            }
                            _ => {}
                        }
                    }
                    if !type_name.is_empty() {
                        if has_all_constructors {
                            exposed.push(format!("{}(..)", type_name));
                        } else {
                            exposed.push(type_name);
                        }
                    }
                }
                _ => {}
            }
        }

        ExposingInfo::Explicit(exposed)
    }

    fn path_to_module_name(&self, path: &Path) -> String {
        // Convert path like src/Pages/Home.elm to Pages.Home
        for source_dir in &self.source_dirs {
            if let Ok(relative) = path.strip_prefix(source_dir) {
                let module_name = relative
                    .with_extension("")
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, ".");
                return module_name;
            }
        }
        path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown".to_string())
    }

    /// Build the reference index by scanning all files for symbol usages
    fn build_reference_index(&mut self) {
        // Collect module info first to avoid borrow issues
        let module_info: Vec<_> = self.modules.iter()
            .map(|(name, m)| (name.clone(), m.path.clone(), m.imports.clone()))
            .collect();

        for (module_name, path, imports) in module_info {
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let uri = match Url::from_file_path(&path) {
                Ok(u) => u,
                Err(_) => continue,
            };

            if let Some(tree) = self.parser.parse(&content) {
                self.find_references_in_tree(&tree, &content, &uri, &module_name, &imports);
            }
        }
    }

    fn find_references_in_tree(
        &mut self,
        tree: &tree_sitter::Tree,
        source: &str,
        uri: &Url,
        _current_module: &str,
        imports: &[ImportInfo],
    ) {
        let root = tree.root_node();
        self.walk_for_references(root, source, uri, imports);
    }

    fn walk_for_references(
        &mut self,
        node: tree_sitter::Node,
        source: &str,
        uri: &Url,
        imports: &[ImportInfo],
    ) {
        // Debug: trace all nodes at line 132
        if node.start_position().row == 131 && uri.path().contains("Group.elm") {
        }

        match node.kind() {
            "value_qid" | "upper_case_qid" => {
                let text_check = &source[node.byte_range()];
                let is_in_import = self.is_module_name_in_import(node);
                // Debug: trace EventId specifically
                if text_check == "EventId" && node.start_position().row == 131 {
                }

                if !is_in_import {
                    let text = &source[node.byte_range()];
                    let kind = self.classify_reference_kind(node, text);

                    if text.contains('.') {
                        let symbol_name = text.rsplit('.').next().unwrap_or(text);
                        let symbol_start_col = node.end_position().column - symbol_name.len();

                        let range = Range {
                            start: Position::new(node.end_position().row as u32, symbol_start_col as u32),
                            end: Position::new(node.end_position().row as u32, node.end_position().column as u32),
                        };

                        let resolved_name = self.resolve_reference(text, imports);

                        self.references
                            .entry(resolved_name)
                            .or_insert_with(Vec::new)
                            .push(SymbolReference {
                                uri: uri.clone(),
                                range,
                                is_definition: false,
                                kind,
                                type_context: None,
                            });
                    } else {
                        let range = Range {
                            start: Position::new(node.start_position().row as u32, node.start_position().column as u32),
                            end: Position::new(node.end_position().row as u32, node.end_position().column as u32),
                        };

                        let resolved_name = self.resolve_reference(text, imports);

                        // Debug: trace EventId resolved name
                        if text == "EventId" && node.start_position().row == 131 {
                        }

                        self.references
                            .entry(resolved_name)
                            .or_insert_with(Vec::new)
                            .push(SymbolReference {
                                uri: uri.clone(),
                                range,
                                is_definition: false,
                                kind,
                                type_context: None,
                            });
                    }
                }
            }
            "lower_case_identifier" | "upper_case_identifier" => {
                let text = &source[node.byte_range()];
                let in_decl = self.is_in_declaration_context(node);

                // Debug: trace EventId specifically
                if text == "EventId" && node.start_position().row == 131 {
                    tracing::info!("DEBUG: Found EventId at line 132, in_decl={}, node_type={}", in_decl, node.kind());
                    if let Some(parent) = node.parent() {
                        tracing::info!("DEBUG: Parent type={}", parent.kind());
                    }
                }

                if !in_decl {
                    let kind = self.classify_reference_kind(node, text);
                    let range = Range {
                        start: Position::new(node.start_position().row as u32, node.start_position().column as u32),
                        end: Position::new(node.end_position().row as u32, node.end_position().column as u32),
                    };

                    let resolved_name = self.resolve_reference(text, imports);

                    self.references
                        .entry(resolved_name)
                        .or_insert_with(Vec::new)
                        .push(SymbolReference {
                            uri: uri.clone(),
                            range,
                            is_definition: false,
                            kind,
                            type_context: None,
                        });
                }
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.walk_for_references(child, source, uri, imports);
        }
    }

    fn classify_reference_kind(&self, node: tree_sitter::Node, text: &str) -> Option<BoundSymbolKind> {
        let is_uppercase = text.chars().next().map(|c| c.is_uppercase()).unwrap_or(false);

        let mut current = node;
        loop {
            if let Some(parent) = current.parent() {
                match parent.kind() {
                    "type_ref" | "type_expression" => {
                        if is_uppercase {
                            return Some(BoundSymbolKind::Type);
                        }
                        return Some(BoundSymbolKind::TypeVariable);
                    }
                    "value_expr" | "function_call_expr" => {
                        if is_uppercase {
                            return Some(BoundSymbolKind::UnionConstructor);
                        }
                        return Some(BoundSymbolKind::Function);
                    }
                    "pattern" | "union_pattern" | "case_of_branch" => {
                        if is_uppercase {
                            return Some(BoundSymbolKind::UnionConstructor);
                        }
                        return Some(BoundSymbolKind::CasePattern);
                    }
                    "field_access_expr" => {
                        if current.kind() == "lower_case_identifier" {
                            if let Some(prev) = current.prev_sibling() {
                                if prev.kind() == "dot" {
                                    return Some(BoundSymbolKind::FieldType);
                                }
                            }
                        }
                        return Some(BoundSymbolKind::Function);
                    }
                    "record_base_identifier" => {
                        return Some(BoundSymbolKind::Function);
                    }
                    "field_type" => {
                        return Some(BoundSymbolKind::FieldType);
                    }
                    "field" => {
                        // Record field assignment like `{ name = value }` - the identifier is a field name
                        // Only the first child (field name) is a field, not the value expression
                        if current == node {
                            return Some(BoundSymbolKind::FieldType);
                        }
                    }
                    "port_annotation" => {
                        return Some(BoundSymbolKind::Port);
                    }
                    "exposed_type" => {
                        return Some(BoundSymbolKind::Type);
                    }
                    "exposed_value" => {
                        return Some(BoundSymbolKind::Function);
                    }
                    "file" => break,
                    _ => {}
                }
                current = parent;
            } else {
                break;
            }
        }

        if is_uppercase {
            Some(BoundSymbolKind::UnionConstructor)
        } else {
            Some(BoundSymbolKind::Function)
        }
    }

    fn is_module_name_in_import(&self, node: tree_sitter::Node) -> bool {
        // Check if this is a module name directly under import_clause, as_clause, or module_declaration
        // But NOT if it's in an exposing_list
        if let Some(parent) = node.parent() {
            if parent.kind() == "import_clause" {
                return true;
            }
            if parent.kind() == "as_clause" {
                return true;
            }
            if parent.kind() == "module_declaration" {
                return true;
            }
        }
        false
    }

    fn is_in_declaration_context(&self, node: tree_sitter::Node) -> bool {
        let mut current = node.parent();
        while let Some(parent) = current {
            match parent.kind() {
                "function_declaration_left" | "type_declaration" |
                "type_alias_declaration" | "port_annotation" => return true,
                // If inside a qualified identifier, this is a module prefix, not a symbol reference
                "value_qid" | "upper_case_qid" => return true,
                // For module declarations and import clauses, skip the module name but allow exposed items
                "module_declaration" | "import_clause" => {
                    // Check if we're in an exposing_list - those ARE valid references
                    let mut check = node.parent();
                    while let Some(p) = check {
                        if p.kind() == "exposing_list" || p.kind() == "exposed_type" || p.kind() == "exposed_value" {
                            return false; // This is an exposed item, not a declaration
                        }
                        if p.kind() == "module_declaration" || p.kind() == "import_clause" {
                            break;
                        }
                        check = p.parent();
                    }
                    return true; // Module name, skip it
                }
                _ => {}
            }
            current = parent.parent();
        }
        false
    }

    fn resolve_reference(&self, name: &str, imports: &[ImportInfo]) -> String {
        // If already qualified (contains .), return as-is
        if name.contains('.') {
            // Check for alias resolution
            let parts: Vec<&str> = name.splitn(2, '.').collect();
            if parts.len() == 2 {
                for import in imports {
                    if let Some(alias) = &import.alias {
                        if alias == parts[0] {
                            return format!("{}.{}", import.module_name, parts[1]);
                        }
                    }
                }
            }
            return name.to_string();
        }

        // Check if it's exposed from an import
        for import in imports {
            match &import.exposing {
                ExposingInfo::All => {
                    // Could be from this module - we'd need to check
                }
                ExposingInfo::Explicit(exposed) => {
                    if exposed.contains(&name.to_string()) {
                        return format!("{}.{}", import.module_name, name);
                    }
                }
            }
        }

        // Return unqualified name
        name.to_string()
    }

    /// Find all references to a symbol
    pub fn find_references(&self, symbol_name: &str, module_name: Option<&str>) -> Vec<SymbolReference> {
        let mut results = Vec::new();

        // Extract just the symbol name if qualified
        let base_name = if symbol_name.contains('.') {
            symbol_name.rsplit('.').next().unwrap_or(symbol_name)
        } else {
            symbol_name
        };

        // Search by exact match first
        if let Some(refs) = self.references.get(symbol_name) {
            results.extend(refs.clone());
        }

        // Search by unqualified name
        if let Some(refs) = self.references.get(base_name) {
            results.extend(refs.clone());
        }

        // Search all qualified variants
        for (key, refs) in &self.references {
            if key.ends_with(&format!(".{}", base_name)) {
                // If module_name is specified, only include matching modules
                if let Some(mod_name) = module_name {
                    if key.starts_with(mod_name) {
                        results.extend(refs.clone());
                    }
                } else {
                    results.extend(refs.clone());
                }
            }
        }

        // Deduplicate by (uri, range)
        results.sort_by(|a, b| {
            (&a.uri, a.range.start.line, a.range.start.character)
                .cmp(&(&b.uri, b.range.start.line, b.range.start.character))
        });
        results.dedup_by(|a, b| a.uri == b.uri && a.range == b.range);

        results
    }

    /// Find references to a function using the DefinitionSymbol
    /// Filters references by Function kind to avoid matching types/constructors
    pub fn find_function_references_typed(&self, symbol: &DefinitionSymbol) -> Vec<SymbolReference> {
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| {
                match r.kind {
                    Some(BoundSymbolKind::Function) => true,
                    Some(BoundSymbolKind::FunctionParameter) => true,
                    Some(BoundSymbolKind::CasePattern) => true,
                    Some(BoundSymbolKind::AnonymousFunctionParameter) => true,
                    None => {
                        // If kind is unknown, include by default (legacy behavior)
                        // but only if it's lowercase (functions are lowercase)
                        symbol.name.chars().next().map(|c| c.is_lowercase()).unwrap_or(false)
                    }
                    _ => false,
                }
            })
            .collect()
    }

    /// Find references to a type (custom type or type alias) using the DefinitionSymbol
    /// Filters references by Type/TypeAlias kind to avoid matching constructors/functions
    pub fn find_type_references_typed(&self, symbol: &DefinitionSymbol) -> Vec<SymbolReference> {
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| {
                match r.kind {
                    Some(BoundSymbolKind::Type) => true,
                    Some(BoundSymbolKind::TypeAlias) => true,
                    Some(BoundSymbolKind::TypeVariable) => true,
                    None => {
                        // If kind is unknown, include by default for uppercase identifiers
                        symbol.name.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
                    }
                    _ => false,
                }
            })
            .collect()
    }

    /// Find references to a union constructor using the DefinitionSymbol
    /// Filters references by UnionConstructor kind to avoid matching type definitions
    pub fn find_constructor_references_typed(&self, symbol: &DefinitionSymbol) -> Vec<SymbolReference> {
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| {
                matches!(r.kind, Some(BoundSymbolKind::UnionConstructor) | None)
            })
            .collect()
    }

    /// Find references to a record field using the DefinitionSymbol
    /// This uses the existing type-aware field reference finder
    pub fn find_field_references_typed(&self, symbol: &DefinitionSymbol, content: &str) -> Vec<SymbolReference> {
        // Get the field definition from the type checker
        if let Some(tree) = self.type_checker.get_tree(symbol.uri.as_str()) {
            let point = tree_sitter::Point::new(symbol.range.start.line as usize, symbol.range.start.character as usize);
            if let Some(node) = Self::find_node_at_point(tree.root_node(), point) {
                if let Some(field_def) = self.type_checker.find_field_definition(symbol.uri.as_str(), node, content) {
                    return self.find_field_references(&symbol.name, &field_def);
                }
            }
        }

        // Fallback: use basic filtering by kind and type_context
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| {
                match r.kind {
                    Some(BoundSymbolKind::FieldType) => {
                        // For fields, also check type_context matches
                        match (&r.type_context, &symbol.type_context) {
                            (Some(ref_ctx), Some(sym_ctx)) => ref_ctx == sym_ctx,
                            (None, None) => true,
                            _ => true, // Be permissive if context is unknown
                        }
                    }
                    None => true, // Include unknown references
                    _ => false,
                }
            })
            .collect()
    }

    /// Find references to a port using the DefinitionSymbol
    pub fn find_port_references_typed(&self, symbol: &DefinitionSymbol) -> Vec<SymbolReference> {
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| {
                matches!(r.kind, Some(BoundSymbolKind::Port) | None)
            })
            .collect()
    }

    /// Find type-aware references at a position
    /// This is the main entry point for type-aware reference finding
    /// It classifies the symbol at the position and dispatches to the appropriate finder
    pub fn find_references_at_position_typed(
        &self,
        uri: &Url,
        position: Position,
        content: &str,
    ) -> Option<Vec<SymbolReference>> {
        let symbol = self.classify_definition_at_position(uri, position)?;

        let refs = match symbol.kind {
            BoundSymbolKind::Function => self.find_function_references_typed(&symbol),
            BoundSymbolKind::FunctionParameter
            | BoundSymbolKind::CasePattern
            | BoundSymbolKind::AnonymousFunctionParameter => {
                // For local bindings, use existing find_references (scoped search would be future work)
                self.find_references(&symbol.name, symbol.module_name.as_deref())
            }
            BoundSymbolKind::Type | BoundSymbolKind::TypeAlias => {
                self.find_type_references_typed(&symbol)
            }
            BoundSymbolKind::TypeVariable => {
                // Type variables are local to a type annotation; basic search for now
                self.find_references(&symbol.name, symbol.module_name.as_deref())
            }
            BoundSymbolKind::UnionConstructor => self.find_constructor_references_typed(&symbol),
            BoundSymbolKind::FieldType | BoundSymbolKind::RecordPatternField => {
                self.find_field_references_typed(&symbol, content)
            }
            BoundSymbolKind::Port => self.find_port_references_typed(&symbol),
            BoundSymbolKind::Operator | BoundSymbolKind::Import => {
                // Use basic find_references for operators and imports
                self.find_references(&symbol.name, symbol.module_name.as_deref())
            }
        };

        Some(refs)
    }

    /// Find module-aware references to a symbol
    /// Only returns references from files that actually import the symbol from the defining module
    pub fn find_module_aware_references(
        &self,
        symbol_name: &str,
        defining_module: &str,
        defining_uri: &Url,
    ) -> Vec<SymbolReference> {
        let mut results = Vec::new();

        // Extract just the symbol name if qualified
        let base_name = if symbol_name.contains('.') {
            symbol_name.rsplit('.').next().unwrap_or(symbol_name)
        } else {
            symbol_name
        };

        tracing::debug!(
            "find_module_aware_references: symbol={}, defining_module={}, defining_uri={}",
            base_name, defining_module, defining_uri.as_str()
        );

        // 1. Get refs stored under the qualified key "DefiningModule.symbol"
        let qualified_key = format!("{}.{}", defining_module, base_name);
        if let Some(refs) = self.references.get(&qualified_key) {
            for r in refs {
                tracing::debug!(
                    "  Including qualified ref (key={}): {} {:?}",
                    qualified_key, r.uri.as_str(), r.range
                );
                results.push(r.clone());
            }
        }

        // 2. Get refs stored under the unqualified key "symbol"
        //    Filter: only include if from defining file OR file imports symbol from defining module
        if let Some(refs) = self.references.get(base_name) {
            for r in refs {
                // Always include refs from the defining file
                if &r.uri == defining_uri {
                    tracing::debug!(
                        "  Including unqualified ref from definition file: {:?}",
                        r.range
                    );
                    results.push(r.clone());
                    continue;
                }

                // For other files, check if they expose the symbol from the defining module
                let file_module = self.get_module_at_uri(&r.uri);
                if let Some(module) = file_module {
                    // Skip if this file defines the same-named symbol (different module)
                    if module.module_name != defining_module {
                        // This ref might be from a local definition or different import
                        // Only include if the file imports this symbol from the defining module
                        let symbol_is_exposed = module.imports.iter().any(|imp| {
                            if imp.module_name != defining_module && imp.alias.as_deref() != Some(defining_module) {
                                return false;
                            }
                            match &imp.exposing {
                                ExposingInfo::All => true,
                                ExposingInfo::Explicit(names) => {
                                    names.iter().any(|n| {
                                        n == base_name ||
                                        n.starts_with(&format!("{}(", base_name)) ||
                                        n == &format!("{}(..)", base_name)
                                    })
                                }
                            }
                        });

                        if symbol_is_exposed {
                            tracing::debug!(
                                "  Including exposed unqualified ref from {}: {:?}",
                                r.uri.as_str(), r.range
                            );
                            results.push(r.clone());
                        } else {
                            tracing::debug!(
                                "  Excluding unqualified ref from {} (not exposed from {}): {:?}",
                                r.uri.as_str(), defining_module, r.range
                            );
                        }
                    }
                }
            }
        }

        // Deduplicate
        results.sort_by(|a, b| {
            (&a.uri, a.range.start.line, a.range.start.character)
                .cmp(&(&b.uri, b.range.start.line, b.range.start.character))
        });
        results.dedup_by(|a, b| a.uri == b.uri && a.range == b.range);

        results
    }

    /// Get module info for a URI
    fn get_module_at_uri(&self, uri: &Url) -> Option<&ElmModule> {
        self.modules.values().find(|m| {
            Url::from_file_path(&m.path).ok().as_ref() == Some(uri)
        })
    }

    /// Find definition of a symbol
    pub fn find_definition(&self, symbol_name: &str) -> Option<&GlobalSymbol> {
        // Try exact match first
        if let Some(symbols) = self.symbols.get(symbol_name) {
            if let Some(sym) = symbols.first() {
                return Some(sym);
            }
        }

        // Extract base name if qualified
        let base_name = if symbol_name.contains('.') {
            symbol_name.rsplit('.').next().unwrap_or(symbol_name)
        } else {
            symbol_name
        };

        // Try base name
        if let Some(symbols) = self.symbols.get(base_name) {
            if let Some(sym) = symbols.first() {
                return Some(sym);
            }
        }

        None
    }

    /// Get all symbols matching a name (searches both qualified and unqualified)
    pub fn get_symbols(&self, name: &str) -> Vec<&GlobalSymbol> {
        let mut results = Vec::new();

        // Direct lookup
        if let Some(symbols) = self.symbols.get(name) {
            results.extend(symbols.iter());
        }

        // If not qualified, also search qualified names
        if !name.contains('.') {
            for (key, symbols) in &self.symbols {
                if key.ends_with(&format!(".{}", name)) {
                    results.extend(symbols.iter());
                }
            }
        }

        results
    }

    /// Get module by name
    pub fn get_module(&self, name: &str) -> Option<&ElmModule> {
        self.modules.get(name)
    }

    /// Get all module names
    pub fn get_module_names(&self) -> Vec<&String> {
        self.modules.keys().collect()
    }

    /// Check if moving a function from source to target would create an import cycle.
    /// After a move, source will import target (so existing usages of the moved function work).
    /// If target already imports source (directly or indirectly), adding source→target creates a cycle.
    fn would_create_import_cycle(&self, source_module_name: &str, target_module_name: &str) -> bool {
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

        let source_path = source_uri.to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid source URI"))?;

        // Find source module
        let source_module = self.modules.values()
            .find(|m| m.path == source_path)
            .ok_or_else(|| anyhow::anyhow!("Source module not found"))?;

        let source_module_name = source_module.module_name.clone();

        // Find target module
        let target_module = self.modules.values()
            .find(|m| m.path == *target_path)
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
        let function = source_module.symbols.iter()
            .find(|s| s.name == function_name && s.kind == SymbolKind::FUNCTION)
            .ok_or_else(|| anyhow::anyhow!("Function not found in source module"))?;

        // Read source file content
        let source_content = std::fs::read_to_string(&source_path)?;
        let source_lines: Vec<&str> = source_content.lines().collect();

        // Extract function definition (type signature + body)
        let (func_start_line, func_end_line) = self.find_function_bounds(
            &source_content,
            function_name,
            function.range.start.line as usize,
        );

        // Get the function text (including type signature if present)
        let function_text: String = source_lines[func_start_line..=func_end_line]
            .join("\n");

        // Read target file content
        let target_content = std::fs::read_to_string(target_path)?;

        // Find insertion point in target (after imports, before first definition)
        let target_insert_line = self.find_insertion_point(&target_content);

        // Create target URI
        let target_uri = Url::from_file_path(target_path)
            .map_err(|_| anyhow::anyhow!("Invalid target path"))?;

        // Find all references to this function
        let refs = self.find_references(function_name, Some(&source_module_name));

        // Build the result
        let mut source_edits = Vec::new();
        let mut target_edits = Vec::new();
        let mut reference_edits: HashMap<Url, Vec<TextEdit>> = HashMap::new();

        // 1. Remove function from source file
        source_edits.push(TextEdit {
            range: Range {
                start: Position { line: func_start_line as u32, character: 0 },
                end: Position { line: (func_end_line + 1) as u32, character: 0 },
            },
            new_text: String::new(),
        });

        // 2. Add import for the moved function in source file (so existing local usages still work)
        let import_text = format!("import {} exposing ({})\n", target_module_name, function_name);
        let source_import_line = self.find_import_insertion_point(&source_content);
        source_edits.push(TextEdit {
            range: Range {
                start: Position { line: source_import_line as u32, character: 0 },
                end: Position { line: source_import_line as u32, character: 0 },
            },
            new_text: import_text,
        });

        // 2b. Remove function from source file's exposing list
        if let Some(unexpose_edit) = self.create_unexpose_edit(&source_content, function_name) {
            source_edits.push(unexpose_edit);
        }

        // 3. Add function to target file
        let target_text = format!("\n\n{}\n", function_text);
        target_edits.push(TextEdit {
            range: Range {
                start: Position { line: target_insert_line as u32, character: 0 },
                end: Position { line: target_insert_line as u32, character: 0 },
            },
            new_text: target_text,
        });

        // 4. Update target module's exposing list to include the new function
        if let Some(exposing_edit) = self.create_expose_edit(&target_content, function_name) {
            target_edits.push(exposing_edit);
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

            let ref_module = self.modules.values()
                .find(|m| m.path == ref_path);

            if let Some(rm) = ref_module {
                let has_target_import = rm.imports.iter()
                    .any(|i| i.module_name == target_module_name);

                if has_target_import {
                    // Already imports target, just update the reference
                    reference_edits
                        .entry(r.uri.clone())
                        .or_insert_with(Vec::new)
                        .push(TextEdit {
                            range: r.range,
                            new_text: function_name.to_string(),
                        });
                } else {
                    // Need to add import and potentially qualify the reference
                    let ref_content = std::fs::read_to_string(&ref_path)?;
                    let import_line = self.find_import_insertion_point(&ref_content);

                    reference_edits
                        .entry(r.uri.clone())
                        .or_insert_with(Vec::new)
                        .push(TextEdit {
                            range: Range {
                                start: Position { line: import_line as u32, character: 0 },
                                end: Position { line: import_line as u32, character: 0 },
                            },
                            new_text: format!("import {} exposing ({})\n", target_module_name, function_name),
                        });
                }
            }
        }

        // Combine all edits
        let mut all_changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();
        all_changes.insert(source_uri.clone(), source_edits);
        all_changes.insert(target_uri.clone(), target_edits);
        for (uri, edits) in reference_edits {
            all_changes.entry(uri).or_insert_with(Vec::new).extend(edits);
        }

        Ok(MoveResult {
            changes: all_changes,
            source_module: source_module_name,
            target_module: target_module_name,
            function_name: function_name.to_string(),
            references_updated: refs.len(),
        })
    }

    /// Find the start and end lines of a function definition
    fn find_function_bounds(&self, content: &str, name: &str, approx_line: usize) -> (usize, usize) {
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
                    for j in (i + 1)..lines.len() {
                        let next_line = lines[j].trim();
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
                    if trimmed.chars().next().map(|c| c.is_lowercase()).unwrap_or(false)
                        || trimmed.starts_with("type ")
                        || trimmed.starts_with("port ")
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

    /// Find where to insert a new function in a file (after imports)
    fn find_insertion_point(&self, content: &str) -> usize {
        let lines: Vec<&str> = content.lines().collect();
        let mut last_import_line = 0;

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();
            if trimmed.starts_with("import ") {
                last_import_line = i;
            } else if trimmed.starts_with("type ") || trimmed.starts_with("port ")
                || (trimmed.chars().next().map(|c| c.is_lowercase()).unwrap_or(false) && trimmed.contains('='))
            {
                // Found first definition after imports
                return i;
            }
        }

        // Return line after last import
        last_import_line + 2
    }

    /// Find where to insert a new import
    fn find_import_insertion_point(&self, content: &str) -> usize {
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
    fn create_unexpose_edit(&self, content: &str, function_name: &str) -> Option<TextEdit> {
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
        let old_exposing = &exposing_text[old_exposing_start..=list_end];

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
                    character: lines[exposing_end_line].find(')').map(|p| p + 1).unwrap_or(0) as u32,
                },
            },
            new_text: new_list,
        })
    }

    /// Create an edit to add a function to the module's exposing list
    fn create_expose_edit(&self, content: &str, function_name: &str) -> Option<TextEdit> {
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

    /// Convert a file path to its module name
    pub fn path_to_module_name_public(&self, path: &Path) -> String {
        self.path_to_module_name(path)
    }

    /// Remove a variant from a custom type
    pub fn remove_variant(
        &self,
        uri: &Url,
        type_name: &str,
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
                    for j in (i + 1)..lines.len() {
                        let next_trimmed = lines[j].trim();
                        if next_trimmed.starts_with('|') {
                            next_variant_line = Some(j);
                            break;
                        } else if !next_trimmed.is_empty() && !next_trimmed.starts_with('|') {
                            // Hit something else (not a variant continuation)
                            break;
                        }
                    }
                    break;
                } else if parts.len() >= 1 && parts[0] == variant_name {
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
            if let Some(ref range) = usage.constructor_usage_range {
                let usage_uri = Url::parse(&usage.uri)
                    .map_err(|_| anyhow::anyhow!("Invalid usage URI"))?;

                let replacement = format!("(Debug.todo \"FIXME: Variant Removal: {}\")", variant_name);

                changes
                    .entry(usage_uri)
                    .or_insert_with(Vec::new)
                    .push(TextEdit {
                        range: range.clone(),
                        new_text: replacement,
                    });
            }
        }

        // 5. Add edits to remove all pattern match branches
        // Also collect removed pattern lines for useless wildcard detection
        let mut removed_pattern_lines: Vec<u32> = Vec::new();

        for usage in &pattern_usages {
            if let Some(ref range) = usage.pattern_branch_range {
                let usage_uri = Url::parse(&usage.uri)
                    .map_err(|_| anyhow::anyhow!("Invalid usage URI"))?;

                removed_pattern_lines.push(range.start.line);

                changes
                    .entry(usage_uri)
                    .or_insert_with(Vec::new)
                    .push(TextEdit {
                        range: range.clone(),
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
                .or_insert_with(Vec::new)
                .push(TextEdit {
                    range: wc_range,
                    new_text: String::new(),
                });
        }

        // 6. Sort edits in reverse order within each file to avoid offset issues
        for edits in changes.values_mut() {
            edits.sort_by(|a, b| {
                b.range.start.line.cmp(&a.range.start.line)
                    .then_with(|| b.range.start.character.cmp(&a.range.start.character))
            });
        }

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

    /// Get the module name from a URI
    pub fn get_module_name_from_uri(&self, uri: &Url) -> String {
        let path = match uri.to_file_path() {
            Ok(p) => p,
            Err(_) => return String::new(),
        };

        for (module_name, module) in &self.modules {
            if module.path == path {
                return module_name.clone();
            }
        }

        // Fallback: extract from path
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string()
    }

    /// Build call chain from a function up to entry points
    fn build_call_chain(
        &self,
        function_name: &str,
        module_name: &str,
        uri: &Url,
        line: u32,
        visited: &mut std::collections::HashSet<String>,
        depth: usize,
    ) -> Vec<CallChainEntry> {
        const MAX_DEPTH: usize = 10;

        if depth >= MAX_DEPTH {
            return Vec::new();
        }

        let key = format!("{}:{}", module_name, function_name);
        if visited.contains(&key) {
            return Vec::new(); // Avoid cycles
        }
        visited.insert(key);

        let file_name = uri
            .to_file_path()
            .ok()
            .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_default();

        let is_entry_point = ENTRY_POINTS.contains(&function_name);

        let mut chain = vec![CallChainEntry {
            function: function_name.to_string(),
            file: file_name,
            module_name: module_name.to_string(),
            line,
            is_entry_point,
        }];

        // If this is an entry point, stop here
        if is_entry_point {
            return chain;
        }

        // Find who calls this function
        let refs = self.find_references(function_name, None);

        for r in refs {
            // Skip the definition and same-file self-references
            if r.is_definition {
                continue;
            }

            // Skip Evergreen files
            if r.uri.path().contains("/Evergreen/") {
                continue;
            }

            // Find the enclosing function of this reference
            if let Some((caller_fn, caller_module)) =
                self.find_enclosing_function(&r.uri, r.range.start)
            {
                // Don't recurse into the same function
                if caller_fn == function_name && caller_module == module_name {
                    continue;
                }

                // Recurse to find the caller's callers
                let caller_chain = self.build_call_chain(
                    &caller_fn,
                    &caller_module,
                    &r.uri,
                    r.range.start.line,
                    visited,
                    depth + 1,
                );

                if !caller_chain.is_empty() {
                    chain.extend(caller_chain);
                    // Take the first valid chain we find (could be extended to find all paths)
                    break;
                }
            }
        }

        chain
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
        let mut refs_by_file: HashMap<String, Vec<&SymbolReference>> = HashMap::new();
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
            let file_imports = self.modules.values()
                .find(|m| m.path == uri.to_file_path().unwrap_or_default())
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

                // Use pre-parsed tree for classification
                let usage_type = self.classify_usage_with_tree(&tree, &content, position);

                // Skip type signatures, definitions, and string literals
                if matches!(usage_type, UsageType::TypeSignature | UsageType::Definition | UsageType::StringLiteral) {
                    continue;
                }

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
                    imports_from_source
                };

                if !is_from_source_module {
                    continue;
                }

                // Get pattern branch range using pre-parsed tree
                let pattern_branch_range = if usage_type == UsageType::PatternMatch {
                    self.get_pattern_branch_range_with_tree(&tree, &content, position)
                } else {
                    None
                };

                // Get constructor usage range for Debug.todo replacement
                let constructor_usage_range = if usage_type == UsageType::Constructor {
                    self.get_constructor_usage_range_with_tree(&tree, &content, position)
                } else {
                    None
                };

                let is_blocking = usage_type == UsageType::Constructor;

                // Get context from cached content
                let context = content
                    .lines()
                    .nth(r.range.start.line as usize)
                    .map(|l| l.trim().to_string())
                    .unwrap_or_default();

                // Find enclosing function using cached module symbols (more reliable)
                let function_name = self
                    .find_enclosing_function(&uri, r.range.start)
                    .map(|(fn_name, _)| fn_name)
                    .unwrap_or_default();

                usages.push(VariantUsage {
                    uri: r.uri.to_string(),
                    line: r.range.start.line,
                    character: r.range.start.character,
                    is_blocking,
                    context,
                    function_name: if function_name.is_empty() {
                        None
                    } else {
                        Some(function_name)
                    },
                    module_name: ref_module_name.clone(),
                    call_chain: Vec::new(),
                    usage_type,
                    pattern_branch_range,
                    constructor_usage_range,
                });
            }
        }

        usages
    }

    /// Get all usages of a field for a specific type
    pub fn get_field_usages(
        &self,
        field_name: &str,
        definition: &crate::type_checker::FieldDefinition,
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
            let (usage_type, full_range) = self.classify_field_usage(&content, r.range.start, field_name);

            // Get context line
            let context = content
                .lines()
                .nth(r.range.start.line as usize)
                .map(|l| l.trim().to_string())
                .unwrap_or_default();

            // Get module name
            let module_name = self.modules.values()
                .find(|m| m.path == path)
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
            });
        }

        usages
    }

    /// Classify a field usage and determine its full range for removal
    fn classify_field_usage(&self, content: &str, position: Position, field_name: &str) -> (FieldUsageType, Option<Range>) {
        let tree = match self.parser.parse(content) {
            Some(t) => t,
            None => return (FieldUsageType::FieldAccess, None),
        };

        let point = tree_sitter::Point {
            row: position.line as usize,
            column: position.character as usize,
        };

        let node = match tree.root_node().descendant_for_point_range(point, point) {
            Some(n) => n,
            None => return (FieldUsageType::FieldAccess, None),
        };

        // Walk up to find the context
        let mut current = Some(node);
        while let Some(n) = current {
            match n.kind() {
                "field_type" => {
                    // Field in type definition: { name : String }
                    let range = self.get_field_definition_range(&n, content);
                    return (FieldUsageType::Definition, Some(range));
                }
                "field" => {
                    // Could be record literal or record update
                    if let Some(parent) = n.parent() {
                        if parent.kind() == "record_expr" {
                            // Check if it's a record update
                            if self.is_record_update(&parent, content) {
                                let range = self.get_field_assignment_range(&n, content, field_name);
                                return (FieldUsageType::RecordUpdate, Some(range));
                            } else {
                                let range = self.get_field_assignment_range(&n, content, field_name);
                                return (FieldUsageType::RecordLiteral, Some(range));
                            }
                        }
                    }
                }
                "record_pattern" => {
                    // Field in record pattern: { name }
                    let range = self.get_pattern_field_range(&n, content, field_name);
                    return (FieldUsageType::RecordPattern, Some(range));
                }
                "field_access_expr" => {
                    // Field access: user.name
                    let range = Range {
                        start: Position::new(n.start_position().row as u32, n.start_position().column as u32),
                        end: Position::new(n.end_position().row as u32, n.end_position().column as u32),
                    };
                    return (FieldUsageType::FieldAccess, Some(range));
                }
                "field_accessor_function_expr" => {
                    // Field accessor: .name
                    let range = Range {
                        start: Position::new(n.start_position().row as u32, n.start_position().column as u32),
                        end: Position::new(n.end_position().row as u32, n.end_position().column as u32),
                    };
                    return (FieldUsageType::FieldAccessor, Some(range));
                }
                _ => {}
            }
            current = n.parent();
        }

        // Default to field access if we can't determine
        (FieldUsageType::FieldAccess, None)
    }

    /// Check if a record_expr is a record update (has a | in it)
    fn is_record_update(&self, node: &tree_sitter::Node, content: &str) -> bool {
        let text = &content[node.byte_range()];
        text.contains('|')
    }

    /// Get the range for a field in a type definition, including comma if necessary
    fn get_field_definition_range(&self, field_node: &tree_sitter::Node, content: &str) -> Range {
        let lines: Vec<&str> = content.lines().collect();
        let start_line = field_node.start_position().row;
        let end_line = field_node.end_position().row;

        // Check if there's a comma after this field on the same line
        if let Some(line) = lines.get(end_line) {
            let after_field = &line[field_node.end_position().column..];
            if let Some(comma_pos) = after_field.find(',') {
                // Include the comma
                return Range {
                    start: Position::new(start_line as u32, 0),
                    end: Position::new(end_line as u32, (field_node.end_position().column + comma_pos + 1) as u32),
                };
            }
        }

        // Check if there's a comma before this field (previous line ends with comma)
        if start_line > 0 {
            if let Some(prev_line) = lines.get(start_line - 1) {
                if prev_line.trim().ends_with(',') {
                    // Remove the entire line including the previous comma
                    let prev_comma_col = prev_line.rfind(',').unwrap();
                    return Range {
                        start: Position::new((start_line - 1) as u32, prev_comma_col as u32),
                        end: Position::new((end_line + 1) as u32, 0),
                    };
                }
            }
        }

        // Just remove the line
        Range {
            start: Position::new(start_line as u32, 0),
            end: Position::new((end_line + 1) as u32, 0),
        }
    }

    /// Get the range for a field assignment (in record literal or update)
    fn get_field_assignment_range(&self, field_node: &tree_sitter::Node, content: &str, _field_name: &str) -> Range {
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

    /// Get the range for a field in a record pattern
    fn get_pattern_field_range(&self, record_pattern_node: &tree_sitter::Node, content: &str, field_name: &str) -> Range {
        // Find the field within the record pattern
        let pattern_text = &content[record_pattern_node.byte_range()];

        // Parse the fields in the pattern
        let inner = pattern_text.trim_start_matches('{').trim_end_matches('}').trim();
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
        if let Some(idx) = field_index {
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
                            let extra = after[comma_pos + 1..].len() - after[comma_pos + 1..].trim_start().len();
                            return Range {
                                start: Position::new(start.row as u32, start.column as u32),
                                end: Position::new(end.row as u32, (end.column + comma_pos + 1 + extra) as u32),
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
        let (type_alias_name, field_name, all_fields) = self.find_field_at_position(node, &content)?;

        // Get field definition
        let definition = self.type_checker.find_field_definition(
            uri.as_str(),
            node,
            &content,
        )?;

        // Get all usages
        let usages = self.get_field_usages(&field_name, &definition);

        Some((type_alias_name, field_name, all_fields, usages))
    }

    /// Find the type alias name, field name, and all fields at a position
    fn find_field_at_position(&self, node: tree_sitter::Node, content: &str) -> Option<(String, String, Vec<String>)> {
        // Walk up to find field_type and type_alias_declaration
        let mut current = Some(node);
        let mut field_name = None;

        while let Some(n) = current {
            if n.kind() == "lower_case_identifier" && field_name.is_none() {
                field_name = Some(content[n.byte_range()].to_string());
            }

            if n.kind() == "type_alias_declaration" {
                // Found the type alias
                let type_name = n.child_by_field_name("name")
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
    fn collect_fields_in_type(cursor: &mut tree_sitter::TreeCursor, content: &str, fields: &mut Vec<String>) {
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
            return Ok(RemoveFieldResult::error("Cannot remove the only field from a type alias"));
        }

        // 2. Get field definition - use type_checker for proper module/uri info
        let path = uri.to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid URI"))?;
        let content = std::fs::read_to_string(&path)?;

        let tree = self.parser.parse(&content)
            .ok_or_else(|| anyhow::anyhow!("Failed to parse file"))?;

        // Find the field node in the type definition
        let field_node = self.find_field_node_in_type(&tree, &content, type_name, field_name)
            .ok_or_else(|| anyhow::anyhow!("Field not found in type definition"))?;

        // Use type_checker to get proper definition with module/uri info
        let definition = self.type_checker.find_field_definition(uri.as_str(), field_node, &content)
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
            let usage_uri = Url::parse(&usage.uri)
                .map_err(|_| anyhow::anyhow!("Invalid usage URI"))?;

            if let Some(ref range) = usage.full_range {
                let edit = match usage.usage_type {
                    FieldUsageType::Definition => {
                        // Just remove the field line
                        TextEdit {
                            range: range.clone(),
                            new_text: String::new(),
                        }
                    }
                    FieldUsageType::FieldAccess => {
                        // Replace with Debug.todo
                        replaced_accesses += 1;
                        TextEdit {
                            range: range.clone(),
                            new_text: format!("(Debug.todo \"FIXME: Field Removal: {}\")", field_name),
                        }
                    }
                    FieldUsageType::FieldAccessor => {
                        // Replace with lambda that returns Debug.todo
                        replaced_accessors += 1;
                        TextEdit {
                            range: range.clone(),
                            new_text: format!("(\\_ -> Debug.todo \"FIXME: Field Removal: {}\")", field_name),
                        }
                    }
                    FieldUsageType::RecordPattern => {
                        removed_patterns += 1;
                        // Check if this is the only field (range covers entire pattern)
                        let usage_path = Url::parse(&usage.uri).ok()
                            .and_then(|u| u.to_file_path().ok());
                        let usage_content = usage_path.as_ref()
                            .and_then(|p| std::fs::read_to_string(p).ok());

                        if let Some(ref c) = usage_content {
                            let line = c.lines().nth(range.start.line as usize).unwrap_or("");
                            let pattern_text = &line[range.start.character as usize..range.end.character as usize];
                            if pattern_text.starts_with('{') && pattern_text.ends_with('}') {
                                // Single field pattern - replace with _
                                TextEdit {
                                    range: range.clone(),
                                    new_text: "_".to_string(),
                                }
                            } else {
                                // Multi-field pattern - just remove this field
                                TextEdit {
                                    range: range.clone(),
                                    new_text: String::new(),
                                }
                            }
                        } else {
                            TextEdit {
                                range: range.clone(),
                                new_text: String::new(),
                            }
                        }
                    }
                    FieldUsageType::RecordLiteral => {
                        removed_literals += 1;
                        TextEdit {
                            range: range.clone(),
                            new_text: String::new(),
                        }
                    }
                    FieldUsageType::RecordUpdate => {
                        removed_updates += 1;
                        TextEdit {
                            range: range.clone(),
                            new_text: String::new(),
                        }
                    }
                };

                changes
                    .entry(usage_uri)
                    .or_insert_with(Vec::new)
                    .push(edit);
            }
        }

        // 5. Sort edits in reverse order within each file to avoid offset issues
        for edits in changes.values_mut() {
            edits.sort_by(|a, b| {
                b.range.start.line.cmp(&a.range.start.line)
                    .then_with(|| b.range.start.character.cmp(&a.range.start.character))
            });
        }

        // 6. Build message
        let message = {
            let mut parts = vec![format!("Removed field '{}' from '{}'", field_name, type_name)];

            if replaced_accesses > 0 {
                parts.push(format!("replaced {} field access(es) with Debug.todo", replaced_accesses));
            }
            if replaced_accessors > 0 {
                parts.push(format!("replaced {} field accessor(s) with Debug.todo", replaced_accessors));
            }
            if removed_patterns > 0 {
                parts.push(format!("removed from {} record pattern(s)", removed_patterns));
            }
            if removed_literals > 0 {
                parts.push(format!("removed from {} record literal(s)", removed_literals));
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
            if let Some(found) = self.find_field_node_recursive(child, content, type_name, field_name) {
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

    /// Find a field definition in a type alias by type name and field name
    fn find_field_definition_in_type(
        &self,
        tree: &tree_sitter::Tree,
        content: &str,
        type_name: &str,
        field_name: &str,
    ) -> Option<crate::type_checker::FieldDefinition> {
        let mut cursor = tree.walk();
        self.find_field_definition_recursive(&mut cursor, content, type_name, field_name)
    }

    fn find_field_definition_recursive(
        &self,
        cursor: &mut tree_sitter::TreeCursor,
        content: &str,
        type_name: &str,
        field_name: &str,
    ) -> Option<crate::type_checker::FieldDefinition> {
        loop {
            let node = cursor.node();

            if node.kind() == "type_alias_declaration" {
                // Check if this is the right type
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = &content[name_node.byte_range()];
                    if name == type_name {
                        // Find the field in this type
                        let mut field_cursor = node.walk();
                        return self.find_field_in_type(&mut field_cursor, content, field_name);
                    }
                }
            }

            if cursor.goto_first_child() {
                if let Some(def) = self.find_field_definition_recursive(cursor, content, type_name, field_name) {
                    return Some(def);
                }
                cursor.goto_parent();
            }

            if !cursor.goto_next_sibling() {
                break;
            }
        }

        None
    }

    fn find_field_in_type(
        &self,
        cursor: &mut tree_sitter::TreeCursor,
        content: &str,
        field_name: &str,
    ) -> Option<crate::type_checker::FieldDefinition> {
        loop {
            let node = cursor.node();

            if node.kind() == "field_type" {
                // Check if this is the right field
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        if child.kind() == "lower_case_identifier" {
                            let name = &content[child.byte_range()];
                            if name == field_name {
                                // Found it!
                                // We need to get the module name from the parent type_alias_declaration
                                let mut parent = Some(node);
                                let mut type_alias_name = None;
                                while let Some(p) = parent {
                                    if p.kind() == "type_alias_declaration" {
                                        if let Some(name_node) = p.child_by_field_name("name") {
                                            type_alias_name = Some(content[name_node.byte_range()].to_string());
                                        }
                                        break;
                                    }
                                    parent = p.parent();
                                }

                                return Some(crate::type_checker::FieldDefinition {
                                    name: field_name.to_string(),
                                    node_id: child.id(),
                                    type_alias_name: type_alias_name.clone(),
                                    type_alias_node_id: None,
                                    module_name: String::new(),
                                    uri: String::new(),
                                });
                            }
                        }
                    }
                }
            }

            if cursor.goto_first_child() {
                if let Some(def) = self.find_field_in_type(cursor, content, field_name) {
                    return Some(def);
                }
                cursor.goto_parent();
            }

            if !cursor.goto_next_sibling() {
                break;
            }
        }

        None
    }

    /// Get context around a usage for display
    fn get_usage_context(&self, uri: &Url, line: u32) -> String {
        let path = match uri.to_file_path() {
            Ok(p) => p,
            Err(_) => return String::new(),
        };

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => return String::new(),
        };

        content
            .lines()
            .nth(line as usize)
            .map(|l| l.trim().to_string())
            .unwrap_or_default()
    }

    /// Classify a variant usage as Constructor, PatternMatch, or TypeSignature
    fn classify_usage(&self, content: &str, position: Position) -> UsageType {
        let tree = match self.parser.parse(content) {
            Some(t) => t,
            None => {
                tracing::warn!("classify_usage: failed to parse content");
                return UsageType::Constructor;
            }
        };

        let point = tree_sitter::Point {
            row: position.line as usize,
            column: position.character as usize,
        };

        let node = match tree.root_node().descendant_for_point_range(point, point) {
            Some(n) => n,
            None => {
                tracing::warn!("classify_usage: no node at position {:?}", position);
                return UsageType::Constructor;
            }
        };

        tracing::debug!(
            "classify_usage: position {:?}, node kind: {}, text: {:?}",
            position,
            node.kind(),
            &content[node.byte_range()]
        );

        // Walk up the tree to find context
        let mut current = Some(node);
        while let Some(n) = current {
            tracing::trace!("classify_usage: checking node kind: {}", n.kind());
            match n.kind() {
                // Pattern match contexts - union_pattern is a variant in case branches
                "case_of_branch" | "pattern" | "union_pattern" => {
                    tracing::debug!("classify_usage: found PatternMatch at {}", n.kind());
                    return UsageType::PatternMatch;
                }
                // Type annotation context
                "type_annotation" | "type_expression" => {
                    tracing::debug!("classify_usage: found TypeSignature at {}", n.kind());
                    return UsageType::TypeSignature;
                }
                // Value/expression contexts = constructor
                "function_call_expr" | "value_expr" | "let_in_expr" | "if_else_expr" | "tuple_expr" | "list_expr" | "record_expr" => {
                    tracing::debug!("classify_usage: found Constructor at {}", n.kind());
                    return UsageType::Constructor;
                }
                // Type definition = definition
                "type_declaration" | "union_variant" => {
                    // Check if this is the variant definition itself, not a usage
                    let parent = n.parent();
                    if parent.is_some_and(|p| p.kind() == "type_declaration") {
                        tracing::debug!("classify_usage: found Definition at {}", n.kind());
                        return UsageType::Definition;
                    }
                }
                _ => {}
            }
            current = n.parent();
        }

        tracing::warn!("classify_usage: defaulting to Constructor (no context found)");
        // Default to Constructor (blocking) if context is unclear
        UsageType::Constructor
    }

    /// Get the full range of a pattern branch for removal
    fn get_pattern_branch_range(&self, content: &str, position: Position) -> Option<Range> {
        let tree = self.parser.parse(content)?;

        let point = tree_sitter::Point {
            row: position.line as usize,
            column: position.character as usize,
        };

        let node = tree.root_node().descendant_for_point_range(point, point)?;

        // Walk up to find the case_of_branch
        let mut current = Some(node);
        while let Some(n) = current {
            if n.kind() == "case_of_branch" {
                // Found the branch - get its full range
                let start = n.start_position();
                let end = n.end_position();

                // Include the newline after if present
                let lines: Vec<&str> = content.lines().collect();
                let end_line = end.row;
                let end_char = if end_line + 1 < lines.len() {
                    0 // Start of next line
                } else {
                    lines.get(end_line).map(|l| l.len()).unwrap_or(0)
                };

                return Some(Range {
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
            current = n.parent();
        }

        None
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

    /// Find enclosing function using a pre-parsed tree (for performance)
    fn find_enclosing_function_with_tree(
        &self,
        tree: &tree_sitter::Tree,
        _content: &str,
        position: Position,
    ) -> Option<String> {
        let point = tree_sitter::Point {
            row: position.line as usize,
            column: position.character as usize,
        };

        let node = tree.root_node().descendant_for_point_range(point, point)?;

        let mut current = Some(node);
        while let Some(n) = current {
            if n.kind() == "value_declaration" || n.kind() == "function_declaration_left" {
                // Get the function name from the first child
                if let Some(name_node) = n.child_by_field_name("name") {
                    return Some(
                        _content[name_node.byte_range()]
                            .to_string(),
                    );
                }
                // Fallback: get first child that looks like an identifier
                for i in 0..n.child_count() {
                    if let Some(child) = n.child(i) {
                        if child.kind() == "lower_case_identifier" {
                            return Some(_content[child.byte_range()].to_string());
                        }
                    }
                }
            }
            current = n.parent();
        }

        None
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

    /// Read file content from a URI
    fn read_file_content(&self, uri: &Url) -> Option<String> {
        let path = uri.to_file_path().ok()?;
        std::fs::read_to_string(&path).ok()
    }

    /// Rename a file and update its module declaration + all imports
    pub fn rename_file(&self, uri: &Url, new_name: &str) -> anyhow::Result<FileOperationResult> {
        let old_path = uri.to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid file URI"))?;

        // Block renaming protected Lamdera files
        if self.is_lamdera_project {
            if let Some(file_name) = old_path.file_name().and_then(|n| n.to_str()) {
                if LAMDERA_PROTECTED_FILES.contains(&file_name) {
                    return Err(anyhow::anyhow!(
                        "Cannot rename {} in a Lamdera project - this file is required by Lamdera",
                        file_name
                    ));
                }
            }
        }

        // Validate new name
        if !new_name.ends_with(".elm") {
            return Err(anyhow::anyhow!("New name must end with .elm"));
        }

        // Get old module name from file content
        let content = std::fs::read_to_string(&old_path)?;
        let old_module_name = self.extract_module_name_from_content(&content)
            .ok_or_else(|| anyhow::anyhow!("Could not extract module name from file"))?;

        // Compute new module name (just the filename without .elm)
        let new_module_base = new_name.trim_end_matches(".elm");

        // The new module name keeps the same path prefix, just changes the final component
        let old_parts: Vec<&str> = old_module_name.split('.').collect();
        let new_module_name = if old_parts.len() > 1 {
            let prefix: Vec<&str> = old_parts[..old_parts.len()-1].to_vec();
            format!("{}.{}", prefix.join("."), new_module_base)
        } else {
            new_module_base.to_string()
        };

        // Compute new path
        let new_path = old_path.parent()
            .ok_or_else(|| anyhow::anyhow!("Invalid file path"))?
            .join(new_name);

        // Collect all edits
        let mut changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();

        // 1. Update module declaration in the file itself
        if let Some(module_range) = self.find_module_declaration_range(&content) {
            let new_module_decl = format!("module {} exposing", new_module_name);
            let old_module_decl_match = format!("module {} exposing", old_module_name);

            if content.contains(&old_module_decl_match) {
                changes.entry(uri.clone())
                    .or_insert_with(Vec::new)
                    .push(TextEdit {
                        range: module_range,
                        new_text: new_module_decl,
                    });
            }
        }

        // 2. Update all imports across the workspace
        let files_updated = self.update_imports_for_rename(
            &old_module_name,
            &new_module_name,
            uri,
            &mut changes,
        )?;

        Ok(FileOperationResult {
            old_module_name,
            new_module_name,
            old_path: old_path.to_string_lossy().to_string(),
            new_path: new_path.to_string_lossy().to_string(),
            files_updated,
            changes,
        })
    }

    /// Move a file to a new location and update its module declaration + all imports
    pub fn move_file(&self, uri: &Url, target_path: &str) -> anyhow::Result<FileOperationResult> {
        let old_path = uri.to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid file URI"))?;

        // Block moving protected Lamdera files
        if self.is_lamdera_project {
            if let Some(file_name) = old_path.file_name().and_then(|n| n.to_str()) {
                if LAMDERA_PROTECTED_FILES.contains(&file_name) {
                    return Err(anyhow::anyhow!(
                        "Cannot move {} in a Lamdera project - this file is required by Lamdera",
                        file_name
                    ));
                }
            }
        }

        // Validate target path
        if !target_path.ends_with(".elm") {
            return Err(anyhow::anyhow!("Target path must end with .elm"));
        }

        // Get old module name from file content
        let content = std::fs::read_to_string(&old_path)?;
        let old_module_name = self.extract_module_name_from_content(&content)
            .ok_or_else(|| anyhow::anyhow!("Could not extract module name from file"))?;

        // Compute new module name from target path
        let new_module_name = self.path_string_to_module_name(target_path);

        // Compute full new path (relative to workspace root or absolute)
        let new_path = if Path::new(target_path).is_absolute() {
            PathBuf::from(target_path)
        } else {
            self.root_path.join(target_path)
        };

        // Collect all edits
        let mut changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();

        // 1. Update module declaration in the file itself
        if let Some(module_range) = self.find_module_declaration_range(&content) {
            let new_module_decl = format!("module {} exposing", new_module_name);
            changes.entry(uri.clone())
                .or_insert_with(Vec::new)
                .push(TextEdit {
                    range: module_range,
                    new_text: new_module_decl,
                });
        }

        // 2. Update all imports across the workspace
        let files_updated = self.update_imports_for_rename(
            &old_module_name,
            &new_module_name,
            uri,
            &mut changes,
        )?;

        Ok(FileOperationResult {
            old_module_name,
            new_module_name,
            old_path: old_path.to_string_lossy().to_string(),
            new_path: new_path.to_string_lossy().to_string(),
            files_updated,
            changes,
        })
    }

    /// Extract module name from file content using simple string parsing
    fn extract_module_name_from_content(&self, content: &str) -> Option<String> {
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(after_module) = trimmed.strip_prefix("module ") {
                // Find "exposing" to extract the module name
                if let Some(exposing_pos) = after_module.find(" exposing") {
                    let module_name = after_module[..exposing_pos].trim();
                    // Validate it's a proper module name (starts with uppercase)
                    if module_name.chars().next().map_or(false, |c| c.is_ascii_uppercase()) {
                        return Some(module_name.to_string());
                    }
                }
            }
        }
        None
    }

    /// Find the range of the module declaration (just "module ModuleName exposing" part)
    fn find_module_declaration_range(&self, content: &str) -> Option<Range> {
        for (line_num, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            if let Some(after_module) = trimmed.strip_prefix("module ") {
                if let Some(exposing_pos) = after_module.find(" exposing") {
                    let module_name = after_module[..exposing_pos].trim();
                    // Validate it's a proper module name
                    if module_name.chars().next().map_or(false, |c| c.is_ascii_uppercase()) {
                        let line_start = line.find("module")?;
                        // Calculate end: "module " + module_name + " exposing"
                        let decl_len = "module ".len() + module_name.len() + " exposing".len();
                        return Some(Range {
                            start: Position {
                                line: line_num as u32,
                                character: line_start as u32,
                            },
                            end: Position {
                                line: line_num as u32,
                                character: (line_start + decl_len) as u32,
                            },
                        });
                    }
                }
            }
        }
        None
    }

    /// Convert a path string like "src/Utils/Helper.elm" to module name "Utils.Helper"
    fn path_string_to_module_name(&self, path_str: &str) -> String {
        let path = Path::new(path_str);

        tracing::debug!("path_string_to_module_name: path_str={}, root_path={}", path_str, self.root_path.display());

        // If absolute path, make it relative to workspace root
        let relative_path = if path.is_absolute() {
            // Try to strip workspace root
            if let Ok(rel) = path.strip_prefix(&self.root_path) {
                tracing::debug!("  Stripped prefix, relative={}", rel.display());
                rel.to_path_buf()
            } else {
                tracing::debug!("  Could not strip prefix");
                // Fallback: just use the path as-is
                path.to_path_buf()
            }
        } else {
            path.to_path_buf()
        };

        // Remove .elm extension
        let stem = relative_path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        // Get parent path components, skipping "src" if present
        let mut parts: Vec<&str> = Vec::new();
        if let Some(parent) = relative_path.parent() {
            for component in parent.components() {
                if let std::path::Component::Normal(s) = component {
                    let s_str = s.to_str().unwrap_or("");
                    // Skip common source directories
                    if s_str != "src" && s_str != "." && !s_str.is_empty() {
                        parts.push(s_str);
                    }
                }
            }
        }

        // Add the filename stem
        parts.push(stem);

        parts.join(".")
    }

    /// Update all imports of old_module to new_module across the workspace
    fn update_imports_for_rename(
        &self,
        old_module: &str,
        new_module: &str,
        skip_uri: &Url,
        changes: &mut HashMap<Url, Vec<TextEdit>>,
    ) -> anyhow::Result<usize> {
        let import_pattern = format!("import {}", old_module);
        let mut files_updated = 0;

        for module in self.modules.values() {
            let file_uri = Url::from_file_path(&module.path)
                .map_err(|_| anyhow::anyhow!("Invalid path"))?;

            // Skip Evergreen files
            if module.path.to_string_lossy().contains("/Evergreen/") {
                continue;
            }

            // Skip the file being renamed/moved (already handled)
            if &file_uri == skip_uri {
                continue;
            }

            let content = std::fs::read_to_string(&module.path)?;

            // Find all import statements for the old module
            for (line_num, line) in content.lines().enumerate() {
                let trimmed = line.trim();
                if trimmed.starts_with(&import_pattern) {
                    // Check it's not a prefix match (e.g., "import Foo" shouldn't match "import FooBar")
                    let after_import = &trimmed[import_pattern.len()..];
                    if after_import.is_empty()
                        || after_import.starts_with(' ')
                        || after_import.starts_with('\n')
                        || after_import.starts_with('\t')
                    {
                        let line_start = line.find("import").unwrap_or(0);
                        let old_end = line_start + "import ".len() + old_module.len();

                        changes.entry(file_uri.clone())
                            .or_insert_with(Vec::new)
                            .push(TextEdit {
                                range: Range {
                                    start: Position {
                                        line: line_num as u32,
                                        character: (line_start + "import ".len()) as u32,
                                    },
                                    end: Position {
                                        line: line_num as u32,
                                        character: old_end as u32,
                                    },
                                },
                                new_text: new_module.to_string(),
                            });

                        files_updated += 1;
                    }
                }

                // Also check for qualified references like "OldModule.function"
                // This handles cases where the module is used with qualification
                let qualified_pattern = format!("{}.", old_module);
                if trimmed.contains(&qualified_pattern) && !trimmed.starts_with("import ") && !trimmed.starts_with("module ") {
                    // Find all occurrences in the line
                    let mut search_start = 0;
                    while let Some(pos) = line[search_start..].find(&qualified_pattern) {
                        let actual_pos = search_start + pos;

                        // Make sure it's not part of a larger identifier
                        let before_ok = actual_pos == 0 || !line.chars().nth(actual_pos - 1).map_or(false, |c| c.is_alphanumeric() || c == '_' || c == '.');

                        if before_ok {
                            changes.entry(file_uri.clone())
                                .or_insert_with(Vec::new)
                                .push(TextEdit {
                                    range: Range {
                                        start: Position {
                                            line: line_num as u32,
                                            character: actual_pos as u32,
                                        },
                                        end: Position {
                                            line: line_num as u32,
                                            character: (actual_pos + old_module.len()) as u32,
                                        },
                                    },
                                    new_text: new_module.to_string(),
                                });
                        }

                        search_start = actual_pos + qualified_pattern.len();
                    }
                }
            }
        }

        Ok(files_updated)
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
            Some(n) => {
                n
            }
            None => {
                return None;
            }
        };

        // Check if this is a field reference
        let field_def = self.type_checker.find_field_definition(uri.as_str(), node, content);
        let field_def = field_def?;

        // Calculate the range for just the field name
        let range = Range {
            start: Position::new(node.start_position().row as u32, node.start_position().column as u32),
            end: Position::new(node.end_position().row as u32, node.end_position().column as u32),
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
        let target = definition.type_alias_name.as_ref().map(|name| TargetTypeAlias {
            name: name.clone(),
            module: definition.module_name.clone(),
        });

        // Include the definition itself - use cached tree for correct node IDs
        if let Some(tree) = self.type_checker.get_tree(&definition.uri) {
            if let Some(node) = Self::find_node_by_id(tree.root_node(), definition.node_id) {
                let range = Range {
                    start: Position::new(node.start_position().row as u32, node.start_position().column as u32),
                    end: Position::new(node.end_position().row as u32, node.end_position().column as u32),
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
        for module in self.modules.values() {
            // Skip Evergreen files
            if module.path.to_string_lossy().contains("/Evergreen/") {
                continue;
            }

            let file_uri = match Url::from_file_path(&module.path) {
                Ok(u) => u,
                Err(_) => continue,
            };

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
                            &content,
                            target,
                        )
                    } else {
                        self.type_checker.find_field_definition(
                            file_uri.as_str(),
                            node,
                            &content,
                        )
                    };

                    tracing::info!(
                        "find_field_references: checking {} in {}, ref_def={:?}",
                        field_name,
                        file_uri.path(),
                        ref_def.as_ref().map(|d| (&d.type_alias_name, &d.module_name))
                    );

                    if let Some(ref_def) = ref_def {
                        // Check if it resolves to the same type alias
                        if ref_def.type_alias_name == definition.type_alias_name
                            && ref_def.module_name == definition.module_name
                        {
                            tracing::info!("find_field_references: MATCH - adding reference");
                            // Determine the kind based on parent node
                            let is_record_pattern = node.parent().map(|p| p.kind()) == Some("record_pattern");
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
                                        &content,
                                        field_name,
                                        node.id(),
                                    );

                                    if !has_other_bindings {
                                        let var_usages = self.find_variable_usages_in_scope(
                                            scope_node,
                                            &content,
                                            field_name,
                                            node,  // Exclude the pattern field itself
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

        // Deduplicate
        references.sort_by(|a, b| {
            (&a.uri, a.range.start.line, a.range.start.character)
                .cmp(&(&b.uri, b.range.start.line, b.range.start.character))
        });
        references.dedup_by(|a, b| a.uri == b.uri && a.range == b.range);

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
        use std::io::Write;
        let node_kind = node.kind();
        let parent_kind = node.parent().map(|p| p.kind());

        // Debug: log all lower_case_identifier nodes with matching text
        if node_kind == "lower_case_identifier" || node_kind == "lower_pattern" {
            if let Ok(text) = node.utf8_text(source.as_bytes()) {
                if text == field_name {
                }
            }
        }

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
                    let first_child = parent.child(0);
                    let matches = first_child
                        .map(|n| n.id() == node.id() && n.kind() == "lower_case_identifier")
                        .unwrap_or(false);
                    matches
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
                        start: Position::new(node.start_position().row as u32, node.start_position().column as u32),
                        end: Position::new(node.end_position().row as u32, node.end_position().column as u32),
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

    /// Find a node at a specific point in the tree
    fn find_node_at_point(node: tree_sitter::Node, point: tree_sitter::Point) -> Option<tree_sitter::Node> {
        if !Self::point_in_range(point, node.start_position(), node.end_position()) {
            return None;
        }

        // Try to find a more specific child node
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = Self::find_node_at_point(child, point) {
                return Some(found);
            }
        }

        // If no child contains the point, return this node
        Some(node)
    }

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

    /// Find a node by its ID
    fn find_node_by_id(node: tree_sitter::Node, target_id: usize) -> Option<tree_sitter::Node> {
        if node.id() == target_id {
            return Some(node);
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = Self::find_node_by_id(child, target_id) {
                return Some(found);
            }
        }

        None
    }

    /// Find the enclosing function scope for a node (value_declaration or let_in_expr)
    fn find_enclosing_scope(node: tree_sitter::Node) -> Option<tree_sitter::Node> {
        let mut current = Some(node);
        while let Some(n) = current {
            match n.kind() {
                "value_declaration" | "let_in_expr" => return Some(n),
                _ => current = n.parent(),
            }
        }
        None
    }

    /// Find all variable usages within a scope that match the given name
    /// Returns a list of (range, node_id) for each usage
    fn find_variable_usages_in_scope(
        &self,
        scope_node: tree_sitter::Node,
        source: &str,
        var_name: &str,
        exclude_node: tree_sitter::Node,
    ) -> Vec<(Range, usize)> {
        let mut usages = Vec::new();
        self.walk_for_variable_usages(scope_node, source, var_name, exclude_node.id(), &mut usages);
        usages
    }

    /// Recursively walk the tree to find variable usages
    fn walk_for_variable_usages(
        &self,
        node: tree_sitter::Node,
        source: &str,
        var_name: &str,
        exclude_id: usize,
        usages: &mut Vec<(Range, usize)>,
    ) {
        // Skip the excluded node (the pattern field itself)
        if node.id() == exclude_id {
            return;
        }

        // Check if this is a value_expr that matches our variable name
        if node.kind() == "value_expr" || node.kind() == "lower_case_identifier" {
            if let Ok(text) = node.utf8_text(source.as_bytes()) {
                if text == var_name {
                    // Check that this is a variable usage, not a field name
                    // Field names would have parent of field_type, field_access_expr, field, etc.
                    let parent_kind = node.parent().map(|p| p.kind());
                    let is_field_context = matches!(
                        parent_kind,
                        Some("field_type")
                            | Some("field_access_expr")
                            | Some("field_accessor_function_expr")
                            | Some("record_pattern")
                    );
                    // Also check if this is the field name in a record field (not the value)
                    let is_field_name_in_field = if parent_kind == Some("field") {
                        // In a `field` node, the first child is the field name
                        node.parent()
                            .and_then(|p| p.child(0))
                            .map(|c| c.id() == node.id())
                            .unwrap_or(false)
                    } else {
                        false
                    };

                    // Also check if this is the function being called in a function_call_expr
                    // e.g., `emailInput userConfig ...` where emailInput is a top-level function
                    // In this case, the identifier is NOT a variable usage of the pattern-bound name
                    let is_function_call_target = if let Some(parent) = node.parent() {
                        if parent.kind() == "function_call_expr" {
                            // Check if this node is the first child (the function being called)
                            parent.child(0).map(|c| c.id() == node.id()).unwrap_or(false)
                        } else if parent.kind() == "value_expr" {
                            // value_expr might wrap the identifier, check grandparent
                            if let Some(grandparent) = parent.parent() {
                                if grandparent.kind() == "function_call_expr" {
                                    grandparent.child(0).map(|c| c.id() == parent.id()).unwrap_or(false)
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        } else if parent.kind() == "value_qid" {
                            // value_qid wraps the identifier, check grandparent (value_expr) and great-grandparent (function_call_expr)
                            // Structure: function_call_expr → value_expr → value_qid → lower_case_identifier
                            if let Some(grandparent) = parent.parent() {
                                if grandparent.kind() == "value_expr" {
                                    if let Some(great_grandparent) = grandparent.parent() {
                                        if great_grandparent.kind() == "function_call_expr" {
                                            great_grandparent.child(0).map(|c| c.id() == grandparent.id()).unwrap_or(false)
                                        } else {
                                            false
                                        }
                                    } else {
                                        false
                                    }
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    };

                    if !is_field_context && !is_field_name_in_field && !is_function_call_target {
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
                        usages.push((range, node.id()));
                    }
                }
            }
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.walk_for_variable_usages(child, source, var_name, exclude_id, usages);
        }
    }

    /// Check if a scope contains other bindings for the given variable name
    /// (case patterns, function parameters, let bindings, lambda parameters, etc.)
    /// This is used to avoid renaming variable usages that are bound by something OTHER than
    /// the record pattern we're processing.
    fn scope_has_other_bindings(
        scope_node: tree_sitter::Node,
        source: &str,
        var_name: &str,
        exclude_node_id: usize,
    ) -> bool {
        Self::walk_for_other_bindings(scope_node, source, var_name, exclude_node_id)
    }

    /// Recursively check for variable bindings in patterns
    fn walk_for_other_bindings(
        node: tree_sitter::Node,
        source: &str,
        var_name: &str,
        exclude_node_id: usize,
    ) -> bool {
        // Skip the node we're renaming (the record pattern field itself)
        if node.id() == exclude_node_id {
            return false;
        }

        let node_kind = node.kind();

        // Check for bindings in various pattern types
        let is_binding = match node_kind {
            // Case pattern bindings: `Just x -> ...`
            "pattern" | "union_pattern" | "cons_pattern" => {
                // Look for lower_case_identifier children that match
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "lower_case_identifier" && child.id() != exclude_node_id {
                        if let Ok(text) = child.utf8_text(source.as_bytes()) {
                            if text == var_name {
                                return true;
                            }
                        }
                    }
                }
                false
            }
            // Let bindings: `let x = ... in ...`
            "value_declaration" if node.parent().map(|p| p.kind()) == Some("let_in_expr") => {
                // Check the function name
                if let Some(decl) = node.child_by_field_name("functionDeclarationLeft") {
                    if let Some(name_node) = decl.child(0) {
                        if name_node.id() != exclude_node_id {
                            if let Ok(text) = name_node.utf8_text(source.as_bytes()) {
                                if text == var_name {
                                    return true;
                                }
                            }
                        }
                    }
                }
                false
            }
            // Function parameters (excluding the record pattern itself)
            "function_declaration_left" => {
                // Check all patterns in the function declaration
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "lower_pattern" && child.id() != exclude_node_id {
                        if let Ok(text) = child.utf8_text(source.as_bytes()) {
                            if text == var_name {
                                return true;
                            }
                        }
                    }
                }
                false
            }
            // Lambda parameters: `\x -> ...`
            "anonymous_function_expr" => {
                // Check the patterns before the arrow
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "pattern" || child.kind() == "lower_pattern" {
                        if child.id() != exclude_node_id {
                            if let Ok(text) = child.utf8_text(source.as_bytes()) {
                                if text == var_name {
                                    return true;
                                }
                            }
                        }
                    }
                }
                false
            }
            // Lower case identifier in a pattern context (catch-all)
            "lower_pattern" | "lower_case_identifier" => {
                // Check if this is in a pattern context (case, lambda, etc.)
                let parent_kind = node.parent().map(|p| p.kind());
                let is_pattern_context = matches!(
                    parent_kind,
                    Some("pattern")
                        | Some("union_pattern")
                        | Some("cons_pattern")
                        | Some("case_of_branch")
                        | Some("anonymous_function_expr")
                );
                if is_pattern_context && node.id() != exclude_node_id {
                    if let Ok(text) = node.utf8_text(source.as_bytes()) {
                        if text == var_name {
                            return true;
                        }
                    }
                }
                false
            }
            _ => false,
        };

        if is_binding {
            return true;
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if Self::walk_for_other_bindings(child, source, var_name, exclude_node_id) {
                return true;
            }
        }

        false
    }

    /// Classify the definition at a given position
    /// Returns a DefinitionSymbol if the position is on a valid definition
    pub fn classify_definition_at_position(
        &self,
        uri: &Url,
        position: Position,
    ) -> Option<DefinitionSymbol> {
        let tree = self.type_checker.get_tree(uri.as_str())?;
        let source = self.type_checker.get_source(uri.as_str())?;
        let root = tree.root_node();

        let point = tree_sitter::Point::new(position.line as usize, position.character as usize);
        let node = Self::find_node_at_point(root, point)?;

        let module_name = Some(self.get_module_name_from_uri(uri));

        self.classify_definition_node(uri, node, source, module_name)
    }

    fn classify_definition_node(
        &self,
        uri: &Url,
        node: tree_sitter::Node,
        source: &str,
        module_name: Option<String>,
    ) -> Option<DefinitionSymbol> {
        let mut current = node;

        loop {
            match current.kind() {
                "function_declaration_left" => {
                    let name_node = self.get_child_by_kind(current, "lower_case_identifier")?;
                    let name = self.node_text(source, name_node);
                    let range = self.node_to_lsp_range(name_node);
                    return Some(DefinitionSymbol {
                        name,
                        kind: BoundSymbolKind::Function,
                        uri: uri.clone(),
                        range,
                        type_context: None,
                        module_name,
                    });
                }

                "type_alias_declaration" => {
                    let name_node = self.get_child_by_kind(current, "upper_case_identifier")?;
                    let name = self.node_text(source, name_node);
                    let range = self.node_to_lsp_range(name_node);
                    return Some(DefinitionSymbol {
                        name,
                        kind: BoundSymbolKind::TypeAlias,
                        uri: uri.clone(),
                        range,
                        type_context: None,
                        module_name,
                    });
                }

                "type_declaration" => {
                    let type_name_node = self.get_child_by_kind(current, "upper_case_identifier")?;
                    let type_name = self.node_text(source, type_name_node.clone());

                    let type_name_range = self.node_to_lsp_range(type_name_node);
                    if self.position_in_range(
                        Position::new(node.start_position().row as u32, node.start_position().column as u32),
                        type_name_range,
                    ) {
                        return Some(DefinitionSymbol {
                            name: type_name,
                            kind: BoundSymbolKind::Type,
                            uri: uri.clone(),
                            range: type_name_range,
                            type_context: None,
                            module_name,
                        });
                    }

                    let mut cursor = current.walk();
                    for child in current.children(&mut cursor) {
                        if child.kind() == "union_variant" {
                            let variant_name_node = self.get_child_by_kind(child, "upper_case_identifier")?;
                            let variant_range = self.node_to_lsp_range(variant_name_node);
                            if self.position_in_range(
                                Position::new(node.start_position().row as u32, node.start_position().column as u32),
                                variant_range,
                            ) {
                                let variant_name = self.node_text(source, variant_name_node);
                                return Some(DefinitionSymbol {
                                    name: variant_name,
                                    kind: BoundSymbolKind::UnionConstructor,
                                    uri: uri.clone(),
                                    range: variant_range,
                                    type_context: Some(type_name),
                                    module_name,
                                });
                            }
                        }
                    }
                    return None;
                }

                "field_type" => {
                    let field_name_node = self.get_child_by_kind(current, "lower_case_identifier")?;
                    let field_name = self.node_text(source, field_name_node);
                    let range = self.node_to_lsp_range(field_name_node);

                    let type_alias_name = self.find_ancestor_type_alias_name(current, source);

                    return Some(DefinitionSymbol {
                        name: field_name,
                        kind: BoundSymbolKind::FieldType,
                        uri: uri.clone(),
                        range,
                        type_context: type_alias_name,
                        module_name,
                    });
                }

                "port_annotation" => {
                    let name_node = self.get_child_by_kind(current, "lower_case_identifier")?;
                    let name = self.node_text(source, name_node);
                    let range = self.node_to_lsp_range(name_node);
                    return Some(DefinitionSymbol {
                        name,
                        kind: BoundSymbolKind::Port,
                        uri: uri.clone(),
                        range,
                        type_context: None,
                        module_name,
                    });
                }

                "union_variant" => {
                    let variant_name_node = self.get_child_by_kind(current, "upper_case_identifier")?;
                    let variant_name = self.node_text(source, variant_name_node);
                    let range = self.node_to_lsp_range(variant_name_node);

                    if let Some(type_decl) = current.parent() {
                        if type_decl.kind() == "type_declaration" {
                            if let Some(type_name_node) = self.get_child_by_kind(type_decl, "upper_case_identifier") {
                                let type_name = self.node_text(source, type_name_node);
                                return Some(DefinitionSymbol {
                                    name: variant_name,
                                    kind: BoundSymbolKind::UnionConstructor,
                                    uri: uri.clone(),
                                    range,
                                    type_context: Some(type_name),
                                    module_name,
                                });
                            }
                        }
                    }
                    return None;
                }

                "file" => return None,

                _ => {}
            }

            current = current.parent()?;
        }
    }

    fn get_child_by_kind<'a>(&self, node: tree_sitter::Node<'a>, kind: &str) -> Option<tree_sitter::Node<'a>> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == kind {
                return Some(child);
            }
        }
        None
    }

    fn node_to_lsp_range(&self, node: tree_sitter::Node) -> Range {
        Range {
            start: Position::new(node.start_position().row as u32, node.start_position().column as u32),
            end: Position::new(node.end_position().row as u32, node.end_position().column as u32),
        }
    }

    fn position_in_range(&self, pos: Position, range: Range) -> bool {
        if pos.line < range.start.line || pos.line > range.end.line {
            return false;
        }
        if pos.line == range.start.line && pos.character < range.start.character {
            return false;
        }
        if pos.line == range.end.line && pos.character > range.end.character {
            return false;
        }
        true
    }

    fn find_ancestor_type_alias_name(&self, node: tree_sitter::Node, source: &str) -> Option<String> {
        let mut current = node.parent();
        while let Some(parent) = current {
            if parent.kind() == "type_alias_declaration" {
                if let Some(name_node) = self.get_child_by_kind(parent, "upper_case_identifier") {
                    return Some(self.node_text(source, name_node));
                }
            }
            current = parent.parent();
        }
        None
    }

    fn node_text(&self, source: &str, node: tree_sitter::Node) -> String {
        source[node.byte_range()].to_string()
    }

    // ========================================================================
    // ERD Generation Methods
    // ========================================================================

    /// Generate an ERD for a given type name
    pub fn generate_erd(&self, type_name: &str, file_uri: &Url) -> Result<ErdResult, String> {
        use std::collections::HashSet;

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
        visited: &mut std::collections::HashSet<String>,
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
                            return Some(self.extract_record_fields(record_type, source));
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
                return Some(self.extract_record_fields(child, source));
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

    /// Extract field names and types from a record_type node
    fn extract_record_fields(&self, record_type: tree_sitter::Node, source: &str) -> Vec<(String, String)> {
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

    /// Get module name from source code
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
        visited: &mut std::collections::HashSet<String>,
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
            let phantom_type = phantom_type.split('.').last().unwrap_or(phantom_type);
            // XxxId -> Xxx (strip "Id" suffix)
            if phantom_type.ends_with("Id") && phantom_type.len() > 2 {
                let entity_name = &phantom_type[..phantom_type.len() - 2];
                if entity_name.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
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
            if trimmed.starts_with(prefix) {
                let inner = &trimmed[prefix.len()..];
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
        if trimmed.starts_with("Maybe ") {
            let inner = &trimmed[6..];
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
        let type_name = first_word.split('.').last()?;

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

/// Information about a field at a position
#[derive(Debug, Clone)]
pub struct FieldInfo {
    pub name: String,
    pub range: Range,
    pub definition: FieldDefinition,
}

/// Result of a move function operation
#[derive(Debug)]
pub struct MoveResult {
    pub changes: HashMap<Url, Vec<TextEdit>>,
    pub source_module: String,
    pub target_module: String,
    pub function_name: String,
    pub references_updated: usize,
}

/// Result of a file rename/move operation
#[derive(Debug)]
pub struct FileOperationResult {
    pub old_module_name: String,
    pub new_module_name: String,
    pub old_path: String,
    pub new_path: String,
    pub files_updated: usize,
    pub changes: HashMap<Url, Vec<TextEdit>>,
}

/// Entry in a call chain showing how a function is called
#[derive(Debug, Clone, serde::Serialize)]
pub struct CallChainEntry {
    pub function: String,
    pub file: String,
    pub module_name: String,
    pub line: u32,
    pub is_entry_point: bool,
}

/// Known entry points in Elm/Lamdera apps
const ENTRY_POINTS: &[&str] = &[
    "app",
    "main",
    "update",
    "updateLoaded",
    "updateFromBackend",
    "updateLoadedFromBackend",
    "updateFromFrontend",
    "view",
    "viewLoaded",
    "viewPage",
    "subscriptions",
    "init",
];

/// Type of variant usage - determines if it blocks removal
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum UsageType {
    /// Constructor call like `let x = Blue` - BLOCKING
    Constructor,
    /// Pattern match like `Blue -> ...` - can be auto-removed
    PatternMatch,
    /// Type signature like `foo : Color -> ...` - not blocking, skip
    TypeSignature,
    /// Definition of the variant itself - skip
    Definition,
    /// Inside a string literal like `"MarkTicketAsResolved"` - skip
    StringLiteral,
}

/// Information about a variant usage
#[derive(Debug, Clone, serde::Serialize)]
pub struct VariantUsage {
    pub uri: String,
    pub line: u32,
    pub character: u32,
    pub is_blocking: bool,
    pub context: String,
    pub function_name: Option<String>,
    pub module_name: String,
    pub call_chain: Vec<CallChainEntry>,
    pub usage_type: UsageType,
    /// Full range of the pattern branch (for auto-removal)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern_branch_range: Option<Range>,
    /// Full range of the constructor expression (for Debug.todo replacement)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constructor_usage_range: Option<Range>,
}

/// Result of a remove variant operation
#[derive(Debug, serde::Serialize)]
pub struct RemoveVariantResult {
    pub success: bool,
    pub message: String,
    pub blocking_usages: Vec<VariantUsage>,
    pub changes: Option<HashMap<Url, Vec<TextEdit>>>,
}

impl RemoveVariantResult {
    pub fn error(message: &str) -> Self {
        Self {
            success: false,
            message: message.to_string(),
            blocking_usages: Vec::new(),
            changes: None,
        }
    }

    pub fn success(message: &str, changes: HashMap<Url, Vec<TextEdit>>) -> Self {
        Self {
            success: true,
            message: message.to_string(),
            blocking_usages: Vec::new(),
            changes: Some(changes),
        }
    }
}

// ============================================================================
// Field Removal Types
// ============================================================================

/// Type of field usage for removal classification
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub enum FieldUsageType {
    /// Field in type definition: { name : String }
    Definition,
    /// Field in record literal: { name = "value" }
    RecordLiteral,
    /// Field access: user.name
    FieldAccess,
    /// Field accessor function: .name
    FieldAccessor,
    /// Field in record pattern: { name }
    RecordPattern,
    /// Field in record update: { user | name = x }
    RecordUpdate,
}

/// Information about a field usage
#[derive(Debug, Clone, serde::Serialize)]
pub struct FieldUsage {
    pub uri: String,
    pub line: u32,
    pub character: u32,
    pub usage_type: FieldUsageType,
    pub context: String,
    pub module_name: String,
    /// Full range for the field (for removal)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_range: Option<Range>,
}

/// Result of a remove field operation
#[derive(Debug, serde::Serialize)]
pub struct RemoveFieldResult {
    pub success: bool,
    pub message: String,
    pub changes: Option<HashMap<Url, Vec<TextEdit>>>,
}

impl RemoveFieldResult {
    pub fn error(message: &str) -> Self {
        Self {
            success: false,
            message: message.to_string(),
            changes: None,
        }
    }

    pub fn success(message: &str, changes: HashMap<Url, Vec<TextEdit>>) -> Self {
        Self {
            success: true,
            message: message.to_string(),
            changes: Some(changes),
        }
    }
}

// ============================================================================
// ERD (Entity-Relationship Diagram) Generation
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
        use std::collections::HashSet;

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
        type_name
            .split('.')
            .last()
            .unwrap_or(type_name)
            .replace(' ', "_")
            .replace('(', "")
            .replace(')', "")
            .replace(',', "_")
            .replace('{', "")
            .replace('}', "")
            .replace(':', "")
            .replace('\n', "")
            .replace('\r', "")
            .replace('-', "_")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn create_test_workspace() -> (TempDir, Workspace) {
        let temp_dir = TempDir::new().unwrap();
        let src_dir = temp_dir.path().join("src");
        fs::create_dir_all(&src_dir).unwrap();

        // Create elm.json
        let elm_json = r#"{ "source-directories": ["src"] }"#;
        fs::write(temp_dir.path().join("elm.json"), elm_json).unwrap();

        let mut workspace = Workspace::new(temp_dir.path().to_path_buf());
        workspace.initialize().unwrap();

        (temp_dir, workspace)
    }

    #[test]
    fn test_extract_module_name_from_content() {
        let (temp_dir, workspace) = create_test_workspace();

        let content = "module MyModule exposing (..)";
        assert_eq!(
            workspace.extract_module_name_from_content(content),
            Some("MyModule".to_string())
        );

        let content2 = "module Utils.Helper exposing (helper)";
        assert_eq!(
            workspace.extract_module_name_from_content(content2),
            Some("Utils.Helper".to_string())
        );

        let content3 = "-- no module declaration";
        assert_eq!(workspace.extract_module_name_from_content(content3), None);

        drop(temp_dir);
    }

    #[test]
    fn test_path_string_to_module_name() {
        let (temp_dir, workspace) = create_test_workspace();

        assert_eq!(
            workspace.path_string_to_module_name("src/Main.elm"),
            "Main"
        );

        assert_eq!(
            workspace.path_string_to_module_name("src/Utils/Helper.elm"),
            "Utils.Helper"
        );

        assert_eq!(
            workspace.path_string_to_module_name("src/Pages/Home/View.elm"),
            "Pages.Home.View"
        );

        drop(temp_dir);
    }

    #[test]
    fn test_rename_file_updates_module_declaration() {
        let (temp_dir, mut workspace) = create_test_workspace();

        // Create a test file
        let src_dir = temp_dir.path().join("src");
        let old_content = r#"module OldName exposing (..)

value : Int
value = 42
"#;
        fs::write(src_dir.join("OldName.elm"), old_content).unwrap();

        // Re-initialize to pick up the new file
        workspace.initialize().unwrap();

        let uri = Url::from_file_path(src_dir.join("OldName.elm")).unwrap();
        let result = workspace.rename_file(&uri, "NewName.elm").unwrap();

        assert_eq!(result.old_module_name, "OldName");
        assert_eq!(result.new_module_name, "NewName");
        assert!(result.new_path.ends_with("NewName.elm"));

        // Check that we have changes for the module declaration
        assert!(result.changes.contains_key(&uri));

        drop(temp_dir);
    }

    #[test]
    fn test_rename_file_updates_imports() {
        let (temp_dir, mut workspace) = create_test_workspace();

        // Create files
        let src_dir = temp_dir.path().join("src");

        let helper_content = r#"module Helper exposing (help)

help : Int
help = 42
"#;
        fs::write(src_dir.join("Helper.elm"), helper_content).unwrap();

        let main_content = r#"module Main exposing (..)

import Helper exposing (help)

value : Int
value = help
"#;
        fs::write(src_dir.join("Main.elm"), main_content).unwrap();

        // Re-initialize to pick up the new files
        workspace.initialize().unwrap();

        let helper_uri = Url::from_file_path(src_dir.join("Helper.elm")).unwrap();
        let result = workspace.rename_file(&helper_uri, "NewHelper.elm").unwrap();

        assert_eq!(result.old_module_name, "Helper");
        assert_eq!(result.new_module_name, "NewHelper");

        // Should have updates in Main.elm for the import
        assert!(result.files_updated > 0);

        drop(temp_dir);
    }

    #[test]
    fn test_move_file_to_subdirectory() {
        let (temp_dir, mut workspace) = create_test_workspace();

        // Create a test file in src root
        let src_dir = temp_dir.path().join("src");
        let old_content = r#"module Helper exposing (..)

value : Int
value = 42
"#;
        fs::write(src_dir.join("Helper.elm"), old_content).unwrap();

        // Re-initialize to pick up the new file
        workspace.initialize().unwrap();

        let uri = Url::from_file_path(src_dir.join("Helper.elm")).unwrap();
        let result = workspace.move_file(&uri, "src/Utils/Helper.elm").unwrap();

        assert_eq!(result.old_module_name, "Helper");
        assert_eq!(result.new_module_name, "Utils.Helper");
        assert!(result.new_path.contains("Utils"));

        // Check that we have changes for the module declaration
        assert!(result.changes.contains_key(&uri));

        drop(temp_dir);
    }

    #[test]
    fn test_move_file_updates_imports() {
        let (temp_dir, mut workspace) = create_test_workspace();

        // Create files
        let src_dir = temp_dir.path().join("src");

        let helper_content = r#"module Helper exposing (help)

help : Int
help = 42
"#;
        fs::write(src_dir.join("Helper.elm"), helper_content).unwrap();

        let main_content = r#"module Main exposing (..)

import Helper exposing (help)

value : Int
value = help
"#;
        fs::write(src_dir.join("Main.elm"), main_content).unwrap();

        // Re-initialize
        workspace.initialize().unwrap();

        let helper_uri = Url::from_file_path(src_dir.join("Helper.elm")).unwrap();
        let result = workspace.move_file(&helper_uri, "src/Utils/Helper.elm").unwrap();

        assert_eq!(result.old_module_name, "Helper");
        assert_eq!(result.new_module_name, "Utils.Helper");

        // Should have updates in Main.elm for the import
        assert!(result.files_updated > 0);

        drop(temp_dir);
    }

    #[test]
    fn test_find_module_declaration_range() {
        let (temp_dir, workspace) = create_test_workspace();

        let content = "module MyModule exposing (..)\n\nvalue = 42";
        let range = workspace.find_module_declaration_range(content);

        assert!(range.is_some());
        let range = range.unwrap();
        assert_eq!(range.start.line, 0);
        assert_eq!(range.start.character, 0);

        drop(temp_dir);
    }

    #[test]
    fn test_rename_file_rejects_invalid_extension() {
        let (temp_dir, mut workspace) = create_test_workspace();

        let src_dir = temp_dir.path().join("src");
        let old_content = r#"module OldName exposing (..)"#;
        fs::write(src_dir.join("OldName.elm"), old_content).unwrap();
        workspace.initialize().unwrap();

        let uri = Url::from_file_path(src_dir.join("OldName.elm")).unwrap();
        let result = workspace.rename_file(&uri, "NewName.txt");

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains(".elm"));

        drop(temp_dir);
    }
}
