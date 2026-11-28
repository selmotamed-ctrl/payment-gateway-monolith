//! `backup-daemon-rs` — backup control plane, `pg-native` engine and restore drill.
//!
//! Routes and payloads are the TS daemon's contract (chapter 2 §8). mTLS runs in ntex/rustls with
//! the internal CA; the peer certificate is classified into the control or WAL plane before any
//! routing. `wal-fetch` is the `restore_command` helper that decrypts a segment out of the local
//! repository.

#![forbid(unsafe_code)]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use tracing::{info, warn};

use backup_daemon::catalog::{
    create_default_policy, BackupCatalog, BackupRun, CatalogStore, CatalogStoreOptions,
};
use backup_daemon::command_runner::{CommandRunner, SpawnCommandRunner};
use backup_daemon::config::Config;
use backup_daemon::crypto::{master_key_from_hex, open_to_buffer};
use backup_daemon::drill::{DrillDependencies, DrillRunOptions, DrillRunner, RestoreDrillRunner};
use backup_daemon::engine::{create_backup_engine, BackupKind, BackupTarget, EngineDeps};
use backup_daemon::instance_lock::{acquire_instance_lock, InstanceLockDeps};
use backup_daemon::job_queue::JobQueue;
use backup_daemon::scheduler::BackupScheduler;
use backup_daemon::server::{BackupDaemonHandler, ServerOptions};
use backup_daemon::wal_names::WalTarget;
use backup_daemon::{artifacts, server};

#[derive(Parser, Debug)]
#[command(
    name = "backup-daemon-rs",
    version,
    about = "Backup control plane (Rust port)"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run the mTLS/HTTP daemon.
    Serve,
    /// Enqueue one backup now and wait for it.
    Trigger {
        #[arg(long, default_value = "all")]
        target: String,
        #[arg(long, default_value = "full")]
        kind: String,
    },
    /// Run one restore drill now.
    Drill {
        #[arg(long)]
        latest: bool,
        #[arg(long)]
        target_time: Option<String>,
    },
    /// Print the catalog (runs, drills, policy) as JSON.
    Catalog,
    /// `restore_command` helper: decrypt one archived WAL file to a destination path.
    WalFetch {
        target: String,
        file: String,
        dest: PathBuf,
    },
}

#[tokio::main(name = "backup-daemon-rs")]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve().await,
        Command::Trigger { target, kind } => trigger(&target, &kind).await,
        Command::Drill {
            latest,
            target_time,
        } => drill(latest, target_time.as_deref()).await,
        Command::Catalog => catalog().await,
        Command::WalFetch { target, file, dest } => wal_fetch(&target, &file, &dest).await,
    }
}

fn io_err(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn cli_clock() -> Arc<dyn Fn() -> DateTime<Utc> + Send + Sync> {
    Arc::new(Utc::now)
}

struct Runtime {
    config: Arc<Config>,
    catalog: Arc<CatalogStore>,
    engine: Arc<dyn backup_daemon::engine::BackupEngine>,
    drill_runner: Arc<RestoreDrillRunner>,
    clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

async fn build_runtime() -> std::io::Result<Runtime> {
    let config = Arc::new(Config::load_default().map_err(io_err)?);
    let runner: Arc<dyn CommandRunner> = Arc::new(SpawnCommandRunner::new(
        false,
        Some(config.command_timeout_ms),
    ));
    let repository =
        Arc::new(artifacts::build_repository(&config, runner.as_ref()).map_err(io_err)?);
    let master = master_key_from_hex(&config.encryption_key_hex).map_err(io_err)?;
    let mirror: Option<Arc<dyn backup_daemon::catalog::CatalogMirror>> = Some(Arc::new(
        backup_daemon::catalog::RepositoryCatalogMirror::new(
            Arc::clone(&repository),
            master,
            config.staging_dir.clone(),
        ),
    ));
    let mut default_policy = create_default_policy();
    default_policy.full_cron = config.full_cron.clone();
    default_policy.delta_cron = config.delta_cron.clone();
    default_policy.drill_cron = config.drill_cron.clone();
    default_policy.full_retention_days = config.retention_full_count * 7;
    default_policy.wal_retention_days = config.retention_wal_days;
    default_policy.alert_lag_seconds = config.alert_lag_seconds;
    default_policy.updated_at = now_iso();
    let catalog = Arc::new(
        CatalogStore::load(CatalogStoreOptions {
            path: PathBuf::from(&config.catalog_path),
            default_policy,
            file_system: None,
            max_runs: None,
            max_drills: None,
            mirror,
            on_warning: Some(Box::new(|message| warn!("{message}"))),
        })
        .await,
    );
    if !catalog.is_persistent() {
        warn!(
            "catalog is running in memory only: {}",
            catalog
                .get_persistence_error()
                .unwrap_or_else(|| "unwritable path".to_owned())
        );
    }
    if catalog.is_recovered() {
        info!("catalog recovered from the signed copy on the storage tiers");
    }

    let clock = cli_clock();
    let engine = create_backup_engine(
        Arc::clone(&config),
        Arc::clone(&runner),
        EngineDeps {
            repository: Some(Arc::clone(&repository)),
            get_policy: Some({
                let catalog = Arc::clone(&catalog);
                Arc::new(move || {
                    let policy = catalog.get_policy();
                    backup_daemon::engine::PolicyView {
                        full_retention_days: policy.full_retention_days,
                        wal_retention_days: policy.wal_retention_days,
                    }
                })
            }),
            clock: Some(Arc::clone(&clock)),
        },
    )
    .map_err(io_err)?;

    if catalog.list_runs(1).is_empty() {
        let rebuilt = engine.reconstruct_runs().await.unwrap_or_default();
        if !rebuilt.is_empty() {
            let count = catalog.import_runs(rebuilt).await;
            info!("rebuilt {count} backup run(s) from the repository manifests");
        }
    }

    let drill_runner = Arc::new(RestoreDrillRunner::new(DrillDependencies {
        config: Arc::clone(&config),
        engine: Arc::clone(&engine),
        runner: Arc::clone(&runner),
        repository: Some(Arc::clone(&repository)),
        file_system: None,
        clock: Arc::clone(&clock),
        id_factory: None,
        sleep: None,
    }));
    Ok(Runtime {
        config,
        catalog,
        engine,
        drill_runner,
        clock,
    })
}

async fn serve() -> std::io::Result<()> {
    let runtime = build_runtime().await?;
    let config = Arc::clone(&runtime.config);
    let state_dir = Path::new(&config.catalog_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let lock = acquire_instance_lock(&state_dir.join("daemon.lock"), InstanceLockDeps::new())
        .await
        .map_err(io_err)?;

    let jobs = Arc::new(JobQueue::new(
        25,
        Some(state_dir.join("idempotency-keys.json")),
        {
            let clock = Arc::clone(&runtime.clock);
            Box::new(move || clock())
        },
    ));
    let restored = backup_daemon::startup::restore_job_state(&runtime.catalog, &jobs).await;
    if !restored.interrupted.is_empty() {
        warn!(
            "marked {} interrupted run(s) FAILED after the restart",
            restored.interrupted.len()
        );
    }
    info!(
        "restored {} idempotency key(s) for finished jobs",
        restored.restored_keys
    );

    let scheduler = Arc::new(BackupScheduler::new(
        Arc::clone(&config),
        Arc::clone(&runtime.catalog),
        Arc::clone(&runtime.engine),
        Arc::clone(&runtime.drill_runner) as Arc<dyn backup_daemon::drill::DrillRunner>,
        Arc::clone(&jobs),
        Arc::clone(&runtime.clock),
        None,
        None,
    ));
    let mut options = ServerOptions::new(
        Arc::clone(&config),
        Arc::clone(&runtime.engine),
        Arc::clone(&runtime.drill_runner) as Arc<dyn backup_daemon::drill::DrillRunner>,
        Arc::clone(&runtime.catalog),
        Arc::clone(&jobs),
        Arc::clone(&runtime.clock),
    );
    options.scheduler = Some(Arc::clone(&scheduler));
    let handler = BackupDaemonHandler::new(options);
    let state = handler.state();

    runtime.engine.start().await.map_err(io_err)?;
    scheduler.start();
    info!(
        "scheduler {} (tick={}ms)",
        if config.scheduler_enabled {
            "enabled"
        } else {
            "disabled"
        },
        config.scheduler_tick_ms
    );

    let result = server::serve(state).await;
    scheduler.stop();
    let _ = runtime.engine.stop().await;
    runtime.catalog.when_mirrored().await;
    jobs.when_persisted().await;
    lock.release().await;
    result
}

async fn trigger(target: &str, kind: &str) -> std::io::Result<()> {
    let runtime = build_runtime().await?;
    let target = BackupTarget::parse(target)
        .ok_or_else(|| io_err("--target must be one of all, postgres_core, audit_db, redis"))?;
    let kind = BackupKind::parse(kind).ok_or_else(|| io_err("--kind must be full or delta"))?;
    let id = format!("cli-{}", Utc::now().timestamp_millis());
    runtime
        .catalog
        .add_run(BackupRun {
            id: id.clone(),
            target: target.as_str().to_owned(),
            kind: kind.as_str().to_owned(),
            engine: runtime.config.engine_mode.clone(),
            status: "RUNNING".to_owned(),
            started_at: now_iso(),
            completed_at: None,
            duration_ms: None,
            size_bytes: None,
            start_lsn: None,
            end_lsn: None,
            storage_targets: Vec::new(),
            error_message: None,
        })
        .await;
    match runtime.engine.trigger_backup(target, kind).await {
        Ok(result) => {
            runtime
                .catalog
                .update_run(
                    &id,
                    backup_daemon::catalog::RunPatch {
                        status: Some("PASSED".to_owned()),
                        completed_at: Some(now_iso()),
                        size_bytes: result.size_bytes,
                        start_lsn: result.start_lsn.clone(),
                        end_lsn: result.end_lsn.clone(),
                        storage_targets: Some(result.storage_targets.clone()),
                        ..backup_daemon::catalog::RunPatch::default()
                    },
                )
                .await;
            println!(
                "{}",
                serde_json::json!({
                    "status": "PASSED",
                    "sizeBytes": result.size_bytes,
                    "startLsn": result.start_lsn,
                    "endLsn": result.end_lsn,
                    "storageTargets": result.storage_targets,
                })
            );
            Ok(())
        }
        Err(error) => {
            let message = error.to_string();
            runtime
                .catalog
                .update_run(
                    &id,
                    backup_daemon::catalog::RunPatch {
                        status: Some("FAILED".to_owned()),
                        completed_at: Some(now_iso()),
                        error_message: Some(message.clone()),
                        ..backup_daemon::catalog::RunPatch::default()
                    },
                )
                .await;
            Err(io_err(message))
        }
    }
}

async fn drill(latest: bool, target_time: Option<&str>) -> std::io::Result<()> {
    let runtime = build_runtime().await?;
    let target_time = match target_time {
        Some(value) => Some(
            DateTime::parse_from_rfc3339(value)
                .map_err(|_| io_err("--target-time must be an ISO-8601 timestamp"))?
                .with_timezone(&Utc),
        ),
        None => None,
    };
    let report = runtime
        .drill_runner
        .run(DrillRunOptions {
            id: None,
            requested_by: Some("cli".to_owned()),
            target_time,
            latest,
        })
        .await
        .map_err(io_err)?;
    let _ = runtime.catalog.add_drill(report.clone()).await;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_owned())
    );
    if report.status == "PASSED" {
        Ok(())
    } else {
        Err(io_err(report.error_message.unwrap_or_else(|| {
            "restore drill failed a check".to_owned()
        })))
    }
}

async fn catalog() -> std::io::Result<()> {
    let runtime = build_runtime().await?;
    let snapshot: BackupCatalog = runtime.catalog.snapshot();
    println!(
        "{}",
        serde_json::to_string_pretty(&snapshot).unwrap_or_else(|_| "{}".to_owned())
    );
    Ok(())
}

async fn wal_fetch(target: &str, file: &str, destination: &Path) -> std::io::Result<()> {
    let config = Config::load_default().map_err(io_err)?;
    let runner: Arc<dyn CommandRunner> = Arc::new(SpawnCommandRunner::new(
        false,
        Some(config.command_timeout_ms),
    ));
    let repository = artifacts::build_repository(&config, runner.as_ref()).map_err(io_err)?;
    let master = master_key_from_hex(&config.encryption_key_hex).map_err(io_err)?;
    let target = WalTarget::parse(target)
        .ok_or_else(|| io_err("WAL target must be postgres_core or audit_db"))?;
    let key = backup_daemon::wal_archive::wal_key(target, file);
    let sealed = tempfile::NamedTempFile::new().map_err(io_err)?;
    repository
        .get_file(&key, sealed.path())
        .await
        .map_err(io_err)?;
    let plain = open_to_buffer(
        sealed.path(),
        &master,
        &format!("wal:{}", target.as_str()),
        &format!("wal/{file}"),
        true,
    )
    .await
    .map_err(io_err)?;
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(io_err)?;
    }
    std::fs::write(destination, plain).map_err(io_err)?;
    eprintln!(
        "wal-fetch: restored {file} ({} bytes)",
        std::fs::metadata(destination)
            .map(|meta| meta.len())
            .unwrap_or(0)
    );
    Ok(())
}
