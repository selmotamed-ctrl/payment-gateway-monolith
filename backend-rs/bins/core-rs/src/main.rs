//! `core-rs` — the Rust core server and its CLI.
//!
//! P3 shell: mTLS, request pipeline, authentication double check, `/health`, channel health, the
//! route policy registry and graceful shutdown with systemd readiness notifications. Domain routes
//! arrive in P4/P5/P7; an unported core route answers `501 NOT_IMPLEMENTED_ROUTE` so the parity
//! harness can classify it instead of reading a 404.

#![forbid(unsafe_code)]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::io::Write;

use clap::{Parser, Subcommand};
use ntex::time::Seconds;
use ntex::web::{self, App, HttpRequest, HttpServer};
use ntex::SharedCfg;
use pg_config::Env;
use tracing::{info, warn};

use core_rs::{app, config::CoreConfig, routes, state::AppState};

#[derive(Parser, Debug)]
#[command(name = "core-rs", version, about = "Payment gateway core (Rust port)")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run the HTTP server.
    Serve,
    /// Validate the environment and TLS files.
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Schema helpers.
    Schema {
        #[command(subcommand)]
        command: SchemaCommand,
    },
    /// Route policy registry helpers.
    Routes {
        #[command(subcommand)]
        command: RoutesCommand,
    },
    /// Not yet ported: migrations, seeds, admin bootstrap, ledger repair, comms, cases, audit.
    Migrate,
    Seed,
    Admin,
    Ledger,
    Comms,
    Cases,
    Audit,
}

#[derive(Subcommand, Debug)]
enum ConfigCommand {
    Validate,
}

#[derive(Subcommand, Debug)]
enum SchemaCommand {
    Version,
    /// Print the SQLSTATE → Prisma code table (documentation aid).
    SqlState,
}

#[derive(Subcommand, Debug)]
enum RoutesCommand {
    /// Write the route policy table.
    Export {
        #[arg(long, default_value = "routes-policy.json")]
        out: String,
    },
    /// Fail when a `routes-policy.json` names an unknown route or omits a mounted one.
    Check {
        /// Defaults to the document committed next to this crate.
        #[arg(long)]
        file: Option<String>,
    },
}

#[ntex::main(name = "core-rs", signals = false)]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let cli = Cli::parse();
    let result = match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve().await,
        Command::Config {
            command: ConfigCommand::Validate,
        } => config_validate(),
        Command::Schema {
            command: SchemaCommand::Version,
        } => {
            println!("{}", pg_db::REQUIRED_SCHEMA_VERSION);
            Ok(())
        }
        Command::Schema {
            command: SchemaCommand::SqlState,
        } => {
            println!("23505 -> P2002 (unique violation)");
            println!("23503 -> P2003 (foreign key)");
            println!("40001/40P01 -> P2034 (retryable transaction)");
            println!("55000 -> append-only guard (not retryable)");
            println!("55P03 -> lock not available (retryable)");
            println!("08xxx/53xxx/57xxx -> transient (retryable)");
            Ok(())
        }
        Command::Routes {
            command: RoutesCommand::Export { out },
        } => routes_export(&out),
        Command::Routes {
            command: RoutesCommand::Check { file },
        } => routes_check(file.as_deref()),
        Command::Migrate
        | Command::Seed
        | Command::Admin
        | Command::Ledger
        | Command::Comms
        | Command::Cases
        | Command::Audit => {
            eprintln!("NOT_IMPLEMENTED: this CLI surface is ported in P6/P7/P9");
            std::process::exit(3);
        }
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

fn io_err(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

fn load_config() -> std::io::Result<CoreConfig> {
    let env = Env::load_default().map_err(io_err)?;
    CoreConfig::from_env(&env).map_err(io_err)
}

fn config_validate() -> std::io::Result<()> {
    let config = load_config()?;
    config.validate_files().map_err(io_err)?;
    println!(
        "config OK (plane {}, mtls {}, workers {})",
        config.execution_plane.as_str(),
        if config.mtls_required {
            "required"
        } else {
            "disabled"
        },
        if config.workers_enabled {
            "enabled"
        } else {
            "disabled"
        }
    );
    Ok(())
}

fn routes_export(out: &str) -> std::io::Result<()> {
    let json = routes::export_json().map_err(io_err)?;
    std::fs::write(out, format!("{json}\n"))?;
    println!("wrote {out} ({} routes)", routes::mounted_routes().len());
    Ok(())
}

fn routes_check(file: Option<&str>) -> std::io::Result<()> {
    let json = match file {
        Some(path) => std::fs::read_to_string(path)?,
        None => routes::COMMITTED_POLICY.to_owned(),
    };
    match routes::check_policy_document(&json) {
        Ok(()) => {
            println!(
                "routes-policy OK ({} routes)",
                routes::mounted_routes().len()
            );
            Ok(())
        }
        Err(error) => {
            eprintln!("routes-policy FAILED: {error}");
            std::process::exit(3);
        }
    }
}

async fn serve() -> std::io::Result<()> {
    let config = load_config()?;
    config.validate_files().map_err(io_err)?;
    core_rs::config::assert_background_job_queue_drainable(
        config.workers_enabled,
        config.background_jobs_enabled,
        config.background_jobs_drained_externally,
    )
    .map_err(io_err)?;
    let bind = format!("{}:{}", config.host, config.port);
    let mtls_required = config.mtls_required;
    let mtls = config.mtls.clone();

    let state = AppState::connect(config)
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;

    let tls = match &mtls {
        Some(paths) => Some(
            pg_mtls::server_config(&pg_mtls::ServerTlsPaths {
                ca_cert: paths.ca_cert.clone(),
                server_cert: paths.server_cert.clone(),
                server_key: paths.server_key.clone(),
            })
            .map_err(io_err)?,
        ),
        None => {
            warn!("mTLS certificates are not configured; serving plain HTTP (MTLS_REQUIRED=false)");
            None
        }
    };

    let factory_state = state.clone();
    let server = HttpServer::new(async move |_| {
        let state = factory_state.clone();
        App::new().default_service(web::to(
            async move |request: HttpRequest, payload: ntex::web::types::Payload| {
                let state = state.clone();
                app::dispatch(state, request, payload).await
            },
        ))
    })
    .workers(worker_count())
    // Signals are handled below so systemd sees `STOPPING=1` before the drain begins.
    .disable_signals()
    .graceful_shutdown_timeout(Seconds(10));

    let server = match &tls {
        Some(tls) => server.bind_rustls(bind.clone(), &tls.config, SharedCfg::new("core-rs"))?,
        None => server.bind(bind.clone(), SharedCfg::new("core-rs"))?,
    };
    let mut server = server.run();
    let actual_bind = match &tls {
        Some(_) => format!(
            "{bind} (TLS 1.3, client certificates {})",
            if mtls_required {
                "required"
            } else {
                "optional"
            }
        ),
        None => bind.clone(),
    };
    info!(bind = %actual_bind, "core-rs listening");
    let _ = sd_notify::notify(&[sd_notify::NotifyState::Ready]);

    tokio::select! {
        result = &mut server => {
            state.close().await;
            result
        }
        _ = shutdown_signal() => {
            info!("shutdown requested");
            let _ = sd_notify::notify(&[sd_notify::NotifyState::Stopping]);
            server.stop(true).await;
            state.close().await;
            let _ = sd_notify::notify(&[sd_notify::NotifyState::Stopping]);
            // Flush the terminal logger before the process exits.
            let _ = std::io::stdout().flush();
            Ok(())
        }
    }
}

fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1)
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = match signal(SignalKind::terminate()) {
            Ok(stream) => stream,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = terminate.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
