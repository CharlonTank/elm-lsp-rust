use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tower_lsp::lsp_types::*;
use walkdir::WalkDir;

use crate::binder::BoundSymbolKind;
use crate::document::ElmSymbol;
use crate::parser::ElmParser;
use crate::type_checker::TypeChecker;

mod erd;
mod field_operations;
mod file_operations;
mod move_function;
mod types;
mod variant_operations;

pub use erd::*;
pub use types::*;

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
    /// For local variables: the start/end positions of their scope (function body, case branch, etc.)
    pub scope_range: Option<Range>,
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
const LAMDERA_PROTECTED_TYPES: &[&str] = &[
    "FrontendMsg",
    "BackendMsg",
    "ToBackend",
    "ToFrontend",
    "FrontendModel",
    "BackendModel",
];

/// Represents an external package dependency
#[derive(Debug, Clone)]
pub struct ExternalPackage {
    pub name: String,    // e.g., "elm/core"
    pub version: String, // e.g., "1.0.5"
    pub path: PathBuf,   // Path to package source
}

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
    /// External packages (from ~/.elm or elm-stuff)
    pub external_packages: Vec<ExternalPackage>,
    /// Symbols from external packages (indexed separately)
    pub external_symbols: HashMap<String, Vec<GlobalSymbol>>,
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
            external_packages: Vec::new(),
            external_symbols: HashMap::new(),
        }
    }

    /// Check if a symbol name is a protected Lamdera type that cannot be renamed
    pub fn is_protected_lamdera_type(&self, name: &str) -> bool {
        self.is_lamdera_project && LAMDERA_PROTECTED_TYPES.contains(&name)
    }

    /// Deduplicate references by (uri, range) - sorts and removes duplicates
    fn deduplicate_references(results: &mut Vec<SymbolReference>) {
        results.sort_by(|a, b| {
            (&a.uri, a.range.start.line, a.range.start.character).cmp(&(
                &b.uri,
                b.range.start.line,
                b.range.start.character,
            ))
        });
        results.dedup_by(|a, b| a.uri == b.uri && a.range == b.range);
    }

    /// Extract base name from a potentially qualified symbol name (e.g., "Module.func" -> "func")
    fn extract_base_name(qualified_name: &str) -> &str {
        if qualified_name.contains('.') {
            qualified_name.rsplit('.').next().unwrap_or(qualified_name)
        } else {
            qualified_name
        }
    }

    /// Iterate over non-Evergreen modules with their URIs
    fn iter_non_evergreen_modules(&self) -> impl Iterator<Item = (&ElmModule, Url)> {
        self.modules.values().filter_map(|module| {
            if module.path.to_string_lossy().contains("/Evergreen/") {
                return None;
            }
            Url::from_file_path(&module.path)
                .ok()
                .map(|uri| (module, uri))
        })
    }

    /// Sort text edits in reverse order (bottom to top) within each file
    /// to avoid offset issues when applying edits sequentially
    pub(super) fn sort_edits_reverse(changes: &mut HashMap<Url, Vec<TextEdit>>) {
        for edits in changes.values_mut() {
            edits.sort_by(|a, b| {
                b.range
                    .start
                    .line
                    .cmp(&a.range.start.line)
                    .then_with(|| b.range.start.character.cmp(&a.range.start.character))
            });
        }
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

        // Index external packages for go-to-definition support
        self.index_external_packages()?;

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

        // Parse dependencies for external package support
        self.parse_dependencies(&json);

        Ok(())
    }

    /// Parse dependencies from elm.json and locate package sources
    fn parse_dependencies(&mut self, json: &serde_json::Value) {
        let elm_home = Self::get_elm_home();

        if let Some(deps) = json.get("dependencies") {
            // Parse direct dependencies
            if let Some(direct) = deps.get("direct") {
                self.collect_packages(direct, &elm_home);
            }
            // Parse indirect dependencies
            if let Some(indirect) = deps.get("indirect") {
                self.collect_packages(indirect, &elm_home);
            }
        }

        tracing::info!("Found {} external packages", self.external_packages.len());
    }

    /// Collect packages from a dependencies object
    fn collect_packages(&mut self, deps: &serde_json::Value, elm_home: &Path) {
        if let Some(obj) = deps.as_object() {
            for (name, version) in obj {
                if let Some(version_str) = version.as_str() {
                    // Try to find package in elm home
                    let package_path = elm_home
                        .join("0.19.1")
                        .join("packages")
                        .join(name.replace('/', std::path::MAIN_SEPARATOR_STR))
                        .join(version_str)
                        .join("src");

                    if package_path.exists() {
                        self.external_packages.push(ExternalPackage {
                            name: name.clone(),
                            version: version_str.to_string(),
                            path: package_path,
                        });
                    }
                }
            }
        }
    }

    /// Get the Elm home directory (~/.elm or ELM_HOME)
    fn get_elm_home() -> PathBuf {
        if let Ok(elm_home) = std::env::var("ELM_HOME") {
            PathBuf::from(elm_home)
        } else if let Some(home) = dirs::home_dir() {
            home.join(".elm")
        } else {
            PathBuf::from(".elm")
        }
    }

    /// Index external packages for go-to-definition support
    fn index_external_packages(&mut self) -> anyhow::Result<()> {
        let packages: Vec<_> = self.external_packages.clone();

        for package in &packages {
            if let Err(e) = self.index_external_package(package) {
                tracing::warn!("Failed to index package {}: {}", package.name, e);
            }
        }

        tracing::info!("Indexed {} external symbols", self.external_symbols.len());
        Ok(())
    }

    /// Index a single external package
    fn index_external_package(&mut self, package: &ExternalPackage) -> anyhow::Result<()> {
        for entry in WalkDir::new(&package.path)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "elm") {
                self.index_external_file(path, &package.name)?;
            }
        }
        Ok(())
    }

    /// Index a single external file (only extracts symbols, no references)
    fn index_external_file(&mut self, path: &Path, _package_name: &str) -> anyhow::Result<()> {
        let content = std::fs::read_to_string(path)?;
        let uri = Url::from_file_path(path).map_err(|_| anyhow::anyhow!("Invalid path"))?;

        if let Some(tree) = self.parser.parse(&content) {
            let symbols = self.parser.extract_symbols(&tree, &content);
            let module_name = self
                .extract_module_name(&tree, &content)
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Unknown")
                        .to_string()
                });

            // Add symbols to external index (not the main symbols index)
            for symbol in &symbols {
                let global_symbol = GlobalSymbol {
                    name: symbol.name.clone(),
                    module_name: module_name.clone(),
                    kind: symbol.kind,
                    definition_uri: uri.clone(),
                    definition_range: symbol.definition_range.unwrap_or(symbol.range),
                    signature: symbol.signature.clone(),
                };

                // Index by unqualified name
                self.external_symbols
                    .entry(symbol.name.clone())
                    .or_default()
                    .push(global_symbol.clone());

                // Index by qualified name
                let qualified_name = format!("{}.{}", module_name, symbol.name);
                self.external_symbols
                    .entry(qualified_name)
                    .or_default()
                    .push(global_symbol);
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
            for entry in WalkDir::new(source_dir).into_iter().filter_map(|e| e.ok()) {
                let path = entry.path();

                // Skip Evergreen directory in Lamdera projects
                if is_lamdera && self.is_evergreen_path(path) {
                    continue;
                }

                if path.extension().is_some_and(|ext| ext == "elm") {
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
            let module_name = self
                .extract_module_name(&tree, &content)
                .unwrap_or_else(|| self.path_to_module_name(path));
            let imports = self.extract_imports(&tree, &content);
            let exposing = self.extract_exposing(&tree, &content);

            // Index for type checking
            self.type_checker
                .index_file(uri.as_str(), &content, tree.clone());

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
                    .or_default()
                    .push(global_symbol.clone());

                // Also index by qualified name
                self.symbols
                    .entry(qualified_name)
                    .or_default()
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
        let old_module_name = self
            .modules
            .iter()
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
            let module_name = self
                .extract_module_name(&tree, content)
                .unwrap_or_else(|| self.path_to_module_name(&path));
            let imports = self.extract_imports(&tree, content);
            let exposing = self.extract_exposing(&tree, content);

            // Re-index for type checking
            self.type_checker
                .index_file(uri.as_str(), content, tree.clone());

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
                    .or_default()
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
        let module_name = self
            .modules
            .iter()
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
        let module_info: Vec<_> = self
            .modules
            .iter()
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
        match node.kind() {
            "value_qid" | "upper_case_qid" => {
                let is_in_import = self.is_module_name_in_import(node);

                if !is_in_import {
                    let text = &source[node.byte_range()];
                    let kind = self.classify_reference_kind(node, text);

                    if text.contains('.') {
                        let symbol_name = text.rsplit('.').next().unwrap_or(text);
                        let symbol_start_col = node.end_position().column - symbol_name.len();

                        let range = Range {
                            start: Position::new(
                                node.end_position().row as u32,
                                symbol_start_col as u32,
                            ),
                            end: Position::new(
                                node.end_position().row as u32,
                                node.end_position().column as u32,
                            ),
                        };

                        let resolved_name = self.resolve_reference(text, imports);

                        self.references
                            .entry(resolved_name)
                            .or_default()
                            .push(SymbolReference {
                                uri: uri.clone(),
                                range,
                                is_definition: false,
                                kind,
                                type_context: None,
                            });
                    } else {
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

                        let resolved_name = self.resolve_reference(text, imports);

                        self.references
                            .entry(resolved_name)
                            .or_default()
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

                if !in_decl {
                    let kind = self.classify_reference_kind(node, text);
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

                    let resolved_name = self.resolve_reference(text, imports);

                    self.references
                        .entry(resolved_name)
                        .or_default()
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

    fn classify_reference_kind(
        &self,
        node: tree_sitter::Node,
        text: &str,
    ) -> Option<BoundSymbolKind> {
        let is_uppercase = text.chars().next().is_some_and(|c| c.is_uppercase());

        let mut current = node;
        while let Some(parent) = current.parent() {
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
                "function_declaration_left"
                | "type_declaration"
                | "type_alias_declaration"
                | "port_annotation" => return true,
                // If inside a qualified identifier AND we're the first child (module prefix), skip
                // But if we're the last child of a qualified identifier, we ARE the symbol reference
                "value_qid" | "upper_case_qid" => {
                    // Check if we're the last child (the actual symbol) or first child (module prefix)
                    if let Some(last) = parent.child(parent.child_count().saturating_sub(1)) {
                        if last.id() == node.id() {
                            // We're the last child (the symbol itself) - NOT a declaration
                            // But we still need to continue checking parents
                            // (e.g., for type_declaration that might be above)
                        } else {
                            // We're an earlier child (module prefix) - skip
                            return true;
                        }
                    }
                }
                // For module declarations and import clauses, skip the module name but allow exposed items
                "module_declaration" | "import_clause" => {
                    // Check if we're in an exposing_list - those ARE valid references
                    let mut check = node.parent();
                    while let Some(p) = check {
                        if p.kind() == "exposing_list"
                            || p.kind() == "exposed_type"
                            || p.kind() == "exposed_value"
                        {
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
                    // Direct exposure check
                    if exposed.contains(&name.to_string()) {
                        return format!("{}.{}", import.module_name, name);
                    }
                    // Check for TypeName(..) patterns - only match if name equals the type name
                    // (the (..) only exposes constructors, which we can't know without the type def)
                    for exp in exposed {
                        if exp.ends_with("(..)") {
                            // Extract the type name from "TypeName(..)"
                            let type_name = &exp[..exp.len() - 4];
                            if name == type_name {
                                return format!("{}.{}", import.module_name, name);
                            }
                        }
                    }
                }
            }
        }

        // Return unqualified name
        name.to_string()
    }

    /// Find all references to a symbol
    pub fn find_references(
        &self,
        symbol_name: &str,
        module_name: Option<&str>,
    ) -> Vec<SymbolReference> {
        let mut results = Vec::new();

        let base_name = Self::extract_base_name(symbol_name);

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

        Self::deduplicate_references(&mut results);
        results
    }

    /// Find references to a function using the DefinitionSymbol
    /// Filters references by Function kind to avoid matching types/constructors
    pub fn find_function_references_typed(
        &self,
        symbol: &DefinitionSymbol,
    ) -> Vec<SymbolReference> {
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
                        symbol
                            .name
                            .chars()
                            .next()
                            .map(|c| c.is_lowercase())
                            .unwrap_or(false)
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
                        symbol
                            .name
                            .chars()
                            .next()
                            .map(|c| c.is_uppercase())
                            .unwrap_or(false)
                    }
                    _ => false,
                }
            })
            .collect()
    }

    /// Find references to a union constructor using the DefinitionSymbol
    /// Filters references by UnionConstructor kind to avoid matching type definitions
    pub fn find_constructor_references_typed(
        &self,
        symbol: &DefinitionSymbol,
    ) -> Vec<SymbolReference> {
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| matches!(r.kind, Some(BoundSymbolKind::UnionConstructor) | None))
            .collect()
    }

    /// Find references to a record field using the DefinitionSymbol
    /// This uses the existing type-aware field reference finder
    pub fn find_field_references_typed(
        &self,
        symbol: &DefinitionSymbol,
        content: &str,
    ) -> Vec<SymbolReference> {
        // Get the field definition from the type checker
        if let Some(tree) = self.type_checker.get_tree(symbol.uri.as_str()) {
            let point = tree_sitter::Point::new(
                symbol.range.start.line as usize,
                symbol.range.start.character as usize,
            );
            if let Some(node) = Self::find_node_at_point(tree.root_node(), point) {
                if let Some(field_def) =
                    self.type_checker
                        .find_field_definition(symbol.uri.as_str(), node, content)
                {
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
            .filter(|r| matches!(r.kind, Some(BoundSymbolKind::Port) | None))
            .collect()
    }

    /// Find references to a local variable (function parameter, case pattern, let binding)
    /// Only searches within the scope of the variable
    pub fn find_local_references(
        &self,
        symbol: &DefinitionSymbol,
        _content: &str,
    ) -> Vec<SymbolReference> {
        let mut references = Vec::new();

        // Add the definition itself
        references.push(SymbolReference {
            uri: symbol.uri.clone(),
            range: symbol.range,
            kind: Some(symbol.kind),
            is_definition: true,
            type_context: None,
        });

        // If there's no scope range, we can't do scoped searching
        let scope_range = match &symbol.scope_range {
            Some(range) => range,
            None => return references,
        };

        // Get the tree and source for the file
        let source = match self.type_checker.get_source(symbol.uri.as_str()) {
            Some(s) => s.to_string(),
            None => return references,
        };
        let tree = match self.type_checker.get_tree(symbol.uri.as_str()) {
            Some(t) => t,
            None => return references,
        };

        // Find all value_expr nodes that match our symbol name within the scope
        let root = tree.root_node();
        self.find_local_usages_in_scope(
            root,
            &symbol.name,
            scope_range,
            &source,
            &symbol.uri,
            &mut references,
        );

        references
    }

    /// Recursively find usages of a local variable within a scope
    fn find_local_usages_in_scope(
        &self,
        node: tree_sitter::Node,
        name: &str,
        scope_range: &Range,
        source: &str,
        uri: &Url,
        references: &mut Vec<SymbolReference>,
    ) {
        // Check if this node is within the scope
        let node_range = self.node_to_lsp_range(node);
        if !self.ranges_overlap(node_range, *scope_range) {
            return;
        }

        // Check if this is a value_expr or value_qid that matches our name
        if node.kind() == "value_expr" || node.kind() == "value_qid" {
            // Get the identifier name
            let text = &source[node.byte_range()];
            // For value_qid, the text might be qualified (e.g., "Module.name"), we want just the last part
            let simple_name = text.rsplit('.').next().unwrap_or(text);

            if simple_name == name {
                // Make sure this is not a qualified reference (which would be a different symbol)
                if !text.contains('.') {
                    references.push(SymbolReference {
                        uri: uri.clone(),
                        range: node_range,
                        kind: None,
                        is_definition: false,
                        type_context: None,
                    });
                }
            }
        }
        // Also check for record_base_identifier (for record updates like { record | field = value })
        else if node.kind() == "record_base_identifier" {
            let text = &source[node.byte_range()];
            if text == name {
                references.push(SymbolReference {
                    uri: uri.clone(),
                    range: node_range,
                    kind: None,
                    is_definition: false,
                    type_context: None,
                });
            }
        }
        // Check lower_case_identifier directly (used in various contexts)
        else if node.kind() == "lower_case_identifier" {
            let text = &source[node.byte_range()];
            if text == name {
                // Check parent to determine context
                if let Some(parent) = node.parent() {
                    // Skip if this is a field access (the field part, not the record part)
                    if parent.kind() == "field_access_expr" {
                        // Only include if this is the target (record), not the field
                        if let Some(target) = parent.child_by_field_name("target") {
                            if target.id() != node.id() {
                                return; // This is the field name, not the record
                            }
                        }
                    }
                    // Skip if this is a field in a record literal or pattern
                    if parent.kind() == "field" || parent.kind() == "field_type" {
                        return;
                    }
                    // Include if it's part of value_expr
                    if parent.kind() == "value_qid" || parent.kind() == "value_expr" {
                        references.push(SymbolReference {
                            uri: uri.clone(),
                            range: node_range,
                            kind: None,
                            is_definition: false,
                            type_context: None,
                        });
                    }
                }
            }
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.find_local_usages_in_scope(child, name, scope_range, source, uri, references);
        }
    }

    /// Check if two ranges overlap
    fn ranges_overlap(&self, a: Range, b: Range) -> bool {
        // a ends before b starts
        if a.end.line < b.start.line
            || (a.end.line == b.start.line && a.end.character < b.start.character)
        {
            return false;
        }
        // b ends before a starts
        if b.end.line < a.start.line
            || (b.end.line == a.start.line && b.end.character < a.start.character)
        {
            return false;
        }
        true
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
                // For local bindings, use scoped search
                self.find_local_references(&symbol, content)
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

        let base_name = Self::extract_base_name(symbol_name);

        tracing::debug!(
            "find_module_aware_references: symbol={}, defining_module={}, defining_uri={}",
            base_name,
            defining_module,
            defining_uri.as_str()
        );

        // 1. Get refs stored under the qualified key "DefiningModule.symbol"
        let qualified_key = format!("{}.{}", defining_module, base_name);
        if let Some(refs) = self.references.get(&qualified_key) {
            for r in refs {
                tracing::debug!(
                    "  Including qualified ref (key={}): {} {:?}",
                    qualified_key,
                    r.uri.as_str(),
                    r.range
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
                            if imp.module_name != defining_module
                                && imp.alias.as_deref() != Some(defining_module)
                            {
                                return false;
                            }
                            match &imp.exposing {
                                ExposingInfo::All => true,
                                ExposingInfo::Explicit(names) => names.iter().any(|n| {
                                    n == base_name
                                        || n.starts_with(&format!("{}(", base_name))
                                        || n == &format!("{}(..)", base_name)
                                }),
                            }
                        });

                        if symbol_is_exposed {
                            tracing::debug!(
                                "  Including exposed unqualified ref from {}: {:?}",
                                r.uri.as_str(),
                                r.range
                            );
                            results.push(r.clone());
                        } else {
                            tracing::debug!(
                                "  Excluding unqualified ref from {} (not exposed from {}): {:?}",
                                r.uri.as_str(),
                                defining_module,
                                r.range
                            );
                        }
                    }
                }
            }
        }

        Self::deduplicate_references(&mut results);
        results
    }

    /// Get module info for a URI
    fn get_module_at_uri(&self, uri: &Url) -> Option<&ElmModule> {
        self.modules
            .values()
            .find(|m| Url::from_file_path(&m.path).ok().as_ref() == Some(uri))
    }

    /// Find definition of a symbol
    pub fn find_definition(&self, symbol_name: &str) -> Option<&GlobalSymbol> {
        // Try exact match first in local symbols
        if let Some(symbols) = self.symbols.get(symbol_name) {
            if let Some(sym) = symbols.first() {
                return Some(sym);
            }
        }

        let base_name = Self::extract_base_name(symbol_name);

        // Try base name in local symbols
        if let Some(symbols) = self.symbols.get(base_name) {
            if let Some(sym) = symbols.first() {
                return Some(sym);
            }
        }

        // Fall back to external packages
        if let Some(symbols) = self.external_symbols.get(symbol_name) {
            if let Some(sym) = symbols.first() {
                return Some(sym);
            }
        }

        // Try base name in external packages
        if let Some(symbols) = self.external_symbols.get(base_name) {
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

    /// Convert a file path to its module name
    pub fn path_to_module_name_public(&self, path: &Path) -> String {
        self.path_to_module_name(path)
    }

    /// Find a module by its file path
    fn find_module_by_path(&self, path: &Path) -> Option<&ElmModule> {
        self.modules.values().find(|m| m.path == *path)
    }

    /// Get the module name from a URI
    pub fn get_module_name_from_uri(&self, uri: &Url) -> String {
        let path = match uri.to_file_path() {
            Ok(p) => p,
            Err(_) => return String::new(),
        };

        if let Some(module) = self.find_module_by_path(&path) {
            return module.module_name.clone();
        }

        // Fallback: extract from path
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string()
    }

    /// Read file content from a URI
    fn read_file_content(&self, uri: &Url) -> Option<String> {
        let path = uri.to_file_path().ok()?;
        std::fs::read_to_string(&path).ok()
    }

    /// Find a node at a specific point in the tree
    fn find_node_at_point(
        node: tree_sitter::Node,
        point: tree_sitter::Point,
    ) -> Option<tree_sitter::Node> {
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

    fn point_in_range(
        point: tree_sitter::Point,
        start: tree_sitter::Point,
        end: tree_sitter::Point,
    ) -> bool {
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
                            parent
                                .child(0)
                                .map(|c| c.id() == node.id())
                                .unwrap_or(false)
                        } else if parent.kind() == "value_expr" {
                            // value_expr might wrap the identifier, check grandparent
                            if let Some(grandparent) = parent.parent() {
                                if grandparent.kind() == "function_call_expr" {
                                    grandparent
                                        .child(0)
                                        .map(|c| c.id() == parent.id())
                                        .unwrap_or(false)
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
                                            great_grandparent
                                                .child(0)
                                                .map(|c| c.id() == grandparent.id())
                                                .unwrap_or(false)
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
                    if (child.kind() == "pattern" || child.kind() == "lower_pattern")
                        && child.id() != exclude_node_id
                    {
                        if let Ok(text) = child.utf8_text(source.as_bytes()) {
                            if text == var_name {
                                return true;
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
                // Function parameter: scope is the function body
                "lower_pattern" => {
                    // Check if we're inside a function_declaration_left (function parameter)
                    if let Some(parent) = current.parent() {
                        if parent.kind() == "function_declaration_left" {
                            let name = self.node_text(source, current);
                            let range = self.node_to_lsp_range(current);

                            // Find the function body (= expr after function_declaration_left)
                            // The structure is: value_declaration -> function_declaration_left -> ... -> expr
                            if let Some(value_decl) = parent.parent() {
                                // Find the expression (function body) which is the last named child
                                let mut scope_range = None;
                                let mut cursor = value_decl.walk();
                                for child in value_decl.children(&mut cursor) {
                                    // Skip function_declaration_left and "="
                                    if child.kind() != "function_declaration_left"
                                        && child.kind() != "="
                                    {
                                        scope_range = Some(self.node_to_lsp_range(child));
                                        break;
                                    }
                                }

                                return Some(DefinitionSymbol {
                                    name,
                                    kind: BoundSymbolKind::FunctionParameter,
                                    uri: uri.clone(),
                                    range,
                                    type_context: None,
                                    module_name,
                                    scope_range,
                                });
                            }
                        }
                        // Check if we're in a case pattern
                        else if parent.kind() == "pattern" {
                            if let Some(case_branch) =
                                self.find_ancestor_of_kind(parent, "case_of_branch")
                            {
                                let name = self.node_text(source, current);
                                let range = self.node_to_lsp_range(current);

                                // The scope is the case branch body (after the ->)
                                let scope_range = case_branch
                                    .child_by_field_name("expr")
                                    .or_else(|| {
                                        case_branch.named_children(&mut case_branch.walk()).last()
                                    })
                                    .map(|body| self.node_to_lsp_range(body));

                                return Some(DefinitionSymbol {
                                    name,
                                    kind: BoundSymbolKind::CasePattern,
                                    uri: uri.clone(),
                                    range,
                                    type_context: None,
                                    module_name,
                                    scope_range,
                                });
                            }
                        }
                        // Check if we're in an anonymous function parameter
                        else if parent.kind() == "anonymous_function_expr" {
                            let name = self.node_text(source, current);
                            let range = self.node_to_lsp_range(current);

                            // The scope is the entire anonymous function body
                            let scope_range = Some(self.node_to_lsp_range(parent));

                            return Some(DefinitionSymbol {
                                name,
                                kind: BoundSymbolKind::AnonymousFunctionParameter,
                                uri: uri.clone(),
                                range,
                                type_context: None,
                                module_name,
                                scope_range,
                            });
                        }
                        // Check if we're in a let binding
                        else if parent.kind() == "value_declaration" {
                            // Check if this is inside a let_in_expr
                            if let Some(let_in) = self.find_ancestor_of_kind(parent, "let_in_expr")
                            {
                                let name = self.node_text(source, current);
                                let range = self.node_to_lsp_range(current);

                                // The scope is the entire let_in_expr (both bindings and body)
                                let scope_range = Some(self.node_to_lsp_range(let_in));

                                return Some(DefinitionSymbol {
                                    name,
                                    kind: BoundSymbolKind::FunctionParameter, // Use FunctionParameter for let bindings too
                                    uri: uri.clone(),
                                    range,
                                    type_context: None,
                                    module_name,
                                    scope_range,
                                });
                            }
                        }
                    }
                }

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
                        scope_range: None,
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
                        scope_range: None,
                    });
                }

                "type_declaration" => {
                    let type_name_node =
                        self.get_child_by_kind(current, "upper_case_identifier")?;
                    let type_name = self.node_text(source, type_name_node);

                    let type_name_range = self.node_to_lsp_range(type_name_node);
                    if self.position_in_range(
                        Position::new(
                            node.start_position().row as u32,
                            node.start_position().column as u32,
                        ),
                        type_name_range,
                    ) {
                        return Some(DefinitionSymbol {
                            name: type_name,
                            kind: BoundSymbolKind::Type,
                            uri: uri.clone(),
                            range: type_name_range,
                            type_context: None,
                            module_name,
                            scope_range: None,
                        });
                    }

                    let mut cursor = current.walk();
                    for child in current.children(&mut cursor) {
                        if child.kind() == "union_variant" {
                            let variant_name_node =
                                self.get_child_by_kind(child, "upper_case_identifier")?;
                            let variant_range = self.node_to_lsp_range(variant_name_node);
                            if self.position_in_range(
                                Position::new(
                                    node.start_position().row as u32,
                                    node.start_position().column as u32,
                                ),
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
                                    scope_range: None,
                                });
                            }
                        }
                    }
                    return None;
                }

                "field_type" => {
                    let field_name_node =
                        self.get_child_by_kind(current, "lower_case_identifier")?;
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
                        scope_range: None,
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
                        scope_range: None,
                    });
                }

                "union_variant" => {
                    let variant_name_node =
                        self.get_child_by_kind(current, "upper_case_identifier")?;
                    let variant_name = self.node_text(source, variant_name_node);
                    let range = self.node_to_lsp_range(variant_name_node);

                    if let Some(type_decl) = current.parent() {
                        if type_decl.kind() == "type_declaration" {
                            if let Some(type_name_node) =
                                self.get_child_by_kind(type_decl, "upper_case_identifier")
                            {
                                let type_name = self.node_text(source, type_name_node);
                                return Some(DefinitionSymbol {
                                    name: variant_name,
                                    kind: BoundSymbolKind::UnionConstructor,
                                    uri: uri.clone(),
                                    range,
                                    type_context: Some(type_name),
                                    module_name,
                                    scope_range: None,
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

    fn find_ancestor_of_kind<'a>(
        &self,
        node: tree_sitter::Node<'a>,
        kind: &str,
    ) -> Option<tree_sitter::Node<'a>> {
        let mut current = node.parent();
        while let Some(parent) = current {
            if parent.kind() == kind {
                return Some(parent);
            }
            current = parent.parent();
        }
        None
    }

    fn get_child_by_kind<'a>(
        &self,
        node: tree_sitter::Node<'a>,
        kind: &str,
    ) -> Option<tree_sitter::Node<'a>> {
        let mut cursor = node.walk();
        let result = node
            .children(&mut cursor)
            .find(|child| child.kind() == kind);
        result
    }

    fn node_to_lsp_range(&self, node: tree_sitter::Node) -> Range {
        Range {
            start: Position::new(
                node.start_position().row as u32,
                node.start_position().column as u32,
            ),
            end: Position::new(
                node.end_position().row as u32,
                node.end_position().column as u32,
            ),
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

    fn find_ancestor_type_alias_name(
        &self,
        node: tree_sitter::Node,
        source: &str,
    ) -> Option<String> {
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
        let content = "module MyModule exposing (..)";
        assert_eq!(
            file_operations::extract_module_name_from_content(content),
            Some("MyModule".to_string())
        );

        let content2 = "module Utils.Helper exposing (helper)";
        assert_eq!(
            file_operations::extract_module_name_from_content(content2),
            Some("Utils.Helper".to_string())
        );

        let content3 = "-- no module declaration";
        assert_eq!(
            file_operations::extract_module_name_from_content(content3),
            None
        );
    }

    #[test]
    fn test_path_to_module_name() {
        let (temp_dir, workspace) = create_test_workspace();
        let src_dir = temp_dir.path().join("src");

        // Create nested directories for testing
        fs::create_dir_all(src_dir.join("Utils")).unwrap();
        fs::create_dir_all(src_dir.join("Pages").join("Home")).unwrap();

        // Use absolute paths that match the workspace's source_dirs
        assert_eq!(
            workspace.path_to_module_name(&src_dir.join("Main.elm")),
            "Main"
        );

        assert_eq!(
            workspace.path_to_module_name(&src_dir.join("Utils").join("Helper.elm")),
            "Utils.Helper"
        );

        assert_eq!(
            workspace.path_to_module_name(&src_dir.join("Pages").join("Home").join("View.elm")),
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
        let result = workspace
            .move_file(&helper_uri, "src/Utils/Helper.elm")
            .unwrap();

        assert_eq!(result.old_module_name, "Helper");
        assert_eq!(result.new_module_name, "Utils.Helper");

        // Should have updates in Main.elm for the import
        assert!(result.files_updated > 0);

        drop(temp_dir);
    }

    #[test]
    fn test_find_module_declaration_range() {
        let content = "module MyModule exposing (..)\n\nvalue = 42";
        let range = file_operations::find_module_declaration_range(content);

        assert!(range.is_some());
        let range = range.unwrap();
        assert_eq!(range.start.line, 0);
        assert_eq!(range.start.character, 0);
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
