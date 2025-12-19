use dashmap::DashMap;
use std::path::PathBuf;
use std::sync::RwLock;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer};

use crate::document::Document;
use crate::parser::ElmParser;
use crate::workspace::Workspace;

// Custom command for move function
const CMD_MOVE_FUNCTION: &str = "elm.moveFunction";

pub struct ElmLanguageServer {
    client: Client,
    documents: DashMap<Url, Document>,
    parser: ElmParser,
    workspace: RwLock<Option<Workspace>>,
}

impl ElmLanguageServer {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            documents: DashMap::new(),
            parser: ElmParser::new(),
            workspace: RwLock::new(None),
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

    fn get_diagnostics(&self, _uri: &Url) -> Vec<Diagnostic> {
        Vec::new()
    }

    /// Get the word at a position in the document
    fn get_word_at_position(&self, uri: &Url, position: Position) -> Option<String> {
        let doc = self.documents.get(uri)?;
        let line = doc.get_line(position.line)?;
        let col = position.character as usize;

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
}

#[tower_lsp::async_trait]
impl LanguageServer for ElmLanguageServer {
    async fn initialize(&self, params: InitializeParams) -> Result<InitializeResult> {
        tracing::info!("initialize: received request");

        // Initialize workspace if we have a root
        if let Some(root_uri) = params.root_uri {
            if let Ok(path) = root_uri.to_file_path() {
                tracing::info!("Initializing workspace at {:?}", path);
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
        } else if let Some(root_path) = params.root_path {
            let path = PathBuf::from(&root_path);
            tracing::info!("Initializing workspace at {:?} (from root_path)", path);
            let mut workspace = Workspace::new(path);
            if let Err(e) = workspace.initialize() {
                tracing::error!("Failed to initialize workspace: {}", e);
            } else {
                if let Ok(mut ws) = self.workspace.write() {
                    *ws = Some(workspace);
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
                    commands: vec![CMD_MOVE_FUNCTION.to_string()],
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
        let uri = &params.text_document_position.text_document.uri;
        let mut items = Vec::new();

        // Local symbols
        if let Some(doc) = self.documents.get(uri) {
            for s in doc.symbols.iter() {
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
                for symbols in workspace.symbols.values() {
                    for sym in symbols {
                        // Don't duplicate local symbols
                        if !items.iter().any(|i| i.label == sym.name) {
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

        if let Some(doc) = self.documents.get(uri) {
            if let Some(symbol) = doc.get_symbol_at_position(position) {
                return Ok(Some(PrepareRenameResponse::Range(symbol.range)));
            }
        }

        Ok(None)
    }

    async fn rename(&self, params: RenameParams) -> Result<Option<WorkspaceEdit>> {
        let uri = &params.text_document_position.text_document.uri;
        let position = params.text_document_position.position;
        let new_name = params.new_name;

        // Get symbol name
        let symbol_name = if let Some(doc) = self.documents.get(uri) {
            doc.get_symbol_at_position(position).map(|s| s.name.clone())
        } else {
            None
        };

        let symbol_name = symbol_name.or_else(|| self.get_word_at_position(uri, position));

        if let Some(name) = symbol_name {
            tracing::info!("Renaming {} to {}", name, new_name);
            let mut changes: std::collections::HashMap<Url, Vec<TextEdit>> = std::collections::HashMap::new();

            // Get cross-file references from workspace
            if let Ok(ws) = self.workspace.read() {
                if let Some(workspace) = ws.as_ref() {
                    // Add definition location
                    if let Some(symbol) = workspace.find_definition(&name) {
                        changes
                            .entry(symbol.definition_uri.clone())
                            .or_insert_with(Vec::new)
                            .push(TextEdit {
                                range: symbol.definition_range,
                                new_text: new_name.clone(),
                            });
                    }

                    // Add all references
                    let refs = workspace.find_references(&name, None);
                    for r in refs {
                        changes
                            .entry(r.uri)
                            .or_insert_with(Vec::new)
                            .push(TextEdit {
                                range: r.range,
                                new_text: new_name.clone(),
                            });
                    }
                }
            }

            // Fallback to local rename if no workspace refs
            if changes.is_empty() {
                if let Some(doc) = self.documents.get(uri) {
                    if let Some(symbol) = doc.symbols.iter().find(|s| s.name == name) {
                        let mut edits = vec![TextEdit {
                            range: symbol.range,
                            new_text: new_name.clone(),
                        }];
                        for range in &symbol.references {
                            edits.push(TextEdit {
                                range: *range,
                                new_text: new_name.clone(),
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
                        self.client.apply_edit(edit).await;

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
            _ => {
                Ok(Some(serde_json::json!({
                    "error": format!("Unknown command: {}", params.command)
                })))
            }
        }
    }
}
