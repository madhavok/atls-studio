mod protocol;
mod transport;
mod project;
mod handlers;

use std::io;
use tracing::info;
use transport::Transport;

#[tokio::main]
async fn main() -> io::Result<()> {
    // Initialize tracing (ANSI disabled — stderr is piped by MCP clients, not a terminal)
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(io::stderr)
        .with_ansi(false)
        .init();

    info!("ATLS MCP Server starting...");

    let mut transport = Transport::new();
    transport.run().await?;

    Ok(())
}
