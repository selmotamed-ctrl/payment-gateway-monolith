//! Shared fixtures for the ported backup-daemon test suite.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use backup_daemon::artifacts::{ArtifactRepository, MemoryArtifactStore};
use backup_daemon::command_runner::{
    BoxFuture, CommandError, CommandResult, CommandRunner, RunOptions,
};
use backup_daemon::config::{Config, PgEndpoint};
use backup_daemon::crypto::master_key_from_hex;
use backup_daemon::drill::{
    compute_audit_row_hash, AuditChainRow, DrillCheckResult, DrillChecks, DrillFileSystem,
    DrillFuture, DrillReport, DrillRunOptions, DrillRunner, GENESIS_HASH,
};
use backup_daemon::engine::{
    BackupEngine, BackupExecutionResult, BackupKind, BackupStorageTarget, BackupSummary,
    BackupTarget, EngineError, EngineFuture, EngineHealth, RecoverLogicalRequest, RecoverRequest,
    RecoverResult, WalHealth, WalIngestOutcome,
};
use backup_daemon::pg_tools::PgCluster;
use chrono::{DateTime, Utc};
use pg_config::Env;
use serde_json::json;

pub const ENCRYPTION_KEY_HEX: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
pub const PG_PASSWORD: &str = "super-secret-password";
pub const S3_ACCESS_KEY: &str = "AKIA-TEST-ACCESS";
pub const S3_SECRET_KEY: &str = "s3-test-secret-value";
pub const NOW_ISO: &str = "2026-11-03T12:00:00.000Z";

pub fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(NOW_ISO)
        .expect("valid timestamp")
        .with_timezone(&Utc)
}

pub fn base_env() -> Env {
    Env::default()
        .with_value("BACKUP_ENGINE_MODE", "wal-g")
        .with_value("BACKUP_ENCRYPTION_KEY_HEX", ENCRYPTION_KEY_HEX)
        .with_value(
            "BACKUP_PRIMARY_S3_ENDPOINT",
            "https://s3.eu-central-1.amazonaws.com",
        )
        .with_value(
            "BACKUP_PRIMARY_S3_BUCKET",
            "s3://libya-pg-backups-primary/prod",
        )
        .with_value("BACKUP_PRIMARY_S3_ACCESS_KEY", S3_ACCESS_KEY)
        .with_value("BACKUP_PRIMARY_S3_SECRET_KEY", S3_SECRET_KEY)
        .with_value("PG_PRIMARY_PASSWORD", PG_PASSWORD)
}

pub fn make_config(overrides: &[(&str, &str)]) -> Config {
    let mut env = base_env();
    for (key, value) in overrides {
        env = env.with_value(*key, *value);
    }
    Config::from_env(&env).expect("valid config")
}

pub fn master() -> Vec<u8> {
    master_key_from_hex(ENCRYPTION_KEY_HEX).expect("valid key")
}

#[derive(Debug, Clone)]
pub struct RecordedCall {
    pub command: String,
    pub args: Vec<String>,
    pub env_keys: Vec<String>,
    pub timeout_ms: Option<u64>,
}

pub type Responder = Box<dyn Fn(&str, &[String], &RunOptions) -> CommandResult + Send + Sync>;

pub struct RecordingRunner {
    calls: Mutex<Vec<RecordedCall>>,
    responder: Responder,
}

impl RecordingRunner {
    pub fn new(
        responder: impl Fn(&str, &[String], &RunOptions) -> CommandResult + Send + Sync + 'static,
    ) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            responder: Box::new(responder),
        }
    }

    pub fn ok() -> Self {
        Self::new(|_, _, _| CommandResult {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        })
    }

    pub fn calls(&self) -> Vec<RecordedCall> {
        self.calls
            .lock()
            .map(|calls| calls.clone())
            .unwrap_or_default()
    }

    pub fn commands(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .map(|call| {
                call.command
                    .rsplit('/')
                    .next()
                    .unwrap_or(&call.command)
                    .to_owned()
            })
            .collect()
    }
}

impl CommandRunner for RecordingRunner {
    fn run<'a>(
        &'a self,
        command: &'a str,
        args: &'a [String],
        options: RunOptions,
    ) -> BoxFuture<'a, Result<CommandResult, CommandError>> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(RecordedCall {
                command: command.to_owned(),
                args: args.to_vec(),
                env_keys: options.env.iter().map(|(key, _)| key.clone()).collect(),
                timeout_ms: options.timeout_ms,
            });
        let result = (self.responder)(command, args, &options);
        Box::pin(async move { Ok(result) })
    }
}

pub type TriggerFn = Box<
    dyn Fn(BackupTarget, BackupKind) -> Result<BackupExecutionResult, EngineError> + Send + Sync,
>;
pub type RecoverFn = Box<
    dyn Fn(RecoverRequest) -> BoxFuture<'static, Result<RecoverResult, EngineError>> + Send + Sync,
>;
pub type IngestFn = Box<
    dyn Fn(&str, &str, &[u8], Option<u64>) -> Result<WalIngestOutcome, EngineError> + Send + Sync,
>;

pub struct FakeEngine {
    pub health: Mutex<EngineHealth>,
    pub trigger_calls: Mutex<Vec<(BackupTarget, BackupKind)>>,
    pub prune_calls: Mutex<Vec<(BackupTarget, Option<BackupKind>)>>,
    pub recovered: Mutex<Vec<RecoverRequest>>,
    pub logical_restores: Mutex<Vec<RecoverLogicalRequest>>,
    trigger: TriggerFn,
    recover: RecoverFn,
    ingest: Mutex<Option<IngestFn>>,
}

impl FakeEngine {
    pub fn new(
        trigger: impl Fn(BackupTarget, BackupKind) -> Result<BackupExecutionResult, EngineError>
            + Send
            + Sync
            + 'static,
        recover: impl Fn(RecoverRequest) -> BoxFuture<'static, Result<RecoverResult, EngineError>>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self {
            health: Mutex::new(EngineHealth {
                healthy: true,
                wal: WalHealth {
                    archive_lag_seconds: 2,
                    current_lsn: "0/16B6C50".to_owned(),
                    last_archived_lsn: "0/16B6C00".to_owned(),
                    lag_bytes: 80,
                },
                targets: vec![
                    BackupStorageTarget {
                        id: "primary-s3".to_owned(),
                        name: "Primary S3 Bucket".to_owned(),
                        kind: "s3".to_owned(),
                        healthy: true,
                        detail: "reachable".to_owned(),
                    },
                    BackupStorageTarget {
                        id: "postgres-primary".to_owned(),
                        name: "PostgreSQL Primary".to_owned(),
                        kind: "database".to_owned(),
                        healthy: true,
                        detail: "reachable".to_owned(),
                    },
                ],
            }),
            trigger_calls: Mutex::new(Vec::new()),
            prune_calls: Mutex::new(Vec::new()),
            recovered: Mutex::new(Vec::new()),
            logical_restores: Mutex::new(Vec::new()),
            trigger: Box::new(trigger),
            recover: Box::new(recover),
            ingest: Mutex::new(None),
        }
    }

    pub fn with_ingest(mut self, ingest: IngestFn) -> Self {
        self.ingest = Mutex::new(Some(ingest));
        self
    }

    pub fn trigger_count(&self) -> usize {
        self.trigger_calls
            .lock()
            .map(|calls| calls.len())
            .unwrap_or(0)
    }
}

impl BackupEngine for FakeEngine {
    fn overview_health(&self) -> EngineFuture<'_, EngineHealth> {
        let health = self
            .health
            .lock()
            .map(|health| health.clone())
            .unwrap_or(EngineHealth {
                healthy: false,
                wal: WalHealth::default(),
                targets: Vec::new(),
            });
        Box::pin(async move { Ok(health) })
    }

    fn trigger_backup(
        &self,
        target: BackupTarget,
        kind: BackupKind,
    ) -> EngineFuture<'_, BackupExecutionResult> {
        self.trigger_calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((target, kind));
        let result = (self.trigger)(target, kind);
        Box::pin(async move { result })
    }

    fn list_backups(
        &self,
        _limit: usize,
        _target: Option<BackupTarget>,
    ) -> EngineFuture<'_, Vec<BackupSummary>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn ingest_wal(
        &self,
        target: &str,
        file: &str,
        body: Vec<u8>,
        declared_length: Option<u64>,
    ) -> EngineFuture<'_, WalIngestOutcome> {
        let ingest = self
            .ingest
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(ingest) = ingest.as_ref() else {
            return Box::pin(async {
                Err(EngineError::Unsupported(
                    "wal_push_not_supported".to_owned(),
                ))
            });
        };
        let target = target.to_owned();
        let file = file.to_owned();
        let outcome = ingest(&target, &file, &body, declared_length);
        Box::pin(async move { outcome })
    }

    fn recover(&self, request: RecoverRequest) -> EngineFuture<'_, RecoverResult> {
        self.recovered
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(request.clone());
        (self.recover)(request)
    }

    fn restore_logical(&self, request: RecoverLogicalRequest) -> EngineFuture<'_, (bool, String)> {
        self.logical_restores
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(request);
        Box::pin(async { Ok((true, "restored logical dump".to_owned())) })
    }

    fn prune(&self, target: BackupTarget, kind: Option<BackupKind>) -> EngineFuture<'_, ()> {
        self.prune_calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((target, kind));
        Box::pin(async { Ok(()) })
    }

    fn supports_wal_ingest(&self) -> bool {
        self.ingest
            .lock()
            .map(|ingest| ingest.is_some())
            .unwrap_or(false)
    }
}

pub type DrillRunFn = Box<dyn Fn(DrillRunOptions) -> Result<DrillReport, String> + Send + Sync>;

pub struct FakeDrillRunner {
    run: DrillRunFn,
    pub calls: Mutex<Vec<DrillRunOptions>>,
}

impl FakeDrillRunner {
    pub fn new(
        run: impl Fn(DrillRunOptions) -> Result<DrillReport, String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            run: Box::new(run),
            calls: Mutex::new(Vec::new()),
        }
    }

    pub fn failing(message: &'static str) -> Self {
        Self::new(move |_| Err(message.to_owned()))
    }

    pub fn reports() -> Self {
        Self::new(|options| Ok(make_drill_report(options.id.as_deref().unwrap_or("drill"))))
    }
}

impl DrillRunner for FakeDrillRunner {
    fn run(&self, options: DrillRunOptions) -> DrillFuture<'_, Result<DrillReport, String>> {
        self.calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(options.clone());
        let result = (self.run)(options);
        Box::pin(async move { result })
    }
}

pub fn make_drill_report(id: &str) -> DrillReport {
    DrillReport {
        id: id.to_owned(),
        status: "PASSED".to_owned(),
        started_at: "2026-11-03T10:00:00.000Z".to_owned(),
        completed_at: "2026-11-03T10:01:00.000Z".to_owned(),
        duration_ms: 60_000,
        target_time: "2026-11-03T09:55:00.000Z".to_owned(),
        replayed_lsn: "0/16B6C50".to_owned(),
        double_entry_drift: "0.0000".to_owned(),
        balance_mismatches: 0,
        audit_broken_links: 0,
        journal_line_count: 42,
        checks: DrillChecks {
            double_entry: DrillCheckResult {
                ok: true,
                detail: "drift zero".to_owned(),
            },
            balance_parity: DrillCheckResult {
                ok: true,
                detail: "0 mismatches".to_owned(),
            },
            audit_chain: DrillCheckResult {
                ok: true,
                detail: "verified".to_owned(),
            },
            object_storage: None,
        },
        error_message: None,
        report_signature: None,
    }
}

pub struct MemoryDrillFileSystem {
    files: Mutex<BTreeMap<PathBuf, String>>,
    directories: Mutex<BTreeSet<PathBuf>>,
    pub removed: Mutex<Vec<PathBuf>>,
    pub written: Mutex<Vec<(PathBuf, String)>>,
}

impl MemoryDrillFileSystem {
    pub fn new(initial: &[(&str, &str)]) -> Self {
        let files = initial
            .iter()
            .map(|(path, content)| (PathBuf::from(path), (*content).to_owned()))
            .collect();
        Self {
            files: Mutex::new(files),
            directories: Mutex::new(BTreeSet::new()),
            removed: Mutex::new(Vec::new()),
            written: Mutex::new(Vec::new()),
        }
    }

    pub fn with_files(initial: &[(&Path, &str)]) -> Self {
        let files = initial
            .iter()
            .map(|(path, content)| ((*path).to_path_buf(), (*content).to_owned()))
            .collect();
        Self {
            files: Mutex::new(files),
            directories: Mutex::new(BTreeSet::new()),
            removed: Mutex::new(Vec::new()),
            written: Mutex::new(Vec::new()),
        }
    }

    pub fn write_now(&self, path: &Path, content: &str) {
        if let Ok(mut files) = self.files.lock() {
            files.insert(path.to_path_buf(), content.to_owned());
        }
    }

    pub fn snapshot(&self) -> BTreeMap<PathBuf, String> {
        self.files
            .lock()
            .map(|files| files.clone())
            .unwrap_or_default()
    }

    pub fn has(&self, path: &str) -> bool {
        self.snapshot().contains_key(&PathBuf::from(path))
    }
}

impl DrillFileSystem for MemoryDrillFileSystem {
    fn rm<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<()>> {
        Box::pin(async move {
            self.removed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(path.to_path_buf());
            if let Ok(mut files) = self.files.lock() {
                files.retain(|candidate, _| !candidate.starts_with(path));
            }
            if let Ok(mut directories) = self.directories.lock() {
                directories.retain(|candidate| !candidate.starts_with(path));
            }
            Ok(())
        })
    }

    fn mkdir<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<()>> {
        Box::pin(async move {
            if let Ok(mut directories) = self.directories.lock() {
                directories.insert(path.to_path_buf());
            }
            Ok(())
        })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a Path,
        data: &'a str,
    ) -> DrillFuture<'a, std::io::Result<()>> {
        Box::pin(async move {
            if let Some(parent) = path.parent() {
                if let Ok(mut directories) = self.directories.lock() {
                    directories.insert(parent.to_path_buf());
                }
            }
            if let Ok(mut files) = self.files.lock() {
                files.insert(path.to_path_buf(), data.to_owned());
            }
            if let Ok(mut written) = self.written.lock() {
                written.push((path.to_path_buf(), data.to_owned()));
            }
            Ok(())
        })
    }

    fn read_file<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<String>> {
        Box::pin(async move {
            self.files
                .lock()
                .ok()
                .and_then(|files| files.get(path).cloned())
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "ENOENT"))
        })
    }

    fn exists<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<bool>> {
        Box::pin(async move {
            let in_files = self
                .files
                .lock()
                .map(|files| files.contains_key(path))
                .unwrap_or(false);
            let in_dirs = self
                .directories
                .lock()
                .map(|directories| directories.contains(path))
                .unwrap_or(false);
            Ok(in_files || in_dirs)
        })
    }
}

pub fn dump_aware_runner(audit_database_present: bool) -> RecordingRunner {
    RecordingRunner::new(move |command, args, _options| {
        let binary = command.rsplit('/').next().unwrap_or(command);
        if binary == "psql" {
            let query = args.last().map(String::as_str).unwrap_or("");
            if query.contains("FROM pg_database") {
                return CommandResult {
                    code: 0,
                    stdout: if audit_database_present {
                        "1\n".to_owned()
                    } else {
                        "\n".to_owned()
                    },
                    stderr: String::new(),
                };
            }
            return CommandResult {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            };
        }
        if binary == "pg_dump" {
            if let Some(index) = args.iter().position(|arg| arg == "--file") {
                if let Some(file) = args.get(index + 1) {
                    let _ = std::fs::write(file, b"PGDMP-fake-custom-format-archive");
                }
            }
            return CommandResult {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            };
        }
        if binary == "pg_restore" && args.iter().any(|arg| arg == "--list") {
            return CommandResult {
                code: 0,
                stdout: "; Archive created at 2026-11-06\n; dbname: pg_audit_db\n".to_owned(),
                stderr: String::new(),
            };
        }
        CommandResult {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    })
}

pub fn primary_endpoint(config: &Config) -> PgEndpoint {
    PgEndpoint {
        host: config.pg_primary_host.clone(),
        port: config.pg_primary_port,
        user: config.pg_primary_user.clone(),
        password: config.pg_primary_password.clone(),
    }
}

pub fn pg_cluster_core() -> PgCluster {
    PgCluster::Core
}

pub fn memory_repository() -> (
    Arc<ArtifactRepository>,
    Arc<MemoryArtifactStore>,
    Arc<MemoryArtifactStore>,
) {
    let s3 = Arc::new(MemoryArtifactStore::new(
        "primary-s3",
        "Primary S3 Bucket",
        backup_daemon::artifacts::StoreKind::S3,
    ));
    let vault = Arc::new(MemoryArtifactStore::new(
        "secondary-ssh",
        "Secondary Off-site Target",
        backup_daemon::artifacts::StoreKind::Ssh,
    ));
    let repository = Arc::new(ArtifactRepository::new(vec![s3.clone(), vault.clone()]));
    (repository, s3, vault)
}

pub fn backup_run(id: &str) -> backup_daemon::catalog::BackupRun {
    backup_daemon::catalog::BackupRun {
        id: id.to_owned(),
        target: "postgres_core".to_owned(),
        kind: "full".to_owned(),
        engine: "pg-native".to_owned(),
        status: "QUEUED".to_owned(),
        started_at: "2026-11-03T10:00:00.000Z".to_owned(),
        completed_at: None,
        duration_ms: None,
        size_bytes: None,
        start_lsn: None,
        end_lsn: None,
        storage_targets: Vec::new(),
        error_message: None,
    }
}

pub fn audit_rows() -> Vec<AuditChainRow> {
    let first = AuditChainRow {
        seq_no: "1".to_owned(),
        id: "0190a000-0000-7000-8000-000000000001".to_owned(),
        created_at: "2026-11-03T10:00:00.000Z".to_owned(),
        actor_id: "0190a000-0000-7000-8000-000000000011".to_owned(),
        action: "MERCHANT_APPROVED".to_owned(),
        entity_type: "merchant".to_owned(),
        entity_id: "merchant-1".to_owned(),
        before_json: json!({"status": "PENDING", "z": 1, "a": 2}),
        after_json: json!({"status": "ACTIVE"}),
        before_json_text: None,
        after_json_text: None,
        prev_hash: GENESIS_HASH.to_owned(),
        row_hash: String::new(),
    };
    let first_hash = compute_audit_row_hash(&first.prev_hash, &first);
    let mut first = first;
    first.row_hash = first_hash.clone();
    let second = AuditChainRow {
        seq_no: "2".to_owned(),
        id: "0190a000-0000-7000-8000-000000000002".to_owned(),
        created_at: "2026-11-03T10:01:00.000Z".to_owned(),
        actor_id: "0190a000-0000-7000-8000-000000000012".to_owned(),
        action: "POLICY_UPDATED".to_owned(),
        entity_type: "policy".to_owned(),
        entity_id: "policy-1".to_owned(),
        before_json: json!({"threshold": 10}),
        after_json: json!({"threshold": 20}),
        before_json_text: None,
        after_json_text: None,
        prev_hash: first_hash,
        row_hash: String::new(),
    };
    let second_hash = compute_audit_row_hash(&second.prev_hash, &second);
    let mut second = second;
    second.row_hash = second_hash;
    vec![first, second]
}

pub fn drill_runner(outputs: DrillOutputs, start_fails: bool) -> RecordingRunner {
    let recovery_states = Arc::new(Mutex::new(outputs.recovery_states.clone()));
    RecordingRunner::new(move |command, args, _options| {
        let binary = command.rsplit('/').next().unwrap_or(command);
        if binary == "pg_ctl" {
            if start_fails && args.iter().any(|arg| arg == "start") {
                return CommandResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: "could not start scratch postgres".to_owned(),
                };
            }
            return CommandResult {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            };
        }
        if binary == "initdb" {
            return CommandResult {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            };
        }
        if binary == "psql" {
            let query = args.last().map(String::as_str).unwrap_or("");
            if query == backup_daemon::drill::DOUBLE_ENTRY_QUERY {
                return CommandResult {
                    code: 0,
                    stdout: format!("{}\n", outputs.double_entry),
                    stderr: String::new(),
                };
            }
            if query == backup_daemon::drill::BALANCE_PARITY_QUERY {
                return CommandResult {
                    code: 0,
                    stdout: format!("{}\n", outputs.balance_parity),
                    stderr: String::new(),
                };
            }
            if query == backup_daemon::drill::JOURNAL_LINE_COUNT_QUERY {
                return CommandResult {
                    code: 0,
                    stdout: format!("{}\n", outputs.journal_count),
                    stderr: String::new(),
                };
            }
            if query == backup_daemon::drill::AUDIT_CHAIN_QUERY {
                return CommandResult {
                    code: 0,
                    stdout: format!("{}\n", outputs.audit),
                    stderr: String::new(),
                };
            }
            if query == backup_daemon::drill::REPLAYED_LSN_QUERY {
                return CommandResult {
                    code: 0,
                    stdout: format!("{}\n", outputs.replayed_lsn),
                    stderr: String::new(),
                };
            }
            if query == "SELECT pg_is_in_recovery();" {
                let mut states = recovery_states
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let answer = if states.len() > 1 {
                    states.remove(0)
                } else {
                    states.first().cloned().unwrap_or_else(|| "f".to_owned())
                };
                return CommandResult {
                    code: 0,
                    stdout: format!("{answer}\n"),
                    stderr: String::new(),
                };
            }
            if query.starts_with("SELECT 1 FROM pg_database") {
                return CommandResult {
                    code: 0,
                    stdout: format!(
                        "{}\n",
                        if outputs.audit_database_present {
                            "1"
                        } else {
                            ""
                        }
                    ),
                    stderr: String::new(),
                };
            }
            return CommandResult {
                code: 1,
                stdout: String::new(),
                stderr: format!("unexpected query {query}"),
            };
        }
        CommandResult {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    })
}

pub struct DrillOutputs {
    pub double_entry: String,
    pub balance_parity: String,
    pub journal_count: String,
    pub audit: String,
    pub replayed_lsn: String,
    pub recovery_states: Vec<String>,
    pub audit_database_present: bool,
}

impl Default for DrillOutputs {
    fn default() -> Self {
        Self {
            double_entry: "0.0000".to_owned(),
            balance_parity: "0".to_owned(),
            journal_count: "3".to_owned(),
            audit: serde_json::Value::Array(Vec::new()).to_string(),
            replayed_lsn: String::new(),
            recovery_states: vec!["f".to_owned()],
            audit_database_present: true,
        }
    }
}

pub fn audit_output() -> String {
    let rows: Vec<serde_json::Value> = audit_rows()
        .into_iter()
        .map(|row| {
            json!({
                "seqNo": row.seq_no,
                "id": row.id,
                "createdAt": row.created_at,
                "actorId": row.actor_id,
                "action": row.action,
                "entityType": row.entity_type,
                "entityId": row.entity_id,
                "beforeJson": row.before_json,
                "afterJson": row.after_json,
                "prevHash": row.prev_hash,
                "rowHash": row.row_hash,
            })
        })
        .collect();
    serde_json::Value::Array(rows).to_string()
}

pub fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    port
}
