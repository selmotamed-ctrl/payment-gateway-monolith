//! Engine contract, target expansion, psql/WAL health helpers and engine selection.
//! Port of `deploy/backup-daemon/src/backupEngine.ts`.
//!
//! `pg-native` is the ported engine. `wal-g` and `barman` are explicit alternatives that return a
//! configuration error instead of pretending to back anything up.

pub mod pg_native;

use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::artifacts::ArtifactRepository;
use crate::command_runner::{BoxFuture, CommandResult, CommandRunner, RunOptions};
use crate::config::{is_audit_configured, Config, PgEndpoint};
use crate::pg_tools::{connection_env, pg_bin, run_tool, ToolCommand};
use crate::wal_names::{parse_wal_archive_status, WalArchiveStatus, DEFAULT_WAL_SEGMENT_BYTES};

pub const RECOVERY_TARGETS: [&str; 2] = ["postgres_core", "audit_db"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupTarget {
    All,
    PostgresCore,
    AuditDb,
    Redis,
}

impl BackupTarget {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::PostgresCore => "postgres_core",
            Self::AuditDb => "audit_db",
            Self::Redis => "redis",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "all" => Some(Self::All),
            "postgres_core" => Some(Self::PostgresCore),
            "audit_db" => Some(Self::AuditDb),
            "redis" => Some(Self::Redis),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryTarget {
    PostgresCore,
    AuditDb,
}

impl RecoveryTarget {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PostgresCore => "postgres_core",
            Self::AuditDb => "audit_db",
        }
    }

    #[must_use]
    pub fn as_backup_target(self) -> BackupTarget {
        match self {
            Self::PostgresCore => BackupTarget::PostgresCore,
            Self::AuditDb => BackupTarget::AuditDb,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupKind {
    Full,
    Delta,
}

impl BackupKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Delta => "delta",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "full" => Some(Self::Full),
            "delta" => Some(Self::Delta),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupStorageTarget {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub healthy: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WalHealth {
    pub archive_lag_seconds: u64,
    pub current_lsn: String,
    pub last_archived_lsn: String,
    pub lag_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineHealth {
    pub healthy: bool,
    pub wal: WalHealth,
    pub targets: Vec<BackupStorageTarget>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackupExecutionResult {
    pub size_bytes: Option<u64>,
    pub start_lsn: Option<String>,
    pub end_lsn: Option<String>,
    pub storage_targets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub backup_id: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_lsn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_lsn: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RecoverRequest {
    pub target: RecoveryTarget,
    /// Recovery target. Ignored when `latest` is set.
    pub target_time: DateTime<Utc>,
    /// Disaster recovery: replay everything available instead of stopping at a time.
    pub latest: bool,
    pub target_dir: PathBuf,
    pub port: u16,
}

#[derive(Debug, Clone, Default)]
pub struct RecoverResult {
    pub replayed_lsn: Option<String>,
    pub recovery_conf: Option<String>,
    /// Set only when the engine deliberately prepared an empty, initialized data dir.
    pub initialized_empty_dir: bool,
}

#[derive(Debug, Clone)]
pub struct RecoverLogicalRequest {
    pub database: String,
    pub host: String,
    pub port: u16,
    pub user: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalIngestOutcome {
    pub status: String,
    pub key: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyView {
    pub full_retention_days: u32,
    pub wal_retention_days: u32,
}

#[derive(Debug, Clone)]
pub enum EngineError {
    Backup {
        message: String,
        target: String,
        kind: String,
    },
    Wal(crate::wal_archive::WalIngestError),
    Store(String),
    Configuration(String),
    Unsupported(String),
    Other(String),
}

impl EngineError {
    #[must_use]
    pub fn backup(message: impl Into<String>, target: BackupTarget, kind: BackupKind) -> Self {
        Self::Backup {
            message: message.into(),
            target: target.as_str().to_owned(),
            kind: kind.as_str().to_owned(),
        }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Backup { message, .. } => formatter.write_str(message),
            Self::Wal(error) => formatter.write_str(&error.message),
            Self::Store(message) | Self::Configuration(message) | Self::Other(message) => {
                formatter.write_str(message)
            }
            Self::Unsupported(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for EngineError {}

pub type EngineFuture<'a, T> = BoxFuture<'a, Result<T, EngineError>>;

pub trait BackupEngine: Send + Sync {
    fn overview_health(&self) -> EngineFuture<'_, EngineHealth>;

    fn trigger_backup(
        &self,
        target: BackupTarget,
        kind: BackupKind,
    ) -> EngineFuture<'_, BackupExecutionResult>;

    fn list_backups(
        &self,
        limit: usize,
        target: Option<BackupTarget>,
    ) -> EngineFuture<'_, Vec<BackupSummary>>;

    fn ingest_wal(
        &self,
        _target: &str,
        _file: &str,
        _body: Vec<u8>,
        _declared_length: Option<u64>,
    ) -> EngineFuture<'_, WalIngestOutcome> {
        Box::pin(async move {
            Err(EngineError::Unsupported(
                "wal_push_not_supported: this engine does not accept WAL uploads".to_owned(),
            ))
        })
    }

    fn recover(&self, _request: RecoverRequest) -> EngineFuture<'_, RecoverResult> {
        Box::pin(async move {
            Err(EngineError::Unsupported(
                "this engine does not implement recover()".to_owned(),
            ))
        })
    }

    fn restore_logical(&self, _request: RecoverLogicalRequest) -> EngineFuture<'_, (bool, String)> {
        Box::pin(async move {
            Err(EngineError::Unsupported(
                "this engine does not implement restoreLogical()".to_owned(),
            ))
        })
    }

    fn prune(&self, _target: BackupTarget, _kind: Option<BackupKind>) -> EngineFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn reconstruct_runs(&self) -> EngineFuture<'_, Vec<crate::catalog::BackupRun>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn wal_status(&self) -> Option<Value> {
        None
    }

    fn repository(&self) -> Option<Arc<ArtifactRepository>> {
        None
    }

    fn start(&self) -> EngineFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> EngineFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn supports_wal_ingest(&self) -> bool {
        false
    }
}

// ---------------------------------------------------------------------------
// psql helpers
// ---------------------------------------------------------------------------

pub const WAL_LAG_QUERY: &str =
    "SELECT COALESCE(pg_last_wal_replay_lsn(), pg_last_wal_receive_lsn())::text AS last_replayed_lsn, pg_current_wal_lsn()::text AS current_lsn;";

/// `last_archived_wal` is a segment FILE NAME, so it is returned as text and the byte lag is
/// computed from segment numbers in code; it is never fed to `pg_wal_lsn_diff()`.
pub const WAL_ARCHIVE_STATUS_QUERY: &str = "SELECT COALESCE(last_archived_wal, '') AS last_archived_wal, CASE WHEN last_archived_time IS NULL THEN 0 ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - last_archived_time))))::bigint END::text AS lag_seconds, COALESCE(archived_count, 0)::text AS archived_count, COALESCE(failed_count, 0)::text AS failed_count, pg_current_wal_lsn()::text AS current_lsn, pg_walfile_name(pg_current_wal_lsn()) AS current_wal_file, (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time))::text AS failing FROM pg_stat_archiver;";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplicaEndpoint {
    pub id: String,
    pub host: String,
    pub port: u16,
}

/// Parses `nodeId@sshHost:sshPort:privateIp:servicePort` as well as `host` / `host:port` entries.
#[must_use]
pub fn parse_replica_nodes(value: &str) -> Vec<ReplicaEndpoint> {
    let mut entries = Vec::new();
    for raw in value.split(',') {
        let entry = raw.trim();
        if entry.is_empty() {
            continue;
        }
        let (id, without_node_id) = match entry.split_once('@') {
            Some((id, rest)) => (id.to_owned(), rest),
            None => (entry.to_owned(), entry),
        };
        let pieces: Vec<&str> = without_node_id.split(':').collect();
        if pieces.len() >= 4 {
            let host = pieces[2].to_owned();
            if !host.is_empty() {
                entries.push(ReplicaEndpoint {
                    id,
                    host,
                    port: pieces[3].parse().unwrap_or(5432),
                });
            }
        } else if pieces.len() >= 2 {
            let host = pieces[0].to_owned();
            if !host.is_empty() {
                entries.push(ReplicaEndpoint {
                    id,
                    host,
                    port: pieces[1].parse().unwrap_or(5432),
                });
            }
        } else if let Some(host) = pieces.first() {
            if !host.is_empty() {
                entries.push(ReplicaEndpoint {
                    id: id.clone(),
                    host: (*host).to_owned(),
                    port: 5432,
                });
            }
        }
    }
    entries
}

#[must_use]
pub fn build_psql_command(
    config: &Config,
    query: &str,
    database: &str,
    endpoint: &PgEndpoint,
    user: &str,
) -> ToolCommand {
    ToolCommand {
        command: pg_bin(config, "psql"),
        args: vec![
            "-h".to_owned(),
            endpoint.host.clone(),
            "-p".to_owned(),
            endpoint.port.to_string(),
            "-U".to_owned(),
            user.to_owned(),
            "-d".to_owned(),
            database.to_owned(),
            "-X".to_owned(),
            "-A".to_owned(),
            "-t".to_owned(),
            "-v".to_owned(),
            "ON_ERROR_STOP=1".to_owned(),
            "-c".to_owned(),
            query.to_owned(),
        ],
        env: connection_env(config, &endpoint.password, &config.pg_sslmode),
        timeout_ms: config.command_timeout_ms,
    }
}

#[must_use]
pub fn build_wal_lag_query_command(config: &Config) -> ToolCommand {
    let replica = parse_replica_nodes(&config.pg_replica_nodes)
        .into_iter()
        .next()
        .unwrap_or(ReplicaEndpoint {
            id: "primary".to_owned(),
            host: config.pg_primary_host.clone(),
            port: config.pg_primary_port,
        });
    build_psql_command(
        config,
        WAL_LAG_QUERY,
        &config.pg_primary_db_name,
        &PgEndpoint {
            host: replica.host,
            port: replica.port,
            user: config.pg_primary_user.clone(),
            password: config.pg_primary_password.clone(),
        },
        &config.pg_primary_user,
    )
}

#[must_use]
pub fn build_wal_archive_status_command(config: &Config) -> ToolCommand {
    build_psql_command(
        config,
        WAL_ARCHIVE_STATUS_QUERY,
        &config.pg_primary_db_name,
        &PgEndpoint {
            host: config.pg_primary_host.clone(),
            port: config.pg_primary_port,
            user: config.pg_primary_user.clone(),
            password: config.pg_primary_password.clone(),
        },
        &config.pg_primary_user,
    )
}

#[must_use]
pub fn parse_field_row(stdout: &str) -> Vec<String> {
    stdout
        .trim()
        .split('\n')
        .next()
        .map(|row| {
            row.split('|')
                .map(|value| value.trim().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[must_use]
pub fn error_text(result: &CommandResult) -> String {
    let text = if !result.stderr.is_empty() {
        &result.stderr
    } else if !result.stdout.is_empty() {
        &result.stdout
    } else {
        return format!("exit code {}", result.code);
    };
    text.trim().chars().take(500).collect()
}

pub async fn run_checked(
    runner: &dyn CommandRunner,
    command: &ToolCommand,
    target: BackupTarget,
    kind: BackupKind,
) -> Result<CommandResult, EngineError> {
    match run_tool(runner, command, &command.command).await {
        Ok(result) => Ok(result),
        Err(message) => Err(EngineError::backup(message, target, kind)),
    }
}

/// What `target = "all"` means for this deployment.
#[must_use]
pub fn expand_targets(config: &Config, target: BackupTarget) -> Vec<BackupTarget> {
    if target != BackupTarget::All {
        return vec![target];
    }
    let mut targets = vec![BackupTarget::PostgresCore];
    if is_audit_configured(config) {
        targets.push(BackupTarget::AuditDb);
    }
    if config.redis_url.is_some() {
        targets.push(BackupTarget::Redis);
    }
    targets
}

pub fn wal_health_for<'a>(
    config: &'a Config,
    runner: &'a dyn CommandRunner,
) -> BoxFuture<'a, WalHealth> {
    Box::pin(async move {
        let mut health = WalHealth::default();
        let lag_command = build_wal_lag_query_command(config);
        if let Ok(result) = runner
            .run(
                &lag_command.command,
                &lag_command.args,
                RunOptions {
                    env: lag_command.env.clone(),
                    input: None,
                    timeout_ms: Some(lag_command.timeout_ms),
                },
            )
            .await
        {
            if result.code == 0 {
                let fields = parse_field_row(&result.stdout);
                health.last_archived_lsn = fields.first().cloned().unwrap_or_default();
                health.current_lsn = fields.get(1).cloned().unwrap_or_default();
            }
        }
        let archive_command = build_wal_archive_status_command(config);
        if let Ok(result) = runner
            .run(
                &archive_command.command,
                &archive_command.args,
                RunOptions {
                    env: archive_command.env.clone(),
                    input: None,
                    timeout_ms: Some(archive_command.timeout_ms),
                },
            )
            .await
        {
            if result.code == 0 {
                let status: WalArchiveStatus =
                    parse_wal_archive_status(&result.stdout, DEFAULT_WAL_SEGMENT_BYTES);
                if !status.last_archived_wal.is_empty() {
                    health.last_archived_lsn = status.last_archived_wal.clone();
                }
                if !status.current_lsn.is_empty() {
                    health.current_lsn = status.current_lsn.clone();
                }
                health.archive_lag_seconds = status.lag_seconds;
                health.lag_bytes = status.lag_bytes;
            }
        }
        health
    })
}

pub async fn check_target(
    runner: &dyn CommandRunner,
    id: &str,
    name: &str,
    kind: &str,
    command: &ToolCommand,
) -> BackupStorageTarget {
    match runner
        .run(
            &command.command,
            &command.args,
            RunOptions {
                env: command.env.clone(),
                input: None,
                timeout_ms: Some(command.timeout_ms),
            },
        )
        .await
    {
        Ok(result) => BackupStorageTarget {
            id: id.to_owned(),
            name: name.to_owned(),
            kind: kind.to_owned(),
            healthy: result.code == 0,
            detail: if result.code == 0 {
                "reachable".to_owned()
            } else {
                error_text(&result)
            },
        },
        Err(error) => BackupStorageTarget {
            id: id.to_owned(),
            name: name.to_owned(),
            kind: kind.to_owned(),
            healthy: false,
            detail: error.to_string(),
        },
    }
}

type RedisCliConnection = (Vec<String>, Vec<(String, String)>);

fn redis_cli_connection(config: &Config) -> Option<RedisCliConnection> {
    let url = config.redis_url.as_ref()?;
    let stripped = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let (authority, _path) = stripped.split_once('/').unwrap_or((stripped, ""));
    let (auth, host_port) = match authority.rsplit_once('@') {
        Some((auth, host_port)) => (Some(auth), host_port),
        None => (None, authority),
    };
    let (host, port) = host_port.rsplit_once(':').unwrap_or((host_port, "6379"));
    let mut args = vec![
        "-h".to_owned(),
        host.to_owned(),
        "-p".to_owned(),
        port.to_owned(),
    ];
    let mut env = Vec::new();
    if let Some(auth) = auth {
        let password = auth
            .split_once(':')
            .map(|(_, password)| password)
            .unwrap_or(auth);
        if !password.is_empty() {
            env.push(("REDISCLI_AUTH".to_owned(), password.to_owned()));
        }
    }
    args.shrink_to_fit();
    Some((args, env))
}

#[must_use]
pub fn build_redis_snapshot_command(config: &Config) -> Option<ToolCommand> {
    let (mut args, env) = redis_cli_connection(config)?;
    args.push("BGSAVE".to_owned());
    Some(ToolCommand {
        command: config.redis_cli_bin.clone(),
        args,
        env,
        timeout_ms: config.command_timeout_ms,
    })
}

#[must_use]
pub fn build_redis_rdb_command(config: &Config, path: &std::path::Path) -> Option<ToolCommand> {
    let (mut args, env) = redis_cli_connection(config)?;
    args.push("--rdb".to_owned());
    args.push(path.to_string_lossy().into_owned());
    Some(ToolCommand {
        command: config.redis_cli_bin.clone(),
        args,
        env,
        timeout_ms: config.command_timeout_ms,
    })
}

#[must_use]
pub fn build_redis_ping_command(config: &Config) -> Option<ToolCommand> {
    let (mut args, env) = redis_cli_connection(config)?;
    args.push("PING".to_owned());
    Some(ToolCommand {
        command: config.redis_cli_bin.clone(),
        args,
        env,
        timeout_ms: config.command_timeout_ms,
    })
}

/// Engine dependencies, shared with the scheduler (live retention policy) and the drill runner
/// (the artifact repository for object-storage parity).
#[derive(Clone, Default)]
pub struct EngineDeps {
    pub repository: Option<Arc<ArtifactRepository>>,
    pub get_policy: Option<Arc<dyn Fn() -> PolicyView + Send + Sync>>,
    pub clock: Option<Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>>,
}

/// Builds the configured engine. `wal-g` and `barman` are NOT implemented in this crate: they fail
/// with a configuration error rather than producing a backup the daemon cannot verify or restore.
pub fn create_backup_engine(
    config: Arc<Config>,
    runner: Arc<dyn CommandRunner>,
    deps: EngineDeps,
) -> Result<Arc<dyn BackupEngine>, EngineError> {
    match config.engine_mode.as_str() {
        "pg-native" => {
            let repository = match &deps.repository {
                Some(repository) => Arc::clone(repository),
                None => Arc::new(
                    crate::artifacts::build_repository(&config, runner.as_ref())
                        .map_err(|error| EngineError::Configuration(error.to_string()))?,
                ),
            };
            Ok(Arc::new(pg_native::PgNativeEngine::new(
                config, runner, repository, deps,
            )?))
        }
        other => Err(EngineError::Configuration(format!(
            "BACKUP_ENGINE_MODE={other} is not implemented by backup-daemon-rs (P9-T02): the \
             {other} engine remains an explicit TypeScript-daemon option; use BACKUP_ENGINE_MODE=pg-native \
             or run deploy/backup-daemon for {other}"
        ))),
    }
}

/// Overview fallback when the engine cannot be asked at all.
#[must_use]
pub fn engine_failure_health(message: &str) -> EngineHealth {
    EngineHealth {
        healthy: false,
        wal: WalHealth::default(),
        targets: vec![BackupStorageTarget {
            id: "engine".to_owned(),
            name: "Backup Engine".to_owned(),
            kind: "database".to_owned(),
            healthy: false,
            detail: message.to_owned(),
        }],
    }
}

/// Empty WAL health used by the overview fallback.
#[must_use]
pub fn empty_wal_health() -> WalHealth {
    WalHealth::default()
}

/// Small helper used by `wal_status` JSON assembly.
#[must_use]
pub fn wal_stream_health_target(
    target: &str,
    running: bool,
    started_at: Option<&str>,
    last_error: Option<&str>,
    lag_bytes: Option<u64>,
    alert_bytes: u64,
) -> BackupStorageTarget {
    let lag = match lag_bytes {
        Some(bytes) => format!(
            "{:.1} MiB behind the primary",
            bytes as f64 / (1024.0 * 1024.0)
        ),
        None => "lag unknown".to_owned(),
    };
    let too_far = lag_bytes.is_some_and(|bytes| bytes > alert_bytes);
    BackupStorageTarget {
        id: format!("wal-stream-{target}"),
        name: format!("WAL Stream ({target})"),
        kind: "database".to_owned(),
        healthy: running && !too_far,
        detail: if !running {
            last_error
                .unwrap_or("pg_receivewal is not running")
                .to_owned()
        } else if too_far {
            format!(
                "streaming but {lag} (alert above {} MiB)",
                alert_bytes / (1024 * 1024)
            )
        } else {
            format!("streaming since {}, {lag}", started_at.unwrap_or("unknown"))
        },
    }
}

#[must_use]
pub fn minimal_targets_json(targets: &[BackupStorageTarget]) -> Value {
    serde_json::to_value(targets).unwrap_or_else(|_| json!([]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pg_config::Env;

    fn config() -> Config {
        Config::from_env(
            &Env::default()
                .with_value("BACKUP_ENGINE_MODE", "pg-native")
                .with_value(
                    "BACKUP_ENCRYPTION_KEY_HEX",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                ),
        )
        .expect("config")
    }

    #[test]
    fn expand_targets_follows_the_topology() {
        let config = config();
        assert_eq!(
            expand_targets(&config, BackupTarget::All),
            vec![BackupTarget::PostgresCore, BackupTarget::AuditDb]
        );
        let with_redis = Config::from_env(
            &Env::default()
                .with_value("BACKUP_ENGINE_MODE", "pg-native")
                .with_value(
                    "BACKUP_ENCRYPTION_KEY_HEX",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                )
                .with_value("REDIS_URL", "redis://127.0.0.1:6379"),
        )
        .expect("config");
        assert!(expand_targets(&with_redis, BackupTarget::All).contains(&BackupTarget::Redis));
        assert_eq!(
            expand_targets(&config, BackupTarget::AuditDb),
            vec![BackupTarget::AuditDb]
        );
    }

    #[test]
    fn replica_nodes_parse_both_forms() {
        let nodes = parse_replica_nodes("node1@10.0.0.1:22:10.0.0.1:5432,db2:5433,plain");
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].host, "10.0.0.1");
        assert_eq!(nodes[1].port, 5433);
        assert_eq!(nodes[2].host, "plain");
    }
}
