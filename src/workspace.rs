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
        let target_lines: Vec<&str> = target_content.lines().collect();

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

        // 2. Check for blocking usages
        let usages = self.get_variant_usages(uri, variant_name);
        let blocking: Vec<_> = usages.iter().filter(|u| u.is_blocking).cloned().collect();

        if !blocking.is_empty() {
            return Ok(RemoveVariantResult {
                success: false,
                message: format!(
                    "Variant '{}' is used in {} place(s). Replace these usages with other variants first.",
                    variant_name,
                    blocking.len()
                ),
                blocking_usages: blocking,
                changes: None,
            });
        }

        // 3. Safe to remove - read file and find the variant line
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

        // 4. Create TextEdit to remove the variant
        let mut changes = HashMap::new();
        let edit = if is_first_variant {
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

        changes.insert(uri.clone(), edit);

        Ok(RemoveVariantResult::success(
            &format!("Removed variant '{}'", variant_name),
            changes,
        ))
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
    fn get_variant_usages(&self, source_uri: &Url, variant_name: &str) -> Vec<VariantUsage> {
        let refs = self.find_references(variant_name, None);
        let mut usages = Vec::new();

        // Get the variant definition line to skip it
        let source_path = source_uri.to_file_path().ok();
        let source_content = source_path.as_ref().and_then(|p| std::fs::read_to_string(p).ok());

        for r in refs {
            // Skip the definition itself
            if r.is_definition {
                continue;
            }

            // Skip Evergreen migration files - they are historical snapshots
            if r.uri.path().contains("/Evergreen/") {
                continue;
            }

            // Skip the variant declaration in the type definition
            // Check if this reference is in the type definition area
            if r.uri == *source_uri {
                if let Some(ref content) = source_content {
                    let lines: Vec<&str> = content.lines().collect();
                    if let Some(line) = lines.get(r.range.start.line as usize) {
                        let trimmed = line.trim();
                        // Skip lines that look like type variant declarations
                        if (trimmed.starts_with('=') || trimmed.starts_with('|'))
                            && trimmed.contains(variant_name)
                        {
                            continue;
                        }
                    }
                }
            }

            // ANY explicit usage of the variant is blocking
            // If you use Red -> ... in a case, removing Red breaks that line
            // Wildcards only help when the variant is NOT explicitly mentioned
            let is_blocking = true;

            let context = self.get_usage_context(&r.uri, r.range.start.line);

            // Find the enclosing function and module
            let (function_name, module_name) = self
                .find_enclosing_function(&r.uri, r.range.start)
                .unwrap_or_else(|| (String::new(), self.get_module_name_from_uri(&r.uri)));

            // Build the call chain from this function up to entry points
            let call_chain = if !function_name.is_empty() {
                let mut visited = std::collections::HashSet::new();
                self.build_call_chain(
                    &function_name,
                    &module_name,
                    &r.uri,
                    r.range.start.line,
                    &mut visited,
                    0,
                )
            } else {
                Vec::new()
            };

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
                module_name,
                call_chain,
            });
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
}

/// Result of a remove variant operation
#[derive(Debug)]
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
