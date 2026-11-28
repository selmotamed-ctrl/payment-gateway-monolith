//! `checkout-edge` — Rust port of `checkout-back`.
//!
//! Serves the real checkout routes on plain HTTP (Nginx terminates TLS), with an mTLS client to
//! core. See `README.md` for the route table, environment and known deviations.

#![forbid(unsafe_code)]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use clap::{Parser, Subcommand};
use pg_config::Env;
use std::sync::Arc;
use tracing::info;

use checkout_edge::config::CheckoutConfig;
use checkout_edge::core::{CoreClient, ReqwestTransport};
use checkout_edge::server::run_server;
use checkout_edge::EdgeService;

const SERVICE: &str = "checkout-back";

#[derive(Parser, Debug)]
#[command(
    name = "checkout-edge",
    version,
    about = "checkout-back edge (Rust port)"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    Serve,
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
}

#[derive(Subcommand, Debug)]
enum ConfigCommand {
    Validate,
}

#[ntex::main(name = "checkout-edge", signals = true)]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    match Cli::parse().command.unwrap_or(Command::Serve) {
        Command::Serve => serve().await,
        Command::Config {
            command: ConfigCommand::Validate,
        } => config_validate(),
    }
}

fn io_err(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

fn load_config() -> std::io::Result<CheckoutConfig> {
    let env = Env::load_default().map_err(io_err)?;
    CheckoutConfig::load(&env).map_err(io_err)
}

fn config_validate() -> std::io::Result<()> {
    let config = load_config()?;
    // Build the TLS config and the reqwest client once so a missing/unreadable certificate is a
    // configuration failure instead of a runtime 500 on the first request.
    ReqwestTransport::new(&config.mtls, config.request_timeout).map_err(io_err)?;
    println!(
        "config OK ({} live node(s), sandbox {})",
        config.live_urls().len(),
        if config.sandbox_urls().is_some() {
            "configured"
        } else {
            "not configured"
        }
    );
    Ok(())
}

async fn serve() -> std::io::Result<()> {
    let config = Arc::new(load_config()?);
    let transport = ReqwestTransport::new(&config.mtls, config.request_timeout).map_err(io_err)?;
    let core = Arc::new(CoreClient::from_config(&config, Arc::new(transport)));
    let service = Arc::new(EdgeService::new(config.clone(), core));
    let bind = bind_address(&config.bind_host, config.port);

    // A tiny startup probe makes a broken environment visible before the listen line: the same
    // validations run in `config validate`.
    info!(
        service = SERVICE,
        release = %config.release,
        commit = %config.commit,
        live_nodes = config.live_urls().len(),
        sandbox = config.sandbox_urls().is_some(),
        json_limit = config.json_limit,
        inbound_limit = config.inbound_limit,
        "checkout edge starting"
    );

    run_server(service, bind).await
}

/// Format an IPv4/IPv6 socket address for `HttpServer::bind` (`::` → `[::]:4103`).
#[must_use]
fn bind_address(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_address_formats_ipv6() {
        assert_eq!(bind_address("0.0.0.0", 4103), "0.0.0.0:4103");
        assert_eq!(bind_address("127.0.0.1", 4103), "127.0.0.1:4103");
        assert_eq!(bind_address("::", 4103), "[::]:4103");
        assert_eq!(bind_address("::1", 4103), "[::1]:4103");
        assert_eq!(bind_address("[::1]", 4103), "[::1]:4103");
    }
}
