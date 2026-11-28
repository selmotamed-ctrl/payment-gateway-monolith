//! `merchant-edge` — the merchant-back edge of the payment gateway (Rust/ntex port).
//!
//! Phase P2-T04: all 105 merchant API routes of `backend-rs/tests/golden-vectors/route-inventory`
//! plus `/health`, the `/sandbox/*` wildcard of the Sandbox Studio proxy, contract translation,
//! zReady validation, uploads, limiters, cookie sessions and the POS SSE stream.
//!
//! ```
//! merchant-edge serve              # run the edge (PORT 4102 by default)
//! merchant-edge config validate    # validate CORE_BACK_URL(S), mTLS files and limits
//! merchant-edge routes             # print the registered route table
//! ```

#![forbid(unsafe_code)]
// The error envelope (`code`/`message`/`details`/`reference`) is intentionally a small owned
// struct; boxing every `Result` would obscure the request handlers for a 152-byte value.
#![allow(clippy::result_large_err)]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use merchant_edge::config::EdgeConfig;
use merchant_edge::routes::ROUTES;

#[derive(Parser, Debug)]
#[command(
    name = "merchant-edge",
    version,
    about = "merchant-back edge (Rust port)"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run the HTTP server.
    Serve,
    /// Configuration helpers.
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Print the registered routes.
    Routes,
}

#[derive(Subcommand, Debug)]
enum ConfigCommand {
    Validate,
}

#[ntex::main(name = "merchant-edge", signals = true)]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    match Cli::parse().command.unwrap_or(Command::Serve) {
        Command::Serve => {
            let config = EdgeConfig::load().map_err(config_error)?;
            merchant_edge::server::serve(config, release(), commit()).await
        }
        Command::Config {
            command: ConfigCommand::Validate,
        } => {
            EdgeConfig::load().map_err(config_error)?;
            println!("config OK");
            Ok(())
        }
        Command::Routes => {
            for route in ROUTES.iter() {
                println!("{:6} {}", route.method, route.pattern);
            }
            println!("{} routes", ROUTES.len());
            Ok(())
        }
    }
}

fn release() -> String {
    std::env::var("APP_RELEASE").unwrap_or_else(|_| "dev".to_owned())
}

fn commit() -> String {
    std::env::var("APP_COMMIT")
        .or_else(|_| std::env::var("GIT_COMMIT"))
        .unwrap_or_else(|_| "unknown".to_owned())
}

fn config_error(error: merchant_edge::config::ConfigError) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_route_table_matches_the_inventory_size() {
        // 105 inventory API routes + /health + the `/sandbox/{*rest}` wildcard.
        assert_eq!(ROUTES.len(), 107);
    }
}
