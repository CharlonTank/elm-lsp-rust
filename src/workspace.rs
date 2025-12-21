use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tower_lsp::lsp_types::*;
use walkdir::WalkDir;

use crate::document::ElmSymbol;
use crate::parser::ElmParser;

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

/// The workspace index - tracks all symbols across all files
pub struct Workspace {
    pub root_path: PathBuf,
    pub source_dirs: Vec<PathBuf>,
    pub modules: HashMap<String, ElmModule>,
    pub symbols: HashMap<String, Vec<GlobalSymbol>>,
    pub references: HashMap<String, Vec<SymbolReference>>,
    pub parser: ElmParser,
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

        Ok(())
    }

    fn parse_elm_json(&mut self, content: &str) -> anyhow::Result<()> {
        let json: serde_json::Value = serde_json::from_str(content)?;

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

    /// Index all .elm files in the workspace
    pub fn index_all_files(&mut self) -> anyhow::Result<()> {
        let mut files_to_index = Vec::new();

        for source_dir in &self.source_dirs {
            for entry in WalkDir::new(source_dir)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let path = entry.path();
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

            // Add symbols to global index
            for symbol in &symbols {
                let qualified_name = format!("{}.{}", module_name, symbol.name);

                let global_symbol = GlobalSymbol {
                    name: symbol.name.clone(),
                    module_name: module_name.clone(),
                    kind: symbol.kind,
                    definition_uri: uri.clone(),
                    definition_range: symbol.range,
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

        // Re-index the file
        if let Some(tree) = self.parser.parse(content) {
            let symbols = self.parser.extract_symbols(&tree, content);
            let module_name = self.extract_module_name(&tree, content)
                .unwrap_or_else(|| self.path_to_module_name(&path));
            let imports = self.extract_imports(&tree, content);
            let exposing = self.extract_exposing(&tree, content);

            for symbol in &symbols {
                let global_symbol = GlobalSymbol {
                    name: symbol.name.clone(),
                    module_name: module_name.clone(),
                    kind: symbol.kind,
                    definition_uri: uri.clone(),
                    definition_range: symbol.range,
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
                "exposed_value" | "exposed_type" => {
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        if inner_child.kind() == "lower_case_identifier"
                            || inner_child.kind() == "upper_case_identifier"
                        {
                            exposed.push(source[inner_child.byte_range()].to_string());
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
        match node.kind() {
            "value_qid" | "upper_case_qid" => {
                // Skip module names in import clauses (but allow exposed items)
                if !self.is_module_name_in_import(node) {
                    let text = &source[node.byte_range()];

                    // For qualified names like "Module.symbol", only track the symbol part
                    // The range should only cover the last part (after the last dot)
                    if text.contains('.') {
                        // Extract just the symbol name (last part after dot)
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
                            });
                    } else {
                        // Unqualified name - track the whole thing
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
                            });
                    }
                }
            }
            "lower_case_identifier" | "upper_case_identifier" => {
                // Only track if it's a reference (not in declaration context)
                if !self.is_in_declaration_context(node) {
                    let text = &source[node.byte_range()];
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
                "type_alias_declaration" | "port_annotation" |
                "module_declaration" => return true,
                // If inside a qualified identifier, this is a module prefix, not a symbol reference
                "value_qid" | "upper_case_qid" => return true,
                // For import clauses, skip the module name but allow exposed items
                "import_clause" => {
                    // Check if we're in an exposing_list - those ARE valid references
                    let mut check = node.parent();
                    while let Some(p) = check {
                        if p.kind() == "exposing_list" || p.kind() == "exposed_type" || p.kind() == "exposed_value" {
                            return false; // This is an exposed item, not a declaration
                        }
                        if p.kind() == "import_clause" {
                            break;
                        }
                        check = p.parent();
                    }
                    return true; // Module name in import, skip it
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

    /// Move a function from one module to another
    /// Returns the workspace edits needed to perform the move
    pub fn move_function(
        &self,
        source_uri: &Url,
        function_name: &str,
        target_path: &Path,
    ) -> anyhow::Result<MoveResult> {
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
        _type_name: &str,
        variant_name: &str,
        _variant_index: usize,
        total_variants: usize,
    ) -> anyhow::Result<RemoveVariantResult> {
        // 1. Validate: can't remove if only 1 variant
        if total_variants <= 1 {
            return Ok(RemoveVariantResult::error("Cannot remove the only variant from a type"));
        }

        // 2. Check for usages and separate blocking from auto-removable
        let usages = self.get_variant_usages(uri, variant_name);

        // Constructor usages are blocking - user must replace them manually
        let blocking: Vec<_> = usages
            .iter()
            .filter(|u| u.usage_type == UsageType::Constructor)
            .cloned()
            .collect();

        if !blocking.is_empty() {
            return Ok(RemoveVariantResult {
                success: false,
                message: format!(
                    "Variant '{}' is used as a constructor in {} place(s). Replace these usages with other variants first.",
                    variant_name,
                    blocking.len()
                ),
                blocking_usages: blocking,
                changes: None,
            });
        }

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

        let message = match (removed_branches, useless_wildcard_count) {
            (0, 0) => format!("Removed variant '{}'", variant_name),
            (b, 0) => format!(
                "Removed variant '{}' and {} pattern match branch(es)",
                variant_name, b
            ),
            (0, w) => format!(
                "Removed variant '{}' and {} useless wildcard(s)",
                variant_name, w
            ),
            (b, w) => format!(
                "Removed variant '{}', {} pattern match branch(es), and {} useless wildcard(s)",
                variant_name, b, w
            ),
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
    fn get_module_name_from_uri(&self, uri: &Url) -> String {
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
    pub fn get_variant_usages(&self, source_uri: &Url, variant_name: &str) -> Vec<VariantUsage> {
        let refs = self.find_references(variant_name, None);
        let mut usages = Vec::new();

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

            let module_name = self.get_module_name_from_uri(&uri);

            // Process all refs in this file with the cached tree
            for r in file_refs {
                let position = Position {
                    line: r.range.start.line,
                    character: r.range.start.character,
                };

                // Use pre-parsed tree for classification
                let usage_type = self.classify_usage_with_tree(&tree, &content, position);

                // Skip type signatures and definitions
                if matches!(usage_type, UsageType::TypeSignature | UsageType::Definition) {
                    continue;
                }

                // Get pattern branch range using pre-parsed tree
                let pattern_branch_range = if usage_type == UsageType::PatternMatch {
                    self.get_pattern_branch_range_with_tree(&tree, &content, position)
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
                    module_name: module_name.clone(),
                    call_chain: Vec::new(),
                    usage_type,
                    pattern_branch_range,
                });
            }
        }

        usages
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

        // Remove .elm extension
        let stem = path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        // Get parent path components, skipping "src" if present
        let mut parts: Vec<&str> = Vec::new();
        if let Some(parent) = path.parent() {
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
