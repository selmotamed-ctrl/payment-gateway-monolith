//! `fake-rails-rs` binary entrypoint.
//!
//! `serve` starts the HTTP emulator; `db migrate` creates/upgrades the SQLite store; `db reset`
//! deletes it and recreates an empty, migrated store.

#![forbid(unsafe_code)]
#![allow(clippy::result_large_err)]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::sync::Arc;

use clap::{Parser, Subcommand};
use ntex::web::{self, App, HttpServer};
use ntex::{time::Seconds, SharedCfg};
use tracing::info;

use fake_rails_rs::config::Config;
use fake_rails_rs::http::ntex_dispatch;
use fake_rails_rs::state::AppState;

const SERVICE: &str = "fake-rails-rs";

#[derive(Parser, Debug)]
#[command(
    name = "fake-rails-rs",
    version,
    about = "Fake Payment Rails emulator (Rust port)"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run the HTTP server (default).
    Serve,
    /// Database maintenance.
    Db {
        #[command(subcommand)]
        command: DbCommand,
    },
}

#[derive(Subcommand, Debug)]
enum DbCommand {
    /// Create or upgrade the embedded SQLite schema.
    Migrate,
    /// Delete the SQLite store (including WAL/SHM) and recreate it.
    Reset,
}

#[ntex::main(name = "fake-rails-rs", signals = true)]
async fn main() -> std::io::Result<()> {
    let config = Config::from_process_env().map_err(io_err)?;
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(config.log_level.clone())),
        )
        .init();
    match Cli::parse().command.unwrap_or(Command::Serve) {
        Command::Serve => serve(config).await,
        Command::Db {
            command: DbCommand::Migrate,
        } => {
            let state = AppState::new(config).map_err(io_err)?;
            let scenarios = state
                .db
                .count("SELECT COUNT(*) FROM fake_rail_scenarios", vec![])
                .map_err(io_err)?;
            let accounts = state
                .db
                .count("SELECT COUNT(*) FROM fake_accounts", vec![])
                .map_err(io_err)?;
            println!(
                "fake-rails-rs database migrated: {} scenarios, {} test accounts",
                scenarios, accounts
            );
            Ok(())
        }
        Command::Db {
            command: DbCommand::Reset,
        } => {
            for suffix in ["", "-wal", "-shm"] {
                let path = format!("{}{suffix}", config.db_path);
                let _ = std::fs::remove_file(path);
            }
            let state = AppState::new(config).map_err(io_err)?;
            let accounts = state
                .db
                .count("SELECT COUNT(*) FROM fake_accounts", vec![])
                .map_err(io_err)?;
            println!("fake-rails-rs database reset: {} test accounts", accounts);
            Ok(())
        }
    }
}

fn io_err(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

async fn serve(config: Config) -> std::io::Result<()> {
    let bind = format!("{}:{}", config.host, config.port);
    let node_env = config.node_env.clone();
    let data_path = config.db_path.clone();
    let state = Arc::new(AppState::new(config).map_err(io_err)?);
    fake_rails_rs::automation::spawn_background(state.clone());
    info!(
        bind = %bind,
        env = %node_env,
        db = %data_path,
        "{SERVICE} listening"
    );
    let factory_state = state.clone();
    HttpServer::new(move |_: &()| {
        let state = (*factory_state).clone();
        async move {
            App::default()
                .with_config(web::WebAppConfig::new().set_value(state))
                .service(web::resource("/{tail}*").to(ntex_dispatch))
        }
    })
    .workers(1)
    .graceful_shutdown_timeout(Seconds(10))
    .bind(bind, SharedCfg::new(SERVICE))?
    .run()
    .await
}
