//! Scratch-cluster restore drill with drift, shard-parity and audit-chain proofs.
//! Port of `deploy/backup-daemon/src/restoreDrillRunner.ts`.
//!
//! Settings forced onto EVERY scratch cluster: the restored `postgresql.auto.conf` still carries the
//! production `archive_command`; without [`SCRATCH_SAFETY_CONF`] a promoted scratch cluster would
//! push its own WAL into the real archive and corrupt point-in-time recovery for production.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::fs;

use crate::artifacts::ArtifactRepository;
use crate::command_runner::{BoxFuture, CommandResult, CommandRunner, RunOptions};
use crate::config::{
    audit_endpoint, is_audit_dedicated_cluster, object_storage_backup_configured, redact_text,
    Config, PgEndpoint,
};
use crate::crypto::{sign_stable_json, verify_stable_json};
use crate::engine::{
    build_psql_command, BackupEngine, RecoverLogicalRequest, RecoverRequest, RecoveryTarget,
};
use crate::object_storage::{
    parse_restored_objects, verify_manifest_parity, OBJECT_STORAGE_EXISTS_QUERY,
    RESTORED_ACTIVE_REFS_QUERY,
};
use crate::pg_tools::pg_bin;
use crate::util::stable_json;

// ---------------------------------------------------------------------------
// SQL proofs (verbatim from the TS runner)
// ---------------------------------------------------------------------------

pub const DOUBLE_ENTRY_QUERY: &str =
    "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0)::text FROM journal_lines;";

/// Per-shard ledger proof on the RESTORED database, counting the shards that fail it (0 = healthy).
pub const BALANCE_PARITY_QUERY: &str = "SELECT COUNT(*)::text FROM gl_account_shards s LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id CROSS JOIN LATERAL (SELECT COALESCE(SUM(x.signed), 0) AS total, COALESCE(SUM(x.signed) FILTER (WHERE x.shard_seq <= COALESCE(c.checkpoint_seq, 0)), 0) AS upto_checkpoint, COUNT(*) FILTER (WHERE x.shard_seq > COALESCE(c.baseline_seq, 0)) AS sequenced FROM (SELECT CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END AS signed, l.shard_seq FROM journal_lines l WHERE l.gl_account_id = s.gl_account_id AND l.shard_id = s.shard_id) x) j WHERE s.current_balance <> j.total OR COALESCE(c.checkpoint_balance, 0) <> j.upto_checkpoint OR j.sequenced <> s.line_seq - COALESCE(c.baseline_seq, 0);";

pub const JOURNAL_LINE_COUNT_QUERY: &str = "SELECT COUNT(*)::text FROM journal_lines;";

pub const REPLAYED_LSN_QUERY: &str =
    "SELECT COALESCE(pg_last_wal_replay_lsn(), pg_current_wal_lsn())::text;";

/// The audit trigger hashes `before_json::text` / `after_json::text` (JSONB text form), so the query
/// returns the database's own text and the timestamp formatted exactly as the trigger formats it.
pub const AUDIT_CHAIN_QUERY: &str = "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.\"seqNo\"::bigint), '[]'::json)::text FROM (SELECT seq_no::text AS \"seqNo\", id::text AS \"id\", to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"createdAt\", actor_id::text AS \"actorId\", action, entity_type AS \"entityType\", entity_id AS \"entityId\", before_json AS \"beforeJson\", after_json AS \"afterJson\", before_json::text AS \"beforeJsonText\", after_json::text AS \"afterJsonText\", prev_hash AS \"prevHash\", row_hash AS \"rowHash\" FROM audit_records ORDER BY seq_no ASC) t;";

/// Settings forced onto every scratch cluster.
pub const SCRATCH_SAFETY_CONF: &str = "archive_mode = off\narchive_command = ''\nprimary_conninfo = ''\nprimary_slot_name = ''\nsynchronous_standby_names = ''\nsummarize_wal = off\nssl = off\nhot_standby = on\n";

pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// `pg_controldata` labels -> `postgresql.conf` names. Hot standby refuses to start below the
/// primary's values.
const CONTROL_DATA_SETTINGS: [(&str, &str); 5] = [
    ("max_connections setting", "max_connections"),
    ("max_worker_processes setting", "max_worker_processes"),
    ("max_wal_senders setting", "max_wal_senders"),
    ("max_prepared_xacts setting", "max_prepared_transactions"),
    ("max_locks_per_xact setting", "max_locks_per_transaction"),
];

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DrillCheckResult {
    pub ok: bool,
    pub detail: String,
}

impl DrillCheckResult {
    #[must_use]
    pub fn not_executed() -> Self {
        Self {
            ok: false,
            detail: "not executed".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DrillChecks {
    pub double_entry: DrillCheckResult,
    pub balance_parity: DrillCheckResult,
    pub audit_chain: DrillCheckResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_storage: Option<DrillCheckResult>,
}

impl DrillChecks {
    #[must_use]
    pub fn default_checks() -> Self {
        Self {
            double_entry: DrillCheckResult::not_executed(),
            balance_parity: DrillCheckResult::not_executed(),
            audit_chain: DrillCheckResult::not_executed(),
            object_storage: None,
        }
    }
}

fn deserialize_drift<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(match value {
        Value::String(text) => text,
        Value::Number(number) => number.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DrillReport {
    pub id: String,
    pub status: String,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    pub target_time: String,
    pub replayed_lsn: String,
    #[serde(deserialize_with = "deserialize_drift")]
    pub double_entry_drift: String,
    pub balance_mismatches: u64,
    pub audit_broken_links: u64,
    pub journal_line_count: u64,
    pub checks: DrillChecks,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_signature: Option<String>,
}

impl DrillReport {
    /// The FAILED report the server records when the drill orchestration itself throws.
    #[must_use]
    pub fn failed(
        id: &str,
        started_at: &str,
        completed_at: &str,
        duration_ms: u64,
        target_time: &str,
        error_message: &str,
    ) -> Self {
        Self {
            id: id.to_owned(),
            status: "FAILED".to_owned(),
            started_at: started_at.to_owned(),
            completed_at: completed_at.to_owned(),
            duration_ms,
            target_time: target_time.to_owned(),
            replayed_lsn: String::new(),
            double_entry_drift: String::new(),
            balance_mismatches: 0,
            audit_broken_links: 0,
            journal_line_count: 0,
            checks: DrillChecks::default_checks(),
            error_message: Some(error_message.to_owned()),
            report_signature: None,
        }
    }

    /// Everything the HMAC covers (`reportSignature` excluded).
    #[must_use]
    pub fn signing_payload(&self) -> Value {
        json!({
            "id": self.id,
            "status": self.status,
            "startedAt": self.started_at,
            "completedAt": self.completed_at,
            "durationMs": self.duration_ms,
            "targetTime": self.target_time,
            "replayedLsn": self.replayed_lsn,
            "doubleEntryDrift": self.double_entry_drift,
            "balanceMismatches": self.balance_mismatches,
            "auditBrokenLinks": self.audit_broken_links,
            "journalLineCount": self.journal_line_count,
            "checks": self.checks,
            "errorMessage": self.error_message,
        })
    }
}

pub fn sign_drill_report(report: &DrillReport, key_hex: &str) -> Result<String, String> {
    sign_stable_json(&report.signing_payload(), key_hex).map_err(|error| error.to_string())
}

#[must_use]
pub fn verify_drill_report_signature(report: &DrillReport, key_hex: &str) -> bool {
    report
        .report_signature
        .as_deref()
        .is_some_and(|signature| verify_stable_json(&report.signing_payload(), signature, key_hex))
}

// ---------------------------------------------------------------------------
// Audit hash chain
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditChainRow {
    pub seq_no: String,
    pub id: String,
    pub created_at: String,
    pub actor_id: String,
    pub action: String,
    pub entity_type: String,
    pub entity_id: String,
    pub before_json: Value,
    pub after_json: Value,
    /// `before_json::text` / `after_json::text` exactly as PostgreSQL renders them.
    pub before_json_text: Option<String>,
    pub after_json_text: Option<String>,
    pub prev_hash: String,
    pub row_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditVerification {
    pub valid: bool,
    pub broken_links: u64,
    pub verified_count: usize,
    pub first_broken_seq_no: Option<String>,
    pub detail: String,
}

pub fn build_audit_canonical_payload(prev_hash: &str, row: &AuditChainRow) -> String {
    [
        prev_hash,
        &row.id,
        &row.created_at,
        &row.actor_id,
        &row.action,
        &row.entity_type,
        &row.entity_id,
        &stable_json(&row.before_json),
        &stable_json(&row.after_json),
    ]
    .join("|")
}

#[must_use]
pub fn compute_audit_row_hash(prev_hash: &str, row: &AuditChainRow) -> String {
    hex::encode(Sha256::digest(
        build_audit_canonical_payload(prev_hash, row).as_bytes(),
    ))
}

/// The trigger's canonical form: the database's own JSONB text, not a re-serialization.
pub fn build_trigger_canonical_payload(
    prev_hash: &str,
    row: &AuditChainRow,
    before_json_text: &str,
    after_json_text: &str,
) -> String {
    [
        prev_hash,
        &row.id,
        &row.created_at,
        &row.actor_id,
        &row.action,
        &row.entity_type,
        &row.entity_id,
        before_json_text,
        after_json_text,
    ]
    .join("|")
}

/// A row is intact when EITHER canonical form reproduces its stored hash.
#[must_use]
pub fn audit_row_hash_matches(prev_hash: &str, row: &AuditChainRow) -> bool {
    if let (Some(before), Some(after)) = (&row.before_json_text, &row.after_json_text) {
        let trigger_hash = hex::encode(Sha256::digest(
            build_trigger_canonical_payload(prev_hash, row, before, after).as_bytes(),
        ));
        if row.row_hash == trigger_hash {
            return true;
        }
    }
    row.row_hash == compute_audit_row_hash(prev_hash, row)
}

#[must_use]
pub fn verify_audit_chain(rows: &[AuditChainRow]) -> AuditVerification {
    let mut previous_hash = GENESIS_HASH.to_owned();
    let mut broken_links = 0_u64;
    let mut first_broken_seq_no: Option<String> = None;
    let mut expected_seq = 1_u64;
    for row in rows {
        let link_broken = row.prev_hash != previous_hash;
        let hash_broken = !audit_row_hash_matches(&previous_hash, row);
        // seq_no is gap-free by construction, so a missing number means a deleted row.
        let seq_number = row.seq_no.parse::<u64>().ok();
        let gap = seq_number.is_some_and(|number| number != expected_seq);
        expected_seq = seq_number.map_or(expected_seq + 1, |number| number + 1);
        if link_broken || hash_broken || gap {
            broken_links += 1;
            if first_broken_seq_no.is_none() {
                first_broken_seq_no = Some(row.seq_no.clone());
            }
        }
        previous_hash = row.row_hash.clone();
    }
    AuditVerification {
        valid: broken_links == 0,
        broken_links,
        verified_count: rows.len(),
        first_broken_seq_no: first_broken_seq_no.clone(),
        detail: if broken_links == 0 {
            format!("verified {} audit rows", rows.len())
        } else {
            format!(
                "{broken_links} broken audit link(s), first at seq_no {}",
                first_broken_seq_no.unwrap_or_default()
            )
        },
    }
}

fn normalize_timestamp(value: &str) -> String {
    match DateTime::parse_from_rfc3339(value) {
        Ok(parsed) => parsed
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        Err(_) => value.to_owned(),
    }
}

pub fn parse_audit_rows(stdout: &str) -> Result<Vec<AuditChainRow>, String> {
    let parsed: Value = serde_json::from_str(if stdout.trim().is_empty() {
        "[]"
    } else {
        stdout.trim()
    })
    .map_err(|error| format!("audit chain query did not return JSON: {error}"))?;
    let Value::Array(entries) = parsed else {
        return Err("audit chain query did not return an array".to_owned());
    };
    let text = |entry: &Value, camel: &str, snake: &str| -> Option<String> {
        entry
            .get(camel)
            .or_else(|| entry.get(snake))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Ok(entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| {
            let created_at = text(&entry, "createdAt", "created_at").unwrap_or_default();
            AuditChainRow {
                seq_no: text(&entry, "seqNo", "seq_no").unwrap_or_else(|| (index + 1).to_string()),
                id: text(&entry, "id", "id").unwrap_or_default(),
                created_at: normalize_timestamp(&created_at),
                actor_id: text(&entry, "actorId", "actor_id").unwrap_or_default(),
                action: text(&entry, "action", "action").unwrap_or_default(),
                entity_type: text(&entry, "entityType", "entity_type").unwrap_or_default(),
                entity_id: text(&entry, "entityId", "entity_id").unwrap_or_default(),
                before_json: entry
                    .get("beforeJson")
                    .or_else(|| entry.get("before_json"))
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                after_json: entry
                    .get("afterJson")
                    .or_else(|| entry.get("after_json"))
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                before_json_text: text(&entry, "beforeJsonText", "before_json_text"),
                after_json_text: text(&entry, "afterJsonText", "after_json_text"),
                prev_hash: text(&entry, "prevHash", "prev_hash").unwrap_or_default(),
                row_hash: text(&entry, "rowHash", "row_hash").unwrap_or_default(),
            }
        })
        .collect())
}

#[must_use]
pub fn parse_control_data(stdout: &str) -> String {
    let mut lines = Vec::new();
    for (label, name) in CONTROL_DATA_SETTINGS {
        let pattern = format!("{label}:");
        for line in stdout.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix(&pattern) {
                let value = rest
                    .trim()
                    .trim_end_matches(|character: char| !character.is_ascii_digit());
                if !value.is_empty() && value.chars().all(|character| character.is_ascii_digit()) {
                    lines.push(format!("{name} = {value}"));
                }
                break;
            }
        }
    }
    let track = stdout
        .lines()
        .any(|line| line.trim() == "track_commit_timestamp setting: on");
    if track {
        lines.push("track_commit_timestamp = on".to_owned());
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn numeric_zero(value: &str) -> bool {
    let normalized = value.trim().replace(',', "");
    if normalized.is_empty() {
        return false;
    }
    normalized
        .parse::<f64>()
        .map(|parsed| parsed == 0.0)
        .unwrap_or(false)
}

fn numeric_integer(value: &str) -> Option<u64> {
    value
        .trim()
        .replace(',', "")
        .parse::<f64>()
        .ok()
        .map(|parsed| parsed.trunc().max(0.0) as u64)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

pub type DrillFuture<'a, T> = BoxFuture<'a, T>;
pub type SleepFn = Arc<dyn Fn(u64) -> BoxFuture<'static, ()> + Send + Sync>;

pub trait DrillFileSystem: Send + Sync {
    fn rm<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<()>>;
    fn mkdir<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<()>>;
    fn write_file<'a>(
        &'a self,
        path: &'a Path,
        data: &'a str,
    ) -> DrillFuture<'a, std::io::Result<()>>;
    fn read_file<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<String>>;
    fn exists<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<bool>>;
}

pub struct RealDrillFileSystem;

impl DrillFileSystem for RealDrillFileSystem {
    fn rm<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<()>> {
        Box::pin(async move { fs::remove_dir_all(path).await })
    }

    fn mkdir<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<()>> {
        Box::pin(async move { fs::create_dir_all(path).await })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a Path,
        data: &'a str,
    ) -> DrillFuture<'a, std::io::Result<()>> {
        Box::pin(async move { fs::write(path, data).await })
    }

    fn read_file<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<String>> {
        Box::pin(async move { fs::read_to_string(path).await })
    }

    fn exists<'a>(&'a self, path: &'a Path) -> DrillFuture<'a, std::io::Result<bool>> {
        Box::pin(async move { Ok(fs::metadata(path).await.is_ok()) })
    }
}

#[derive(Debug, Clone, Default)]
pub struct DrillRunOptions {
    pub id: Option<String>,
    pub requested_by: Option<String>,
    /// Recover to this moment instead of "now - 5 minutes". Must not be in the future.
    pub target_time: Option<DateTime<Utc>>,
    /// Disaster-recovery rehearsal: replay ALL available WAL instead of stopping at a time.
    pub latest: bool,
}

pub struct DrillDependencies {
    pub config: Arc<Config>,
    pub engine: Arc<dyn BackupEngine>,
    pub runner: Arc<dyn CommandRunner>,
    pub repository: Option<Arc<ArtifactRepository>>,
    pub file_system: Option<Arc<dyn DrillFileSystem>>,
    pub clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    pub id_factory: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    pub sleep: Option<SleepFn>,
}

pub trait DrillRunner: Send + Sync {
    fn run(&self, options: DrillRunOptions) -> DrillFuture<'_, Result<DrillReport, String>>;
}

pub struct RestoreDrillRunner {
    deps: DrillDependencies,
    file_system: Arc<dyn DrillFileSystem>,
    clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    id_factory: Arc<dyn Fn() -> String + Send + Sync>,
    sleep: SleepFn,
}

impl RestoreDrillRunner {
    #[must_use]
    pub fn new(mut deps: DrillDependencies) -> Self {
        let file_system = deps
            .file_system
            .take()
            .unwrap_or_else(|| Arc::new(RealDrillFileSystem));
        let clock = Arc::clone(&deps.clock);
        let id_factory = deps
            .id_factory
            .take()
            .unwrap_or_else(|| Arc::new(|| uuid::Uuid::new_v4().to_string()));
        let sleep = deps.sleep.take().unwrap_or_else(|| {
            Arc::new(|milliseconds: u64| {
                Box::pin(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(milliseconds)).await;
                })
            })
        });
        Self {
            deps,
            file_system,
            clock,
            id_factory,
            sleep,
        }
    }

    fn safe_error(&self, error: &str) -> String {
        redact_text(error, &self.deps.config.secret_values())
    }

    async fn stop_scratch(&self, scratch: &Path) {
        let pg_ctl = pg_bin(&self.deps.config, "pg_ctl");
        let _ = self
            .deps
            .runner
            .run(
                &pg_ctl,
                &[
                    "-D".to_owned(),
                    scratch.to_string_lossy().into_owned(),
                    "-m".to_owned(),
                    "fast".to_owned(),
                    "-w".to_owned(),
                    "stop".to_owned(),
                ],
                RunOptions {
                    timeout_ms: Some(self.deps.config.command_timeout_ms),
                    ..RunOptions::default()
                },
            )
            .await;
    }

    async fn psql(
        &self,
        query: &str,
        database: &str,
        target: &str,
        dedicated_audit: bool,
        core_port: u16,
        audit_port: u16,
    ) -> CommandResult {
        let config = &self.deps.config;
        let user = if target == "audit_db" {
            audit_endpoint(config).user
        } else {
            config.pg_primary_user.clone()
        };
        let port = if target == "audit_db" && dedicated_audit {
            audit_port
        } else {
            core_port
        };
        let endpoint = PgEndpoint {
            host: "127.0.0.1".to_owned(),
            port,
            user: user.clone(),
            password: config.pg_primary_password.clone(),
        };
        let command = build_psql_command(config, query, database, &endpoint, &user);
        let mut env = command.env.clone();
        env.retain(|(key, _)| key != "PGSSLMODE");
        env.push(("PGSSLMODE".to_owned(), "disable".to_owned()));
        match self
            .deps
            .runner
            .run(
                &command.command,
                &command.args,
                RunOptions {
                    env,
                    input: None,
                    timeout_ms: Some(command.timeout_ms),
                },
            )
            .await
        {
            Ok(result) => result,
            Err(error) => CommandResult {
                code: 124,
                stdout: String::new(),
                stderr: self.safe_error(&error.to_string()),
            },
        }
    }

    async fn log_tail(&self, scratch: &Path) -> String {
        match self
            .file_system
            .read_file(&scratch.join("postgresql.log"))
            .await
        {
            Ok(text) => {
                let tail: Vec<&str> = text.trim().lines().rev().take(6).collect();
                let joined = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
                let redacted = redact_text(&joined, &self.deps.config.secret_values());
                redacted
                    .chars()
                    .rev()
                    .take(600)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect()
            }
            Err(_) => String::new(),
        }
    }

    async fn ensure_cluster(
        &self,
        scratch: &Path,
        initialized_empty_dir: bool,
        label: &str,
    ) -> Result<(), String> {
        if self
            .file_system
            .exists(&scratch.join("PG_VERSION"))
            .await
            .unwrap_or(false)
        {
            return Ok(());
        }
        if !initialized_empty_dir {
            return Err(format!(
                "{label} restore did not produce a PostgreSQL data directory (PG_VERSION missing); \
                 refusing to initdb over a failed restore"
            ));
        }
        let result = self
            .deps
            .runner
            .run(
                &pg_bin(&self.deps.config, "initdb"),
                &[
                    "-D".to_owned(),
                    scratch.to_string_lossy().into_owned(),
                    "-U".to_owned(),
                    self.deps.config.pg_primary_user.clone(),
                    "--auth=trust".to_owned(),
                    "--no-locale".to_owned(),
                    "-E".to_owned(),
                    "UTF8".to_owned(),
                ],
                RunOptions {
                    timeout_ms: Some(self.deps.config.command_timeout_ms),
                    ..RunOptions::default()
                },
            )
            .await
            .map_err(|error| format!("{label} initdb failed: {error}"))?;
        if result.code != 0 {
            return Err(format!(
                "{label} initdb failed: {}",
                result.stderr.trim().chars().take(500).collect::<String>()
            ));
        }
        Ok(())
    }

    async fn ensure_scratch_config(&self, scratch: &Path) -> Result<(), String> {
        let config_path = scratch.join("postgresql.conf");
        if !self.file_system.exists(&config_path).await.unwrap_or(false) {
            let control = self
                .deps
                .runner
                .run(
                    &pg_bin(&self.deps.config, "pg_controldata"),
                    &[scratch.to_string_lossy().into_owned()],
                    RunOptions {
                        timeout_ms: Some(self.deps.config.command_timeout_ms),
                        ..RunOptions::default()
                    },
                )
                .await
                .unwrap_or(CommandResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: String::new(),
                });
            let sized = if control.code == 0 {
                parse_control_data(&control.stdout)
            } else {
                String::new()
            };
            self.file_system
                .write_file(
                    &config_path,
                    &format!(
                        "# generated by pg-backup-daemon for a scratch restore\n{sized}fsync = off\nfull_page_writes = off\n"
                    ),
                )
                .await
                .map_err(|error| error.to_string())?;
        }
        let hba = scratch.join("pg_hba.conf");
        if !self.file_system.exists(&hba).await.unwrap_or(false) {
            self.file_system
                .write_file(
                    &hba,
                    "local all all trust\nhost all all 127.0.0.1/32 trust\n",
                )
                .await
                .map_err(|error| error.to_string())?;
        }
        let ident = scratch.join("pg_ident.conf");
        if !self.file_system.exists(&ident).await.unwrap_or(false) {
            self.file_system
                .write_file(&ident, "")
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    async fn write_recovery_files(
        &self,
        scratch: &Path,
        recovery_conf: Option<&str>,
    ) -> Result<(), String> {
        self.ensure_scratch_config(scratch).await?;
        let auto_conf_path = scratch.join("postgresql.auto.conf");
        let existing = self
            .file_system
            .read_file(&auto_conf_path)
            .await
            .unwrap_or_default();
        let separator = if !existing.trim().is_empty() && !existing.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        self.file_system
            .write_file(
                &auto_conf_path,
                &format!(
                    "{existing}{separator}{}{SCRATCH_SAFETY_CONF}",
                    recovery_conf.unwrap_or("")
                ),
            )
            .await
            .map_err(|error| error.to_string())?;
        if recovery_conf.is_some() {
            let signal = scratch.join("recovery.signal");
            if !self.file_system.exists(&signal).await.unwrap_or(false) {
                self.file_system
                    .write_file(&signal, "")
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    async fn start_cluster(&self, scratch: &Path, port: u16, label: &str) -> Result<(), String> {
        let result = self
            .deps
            .runner
            .run(
                &pg_bin(&self.deps.config, "pg_ctl"),
                &[
                    "-D".to_owned(),
                    scratch.to_string_lossy().into_owned(),
                    "-l".to_owned(),
                    scratch
                        .join("postgresql.log")
                        .to_string_lossy()
                        .into_owned(),
                    "-o".to_owned(),
                    format!(
                        "-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories={}",
                        scratch.to_string_lossy()
                    ),
                    "-w".to_owned(),
                    "start".to_owned(),
                ],
                RunOptions {
                    timeout_ms: Some(self.deps.config.command_timeout_ms),
                    ..RunOptions::default()
                },
            )
            .await
            .map_err(|error| format!("{label} pg_ctl start failed: {error}"))?;
        if result.code != 0 {
            let tail = self.log_tail(scratch).await;
            return Err(format!(
                "{label} pg_ctl start failed: {}{}",
                result.stderr.trim().chars().take(500).collect::<String>(),
                if tail.is_empty() {
                    String::new()
                } else {
                    format!(" [{tail}]")
                }
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn wait_for_recovery_promotion(
        &self,
        scratch: &Path,
        target: &str,
        label: &str,
        dedicated_audit: bool,
        core_port: u16,
        audit_port: u16,
        target_time: DateTime<Utc>,
    ) -> Result<(), String> {
        let timeout_ms = self.deps.config.recovery_timeout_ms;
        let interval_ms = 250_u64;
        let mut waited = 0_u64;
        let mut failures = 0_u32;
        while waited <= timeout_ms {
            let result = self
                .psql(
                    "SELECT pg_is_in_recovery();",
                    "postgres",
                    target,
                    dedicated_audit,
                    core_port,
                    audit_port,
                )
                .await;
            if result.code == 0 && result.stdout.trim().to_ascii_lowercase().starts_with('f') {
                return Ok(());
            }
            failures = if result.code == 0 { 0 } else { failures + 1 };
            if failures >= 40 {
                let tail = self.log_tail(scratch).await;
                return Err(format!(
                    "{label} scratch cluster stopped answering during recovery{}",
                    if tail.is_empty() {
                        String::new()
                    } else {
                        format!(" [{tail}]")
                    }
                ));
            }
            (self.sleep)(interval_ms).await;
            waited += interval_ms;
        }
        let tail = self.log_tail(scratch).await;
        Err(format!(
            "{label} recovery did not finish within {}s (target {}){}",
            timeout_ms / 1000,
            target_time.to_rfc3339_opts(SecondsFormat::Millis, true),
            if tail.is_empty() {
                String::new()
            } else {
                format!(" [{tail}]")
            }
        ))
    }
}

impl DrillRunner for RestoreDrillRunner {
    fn run(&self, options: DrillRunOptions) -> DrillFuture<'_, Result<DrillReport, String>> {
        Box::pin(async move {
            let config = Arc::clone(&self.deps.config);
            let started_at_date = (self.clock)();
            let started_at = started_at_date.to_rfc3339_opts(SecondsFormat::Millis, true);
            let latest = options.latest;
            let target_time = if latest {
                started_at_date
            } else {
                options
                    .target_time
                    .unwrap_or_else(|| started_at_date - chrono::Duration::minutes(5))
            };
            let id = options.id.clone().unwrap_or_else(|| (self.id_factory)());
            let mut checks = DrillChecks::default_checks();
            let mut replayed_lsn = String::new();
            let mut double_entry_drift = String::new();
            let mut balance_mismatches = 0_u64;
            let mut audit_broken_links = 0_u64;
            let mut journal_line_count = 0_u64;
            let mut error_message: Option<String> = None;

            let dedicated_audit = is_audit_dedicated_cluster(&config);
            let core_scratch = PathBuf::from(&config.scratch_dir);
            let audit_scratch = PathBuf::from(&config.scratch_audit_dir);
            let core_port = config.scratch_port;
            let audit_port = config.scratch_audit_port;
            let scratch_directories: Vec<PathBuf> = if dedicated_audit {
                vec![core_scratch.clone(), audit_scratch.clone()]
            } else {
                vec![core_scratch.clone()]
            };

            let mut result: Result<(), String> = async {
                for scratch in &scratch_directories {
                    self.stop_scratch(scratch).await;
                }
                for scratch in &scratch_directories {
                    let _ = self.file_system.rm(scratch).await;
                    self.file_system
                        .mkdir(scratch)
                        .await
                        .map_err(|error| error.to_string())?;
                }

                let core_recovered = self
                    .deps
                    .engine
                    .recover(RecoverRequest {
                        target: RecoveryTarget::PostgresCore,
                        target_time,
                        latest,
                        target_dir: core_scratch.clone(),
                        port: core_port,
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                let audit_recovered = if dedicated_audit {
                    Some(
                        self.deps
                            .engine
                            .recover(RecoverRequest {
                                target: RecoveryTarget::AuditDb,
                                target_time,
                                latest,
                                target_dir: audit_scratch.clone(),
                                port: audit_port,
                            })
                            .await
                            .map_err(|error| error.to_string())?,
                    )
                } else {
                    None
                };
                replayed_lsn = core_recovered.replayed_lsn.clone().unwrap_or_default();

                self.ensure_cluster(
                    &core_scratch,
                    core_recovered.initialized_empty_dir,
                    "core",
                )
                .await?;
                if let Some(audit) = &audit_recovered {
                    self.ensure_cluster(&audit_scratch, audit.initialized_empty_dir, "audit")
                        .await?;
                }
                self.write_recovery_files(&core_scratch, core_recovered.recovery_conf.as_deref())
                    .await?;
                if let Some(audit) = &audit_recovered {
                    self.write_recovery_files(&audit_scratch, audit.recovery_conf.as_deref())
                        .await?;
                }

                self.start_cluster(&core_scratch, core_port, "core").await?;
                if audit_recovered.is_some() {
                    self.start_cluster(&audit_scratch, audit_port, "audit").await?;
                }
                if core_recovered.recovery_conf.is_some() {
                    self.wait_for_recovery_promotion(
                        &core_scratch,
                        "postgres_core",
                        "core",
                        dedicated_audit,
                        core_port,
                        audit_port,
                        target_time,
                    )
                    .await?;
                }
                if audit_recovered
                    .as_ref()
                    .is_some_and(|result| result.recovery_conf.is_some())
                {
                    self.wait_for_recovery_promotion(
                        &audit_scratch,
                        "audit_db",
                        "audit",
                        dedicated_audit,
                        core_port,
                        audit_port,
                        target_time,
                    )
                    .await?;
                }

                let double_entry = self
                    .psql(
                        DOUBLE_ENTRY_QUERY,
                        &config.pg_primary_db_name,
                        "postgres_core",
                        dedicated_audit,
                        core_port,
                        audit_port,
                    )
                    .await;
                double_entry_drift = if double_entry.code == 0 {
                    double_entry.stdout.trim().to_owned()
                } else {
                    String::new()
                };
                checks.double_entry = DrillCheckResult {
                    ok: double_entry.code == 0 && numeric_zero(&double_entry.stdout),
                    detail: if double_entry.code == 0 {
                        format!(
                            "SUM(DEBIT) - SUM(CREDIT) = {}",
                            if double_entry.stdout.trim().is_empty() {
                                "0"
                            } else {
                                double_entry.stdout.trim()
                            }
                        )
                    } else {
                        format!(
                            "double-entry query failed: {}",
                            double_entry
                                .stderr
                                .trim()
                                .chars()
                                .take(300)
                                .collect::<String>()
                        )
                    },
                };

                let count_result = self
                    .psql(
                        JOURNAL_LINE_COUNT_QUERY,
                        &config.pg_primary_db_name,
                        "postgres_core",
                        dedicated_audit,
                        core_port,
                        audit_port,
                    )
                    .await;
                if count_result.code == 0 {
                    journal_line_count = numeric_integer(&count_result.stdout).unwrap_or(0);
                }

                let parity = self
                    .psql(
                        BALANCE_PARITY_QUERY,
                        &config.pg_primary_db_name,
                        "postgres_core",
                        dedicated_audit,
                        core_port,
                        audit_port,
                    )
                    .await;
                let mismatch_count = if parity.code == 0 {
                    numeric_integer(&parity.stdout)
                } else {
                    None
                };
                balance_mismatches = mismatch_count.unwrap_or(0);
                checks.balance_parity = DrillCheckResult {
                    ok: parity.code == 0 && mismatch_count == Some(0),
                    detail: if parity.code == 0 {
                        format!(
                            "{} sharded-balance mismatch(es)",
                            mismatch_count
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "unparseable".to_owned())
                        )
                    } else {
                        format!(
                            "balance parity query failed: {}",
                            parity
                                .stderr
                                .trim()
                                .chars()
                                .take(300)
                                .collect::<String>()
                        )
                    },
                };

                // Shared cluster: the audit database normally came back inside the physical restore;
                // if it did not, restore the newest logical dump into the same scratch cluster.
                let mut audit_note = String::new();
                let mut object_storage_query = true;
                if !dedicated_audit {
                    let present = self
                        .psql(
                            &format!(
                                "SELECT 1 FROM pg_database WHERE datname = '{}';",
                                config.pg_audit_db_name.replace('\'', "''")
                            ),
                            "postgres",
                            "postgres_core",
                            dedicated_audit,
                            core_port,
                            audit_port,
                        )
                        .await;
                    if present.code == 0 && present.stdout.trim() != "1" {
                        object_storage_query = false;
                        let restored = self
                            .deps
                            .engine
                            .restore_logical(RecoverLogicalRequest {
                                database: config.pg_audit_db_name.clone(),
                                host: "127.0.0.1".to_owned(),
                                port: core_port,
                                user: config.pg_primary_user.clone(),
                            })
                            .await;
                        match restored {
                            Ok((_, detail)) => audit_note = format!(" ({detail})"),
                            Err(error) => audit_note = format!(" ({error})"),
                        }
                    }
                }

                let audit_result = self
                    .psql(
                        AUDIT_CHAIN_QUERY,
                        &config.pg_audit_db_name,
                        "audit_db",
                        dedicated_audit,
                        core_port,
                        audit_port,
                    )
                    .await;
                if audit_result.code != 0 {
                    checks.audit_chain = DrillCheckResult {
                        ok: false,
                        detail: format!(
                            "audit chain query failed: {}{audit_note}",
                            audit_result
                                .stderr
                                .trim()
                                .chars()
                                .take(300)
                                .collect::<String>()
                        ),
                    };
                } else {
                    match parse_audit_rows(&audit_result.stdout)
                        .map(|rows| verify_audit_chain(&rows))
                    {
                        Ok(verification) => {
                            audit_broken_links = verification.broken_links;
                            checks.audit_chain = DrillCheckResult {
                                ok: verification.valid,
                                detail: format!("{}{audit_note}", verification.detail),
                            };
                        }
                        Err(error) => {
                            checks.audit_chain = DrillCheckResult {
                                ok: false,
                                detail: format!(
                                    "audit chain parse failed: {}",
                                    self.safe_error(&error)
                                ),
                            };
                        }
                    }
                }

                if object_storage_backup_configured(&config) {
                    let repository = self
                        .deps
                        .repository
                        .clone()
                        .or_else(|| self.deps.engine.repository());
                    if let Some(repository) = repository {
                        if object_storage_query {
                            checks.object_storage = Some(
                                self.object_storage_check(
                                    &repository,
                                    &config,
                                    dedicated_audit,
                                    core_port,
                                    audit_port,
                                )
                                .await,
                            );
                        } else {
                            checks.object_storage = Some(DrillCheckResult {
                                ok: true,
                                detail: "audit database was restored logically; the core schema was not reachable for the object-storage manifest check"
                                    .to_owned(),
                            });
                        }
                    } else {
                        checks.object_storage = Some(DrillCheckResult {
                            ok: false,
                            detail: "the backup engine does not expose its artifact repository for the object-storage drill".to_owned(),
                        });
                    }
                }

                if replayed_lsn.is_empty() {
                    let lsn_result = self
                        .psql(
                            REPLAYED_LSN_QUERY,
                            &config.pg_primary_db_name,
                            "postgres_core",
                            dedicated_audit,
                            core_port,
                            audit_port,
                        )
                        .await;
                    if lsn_result.code == 0 {
                        replayed_lsn = lsn_result.stdout.trim().to_owned();
                    }
                }
                Ok(())
            }
            .await;

            if let Err(error) = &result {
                error_message = Some(self.safe_error(error));
            }

            for scratch in &scratch_directories {
                self.stop_scratch(scratch).await;
            }
            for scratch in &scratch_directories {
                if let Err(error) = self.file_system.rm(scratch).await {
                    if error_message.is_none() {
                        error_message = Some(format!("scratch cleanup failed: {error}"));
                    }
                }
            }
            let _ = &mut result;

            let completed_at_date = (self.clock)();
            let checks_passed = checks.double_entry.ok
                && checks.balance_parity.ok
                && checks.audit_chain.ok
                && checks.object_storage.as_ref().is_none_or(|check| check.ok);
            let status = if error_message.is_none() && checks_passed {
                "PASSED"
            } else {
                "FAILED"
            };
            let report = DrillReport {
                id,
                status: status.to_owned(),
                started_at,
                completed_at: completed_at_date.to_rfc3339_opts(SecondsFormat::Millis, true),
                duration_ms: (completed_at_date - started_at_date)
                    .num_milliseconds()
                    .max(0) as u64,
                target_time: target_time.to_rfc3339_opts(SecondsFormat::Millis, true),
                replayed_lsn,
                double_entry_drift,
                balance_mismatches,
                audit_broken_links,
                journal_line_count,
                checks,
                error_message,
                report_signature: None,
            };
            let signature = sign_drill_report(&report, &config.encryption_key_hex);
            Ok(DrillReport {
                report_signature: signature.ok(),
                ..report
            })
        })
    }
}

impl RestoreDrillRunner {
    async fn object_storage_check(
        &self,
        repository: &Arc<ArtifactRepository>,
        config: &Config,
        dedicated_audit: bool,
        core_port: u16,
        audit_port: u16,
    ) -> DrillCheckResult {
        let presence = self
            .psql(
                OBJECT_STORAGE_EXISTS_QUERY,
                &config.pg_primary_db_name,
                "postgres_core",
                dedicated_audit,
                core_port,
                audit_port,
            )
            .await;
        if presence.code != 0 {
            return DrillCheckResult {
                ok: false,
                detail: format!(
                    "storage_objects presence check failed: {}",
                    presence.stderr.trim().chars().take(200).collect::<String>()
                ),
            };
        }
        if presence.stdout.trim() != "t" {
            return DrillCheckResult {
                ok: true,
                detail: "the restored schema has no storage_objects table".to_owned(),
            };
        }
        let refs = self
            .psql(
                RESTORED_ACTIVE_REFS_QUERY,
                &config.pg_primary_db_name,
                "postgres_core",
                dedicated_audit,
                core_port,
                audit_port,
            )
            .await;
        if refs.code != 0 {
            return DrillCheckResult {
                ok: false,
                detail: format!(
                    "restored active-object query failed: {}",
                    refs.stderr.trim().chars().take(200).collect::<String>()
                ),
            };
        }
        let restored = match parse_restored_objects(&refs.stdout) {
            Ok(restored) => restored,
            Err(error) => {
                return DrillCheckResult {
                    ok: false,
                    detail: error,
                }
            }
        };
        match verify_manifest_parity(repository, &restored).await {
            Ok(Some((ok, detail))) => DrillCheckResult {
                ok,
                detail: format!(
                    "{detail}; encrypted blob decryption sample is not ported (documented gap)"
                ),
            },
            Ok(None) => DrillCheckResult {
                ok: true,
                detail: "no object-storage backup manifest was recorded at backup time".to_owned(),
            },
            Err(error) => DrillCheckResult {
                ok: false,
                detail: error,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_json_sorts_nested_keys() {
        let value = json!({"b": 1, "a": {"d": 2, "c": 3}});
        assert_eq!(stable_json(&value), r#"{"a":{"c":3,"d":2},"b":1}"#);
    }

    #[test]
    fn control_data_parses_only_known_settings() {
        let output = "max_connections setting: 200\nmax_worker_processes setting: 8\ntrack_commit_timestamp setting: on\n";
        let parsed = parse_control_data(output);
        assert!(parsed.contains("max_connections = 200"));
        assert!(parsed.contains("track_commit_timestamp = on"));
    }
}
