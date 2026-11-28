//! `admin-edge` — Rust port of the admin back-office edge (`admin-back`).
//!
//! Serves every route registered by `admin-back` with the same guards, limits, validation and
//! contract translation. Routes whose translation is not ported are not guessed: they answer
//! `501 NOT_IMPLEMENTED_ROUTE` and are listed in `README.md`. The route table is complete, so the
//! list is empty today.

#![forbid(unsafe_code)]
// The TS `ApiError` carries a message and optional JSON details; boxing it would hide the
// envelope shape at every call site (same decision as `bins/core-rs`).
#![allow(clippy::result_large_err)]

mod auth;
mod client;
mod config;
mod contract;
#[cfg(test)]
mod contract_tests;
mod cron;
mod dispatch;
mod error;
#[cfg(test)]
mod http_tests;
mod limits;
mod routes;
mod sandbox;
mod schema;
mod schemas;
mod upload;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::io;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use ntex::web::{self, App, HttpServer};
use ntex::{time::Seconds, SharedCfg};
use tracing::info;

use crate::client::{CoreClient, ReqwestSender};
use crate::dispatch::AppState;

const SERVICE: &str = "admin-back";

#[derive(Parser, Debug)]
#[command(name = "admin-edge", version, about = "admin-back edge (Rust port)")]
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

#[ntex::main(name = "admin-edge", signals = true)]
async fn main() -> io::Result<()> {
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

fn io_err(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

fn load_config() -> io::Result<config::Config> {
    config::load().map_err(io_err)
}

fn config_validate() -> io::Result<()> {
    let config = load_config()?;
    let routes = routes::table();
    let uploads = routes::uploads();
    for route in &routes {
        if !route.core.starts_with("/internal/admin/") {
            return Err(io_err(format!(
                "route {} {} escapes the admin channel: {}",
                route.method, route.pattern, route.core
            )));
        }
    }
    println!(
        "config OK: {SERVICE} port {} ({} core nodes, sandbox {}, {} routes, {} multipart routes, 0 not implemented)",
        config.port,
        config.core_urls.len(),
        if config.sandbox_core_urls.is_some() {
            "configured"
        } else {
            "not configured"
        },
        routes.len(),
        uploads.len()
    );
    Ok(())
}

async fn serve() -> io::Result<()> {
    let config = Arc::new(load_config()?);
    pg_mtls::install_crypto_provider();
    let sender = Arc::new(ReqwestSender::new(&config).map_err(io_err)?);
    let client = Arc::new(CoreClient::new(&config, sender));
    let state = Arc::new(AppState::new(
        config.clone(),
        client,
        routes::table(),
        routes::uploads(),
    ));
    let bind = format!("{}:{}", config.bind_host, config.port);
    info!(
        bind = %bind,
        service = SERVICE,
        routes = state.routes.len(),
        core_nodes = config.core_urls.len(),
        sandbox = config.sandbox_configured(),
        "admin edge listening (LAN only)"
    );
    let app_state = state.clone();
    let server = HttpServer::new(async move |_| {
        let state = app_state.clone();
        let config = web::WebAppConfig::new().set_value(state);
        App::new()
            .with_config(config)
            .service(web::resource("/{tail}*").to(dispatch::handle))
            .service(web::resource("/").to(dispatch::handle))
    })
    .graceful_shutdown_timeout(Seconds(10))
    .bind(bind, SharedCfg::new("pg-admin-edge"))?;
    let _ = sd_notify::notify(&[sd_notify::NotifyState::Ready]);
    server.run().await
}
