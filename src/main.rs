use anyhow::Result;
use tower_lsp::{LspService, Server};
use tracing_subscriber::EnvFilter;

mod document;
mod parser;
mod server;
mod workspace;

use server::ElmLanguageServer;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    tracing::info!("Starting Elm Language Server (Rust)");

    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) = LspService::new(ElmLanguageServer::new);
    Server::new(stdin, stdout, socket).serve(service).await;

    Ok(())
}
