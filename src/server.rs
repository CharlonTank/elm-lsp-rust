use dashmap::DashMap;
use std::path::PathBuf;
use std::sync::RwLock;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer};

use crate::diagnostics::DiagnosticsProvider;
use crate::document::{Document, VariantInfo};
use crate::parser::ElmParser;
use crate::workspace::Workspace;

// Custom commands
const CMD_MOVE_FUNCTION: &str = "elm.moveFunction";
const CMD_GET_DIAGNOSTICS: &str = "elm.getDiagnostics";
const CMD_PREPARE_REMOVE_VARIANT: &str = "elm.prepareRemoveVariant";
const CMD_REMOVE_VARIANT: &str = "elm.removeVariant";
const CMD_RENAME_FILE: &str = "elm.renameFile";
const CMD_MOVE_FILE: &str = "elm.moveFile";
const CMD_RENAME_VARIANT: &str = "elm.renameVariant";
const CMD_RENAME_TYPE: &str = "elm.renameType";
const CMD_RENAME_FUNCTION: &str = "elm.renameFunction";

pub struct ElmLanguageServer {
    client: Client,
    documents: DashMap<Url, Document>,
    parser: ElmParser,
    workspace: RwLock<Option<Workspace>>,
    diagnostics_provider: RwLock<DiagnosticsProvider>,
}

impl ElmLanguageServer {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            documents: DashMap::new(),
            parser: ElmParser::new(),
            workspace: RwLock::new(None),
            diagnostics_provider: RwLock::new(DiagnosticsProvider::new()),
        }
    }

    async fn on_change(&self, uri: Url, text: String, version: i32) {
        tracing::info!("on_change: uri={}, text_len={}", uri, text.len());
        let doc = Document::new(uri.clone(), text.clone(), version);

        if let Some(tree) = self.parser.parse(&text) {
            let symbols = self.parser.extract_symbols(&tree, &text);
            tracing::info!("Parsed {} symbols", symbols.len());
            let mut doc = doc;
            doc.symbols = symbols;
            self.documents.insert(uri.clone(), doc);

            // Update workspace index
            if let Ok(mut ws) = self.workspace.write() {
                if let Some(workspace) = ws.as_mut() {
                    workspace.update_file(&uri, &text);
                }
            }
        } else {
            tracing::warn!("Failed to parse document");
            self.documents.insert(uri.clone(), doc);
        }

        let diagnostics = self.get_diagnostics(&uri);
        self.client
            .publish_diagnostics(uri, diagnostics, None)
            .await;
    }

    fn get_diagnostics(&self, uri: &Url) -> Vec<Diagnostic> {
        if let Ok(provider) = self.diagnostics_provider.read() {
            provider.get_diagnostics(uri)
        } else {
            Vec::new()
        }
    }

    /// Get the word at a position in the document
    fn get_word_at_position(&self, uri: &Url, position: Position) -> Option<String> {
        // Try from open document first
        if let Some(doc) = self.documents.get(uri) {
            if let Some(line) = doc.get_line(position.line) {
                return self.extract_word_from_line(&line, position.character as usize);
            }
        }

        // Fallback: read from disk if document not open
        if let Ok(path) = uri.to_file_path() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Some(line) = content.lines().nth(position.line as usize) {
                    return self.extract_word_from_line(line, position.character as usize);
                }
            }
        }

        None
    }

    fn extract_word_from_line(&self, line: &str, col: usize) -> Option<String> {
        if col >= line.len() {
            return None;
        }

        // Find word boundaries
        let chars: Vec<char> = line.chars().collect();
        let mut start = col;
        let mut end = col;

        while start > 0 && (chars[start - 1].is_alphanumeric() || chars[start - 1] == '_' || chars[start - 1] == '.') {
            start -= 1;
        }

        while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_' || chars[end] == '.') {
            end += 1;
        }

        if start < end {
            Some(chars[start..end].iter().collect())
        } else {
            None
        }
    }

    fn get_variant_at_position(&self, uri: &Url, position: Position) -> Option<(String, VariantInfo, usize, usize, Vec<String>)> {
        if let Some(doc) = self.documents.get(uri) {
            for symbol in &doc.symbols {
                if symbol.kind == SymbolKind::ENUM {
                    for (idx, variant) in symbol.variants.iter().enumerate() {
                        if variant.range.start.line == position.line
                            && position.character >= variant.range.start.character
                            && position.character <= variant.range.end.character
                        {
                            let all_variants: Vec<String> = symbol.variants.iter()
                                .map(|v| v.name.clone())
                                .collect();
                            return Some((
                                symbol.name.clone(),
                                variant.clone(),
                                idx,
                                symbol.variants.len(),
                                all_variants,
                            ));
                        }
                    }
                }
            }
        }
        None
    }

    /// Get the type (custom type or type alias) at a position
    /// Returns (symbol_name, definition_range) if found
    fn get_type_at_position(&self, uri: &Url, position: Position) -> Option<(String, Range)> {
        if let Some(doc) = self.documents.get(uri) {
            for symbol in &doc.symbols {
                // ENUM = custom type, STRUCT = type alias
                if symbol.kind == SymbolKind::ENUM || symbol.kind == SymbolKind::STRUCT {
                    // Check if position is on the type name (definition_range)
                    if let Some(def_range) = symbol.definition_range {
                        if position.line == def_range.start.line
                            && position.character >= def_range.start.character
                            && position.character <= def_range.end.character
                        {
                            return Some((symbol.name.clone(), def_range));
                        }
                    }
                }
            }
        }
        None
    }

    /// Get the function at a position
    /// Returns (symbol_name, definition_range) if found
    fn get_function_at_position(&self, uri: &Url, position: Position) -> Option<(String, Range)> {
        if let Some(doc) = self.documents.get(uri) {
            for symbol in &doc.symbols {
                if symbol.kind == SymbolKind::FUNCTION {
                    // Check if position is on the function name (definition_range)
                    if let Some(def_range) = symbol.definition_range {
                        if position.line == def_range.start.line
                            && position.character >= def_range.start.character
                            && position.character <= def_range.end.character
                        {
                            return Some((symbol.name.clone(), def_range));
                        }
                    }

                    // Also check if position is on the type annotation name
                    if let Some(annot_range) = symbol.type_annotation_range {
                        if position.line == annot_range.start.line
                            && position.character >= annot_range.start.character
                            && position.character <= annot_range.end.character
                        {
                            // Return the definition_range for the actual rename operation
                            if let Some(def_range) = symbol.definition_range {
                                return Some((symbol.name.clone(), def_range));
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Classify what kind of symbol is at a position
    /// Returns: "variant", "type", "function", "field", or "unknown"
    fn get_symbol_kind_at_position(&self, uri: &Url, position: Position, text: &str) -> &'static str {
        // Check for variant first (most specific)
        if self.get_variant_at_position(uri, position).is_some() {
            return "variant";
        }

        // Check for field
        if let Ok(ws) = self.workspace.read() {
            if let Some(workspace) = ws.as_ref() {
                if workspace.get_field_at_position(uri, position, text).is_some() {
                    return "field";
                }
            }
        }

        // Check for type
        if self.get_type_at_position(uri, position).is_some() {
            return "type";
        }

        // Check for function
        if self.get_function_at_position(uri, position).is_some() {
            return "function";
        }

        "unknown"
    }

    /// Rename a symbol by its name directly (without using position lookup)
    fn rename_symbol_by_name(
        &self,
        uri: &Url,
        name: &str,
        new_name: &str,
    ) -> Result<Option<WorkspaceEdit>> {
        tracing::info!("Renaming {} to {}", name, new_name);
        let mut changes: std::collections::HashMap<Url, Vec<TextEdit>> = std::collections::HashMap::new();

        // Get cross-file references from workspace
        if let Ok(ws) = self.workspace.read() {
            if let Some(workspace) = ws.as_ref() {
                // Add definition location - prefer definition in the current file, skip Evergreen
                let definition = workspace.get_symbols(name)
                    .into_iter()
                    .find(|s| &s.definition_uri == uri && !s.definition_uri.path().contains("/Evergreen/"))
                    .or_else(|| {
                        workspace.find_definition(name)
                            .filter(|s| !s.definition_uri.path().contains("/Evergreen/"))
                    });

                // Track ranges we've already added to avoid duplicates
                let mut seen_ranges: std::collections::HashSet<(String, u32, u32, u32, u32)> = std::collections::HashSet::new();

                if let Some(symbol) = definition {
                    let key = (
                        symbol.definition_uri.to_string(),
                        symbol.definition_range.start.line,
                        symbol.definition_range.start.character,
                        symbol.definition_range.end.line,
                        symbol.definition_range.end.character,
                    );
                    seen_ranges.insert(key);
                    changes
                        .entry(symbol.definition_uri.clone())
                        .or_insert_with(Vec::new)
                        .push(TextEdit {
                            range: symbol.definition_range,
                            new_text: new_name.to_string(),
                        });

                    // Use module-aware references to only rename in files that import this symbol
                    let refs = workspace.find_module_aware_references(
                        name,
                        &symbol.module_name,
                        &symbol.definition_uri,
                    );
                    for r in refs {
                        // Skip Evergreen files - they are migration snapshots
                        if r.uri.path().contains("/Evergreen/") {
                            continue;
                        }
                        // Skip if we already have an edit for this exact range
                        let key = (
                            r.uri.to_string(),
                            r.range.start.line,
                            r.range.start.character,
                            r.range.end.line,
                            r.range.end.character,
                        );
                        if seen_ranges.contains(&key) {
                            continue;
                        }
                        seen_ranges.insert(key);
                        changes
                            .entry(r.uri)
                            .or_insert_with(Vec::new)
                            .push(TextEdit {
                                range: r.range,
                                new_text: new_name.to_string(),
                            });
                    }
                }
            }
        }

        // Fallback to local rename if no workspace refs
        if changes.is_empty() {
            if let Some(doc) = self.documents.get(uri) {
                if let Some(symbol) = doc.symbols.iter().find(|s| s.name == name) {
                    // Use definition_range (just the name) instead of range (full body)
                    let def_range = symbol.definition_range.unwrap_or(symbol.range);
                    let mut edits = vec![TextEdit {
                        range: def_range,
                        new_text: new_name.to_string(),
                    }];
                    for range in &symbol.references {
                        edits.push(TextEdit {
                            range: *range,
                            new_text: new_name.to_string(),
                        });
                    }
                    changes.insert(uri.clone(), edits);
                }
            }
        }

        if !changes.is_empty() {
            tracing::info!("Rename affects {} files", changes.len());
            return Ok(Some(WorkspaceEdit {
                changes: Some(changes),
                ..Default::default()
            }));
        }

        Ok(None)
    }

    /// Rename a variant using its definition range directly
    /// Variants are not indexed as top-level symbols, so we need this specialized function
    fn rename_variant_by_range(
        &self,
        uri: &Url,
        variant_name: &str,
        variant_definition_range: Range,
        new_name: &str,
    ) -> Result<Option<WorkspaceEdit>> {
        tracing::info!("Renaming variant {} to {} (range: {:?})", variant_name, new_name, variant_definition_range);
        let mut changes: std::collections::HashMap<Url, Vec<TextEdit>> = std::collections::HashMap::new();

        // Track ranges we've already added to avoid duplicates
        let mut seen_ranges: std::collections::HashSet<(String, u32, u32, u32, u32)> = std::collections::HashSet::new();

        // Add the definition edit using the provided range
        let def_key = (
            uri.to_string(),
            variant_definition_range.start.line,
            variant_definition_range.start.character,
            variant_definition_range.end.line,
            variant_definition_range.end.character,
        );
        seen_ranges.insert(def_key);
        changes
            .entry(uri.clone())
            .or_insert_with(Vec::new)
            .push(TextEdit {
                range: variant_definition_range,
                new_text: new_name.to_string(),
            });

        // Get all references from workspace
        if let Ok(ws) = self.workspace.read() {
            if let Some(workspace) = ws.as_ref() {
                let refs = workspace.find_references(variant_name, None);
                for r in refs {
                    // Skip Evergreen files
                    if r.uri.path().contains("/Evergreen/") {
                        continue;
                    }
                    // Skip if we already have an edit for this exact range
                    let key = (
                        r.uri.to_string(),
                        r.range.start.line,
                        r.range.start.character,
                        r.range.end.line,
                        r.range.end.character,
                    );
                    if seen_ranges.contains(&key) {
                        continue;
                    }
                    seen_ranges.insert(key);
                    changes
                        .entry(r.uri)
                        .or_insert_with(Vec::new)
                        .push(TextEdit {
                            range: r.range,
                            new_text: new_name.to_string(),
                        });
                }
            }
        }

        if !changes.is_empty() {
            tracing::info!("Variant rename affects {} files", changes.len());
            return Ok(Some(WorkspaceEdit {
                changes: Some(changes),
                ..Default::default()
            }));
        }

        Ok(None)
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for ElmLanguageServer {
    async fn initialize(&self, params: InitializeParams) -> Result<InitializeResult> {
        tracing::info!("initialize: received request");

        // Initialize workspace if we have a root
        if let Some(root_uri) = params.root_uri {
            if let Ok(path) = root_uri.to_file_path() {
                tracing::info!("Initializing workspace at {:?}", path);

                // Set diagnostics provider workspace root
                if let Ok(mut diag) = self.diagnostics_provider.write() {
                    diag.set_workspace_root(&path.to_string_lossy());
                }

                let mut workspace = Workspace::new(path);
                if let Err(e) = workspace.initialize() {
                    tracing::error!("Failed to initialize workspace: {}", e);
                } else {
                    let module_count = workspace.modules.len();
                    let symbol_count: usize = workspace.symbols.values().map(|v| v.len()).sum();
                    tracing::info!("Workspace initialized: {} modules, {} symbols", module_count, symbol_count);

                    if let Ok(mut ws) = self.workspace.write() {
                        *ws = Some(workspace);
                    }
                }
            }
        }

        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                definition_provider: Some(OneOf::Left(true)),
                references_provider: Some(OneOf::Left(true)),
                document_symbol_provider: Some(OneOf::Left(true)),
                workspace_symbol_provider: Some(OneOf::Left(true)),
                completion_provider: Some(CompletionOptions {
                    trigger_characters: Some(vec![".".to_string()]),
                    ..Default::default()
                }),
                rename_provider: Some(OneOf::Right(RenameOptions {
                    prepare_provider: Some(true),
                    work_done_progress_options: Default::default(),
                })),
                code_action_provider: Some(CodeActionProviderCapability::Simple(true)),
                execute_command_provider: Some(ExecuteCommandOptions {
                    commands: vec![
                        CMD_MOVE_FUNCTION.to_string(),
                        CMD_GET_DIAGNOSTICS.to_string(),
                        CMD_PREPARE_REMOVE_VARIANT.to_string(),
                        CMD_REMOVE_VARIANT.to_string(),
                        CMD_RENAME_FILE.to_string(),
                        CMD_MOVE_FILE.to_string(),
                    ],
                    ..Default::default()
                }),
                ..Default::default()
            },
            server_info: Some(ServerInfo {
                name: "elm-lsp-rust".to_string(),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }),
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        tracing::info!("initialized: received notification");

        // Log workspace status - get message first, then await
        let message = {
            if let Ok(ws) = self.workspace.read() {
                if let Some(workspace) = ws.as_ref() {
                    format!("Elm LSP (Rust) initialized: {} modules indexed", workspace.modules.len())
                } else {
                    "Elm LSP (Rust) initialized (no workspace)".to_string()
                }
            } else {
                "Elm LSP (Rust) initialized".to_string()
            }
        };

        self.client.log_message(MessageType::INFO, message).await;
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        tracing::info!("did_open: uri={}", params.text_document.uri);
        let uri = params.text_document.uri;
        let text = params.text_document.text;
        let version = params.text_document.version;
        self.on_change(uri, text, version).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri;
        let version = params.text_document.version;
        if let Some(change) = params.content_changes.into_iter().next() {
            self.on_change(uri, change.text, version).await;
        }
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        self.documents.remove(&params.text_document.uri);
    }

    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let uri = &params.text_document_position_params.text_document.uri;
        let position = params.text_document_position_params.position;

        // First try local document
        if let Some(doc) = self.documents.get(uri) {
            if let Some(symbol) = doc.get_symbol_at_position(position) {
                return Ok(Some(Hover {
                    contents: HoverContents::Markup(MarkupContent {
                        kind: MarkupKind::Markdown,
                        value: format!(
                            "```elm\n{}\n```\n\n{}",
                            symbol.signature.as_deref().unwrap_or(&symbol.name),
                            symbol.documentation.as_deref().unwrap_or("")
                        ),
                    }),
                    range: Some(symbol.range),
                }));
            }
        }

        // Try workspace lookup
        if let Some(word) = self.get_word_at_position(uri, position) {
            if let Ok(ws) = self.workspace.read() {
                if let Some(workspace) = ws.as_ref() {
                    if let Some(symbol) = workspace.find_definition(&word) {
                        return Ok(Some(Hover {
                            contents: HoverContents::Markup(MarkupContent {
                                kind: MarkupKind::Markdown,
                                value: format!(
                                    "```elm\n{}\n```\n\n*Defined in {}*",
                                    symbol.signature.as_deref().unwrap_or(&symbol.name),
                                    symbol.module_name
                                ),
                            }),
                            range: None,
                        }));
                    }
                }
            }
        }

        Ok(None)
    }

    async fn goto_definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        let uri = &params.text_document_position_params.text_document.uri;
        let position = params.text_document_position_params.position;

        // First try local document
        if let Some(doc) = self.documents.get(uri) {
            if let Some(symbol) = doc.get_symbol_at_position(position) {
                return Ok(Some(GotoDefinitionResponse::Scalar(Location {
                    uri: uri.clone(),
                    range: symbol.definition_range.unwrap_or(symbol.range),
                })));
            }
        }

        // Try workspace lookup for cross-file definition
        if let Some(word) = self.get_word_at_position(uri, position) {
            tracing::info!("Looking up definition for: {}", word);
            if let Ok(ws) = self.workspace.read() {
                if let Some(workspace) = ws.as_ref() {
                    if let Some(symbol) = workspace.find_definition(&word) {
                        tracing::info!("Found definition in {}", symbol.module_name);
                        return Ok(Some(GotoDefinitionResponse::Scalar(Location {
                            uri: symbol.definition_uri.clone(),
                            range: symbol.definition_range,
                        })));
                    }
                }
            }
        }

        Ok(None)
    }

    async fn references(&self, params: ReferenceParams) -> Result<Option<Vec<Location>>> {
        let uri = &params.text_document_position.text_document.uri;
        let position = params.text_document_position.position;

        // Get the symbol name at position
        let symbol_name = if let Some(doc) = self.documents.get(uri) {
            doc.get_symbol_at_position(position).map(|s| s.name.clone())
        } else {
            None
        };

        let symbol_name = symbol_name.or_else(|| self.get_word_at_position(uri, position));

        if let Some(name) = symbol_name {
            tracing::info!("Finding references for: {}", name);

            // Get cross-file references from workspace
            if let Ok(ws) = self.workspace.read() {
                if let Some(workspace) = ws.as_ref() {
                    let refs = workspace.find_references(&name, None);
                    if !refs.is_empty() {
                        let locations: Vec<Location> = refs
                            .into_iter()
                            .map(|r| Location {
                                uri: r.uri,
                                range: r.range,
                            })
                            .collect();
                        tracing::info!("Found {} references", locations.len());
                        return Ok(Some(locations));
                    }
                }
            }

            // Fallback to local references
            if let Some(doc) = self.documents.get(uri) {
                if let Some(symbol) = doc.symbols.iter().find(|s| s.name == name) {
                    let mut locations: Vec<Location> = vec![Location {
                        uri: uri.clone(),
                        range: symbol.range,
                    }];
                    for range in &symbol.references {
                        locations.push(Location {
                            uri: uri.clone(),
                            range: *range,
                        });
                    }
                    return Ok(Some(locations));
                }
            }
        }

        Ok(None)
    }

    async fn document_symbol(
        &self,
        params: DocumentSymbolParams,
    ) -> Result<Option<DocumentSymbolResponse>> {
        let uri = &params.text_document.uri;

        if let Some(doc) = self.documents.get(uri) {
            let symbols: Vec<SymbolInformation> = doc
                .symbols
                .iter()
                .map(|s| {
                    #[allow(deprecated)]
                    SymbolInformation {
                        name: s.name.clone(),
                        kind: s.kind,
                        tags: None,
                        deprecated: None,
                        location: Location {
                            uri: uri.clone(),
                            range: s.range,
                        },
                        container_name: None,
                    }
                })
                .collect();
            return Ok(Some(DocumentSymbolResponse::Flat(symbols)));
        }

        Ok(None)
    }

    async fn symbol(
        &self,
        params: WorkspaceSymbolParams,
    ) -> Result<Option<Vec<SymbolInformation>>> {
        let query = params.query.to_lowercase();
        let mut results = Vec::new();

        if let Ok(ws) = self.workspace.read() {
            if let Some(workspace) = ws.as_ref() {
                for (name, symbols) in &workspace.symbols {
                    if name.to_lowercase().contains(&query) {
                        for sym in symbols {
                            #[allow(deprecated)]
                            results.push(SymbolInformation {
                                name: format!("{}.{}", sym.module_name, sym.name),
                                kind: sym.kind,
                                tags: None,
                                deprecated: None,
                                location: Location {
                                    uri: sym.definition_uri.clone(),
                                    range: sym.definition_range,
                                },
                                container_name: Some(sym.module_name.clone()),
                            });
                        }
                    }
                }
            }
        }

        if results.is_empty() {
            Ok(None)
        } else {
            Ok(Some(results))
        }
    }

    async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>> {
        use std::collections::HashSet;

        let uri = &params.text_document_position.text_document.uri;
        let mut items = Vec::new();
        let mut seen_labels: HashSet<String> = HashSet::new();

        // Limit to prevent timeout on large workspaces
        const MAX_COMPLETION_ITEMS: usize = 1000;

        // Local symbols (prioritized)
        if let Some(doc) = self.documents.get(uri) {
            for s in doc.symbols.iter() {
                if items.len() >= MAX_COMPLETION_ITEMS {
                    break;
                }
                seen_labels.insert(s.name.clone());
                items.push(CompletionItem {
                    label: s.name.clone(),
                    kind: Some(match s.kind {
                        SymbolKind::FUNCTION => CompletionItemKind::FUNCTION,
                        SymbolKind::CONSTANT => CompletionItemKind::CONSTANT,
                        SymbolKind::STRUCT => CompletionItemKind::STRUCT,
                        SymbolKind::ENUM => CompletionItemKind::ENUM,
                        SymbolKind::ENUM_MEMBER => CompletionItemKind::ENUM_MEMBER,
                        _ => CompletionItemKind::TEXT,
                    }),
                    detail: s.signature.clone(),
                    ..Default::default()
                });
            }
        }

        // Workspace symbols
        if let Ok(ws) = self.workspace.read() {
            if let Some(workspace) = ws.as_ref() {
                'outer: for symbols in workspace.symbols.values() {
                    for sym in symbols {
                        if items.len() >= MAX_COMPLETION_ITEMS {
                            break 'outer;
                        }
                        // Use HashSet for O(1) duplicate check instead of O(n)
                        if !seen_labels.contains(&sym.name) {
                            seen_labels.insert(sym.name.clone());
                            items.push(CompletionItem {
                                label: sym.name.clone(),
                                kind: Some(match sym.kind {
                                    SymbolKind::FUNCTION => CompletionItemKind::FUNCTION,
                                    SymbolKind::STRUCT => CompletionItemKind::STRUCT,
                                    SymbolKind::ENUM => CompletionItemKind::ENUM,
                                    _ => CompletionItemKind::TEXT,
                                }),
                                detail: sym.signature.clone(),
                                label_details: Some(CompletionItemLabelDetails {
                                    detail: Some(format!(" ({})", sym.module_name)),
                                    description: None,
                                }),
                                ..Default::default()
                            });
                        }
                    }
                }
            }
        }

        if items.is_empty() {
            Ok(None)
        } else {
            Ok(Some(CompletionResponse::Array(items)))
        }
    }

    async fn prepare_rename(
        &self,
        params: TextDocumentPositionParams,
    ) -> Result<Option<PrepareRenameResponse>> {
        let uri = &params.text_document.uri;
        let position = params.position;

        // First check if this is a field rename
        if let Some(doc) = self.documents.get(uri) {
            if let Ok(ws) = self.workspace.read() {
                if let Some(workspace) = ws.as_ref() {
                    if let Some(field_info) = workspace.get_field_at_position(uri, position, &doc.text) {
                        return Ok(Some(PrepareRenameResponse::RangeWithPlaceholder {
                            range: field_info.range,
                            placeholder: field_info.name.clone(),
                        }));
                    }
                }
            }
        }

        // Fall back to symbol rename
        if let Some(doc) = self.documents.get(uri) {
            if let Some(symbol) = doc.get_symbol_at_position(position) {
                // Check if this is a protected Lamdera type
                if let Ok(ws) = self.workspace.read() {
                    if let Some(workspace) = ws.as_ref() {
                        if workspace.is_protected_lamdera_type(&symbol.name) {
                            // Cannot rename protected Lamdera types
                            return Ok(None);
                        }
                    }
                }
                return Ok(Some(PrepareRenameResponse::RangeWithPlaceholder {
                    range: symbol.range,
                    placeholder: symbol.name.clone(),
                }));
            }
        }

        Ok(None)
    }

    async fn rename(&self, params: RenameParams) -> Result<Option<WorkspaceEdit>> {
        let uri = &params.text_document_position.text_document.uri;
        let position = params.text_document_position.position;
        let new_name = params.new_name;

        // First check if this is a field rename
        if let Some(doc) = self.documents.get(uri) {
            if let Ok(ws) = self.workspace.read() {
                if let Some(workspace) = ws.as_ref() {
                    if let Some(field_info) = workspace.get_field_at_position(uri, position, &doc.text) {
                        tracing::info!(
                            "Renaming field {} in type alias {:?} to {}",
                            field_info.name,
                            field_info.definition.type_alias_name,
                            new_name
                        );

                        // Find all field references using type inference
                        let refs = workspace.find_field_references(&field_info.name, &field_info.definition);

                        let mut changes: std::collections::HashMap<Url, Vec<TextEdit>> = std::collections::HashMap::new();

                        for r in refs {
                            changes
                                .entry(r.uri)
                                .or_insert_with(Vec::new)
                                .push(TextEdit {
                                    range: r.range,
                                    new_text: new_name.clone(),
                                });
                        }

                        if !changes.is_empty() {
                            tracing::info!("Field rename affects {} files", changes.len());
                            return Ok(Some(WorkspaceEdit {
                                changes: Some(changes),
                                ..Default::default()
                            }));
                        }
                    }
                }
            }
        }

        // Fall back to symbol rename
        let symbol_name = if let Some(doc) = self.documents.get(uri) {
            doc.get_symbol_at_position(position).map(|s| s.name.clone())
        } else {
            None
        };

        let symbol_name = symbol_name.or_else(|| self.get_word_at_position(uri, position));

        if let Some(name) = symbol_name {
            // Check if this is a protected Lamdera type
            if let Ok(ws) = self.workspace.read() {
                if let Some(workspace) = ws.as_ref() {
                    if workspace.is_protected_lamdera_type(&name) {
                        tracing::info!("Blocked rename of protected Lamdera type: {}", name);
                        return Ok(None);
                    }
                }
            }

            return self.rename_symbol_by_name(uri, &name, &new_name);
        }

        Ok(None)
    }

    async fn code_action(&self, params: CodeActionParams) -> Result<Option<CodeActionResponse>> {
        let uri = &params.text_document.uri;
        let range = params.range;
        let mut actions = Vec::new();

        // Get word at start of range
        if let Some(word) = self.get_word_at_position(uri, range.start) {
            // Check if it's an undefined symbol that could be imported
            if let Ok(ws) = self.workspace.read() {
                if let Some(workspace) = ws.as_ref() {
                    let symbols = workspace.get_symbols(&word);
                    for sym in symbols {
                        // Create "Add import" action
                        let import_line = format!("import {} exposing ({})\n", sym.module_name, sym.name);

                        let edit = TextEdit {
                            range: Range {
                                start: Position { line: 2, character: 0 },  // After module declaration
                                end: Position { line: 2, character: 0 },
                            },
                            new_text: import_line,
                        };

                        let mut changes = std::collections::HashMap::new();
                        changes.insert(uri.clone(), vec![edit]);

                        actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                            title: format!("Import {} from {}", sym.name, sym.module_name),
                            kind: Some(CodeActionKind::QUICKFIX),
                            edit: Some(WorkspaceEdit {
                                changes: Some(changes),
                                ..Default::default()
                            }),
                            ..Default::default()
                        }));
                    }
                }
            }
        }

        // Check if cursor is on a function that could be exposed
        if let Some(doc) = self.documents.get(uri) {
            if let Some(symbol) = doc.get_symbol_at_position(range.start) {
                if symbol.kind == SymbolKind::FUNCTION {
                    actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                        title: format!("Expose {}", symbol.name),
                        kind: Some(CodeActionKind::REFACTOR),
                        ..Default::default()
                    }));
                }
            }
        }

        if actions.is_empty() {
            Ok(None)
        } else {
            Ok(Some(actions))
        }
    }

    async fn execute_command(&self, params: ExecuteCommandParams) -> Result<Option<serde_json::Value>> {
        tracing::info!("execute_command: {:?}", params.command);

        match params.command.as_str() {
            CMD_MOVE_FUNCTION => {
                // Expected arguments: [source_uri, function_name, target_path]
                if params.arguments.len() != 3 {
                    return Ok(Some(serde_json::json!({
                        "error": "Expected 3 arguments: source_uri, function_name, target_path"
                    })));
                }

                let source_uri: String = serde_json::from_value(params.arguments[0].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let function_name: String = serde_json::from_value(params.arguments[1].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let target_path: String = serde_json::from_value(params.arguments[2].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;

                tracing::info!("Moving {} from {} to {}", function_name, source_uri, target_path);

                let source_uri = Url::parse(&source_uri)
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(format!("Invalid source URI: {}", e)))?;
                let target_path = PathBuf::from(&target_path);

                // Execute the move - extract result before any awaits
                let move_result = {
                    if let Ok(ws) = self.workspace.read() {
                        if let Some(workspace) = ws.as_ref() {
                            workspace.move_function(&source_uri, &function_name, &target_path)
                        } else {
                            Err(anyhow::anyhow!("Workspace not initialized"))
                        }
                    } else {
                        Err(anyhow::anyhow!("Could not acquire workspace lock"))
                    }
                };

                match move_result {
                    Ok(result) => {
                        // Convert to workspace edit and apply
                        let edit = WorkspaceEdit {
                            changes: Some(result.changes),
                            ..Default::default()
                        };

                        // Apply the edit
                        let _ = self.client.apply_edit(edit).await;

                        Ok(Some(serde_json::json!({
                            "success": true,
                            "sourceModule": result.source_module,
                            "targetModule": result.target_module,
                            "functionName": result.function_name,
                            "referencesUpdated": result.references_updated
                        })))
                    }
                    Err(e) => {
                        Ok(Some(serde_json::json!({
                            "error": e.to_string()
                        })))
                    }
                }
            }
            CMD_GET_DIAGNOSTICS => {
                // Expected arguments: [file_uri]
                if params.arguments.is_empty() {
                    return Ok(Some(serde_json::json!({
                        "error": "Expected 1 argument: file_uri"
                    })));
                }

                let file_uri: String = serde_json::from_value(params.arguments[0].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;

                let uri = Url::parse(&file_uri)
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(format!("Invalid URI: {}", e)))?;

                tracing::info!("Getting diagnostics for {}", uri);

                let diagnostics = self.get_diagnostics(&uri);

                // Convert diagnostics to JSON-serializable format
                let diagnostics_json: Vec<serde_json::Value> = diagnostics.iter().map(|d| {
                    serde_json::json!({
                        "range": {
                            "start": { "line": d.range.start.line, "character": d.range.start.character },
                            "end": { "line": d.range.end.line, "character": d.range.end.character }
                        },
                        "severity": match d.severity {
                            Some(DiagnosticSeverity::ERROR) => 1,
                            Some(DiagnosticSeverity::WARNING) => 2,
                            Some(DiagnosticSeverity::INFORMATION) => 3,
                            Some(DiagnosticSeverity::HINT) => 4,
                            _ => 1
                        },
                        "message": d.message,
                        "source": d.source
                    })
                }).collect();

                Ok(Some(serde_json::json!({
                    "uri": file_uri,
                    "diagnostics": diagnostics_json
                })))
            }
            CMD_PREPARE_REMOVE_VARIANT => {
                // Expected arguments: [uri, line, character]
                if params.arguments.len() != 3 {
                    return Ok(Some(serde_json::json!({
                        "error": "Expected 3 arguments: uri, line, character"
                    })));
                }

                let uri_str: String = serde_json::from_value(params.arguments[0].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let line: u32 = serde_json::from_value(params.arguments[1].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let character: u32 = serde_json::from_value(params.arguments[2].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;

                let uri = Url::parse(&uri_str)
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(format!("Invalid URI: {}", e)))?;

                let position = Position { line, character };

                if let Some((type_name, variant, idx, total, all_variants)) = self.get_variant_at_position(&uri, position) {
                    // Get all usages
                    let all_usages = if let Ok(ws) = self.workspace.read() {
                        if let Some(workspace) = ws.as_ref() {
                            workspace.get_variant_usages(&uri, &variant.name)
                        } else {
                            Vec::new()
                        }
                    } else {
                        Vec::new()
                    };

                    // Only constructor usages are truly blocking
                    let blocking_usages: Vec<_> = all_usages.iter()
                        .filter(|u| u.is_blocking)
                        .cloned()
                        .collect();

                    // Pattern match usages can be auto-removed
                    let pattern_usages: Vec<_> = all_usages.iter()
                        .filter(|u| !u.is_blocking)
                        .cloned()
                        .collect();

                    let blocking_count = blocking_usages.len();
                    let pattern_count = pattern_usages.len();
                    let can_remove = total > 1 && blocking_count == 0;

                    // Other variants (excluding the one being removed)
                    let other_variants: Vec<&String> = all_variants.iter()
                        .filter(|v| *v != &variant.name)
                        .collect();

                    Ok(Some(serde_json::json!({
                        "success": true,
                        "typeName": type_name,
                        "variantName": variant.name,
                        "variantIndex": idx,
                        "totalVariants": total,
                        "otherVariants": other_variants,
                        "blockingCount": blocking_count,
                        "patternCount": pattern_count,
                        "canRemove": can_remove,
                        "blockingUsages": blocking_usages,
                        "patternUsages": pattern_usages,
                        "range": {
                            "start": { "line": variant.range.start.line, "character": variant.range.start.character },
                            "end": { "line": variant.range.end.line, "character": variant.range.end.character }
                        }
                    })))
                } else {
                    Ok(Some(serde_json::json!({
                        "success": false,
                        "message": "No variant found at this position"
                    })))
                }
            }
            CMD_REMOVE_VARIANT => {
                // Expected arguments: [uri, line, character]
                if params.arguments.len() != 3 {
                    return Ok(Some(serde_json::json!({
                        "error": "Expected 3 arguments: uri, line, character"
                    })));
                }

                let uri_str: String = serde_json::from_value(params.arguments[0].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let line: u32 = serde_json::from_value(params.arguments[1].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let character: u32 = serde_json::from_value(params.arguments[2].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;

                let uri = Url::parse(&uri_str)
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(format!("Invalid URI: {}", e)))?;

                let position = Position { line, character };

                if let Some((type_name, variant, idx, total, all_variants)) = self.get_variant_at_position(&uri, position) {
                    // Other variants (excluding the one being removed)
                    let other_variants: Vec<&String> = all_variants.iter()
                        .filter(|v| *v != &variant.name)
                        .collect();

                    // Execute removal
                    let remove_result = {
                        if let Ok(ws) = self.workspace.read() {
                            if let Some(workspace) = ws.as_ref() {
                                workspace.remove_variant(&uri, &type_name, &variant.name, idx, total)
                            } else {
                                Err(anyhow::anyhow!("Workspace not initialized"))
                            }
                        } else {
                            Err(anyhow::anyhow!("Could not acquire workspace lock"))
                        }
                    };

                    match remove_result {
                        Ok(result) => {
                            if result.success {
                                // Return the changes for the caller to apply
                                // (instead of trying to apply via workspace/applyEdit which may not be supported)
                                let changes_json = if let Some(ref changes) = result.changes {
                                    let mut changes_map = serde_json::Map::new();
                                    for (uri, edits) in changes {
                                        let edits_json: Vec<serde_json::Value> = edits.iter().map(|edit| {
                                            serde_json::json!({
                                                "range": {
                                                    "start": { "line": edit.range.start.line, "character": edit.range.start.character },
                                                    "end": { "line": edit.range.end.line, "character": edit.range.end.character }
                                                },
                                                "newText": edit.new_text
                                            })
                                        }).collect();
                                        changes_map.insert(uri.to_string(), serde_json::json!(edits_json));
                                    }
                                    Some(serde_json::Value::Object(changes_map))
                                } else {
                                    None
                                };

                                Ok(Some(serde_json::json!({
                                    "success": true,
                                    "message": result.message,
                                    "typeName": type_name,
                                    "variantName": variant.name,
                                    "changes": changes_json
                                })))
                            } else {
                                Ok(Some(serde_json::json!({
                                    "success": false,
                                    "message": result.message,
                                    "typeName": type_name,
                                    "variantName": variant.name,
                                    "otherVariants": other_variants,
                                    "blockingUsages": result.blocking_usages
                                })))
                            }
                        }
                        Err(e) => {
                            Ok(Some(serde_json::json!({
                                "success": false,
                                "message": e.to_string()
                            })))
                        }
                    }
                } else {
                    Ok(Some(serde_json::json!({
                        "success": false,
                        "message": "No variant found at this position"
                    })))
                }
            }
            CMD_RENAME_FILE => {
                // Expected arguments: [file_uri, new_name]
                // new_name is just the filename without path, e.g. "NewName.elm"
                if params.arguments.len() != 2 {
                    return Ok(Some(serde_json::json!({
                        "error": "Expected 2 arguments: file_uri, new_name"
                    })));
                }

                let file_uri: String = serde_json::from_value(params.arguments[0].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let new_name: String = serde_json::from_value(params.arguments[1].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;

                let uri = Url::parse(&file_uri)
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(format!("Invalid URI: {}", e)))?;

                tracing::info!("Renaming file {} to {}", file_uri, new_name);

                let rename_result = {
                    if let Ok(ws) = self.workspace.read() {
                        if let Some(workspace) = ws.as_ref() {
                            workspace.rename_file(&uri, &new_name)
                        } else {
                            Err(anyhow::anyhow!("Workspace not initialized"))
                        }
                    } else {
                        Err(anyhow::anyhow!("Could not acquire workspace lock"))
                    }
                };

                match rename_result {
                    Ok(result) => {
                        // Convert changes to JSON
                        let changes_json = {
                            let mut changes_map = serde_json::Map::new();
                            for (uri, edits) in &result.changes {
                                let edits_json: Vec<serde_json::Value> = edits.iter().map(|edit| {
                                    serde_json::json!({
                                        "range": {
                                            "start": { "line": edit.range.start.line, "character": edit.range.start.character },
                                            "end": { "line": edit.range.end.line, "character": edit.range.end.character }
                                        },
                                        "newText": edit.new_text
                                    })
                                }).collect();
                                changes_map.insert(uri.to_string(), serde_json::json!(edits_json));
                            }
                            serde_json::Value::Object(changes_map)
                        };

                        Ok(Some(serde_json::json!({
                            "success": true,
                            "oldModuleName": result.old_module_name,
                            "newModuleName": result.new_module_name,
                            "oldPath": result.old_path,
                            "newPath": result.new_path,
                            "filesUpdated": result.files_updated,
                            "changes": changes_json
                        })))
                    }
                    Err(e) => {
                        Ok(Some(serde_json::json!({
                            "success": false,
                            "error": e.to_string()
                        })))
                    }
                }
            }
            CMD_MOVE_FILE => {
                // Expected arguments: [file_uri, target_path]
                // target_path is the full path where the file should be moved, e.g. "src/Utils/Helper.elm"
                if params.arguments.len() != 2 {
                    return Ok(Some(serde_json::json!({
                        "error": "Expected 2 arguments: file_uri, target_path"
                    })));
                }

                let file_uri: String = serde_json::from_value(params.arguments[0].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let target_path: String = serde_json::from_value(params.arguments[1].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;

                let uri = Url::parse(&file_uri)
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(format!("Invalid URI: {}", e)))?;

                tracing::info!("Moving file {} to {}", file_uri, target_path);

                let move_result = {
                    if let Ok(ws) = self.workspace.read() {
                        if let Some(workspace) = ws.as_ref() {
                            workspace.move_file(&uri, &target_path)
                        } else {
                            Err(anyhow::anyhow!("Workspace not initialized"))
                        }
                    } else {
                        Err(anyhow::anyhow!("Could not acquire workspace lock"))
                    }
                };

                match move_result {
                    Ok(result) => {
                        // Convert changes to JSON
                        let changes_json = {
                            let mut changes_map = serde_json::Map::new();
                            for (uri, edits) in &result.changes {
                                let edits_json: Vec<serde_json::Value> = edits.iter().map(|edit| {
                                    serde_json::json!({
                                        "range": {
                                            "start": { "line": edit.range.start.line, "character": edit.range.start.character },
                                            "end": { "line": edit.range.end.line, "character": edit.range.end.character }
                                        },
                                        "newText": edit.new_text
                                    })
                                }).collect();
                                changes_map.insert(uri.to_string(), serde_json::json!(edits_json));
                            }
                            serde_json::Value::Object(changes_map)
                        };

                        Ok(Some(serde_json::json!({
                            "success": true,
                            "oldModuleName": result.old_module_name,
                            "newModuleName": result.new_module_name,
                            "oldPath": result.old_path,
                            "newPath": result.new_path,
                            "filesUpdated": result.files_updated,
                            "changes": changes_json
                        })))
                    }
                    Err(e) => {
                        Ok(Some(serde_json::json!({
                            "success": false,
                            "error": e.to_string()
                        })))
                    }
                }
            }
            CMD_RENAME_VARIANT => {
                // Expected arguments: [uri, line, character, newName]
                if params.arguments.len() != 4 {
                    return Ok(Some(serde_json::json!({
                        "success": false,
                        "error": "Expected 4 arguments: uri, line, character, newName"
                    })));
                }

                let uri_str: String = serde_json::from_value(params.arguments[0].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let line: u32 = serde_json::from_value(params.arguments[1].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let character: u32 = serde_json::from_value(params.arguments[2].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let new_name: String = serde_json::from_value(params.arguments[3].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;

                let uri = Url::parse(&uri_str)
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(format!("Invalid URI: {}", e)))?;

                let position = Position { line, character };

                // First, verify this is a variant
                if let Some((type_name, variant, _idx, _total, _all_variants)) = self.get_variant_at_position(&uri, position) {
                    // This IS a variant - proceed with rename using the variant's definition range
                    let old_name = variant.name.clone();
                    let variant_range = variant.range;

                    // Use rename_variant_by_range with the variant's definition range directly
                    match self.rename_variant_by_range(&uri, &old_name, variant_range, &new_name) {
                        Ok(Some(edit)) => {
                            // Convert WorkspaceEdit to JSON
                            if let Some(changes) = edit.changes {
                                let mut changes_json = serde_json::Map::new();
                                for (uri, edits) in changes {
                                    let edits_json: Vec<serde_json::Value> = edits.iter().map(|edit| {
                                        serde_json::json!({
                                            "range": {
                                                "start": { "line": edit.range.start.line, "character": edit.range.start.character },
                                                "end": { "line": edit.range.end.line, "character": edit.range.end.character }
                                            },
                                            "newText": edit.new_text
                                        })
                                    }).collect();
                                    changes_json.insert(uri.to_string(), serde_json::json!(edits_json));
                                }
                                Ok(Some(serde_json::json!({
                                    "success": true,
                                    "oldName": old_name,
                                    "newName": new_name,
                                    "typeName": type_name,
                                    "symbolKind": "variant",
                                    "changes": serde_json::Value::Object(changes_json)
                                })))
                            } else {
                                Ok(Some(serde_json::json!({
                                    "success": true,
                                    "oldName": old_name,
                                    "newName": new_name,
                                    "typeName": type_name,
                                    "symbolKind": "variant",
                                    "message": "No changes needed"
                                })))
                            }
                        }
                        Ok(None) => {
                            Ok(Some(serde_json::json!({
                                "success": false,
                                "error": "Rename not possible for this variant"
                            })))
                        }
                        Err(e) => {
                            Ok(Some(serde_json::json!({
                                "success": false,
                                "error": e.to_string()
                            })))
                        }
                    }
                } else {
                    // Not a variant - detect what it actually is and return error
                    let actual_kind = if let Some(doc) = self.documents.get(&uri) {
                        self.get_symbol_kind_at_position(&uri, position, &doc.text)
                    } else {
                        "unknown"
                    };

                    Ok(Some(serde_json::json!({
                        "success": false,
                        "error": format!(
                            "Position is not on a variant. Found '{}' instead. Use elm_rename_{} for this symbol.",
                            actual_kind,
                            if actual_kind == "unknown" { "..." } else { actual_kind }
                        ),
                        "actualKind": actual_kind
                    })))
                }
            }
            CMD_RENAME_TYPE => {
                // Expected arguments: [uri, line, character, newName]
                if params.arguments.len() != 4 {
                    return Ok(Some(serde_json::json!({
                        "success": false,
                        "error": "Expected 4 arguments: uri, line, character, newName"
                    })));
                }

                let uri_str: String = serde_json::from_value(params.arguments[0].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let line: u32 = serde_json::from_value(params.arguments[1].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let character: u32 = serde_json::from_value(params.arguments[2].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let new_name: String = serde_json::from_value(params.arguments[3].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;

                let uri = Url::parse(&uri_str)
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(format!("Invalid URI: {}", e)))?;

                let position = Position { line, character };

                // First, verify this is a type (custom type or type alias)
                if let Some((type_name, _def_range)) = self.get_type_at_position(&uri, position) {
                    // Check for protected Lamdera types
                    if let Ok(ws) = self.workspace.read() {
                        if let Some(workspace) = ws.as_ref() {
                            if workspace.is_protected_lamdera_type(&type_name) {
                                return Ok(Some(serde_json::json!({
                                    "success": false,
                                    "error": format!("Cannot rename {} in a Lamdera project - this type is required by Lamdera", type_name)
                                })));
                            }
                        }
                    }

                    let old_name = type_name.clone();

                    // Use rename_symbol_by_name with the type name directly
                    match self.rename_symbol_by_name(&uri, &old_name, &new_name) {
                        Ok(Some(edit)) => {
                            if let Some(changes) = edit.changes {
                                let mut changes_json = serde_json::Map::new();
                                for (uri, edits) in changes {
                                    let edits_json: Vec<serde_json::Value> = edits.iter().map(|edit| {
                                        serde_json::json!({
                                            "range": {
                                                "start": { "line": edit.range.start.line, "character": edit.range.start.character },
                                                "end": { "line": edit.range.end.line, "character": edit.range.end.character }
                                            },
                                            "newText": edit.new_text
                                        })
                                    }).collect();
                                    changes_json.insert(uri.to_string(), serde_json::json!(edits_json));
                                }
                                Ok(Some(serde_json::json!({
                                    "success": true,
                                    "oldName": old_name,
                                    "newName": new_name,
                                    "symbolKind": "type",
                                    "changes": serde_json::Value::Object(changes_json)
                                })))
                            } else {
                                Ok(Some(serde_json::json!({
                                    "success": true,
                                    "oldName": old_name,
                                    "newName": new_name,
                                    "symbolKind": "type",
                                    "message": "No changes needed"
                                })))
                            }
                        }
                        Ok(None) => {
                            Ok(Some(serde_json::json!({
                                "success": false,
                                "error": "Rename not possible for this type"
                            })))
                        }
                        Err(e) => {
                            Ok(Some(serde_json::json!({
                                "success": false,
                                "error": e.to_string()
                            })))
                        }
                    }
                } else {
                    // Not a type - detect what it actually is and return error
                    let actual_kind = if let Some(doc) = self.documents.get(&uri) {
                        self.get_symbol_kind_at_position(&uri, position, &doc.text)
                    } else {
                        "unknown"
                    };

                    Ok(Some(serde_json::json!({
                        "success": false,
                        "error": format!(
                            "Position is not on a type. Found '{}' instead. Use elm_rename_{} for this symbol.",
                            actual_kind,
                            if actual_kind == "unknown" { "..." } else { actual_kind }
                        ),
                        "actualKind": actual_kind
                    })))
                }
            }
            CMD_RENAME_FUNCTION => {
                // Expected arguments: [uri, line, character, newName]
                if params.arguments.len() != 4 {
                    return Ok(Some(serde_json::json!({
                        "success": false,
                        "error": "Expected 4 arguments: uri, line, character, newName"
                    })));
                }

                let uri_str: String = serde_json::from_value(params.arguments[0].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let line: u32 = serde_json::from_value(params.arguments[1].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let character: u32 = serde_json::from_value(params.arguments[2].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;
                let new_name: String = serde_json::from_value(params.arguments[3].clone())
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(e.to_string()))?;

                let uri = Url::parse(&uri_str)
                    .map_err(|e| tower_lsp::jsonrpc::Error::invalid_params(format!("Invalid URI: {}", e)))?;

                let position = Position { line, character };

                // First, verify this is a function
                if let Some((func_name, _def_range)) = self.get_function_at_position(&uri, position) {
                    let old_name = func_name.clone();

                    // Use rename_symbol_by_name with the function name directly
                    match self.rename_symbol_by_name(&uri, &old_name, &new_name) {
                        Ok(Some(edit)) => {
                            if let Some(changes) = edit.changes {
                                let mut changes_json = serde_json::Map::new();
                                for (uri, edits) in changes {
                                    let edits_json: Vec<serde_json::Value> = edits.iter().map(|edit| {
                                        serde_json::json!({
                                            "range": {
                                                "start": { "line": edit.range.start.line, "character": edit.range.start.character },
                                                "end": { "line": edit.range.end.line, "character": edit.range.end.character }
                                            },
                                            "newText": edit.new_text
                                        })
                                    }).collect();
                                    changes_json.insert(uri.to_string(), serde_json::json!(edits_json));
                                }
                                Ok(Some(serde_json::json!({
                                    "success": true,
                                    "oldName": old_name,
                                    "newName": new_name,
                                    "symbolKind": "function",
                                    "changes": serde_json::Value::Object(changes_json)
                                })))
                            } else {
                                Ok(Some(serde_json::json!({
                                    "success": true,
                                    "oldName": old_name,
                                    "newName": new_name,
                                    "symbolKind": "function",
                                    "message": "No changes needed"
                                })))
                            }
                        }
                        Ok(None) => {
                            Ok(Some(serde_json::json!({
                                "success": false,
                                "error": "Rename not possible for this function"
                            })))
                        }
                        Err(e) => {
                            Ok(Some(serde_json::json!({
                                "success": false,
                                "error": e.to_string()
                            })))
                        }
                    }
                } else {
                    // Not a function - detect what it actually is and return error
                    let actual_kind = if let Some(doc) = self.documents.get(&uri) {
                        self.get_symbol_kind_at_position(&uri, position, &doc.text)
                    } else {
                        "unknown"
                    };

                    Ok(Some(serde_json::json!({
                        "success": false,
                        "error": format!(
                            "Position is not on a function. Found '{}' instead. Use elm_rename_{} for this symbol.",
                            actual_kind,
                            if actual_kind == "unknown" { "..." } else { actual_kind }
                        ),
                        "actualKind": actual_kind
                    })))
                }
            }
            _ => {
                Ok(Some(serde_json::json!({
                    "error": format!("Unknown command: {}", params.command)
                })))
            }
        }
    }
}
