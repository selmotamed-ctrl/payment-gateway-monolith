//! Built-in platform checks (`core-back/engine/workers/*MonitorChecks.ts`).
//!
//! Each factory returns a [`PlatformMonitorCheck`]. All SQL is raw, bounded and read-only. External
//! probes (the backup daemon, certificate files, Redis, the communication settings, the object
//! vault) enter through traits so a check is testable without the dependency:
//!
//! - [`CertificateValidityReader`] → `readCertificateValidTo`
//! - [`ServiceProbe`] → `redisReachabilityCheck`
//! - [`BackupOverviewSource`] → `createBackupMonitorCheck`
//! - [`CommunicationSettingsSource`] → `createCommunicationReadinessCheck`
//! - [`ObjectStorageProbe`] → `createObjectStorageMonitorCheck`
//!
//! Check ids are the TS ones, because they become part of the operator case `subjectKey`
//! (`platform.cert_expiry:mtls_server`, `platform.backup:wal-lag`, …).

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sqlx::Row;
use tracing::warn;

use crate::cases::MonitorPriority;
use crate::db::is_transient_sqlstate;
use crate::health::WorkerSnapshot;
use crate::monitor::{MonitorCheckResult, MonitorContext, MonitorFinding, PlatformMonitorCheck};
use crate::runtime::WorkerError;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// `formatAge` (`platformMonitorChecks.ts:20-25`).
#[must_use]
pub fn format_age(ms: i64) -> String {
    if ms < 120_000 {
        format!("{} s", (ms as f64 / 1_000.0).round() as i64)
    } else if ms < 2 * 60 * 60 * 1000 {
        format!("{} min", (ms as f64 / 60_000.0).round() as i64)
    } else if ms < 2 * DAY_MS {
        format!("{:.1} h", ms as f64 / 3_600_000.0)
    } else {
        format!("{:.1} days", ms as f64 / DAY_MS as f64)
    }
}

fn check_error(id: &str, error: impl std::fmt::Display) -> WorkerError {
    WorkerError::Failed(format!("monitor check {id}: {error}"))
}

// ---------------------------------------------------------------------------------------------
// worker_stale
// ---------------------------------------------------------------------------------------------

/// Worker with no success for `multiplier` × its interval (`platformMonitorChecks.ts:31`).
pub struct WorkerStalenessCheck {
    multiplier: f64,
    ignore: Vec<String>,
    priority: MonitorPriority,
}

impl WorkerStalenessCheck {
    #[must_use]
    pub fn new(multiplier: f64, ignore: Vec<String>, priority: MonitorPriority) -> Self {
        Self {
            multiplier: if multiplier > 0.0 { multiplier } else { 3.0 },
            ignore,
            priority,
        }
    }

    #[must_use]
    pub fn standard() -> Self {
        Self::new(3.0, Vec::new(), MonitorPriority::P1)
    }

    /// The pure decision over a snapshot, so the check can be tested without a tick.
    #[must_use]
    pub fn findings(now: DateTime<Utc>, snapshot: &WorkerSnapshot) -> Vec<MonitorFinding> {
        Self::new(3.0, Vec::new(), MonitorPriority::P1).findings_with(now, snapshot)
    }

    #[must_use]
    pub fn findings_with(
        &self,
        now: DateTime<Utc>,
        snapshot: &WorkerSnapshot,
    ) -> Vec<MonitorFinding> {
        let mut findings = Vec::new();
        for record in snapshot.all() {
            if self.ignore.iter().any(|name| name == &record.name)
                || !record.running
                || record.interval_ms == 0
            {
                continue;
            }
            // A singleton led by another node does not tick here; this registry cannot judge it.
            if !record.leader {
                continue;
            }
            let reference = record
                .last_success_at
                .as_deref()
                .or(record.started_at.as_deref())
                .and_then(parse_iso);
            let Some(reference) = reference else {
                continue;
            };
            let age = (now - reference).num_milliseconds();
            let limit = (record.interval_ms as f64 * self.multiplier) as i64;
            if age <= limit {
                continue;
            }
            let last_error = record
                .last_error
                .as_deref()
                .map(|error| format!("; last error: {error}"))
                .unwrap_or_default();
            findings.push(MonitorFinding::keyed(
                &record.name,
                "Worker has stopped succeeding",
                &format!(
                    "{} has had no successful tick for {} (interval {}, limit {}x){}; consecutive failures {}.",
                    record.name,
                    format_age(age),
                    format_age(record.interval_ms as i64),
                    self.multiplier,
                    last_error,
                    record.consecutive_failures
                ),
                self.priority,
            ));
        }
        findings
    }
}

fn parse_iso(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

#[async_trait]
impl PlatformMonitorCheck for WorkerStalenessCheck {
    fn id(&self) -> &'static str {
        "worker_stale"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        Ok(MonitorCheckResult::complete(
            self.findings_with(ctx.now, &ctx.registry),
        ))
    }
}

// ---------------------------------------------------------------------------------------------
// checkpoint_stale
// ---------------------------------------------------------------------------------------------

pub const CHECKPOINT_STALE_SQL: &str = "SELECT s.gl_account_id AS id, s.shard_id,
        (s.line_seq - COALESCE(c.checkpoint_seq, 0))::bigint AS pending,
        COALESCE(c.checkpoint_at, c.verified_at, s.updated_at) AS reference_at
   FROM gl_account_shards s
   LEFT JOIN gl_shard_checkpoints c
     ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
  WHERE s.line_seq > COALESCE(c.checkpoint_seq, 0)
    AND COALESCE(c.status, 'OK') = 'OK'
    AND COALESCE(c.checkpoint_at, c.verified_at, s.updated_at) < $1
  ORDER BY COALESCE(c.checkpoint_at, c.verified_at, s.updated_at) ASC
  LIMIT $2::int";

/// Per-shard checkpoint staleness (`platformMonitorChecks.ts:75`).
pub struct CheckpointStalenessCheck {
    threshold_ms: i64,
    limit: i64,
    priority: MonitorPriority,
}

impl CheckpointStalenessCheck {
    #[must_use]
    pub fn new(max_age_ms: i64, grace_factor: f64, limit: i64, priority: MonitorPriority) -> Self {
        Self {
            threshold_ms: (max_age_ms as f64 * grace_factor.max(0.0)) as i64,
            limit: limit.max(1),
            priority,
        }
    }
}

#[async_trait]
impl PlatformMonitorCheck for CheckpointStalenessCheck {
    fn id(&self) -> &'static str {
        "checkpoint_stale"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let cutoff = ctx.now.naive_utc() - ChronoDuration::milliseconds(self.threshold_ms);
        let rows = sqlx::query(CHECKPOINT_STALE_SQL)
            .bind(cutoff)
            .bind(self.limit)
            .fetch_all(ctx.pool)
            .await
            .map_err(|error| check_error(self.id(), error))?;
        let mut findings = Vec::new();
        for row in &rows {
            let gl_account_id: uuid::Uuid = row.get("id");
            let shard_id = i32::from(row.get::<i16, _>("shard_id"));
            let pending: i64 = row.get("pending");
            let reference_at: Option<chrono::NaiveDateTime> =
                row.try_get("reference_at").ok().flatten();
            let age = reference_at
                .map(|reference| (ctx.now.naive_utc() - reference).num_milliseconds())
                .unwrap_or(self.threshold_ms);
            findings.push(MonitorFinding::keyed(
                &format!("{gl_account_id}:{shard_id}"),
                "Ledger checkpoint is stale",
                &format!(
                    "Shard {shard_id} of GL account {gl_account_id} has {pending} lines above a checkpoint that is {} old (limit {}).",
                    format_age(age),
                    format_age(self.threshold_ms)
                ),
                self.priority,
            ));
        }
        let complete = (rows.len() as i64) < self.limit;
        Ok(MonitorCheckResult { findings, complete })
    }
}

// ---------------------------------------------------------------------------------------------
// Oldest pending row of a queue table
// ---------------------------------------------------------------------------------------------

/// Oldest pending row of a queue table older than `max_age_ms`.
pub struct OldestPendingCheck {
    id: &'static str,
    title: &'static str,
    label: &'static str,
    sql: &'static str,
    max_age_ms: i64,
    priority: MonitorPriority,
}

pub const OUTBOX_OLDEST_SQL: &str =
    "SELECT created_at AS oldest_at FROM outbox_events WHERE processed_at IS NULL ORDER BY id ASC LIMIT 1";

pub const AUDIT_OUTBOX_OLDEST_SQL: &str = "SELECT created_at AS oldest_at
   FROM audit_outbox WHERE shipped_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1";

impl OldestPendingCheck {
    #[must_use]
    pub fn outbox(max_age_ms: i64) -> Self {
        Self {
            id: "outbox_age",
            title: "Outbox relay is behind",
            label: "outbox event",
            sql: OUTBOX_OLDEST_SQL,
            max_age_ms,
            priority: MonitorPriority::P1,
        }
    }

    #[must_use]
    pub fn audit_outbox(max_age_ms: i64) -> Self {
        Self {
            id: "audit_outbox_age",
            title: "Audit shipper is behind",
            label: "audit outbox row",
            sql: AUDIT_OUTBOX_OLDEST_SQL,
            max_age_ms,
            priority: MonitorPriority::P1,
        }
    }
}

#[async_trait]
impl PlatformMonitorCheck for OldestPendingCheck {
    fn id(&self) -> &'static str {
        self.id
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let oldest: Option<DateTime<Utc>> = sqlx::query_scalar(self.sql)
            .fetch_optional(ctx.pool)
            .await
            .map_err(|error| check_error(self.id, error))?;
        let Some(oldest) = oldest else {
            return Ok(MonitorCheckResult::empty());
        };
        let age = (ctx.now - oldest).num_milliseconds();
        if age <= self.max_age_ms {
            return Ok(MonitorCheckResult::empty());
        }
        Ok(MonitorCheckResult::complete(vec![MonitorFinding::new(
            self.title,
            &format!(
                "The oldest pending {} is {} old (limit {}).",
                self.label,
                format_age(age),
                format_age(self.max_age_ms)
            ),
            self.priority,
        )]))
    }
}

// ---------------------------------------------------------------------------------------------
// background jobs
// ---------------------------------------------------------------------------------------------

pub const BACKGROUND_JOB_OLDEST_SQL: &str = "SELECT available_at FROM background_jobs
  WHERE state = 'QUEUED' AND available_at <= $1
  ORDER BY available_at ASC LIMIT 1";

pub struct BackgroundJobQueueAgeCheck {
    max_age_ms: i64,
    priority: MonitorPriority,
}

impl BackgroundJobQueueAgeCheck {
    #[must_use]
    pub fn new(max_age_ms: i64, priority: MonitorPriority) -> Self {
        Self {
            max_age_ms,
            priority,
        }
    }
}

#[async_trait]
impl PlatformMonitorCheck for BackgroundJobQueueAgeCheck {
    fn id(&self) -> &'static str {
        "background_job_age"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let oldest: Option<chrono::NaiveDateTime> = sqlx::query_scalar(BACKGROUND_JOB_OLDEST_SQL)
            .bind(ctx.now.naive_utc())
            .fetch_optional(ctx.pool)
            .await
            .map_err(|error| check_error(self.id(), error))?;
        let Some(oldest) = oldest else {
            return Ok(MonitorCheckResult::empty());
        };
        let age = (ctx.now.naive_utc() - oldest).num_milliseconds();
        if age <= self.max_age_ms {
            return Ok(MonitorCheckResult::empty());
        }
        Ok(MonitorCheckResult::complete(vec![MonitorFinding::new(
            "Background job queue is not draining",
            &format!(
                "The oldest due background job has waited {} (limit {}).",
                format_age(age),
                format_age(self.max_age_ms)
            ),
            self.priority,
        )]))
    }
}

// ---------------------------------------------------------------------------------------------
// KYB scan backlog
// ---------------------------------------------------------------------------------------------

pub const KYB_SCAN_BACKLOG_SQL: &str = "SELECT count(*)::bigint AS n, min(created_at) AS oldest_at
   FROM kyb_documents
  WHERE av_status = 'PENDING' AND status = 'UPLOADED' AND created_at < $1";

pub struct KybScanBacklogCheck {
    max_age_ms: i64,
    priority: MonitorPriority,
}

impl KybScanBacklogCheck {
    #[must_use]
    pub fn new(max_age_ms: i64, priority: MonitorPriority) -> Self {
        Self {
            max_age_ms,
            priority,
        }
    }
}

#[async_trait]
impl PlatformMonitorCheck for KybScanBacklogCheck {
    fn id(&self) -> &'static str {
        "kyb_scan_backlog"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let cutoff = ctx.now.naive_utc() - ChronoDuration::milliseconds(self.max_age_ms);
        let row = sqlx::query(KYB_SCAN_BACKLOG_SQL)
            .bind(cutoff)
            .fetch_one(ctx.pool)
            .await
            .map_err(|error| check_error(self.id(), error))?;
        let count: i64 = row.get("n");
        if count == 0 {
            return Ok(MonitorCheckResult::empty());
        }
        let oldest: Option<chrono::NaiveDateTime> = row.try_get("oldest_at").ok().flatten();
        let oldest_text = oldest
            .map(|oldest| {
                format!(
                    " (oldest {} old)",
                    format_age((ctx.now.naive_utc() - oldest).num_milliseconds())
                )
            })
            .unwrap_or_default();
        Ok(MonitorCheckResult::complete(vec![MonitorFinding::new(
            "KYB documents are waiting for a malware scan",
            &format!(
                "{count} uploaded KYB document(s) have been PENDING for more than {}{}. Reviewers cannot open them until a scan succeeds: check the scanner (clamd) and the KybScanWorker.",
                format_age(self.max_age_ms),
                oldest_text
            ),
            self.priority,
        )]))
    }
}

// ---------------------------------------------------------------------------------------------
// journal default partition
// ---------------------------------------------------------------------------------------------

pub const JOURNAL_DEFAULT_SQL: &str =
    "SELECT count(*)::bigint AS n FROM (SELECT 1 FROM journal_lines_default LIMIT $1::int) AS capped";

pub struct JournalDefaultPartitionCheck {
    cap: i64,
    priority: MonitorPriority,
}

impl JournalDefaultPartitionCheck {
    #[must_use]
    pub fn new(cap: i64, priority: MonitorPriority) -> Self {
        Self {
            cap: cap.max(1),
            priority,
        }
    }
}

#[async_trait]
impl PlatformMonitorCheck for JournalDefaultPartitionCheck {
    fn id(&self) -> &'static str {
        "journal_default_rows"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let count: i64 = match sqlx::query_scalar(JOURNAL_DEFAULT_SQL)
            .bind(self.cap)
            .fetch_one(ctx.pool)
            .await
        {
            Ok(count) => count,
            Err(error) => {
                let code = crate::db::sqlstate(&error);
                if code.as_deref() == Some("42P01")
                    || error.to_string().contains("journal_lines_default")
                {
                    return Ok(MonitorCheckResult::empty());
                }
                return Err(check_error(self.id(), error));
            }
        };
        if count <= 0 {
            return Ok(MonitorCheckResult::empty());
        }
        Ok(MonitorCheckResult::complete(vec![MonitorFinding::new(
            "Journal lines in the default partition",
            &format!(
                "{} journal line(s) landed in journal_lines_default: a monthly partition is missing and creating it later will fail until the rows are moved.",
                if count >= self.cap {
                    format!("At least {}", self.cap)
                } else {
                    count.to_string()
                }
            ),
            self.priority,
        )]))
    }
}

// ---------------------------------------------------------------------------------------------
// certificate expiry
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificateFile {
    pub label: String,
    pub path: String,
}

#[async_trait]
pub trait CertificateValidityReader: Send + Sync {
    async fn read_valid_to(&self, path: &str) -> Result<DateTime<Utc>, String>;
}

/// Certificate expiry within the warning window (`platformMonitorChecks.ts:284`).
pub struct CertificateExpiryCheck {
    files: Vec<CertificateFile>,
    warn_within_ms: i64,
    reader: Arc<dyn CertificateValidityReader>,
    priority: MonitorPriority,
}

impl CertificateExpiryCheck {
    #[must_use]
    pub fn new(
        files: Vec<CertificateFile>,
        warn_within_ms: i64,
        reader: Arc<dyn CertificateValidityReader>,
        priority: MonitorPriority,
    ) -> Self {
        Self {
            files,
            warn_within_ms,
            reader,
            priority,
        }
    }
}

#[async_trait]
impl PlatformMonitorCheck for CertificateExpiryCheck {
    fn id(&self) -> &'static str {
        "cert_expiry"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let mut findings = Vec::new();
        for file in &self.files {
            let valid_to = match self.reader.read_valid_to(&file.path).await {
                Ok(valid_to) => valid_to,
                Err(error) => {
                    findings.push(MonitorFinding::keyed(
                        &format!("{}:unreadable", file.label),
                        "Certificate cannot be read",
                        &format!(
                            "The {} certificate at {} cannot be read: {error}.",
                            file.label, file.path
                        ),
                        MonitorPriority::P2,
                    ));
                    continue;
                }
            };
            let remaining = (valid_to - ctx.now).num_milliseconds();
            if remaining <= self.warn_within_ms {
                let (title, detail) = if remaining <= 0 {
                    (
                        "Certificate expired",
                        format!(
                            "The {} certificate ({}) expired at {}.",
                            file.label,
                            file.path,
                            valid_to.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                        ),
                    )
                } else {
                    (
                        "Certificate expires soon",
                        format!(
                            "The {} certificate ({}) expires at {}, in {}.",
                            file.label,
                            file.path,
                            valid_to.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                            format_age(remaining)
                        ),
                    )
                };
                findings.push(MonitorFinding::keyed(
                    &file.label,
                    title,
                    &detail,
                    self.priority,
                ));
            }
        }
        Ok(MonitorCheckResult::complete(findings))
    }
}

// ---------------------------------------------------------------------------------------------
// Redis reachability
// ---------------------------------------------------------------------------------------------

#[async_trait]
pub trait ServiceProbe: Send + Sync {
    /// Fails by error or by returning `false`.
    async fn probe(&self) -> Result<bool, String>;
}

pub struct ServiceReachabilityCheck {
    id: &'static str,
    title: &'static str,
    probe: Arc<dyn ServiceProbe>,
    timeout_ms: u64,
    priority: MonitorPriority,
}

impl ServiceReachabilityCheck {
    #[must_use]
    pub fn redis(probe: Arc<dyn ServiceProbe>, timeout_ms: u64) -> Self {
        Self {
            id: "redis_unreachable",
            title: "Redis is unreachable",
            probe,
            timeout_ms,
            priority: MonitorPriority::P2,
        }
    }
}

#[async_trait]
impl PlatformMonitorCheck for ServiceReachabilityCheck {
    fn id(&self) -> &'static str {
        self.id
    }

    async fn run(&self, _ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let outcome = tokio::time::timeout(
            Duration::from_millis(self.timeout_ms.max(1)),
            self.probe.probe(),
        )
        .await;
        match outcome {
            Ok(Ok(true)) => Ok(MonitorCheckResult::empty()),
            Ok(Ok(false)) => Ok(MonitorCheckResult::complete(vec![MonitorFinding::new(
                self.title,
                "The Redis probe reported unreachable.",
                self.priority,
            )])),
            Ok(Err(error)) => Ok(MonitorCheckResult::complete(vec![MonitorFinding::new(
                self.title,
                &format!("The Redis probe failed: {error}."),
                self.priority,
            )])),
            Err(_) => Ok(MonitorCheckResult::complete(vec![MonitorFinding::new(
                self.title,
                &format!(
                    "The Redis probe did not answer within {} ms.",
                    self.timeout_ms
                ),
                self.priority,
            )])),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Money path (AUTO-19, AUTO-20)
// ---------------------------------------------------------------------------------------------

pub const STALE_UNKNOWN_SUMMARY_SQL: &str = "SELECT count(*)::bigint AS total,
        (count(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM operator_cases c WHERE c.attempt_id = p.id
              AND c.kind = 'UNKNOWN' AND c.state <> 'RESOLVED')))::bigint AS without_case,
        min(p.created_at) AS oldest
   FROM payment_attempts p
  WHERE p.status = 'UNKNOWN' AND p.terminal_at IS NULL AND p.created_at <= $1";

pub const STALE_UNKNOWN_LIST_SQL: &str = "SELECT p.id FROM payment_attempts p
  WHERE p.status = 'UNKNOWN' AND p.terminal_at IS NULL AND p.created_at <= $1
  ORDER BY p.created_at ASC LIMIT $2";

pub struct StaleUnknownCheck {
    older_than_hours: i64,
    sample_size: i64,
}

impl StaleUnknownCheck {
    #[must_use]
    pub fn new(older_than_hours: i64, sample_size: i64) -> Self {
        Self {
            older_than_hours: older_than_hours.max(0),
            sample_size: sample_size.max(1),
        }
    }
}

#[async_trait]
impl PlatformMonitorCheck for StaleUnknownCheck {
    fn id(&self) -> &'static str {
        "stale_unknown"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let cutoff = ctx.now.naive_utc() - ChronoDuration::hours(self.older_than_hours);
        let summary = sqlx::query(STALE_UNKNOWN_SUMMARY_SQL)
            .bind(cutoff)
            .fetch_one(ctx.pool)
            .await
            .map_err(|error| check_error(self.id(), error))?;
        let total: i64 = summary.get("total");
        if total == 0 {
            return Ok(MonitorCheckResult::empty());
        }
        let without_case: i64 = summary.get("without_case");
        let oldest: Option<chrono::NaiveDateTime> = summary.try_get("oldest").ok().flatten();
        let oldest_hours = oldest
            .map(|oldest| (ctx.now.naive_utc() - oldest).num_hours())
            .unwrap_or_default();
        let ids: Vec<uuid::Uuid> = sqlx::query_scalar(STALE_UNKNOWN_LIST_SQL)
            .bind(cutoff)
            .bind(self.sample_size)
            .fetch_all(ctx.pool)
            .await
            .map_err(|error| check_error(self.id(), error))?;
        let id_list = ids
            .iter()
            .map(uuid::Uuid::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        Ok(MonitorCheckResult::complete(vec![MonitorFinding::new(
            &format!(
                "{total} payment attempt(s) UNKNOWN for more than {} h",
                self.older_than_hours
            ),
            &format!(
                "{total} attempt(s) are still UNKNOWN after {} h ({without_case} without an open UNKNOWN case, oldest {oldest_hours} h). Oldest: {id_list}.",
                self.older_than_hours
            ),
            MonitorPriority::P1,
        )]))
    }
}

pub const UNSCHEDULED_REFUND_SQL: &str = "SELECT a.id FROM adjustments a
  WHERE a.type = 'REFUND' AND a.state = 'EXECUTING' AND a.updated_at <= $1
    AND NOT EXISTS (SELECT 1 FROM background_jobs j
                     WHERE j.job_type::text = 'REFUND_INQUIRY'
                       AND j.reference_type = 'ADJUSTMENT' AND j.reference_id = a.id::text
                       AND j.state IN ('QUEUED', 'RUNNING'))
    AND NOT EXISTS (SELECT 1 FROM operator_cases c
                     WHERE c.subject_key = 'refund.inquiry:' || a.id::text AND c.state <> 'RESOLVED')
  ORDER BY a.updated_at ASC LIMIT $2";

pub struct UnscheduledRefundCheck {
    older_than_minutes: i64,
    sample_size: i64,
}

impl UnscheduledRefundCheck {
    #[must_use]
    pub fn new(older_than_minutes: i64, sample_size: i64) -> Self {
        Self {
            older_than_minutes: older_than_minutes.max(0),
            sample_size: sample_size.max(1),
        }
    }
}

#[async_trait]
impl PlatformMonitorCheck for UnscheduledRefundCheck {
    fn id(&self) -> &'static str {
        "refund_unscheduled"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let cutoff = ctx.now.naive_utc() - ChronoDuration::minutes(self.older_than_minutes);
        let rows: Vec<uuid::Uuid> = sqlx::query_scalar(UNSCHEDULED_REFUND_SQL)
            .bind(cutoff)
            .bind(self.sample_size)
            .fetch_all(ctx.pool)
            .await
            .map_err(|error| check_error(self.id(), error))?;
        if rows.is_empty() {
            return Ok(MonitorCheckResult::empty());
        }
        let plus = if (rows.len() as i64) >= self.sample_size {
            "+"
        } else {
            ""
        };
        let ids = rows
            .iter()
            .map(uuid::Uuid::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        Ok(MonitorCheckResult::complete(vec![MonitorFinding::new(
            "Refunds stuck in EXECUTING without a follow-up",
            &format!(
                "{}{plus} refund adjustment(s) are EXECUTING with no REFUND_INQUIRY job and no inquiry case: {ids}. Re-schedule them with the refund inquiry scheduler.",
                rows.len()
            ),
            MonitorPriority::P1,
        )]))
    }
}

// ---------------------------------------------------------------------------------------------
// Backup (AUTO-27)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupRun {
    pub id: String,
    pub target: String,
    pub kind: String,
    pub engine: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub error_message: Option<String>,
}

impl BackupRun {
    #[must_use]
    pub fn finished_at(&self) -> DateTime<Utc> {
        self.completed_at.unwrap_or(self.started_at)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupTargetStatus {
    pub name: String,
    pub healthy: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackupWalStatus {
    pub archive_lag_seconds: Option<i64>,
    pub lag_bytes: Option<i64>,
    pub last_archived_lsn: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupDrill {
    pub id: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub error_message: Option<String>,
    pub double_entry_drift: Option<String>,
    pub balance_mismatches: Option<i64>,
    pub audit_broken_links: Option<i64>,
}

impl BackupDrill {
    #[must_use]
    pub fn finished_at(&self) -> DateTime<Utc> {
        self.completed_at.unwrap_or(self.started_at)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackupPolicySummary {
    pub alert_lag_seconds: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackupOverview {
    pub healthy: Option<bool>,
    pub engine_mode: String,
    pub targets: Vec<BackupTargetStatus>,
    pub wal: BackupWalStatus,
    pub backups: Vec<BackupRun>,
    pub latest_drill: Option<BackupDrill>,
    pub policy: Option<BackupPolicySummary>,
}

#[async_trait]
pub trait BackupOverviewSource: Send + Sync {
    async fn overview(&self) -> Result<BackupOverview, String>;
}

pub const DEFAULT_BACKUP_MAX_FULL_AGE_MS: i64 = 36 * 60 * 60 * 1000;
pub const DEFAULT_BACKUP_MAX_DRILL_AGE_MS: i64 = 8 * DAY_MS;

/// `createBackupMonitorCheck` (`backupMonitorChecks.ts:35`).
pub struct BackupCheck {
    source: Arc<dyn BackupOverviewSource>,
    max_full_age_ms: i64,
    max_drill_age_ms: i64,
}

impl BackupCheck {
    #[must_use]
    pub fn new(
        source: Arc<dyn BackupOverviewSource>,
        max_full_age_ms: i64,
        max_drill_age_ms: i64,
    ) -> Self {
        Self {
            source,
            max_full_age_ms,
            max_drill_age_ms,
        }
    }
}

/// The pure decision, so the daemon contract can be checked without HTTP.
#[must_use]
pub fn backup_findings(
    now: DateTime<Utc>,
    overview: &BackupOverview,
    max_full_age_ms: i64,
    max_drill_age_ms: i64,
) -> Vec<MonitorFinding> {
    let mut findings = Vec::new();
    if overview.healthy == Some(false) {
        let unhealthy = overview
            .targets
            .iter()
            .filter(|target| !target.healthy)
            .map(|target| match &target.detail {
                Some(detail) => format!("{} ({detail})", target.name),
                None => target.name.clone(),
            })
            .collect::<Vec<_>>()
            .join(", ");
        findings.push(MonitorFinding::keyed(
            "unhealthy",
            "The backup daemon reports itself unhealthy",
            &format!(
                "The daemon (engine {}) reports healthy=false. Unhealthy targets: {}.",
                overview.engine_mode,
                if unhealthy.is_empty() {
                    "none listed"
                } else {
                    &unhealthy
                }
            ),
            MonitorPriority::P1,
        ));
    }
    let lag_seconds = overview.wal.archive_lag_seconds.unwrap_or(0);
    if let Some(limit) = overview
        .policy
        .as_ref()
        .and_then(|policy| policy.alert_lag_seconds)
    {
        if limit > 0 && lag_seconds > limit {
            findings.push(MonitorFinding::keyed(
                "wal-lag",
                "WAL archiving is behind",
                &format!(
                    "The WAL archive lags {lag_seconds} s (limit {limit} s, {} bytes behind). Point-in-time recovery is not possible past the last archived LSN {}.",
                    overview.wal.lag_bytes.unwrap_or_default(),
                    overview.wal.last_archived_lsn.as_deref().unwrap_or("unknown")
                ),
                MonitorPriority::P1,
            ));
        }
    }
    let runs: Vec<&BackupRun> = overview
        .backups
        .iter()
        .filter(|run| run.status == "PASSED" || run.status == "FAILED")
        .collect();
    let mut latest_by_target: std::collections::BTreeMap<&str, &BackupRun> =
        std::collections::BTreeMap::new();
    for run in &runs {
        match latest_by_target.get(run.target.as_str()) {
            Some(current) if current.finished_at() >= run.finished_at() => {}
            _ => {
                latest_by_target.insert(run.target.as_str(), run);
            }
        }
    }
    for (target, run) in latest_by_target {
        if run.status == "FAILED" {
            findings.push(MonitorFinding::keyed(
                &format!("backup-failed:{target}"),
                &format!("The latest {target} backup failed"),
                &format!(
                    "Backup {} ({}, {}) of {target} failed at {}: {}.",
                    run.id,
                    run.kind,
                    run.engine,
                    run.finished_at()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    run.error_message
                        .as_deref()
                        .unwrap_or("no error message recorded")
                ),
                MonitorPriority::P1,
            ));
        }
    }
    let last_full = runs
        .iter()
        .filter(|run| run.status == "PASSED" && run.kind == "full")
        .max_by_key(|run| run.finished_at());
    let full_age = last_full.map(|run| (now - run.finished_at()).num_milliseconds());
    if full_age.is_none_or(|age| age > max_full_age_ms) {
        findings.push(MonitorFinding::keyed(
            "backup-stale",
            "No recent full backup",
            &match full_age {
                Some(age) => format!(
                    "The last PASSED full backup finished {} ago (limit {}).",
                    format_age(age),
                    format_age(max_full_age_ms)
                ),
                None => format!(
                    "The daemon lists no PASSED full backup (limit {}).",
                    format_age(max_full_age_ms)
                ),
            },
            MonitorPriority::P1,
        ));
    }
    if let Some(drill) = &overview.latest_drill {
        if drill.status == "FAILED" {
            findings.push(MonitorFinding::keyed(
                "drill-failed",
                "The latest restore drill failed",
                &format!(
                    "Drill {} failed at {}: {}. Double-entry drift {}, balance mismatches {}, audit chain broken links {}.",
                    drill.id,
                    drill
                        .finished_at()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    drill.error_message.as_deref().unwrap_or("see the report"),
                    drill.double_entry_drift.as_deref().unwrap_or("unknown"),
                    drill.balance_mismatches.unwrap_or_default(),
                    drill.audit_broken_links.unwrap_or_default()
                ),
                MonitorPriority::P1,
            ));
        }
    }
    let drill_age = overview
        .latest_drill
        .as_ref()
        .map(|drill| (now - drill.finished_at()).num_milliseconds());
    if drill_age.is_none_or(|age| age > max_drill_age_ms) {
        findings.push(MonitorFinding::keyed(
            "drill-stale",
            "No recent restore drill",
            &match drill_age {
                Some(age) => format!(
                    "The last restore drill finished {} ago (limit {}).",
                    format_age(age),
                    format_age(max_drill_age_ms)
                ),
                None => "No restore drill has ever been recorded.".to_owned(),
            },
            MonitorPriority::P2,
        ));
    }
    findings
}

#[async_trait]
impl PlatformMonitorCheck for BackupCheck {
    fn id(&self) -> &'static str {
        "backup"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let overview = match self.source.overview().await {
            Ok(overview) => overview,
            Err(error) => {
                return Ok(MonitorCheckResult::complete(vec![MonitorFinding::keyed(
                    "daemon",
                    "The backup daemon cannot be reached",
                    &format!(
                        "The backup daemon did not answer the overview request ({error}). Backups, WAL archiving and restore drills cannot be confirmed."
                    ),
                    MonitorPriority::P1,
                )]))
            }
        };
        Ok(MonitorCheckResult::complete(backup_findings(
            ctx.now,
            &overview,
            self.max_full_age_ms,
            self.max_drill_age_ms,
        )))
    }
}

// ---------------------------------------------------------------------------------------------
// Communication readiness
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommunicationSnapshot {
    pub email_configured: bool,
    pub sms_enabled: bool,
    pub sms_configured: bool,
    pub sms_missing_fields: Vec<String>,
    pub google_enabled: bool,
    pub google_configured: bool,
    pub google_missing_fields: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommunicationChannelHealth {
    pub channel: String,
    pub consecutive_failures: i64,
    pub last_test_status: Option<String>,
    pub last_test_error: Option<String>,
    pub last_delivery_error: Option<String>,
}

#[async_trait]
pub trait CommunicationSettingsSource: Send + Sync {
    async fn configuration(&self) -> Result<CommunicationSnapshot, String>;
}

pub const COMMUNICATION_STATUS_SQL: &str = "SELECT channel, consecutive_failures, last_test_status,
        last_test_error, last_delivery_error
   FROM communication_channel_status
  WHERE channel IN ('EMAIL', 'SMS')";

/// `createCommunicationReadinessCheck` (`communicationMonitorChecks.ts:111`). The in-app/sms notice
/// fan-out of `notifyCommunicationGap` is not started from here (P6-T04 owns the transports); the
/// keyed operator case is the durable record.
pub struct CommunicationReadinessCheck {
    source: Arc<dyn CommunicationSettingsSource>,
}

impl CommunicationReadinessCheck {
    #[must_use]
    pub fn new(source: Arc<dyn CommunicationSettingsSource>) -> Self {
        Self { source }
    }
}

#[async_trait]
impl PlatformMonitorCheck for CommunicationReadinessCheck {
    fn id(&self) -> &'static str {
        "communication"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let config = self
            .source
            .configuration()
            .await
            .map_err(|error| check_error(self.id(), error))?;
        let mut findings = Vec::new();
        if !config.email_configured {
            findings.push(MonitorFinding::keyed(
                "email",
                "Email delivery is not configured",
                "Merchant registration and sign-in are in maintenance. Configure communication.email in Platform Settings (SMTP host, From address and credentials) or provide SMTP_HOST/SMTP_FROM_EMAIL in the deployment environment.",
                MonitorPriority::P1,
            ));
        }
        if config.sms_enabled && !config.sms_configured {
            findings.push(MonitorFinding::keyed(
                "sms",
                "SMS channel is enabled but incomplete",
                &format!(
                    "Missing: {}.",
                    if config.sms_missing_fields.is_empty() {
                        "provider configuration".to_owned()
                    } else {
                        config.sms_missing_fields.join(", ")
                    }
                ),
                MonitorPriority::P2,
            ));
        }
        if config.google_enabled && !config.google_configured {
            findings.push(MonitorFinding::keyed(
                "google",
                "Google sign-in is enabled but incomplete",
                &format!(
                    "Missing: {}.",
                    if config.google_missing_fields.is_empty() {
                        "OAuth client configuration".to_owned()
                    } else {
                        config.google_missing_fields.join(", ")
                    }
                ),
                MonitorPriority::P2,
            ));
        }
        let statuses = sqlx::query(COMMUNICATION_STATUS_SQL)
            .fetch_all(ctx.pool)
            .await
            .map_err(|error| check_error(self.id(), error))?;
        for row in statuses {
            let channel: String = row.get("channel");
            let failures = i64::from(row.try_get::<i32, _>("consecutive_failures").unwrap_or(0));
            let last_test: Option<String> = row.try_get("last_test_status").ok().flatten();
            if failures >= 3 {
                let last_error: Option<String> = row.try_get("last_delivery_error").ok().flatten();
                findings.push(MonitorFinding::keyed(
                    &format!("delivery-{}", channel.to_lowercase()),
                    &format!("{channel} delivery is failing"),
                    &format!(
                        "{failures} consecutive delivery failures. Last error: {}.",
                        last_error.unwrap_or_else(|| "unknown".to_owned())
                    ),
                    MonitorPriority::P2,
                ));
            } else if last_test.as_deref() == Some("FAILED") {
                let last_error: Option<String> = row.try_get("last_test_error").ok().flatten();
                findings.push(MonitorFinding::keyed(
                    &format!("test-{}", channel.to_lowercase()),
                    &format!("{channel} test failed"),
                    &last_error.unwrap_or_else(|| "The test message could not be sent.".to_owned()),
                    MonitorPriority::P3,
                ));
            }
        }
        Ok(MonitorCheckResult::complete(findings))
    }
}

// ---------------------------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObjectStorageHealth {
    pub ok: bool,
    pub mode: String,
    pub root_dir_or_url: String,
    pub error: Option<String>,
}

#[async_trait]
pub trait ObjectStorageProbe: Send + Sync {
    async fn health(&self) -> Result<ObjectStorageHealth, String>;
}

pub const OBJECT_STORAGE_SCRUB_ERRORS_SQL: &str =
    "SELECT count(*)::bigint FROM storage_objects WHERE status = 'ACTIVE' AND scrub_error_count > 0";

pub const OBJECT_STORAGE_QUARANTINE_SQL: &str =
    "SELECT count(*)::bigint FROM storage_objects WHERE status = 'QUARANTINE_PENDING_AV' AND created_at < $1";

pub const DEFAULT_QUARANTINE_MAX_AGE_MS: i64 = 30 * 60 * 1000;

/// `createObjectStorageMonitorCheck` (`objectStorageMonitorChecks.ts:25`).
pub struct ObjectStorageCheck {
    probe: Arc<dyn ObjectStorageProbe>,
    quarantine_max_age_ms: i64,
}

impl ObjectStorageCheck {
    #[must_use]
    pub fn new(probe: Arc<dyn ObjectStorageProbe>, quarantine_max_age_ms: i64) -> Self {
        Self {
            probe,
            quarantine_max_age_ms,
        }
    }
}

#[async_trait]
impl PlatformMonitorCheck for ObjectStorageCheck {
    fn id(&self) -> &'static str {
        "object_storage"
    }

    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
        let mut findings = Vec::new();
        let health = self
            .probe
            .health()
            .await
            .map_err(|error| check_error(self.id(), error))?;
        if !health.ok {
            findings.push(MonitorFinding::keyed(
                "health",
                "The shared object storage vault cannot be reached",
                &format!(
                    "The {} at {} is unhealthy{}. Uploads and downloads will fail.",
                    if health.mode == "REMOTE_MTLS" {
                        "mTLS object-storage daemon"
                    } else {
                        "local object vault"
                    },
                    health.root_dir_or_url,
                    health
                        .error
                        .as_deref()
                        .map(|error| format!(": {error}"))
                        .unwrap_or_default()
                ),
                MonitorPriority::P1,
            ));
        }
        let scrub_errors: i64 = sqlx::query_scalar(OBJECT_STORAGE_SCRUB_ERRORS_SQL)
            .fetch_one(ctx.pool)
            .await
            .map_err(|error| check_error(self.id(), error))?;
        if scrub_errors > 0 {
            findings.push(MonitorFinding::keyed(
                "scrub-errors",
                "Stored objects failed their integrity scrub",
                &format!(
                    "{scrub_errors} ACTIVE object(s) have a non-zero scrub error count and may not decrypt. Inspect /system/object-storage and restore the affected objects from backup."
                ),
                MonitorPriority::P1,
            ));
        }
        let cutoff = ctx.now.naive_utc() - ChronoDuration::milliseconds(self.quarantine_max_age_ms);
        let stuck: i64 = sqlx::query_scalar(OBJECT_STORAGE_QUARANTINE_SQL)
            .bind(cutoff)
            .fetch_one(ctx.pool)
            .await
            .map_err(|error| check_error(self.id(), error))?;
        if stuck > 0 {
            findings.push(MonitorFinding::keyed(
                "quarantine-stuck",
                "Uploads are waiting too long for malware scanning",
                &format!(
                    "{stuck} uploaded object(s) have been in QUARANTINE_PENDING_AV for more than {} minutes. The scanner backlog blocks their owners from downloading them.",
                    self.quarantine_max_age_ms / 60_000
                ),
                MonitorPriority::P2,
            ));
        }
        Ok(MonitorCheckResult::complete(findings))
    }
}

// ---------------------------------------------------------------------------------------------
// Standard set
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct StandardChecksConfig {
    pub worker_stale_multiplier: Option<f64>,
    pub worker_stale_ignore: Vec<String>,
    pub checkpoint_max_age_ms: Option<i64>,
    pub checkpoint_grace_factor: Option<f64>,
    pub outbox_max_age_ms: Option<i64>,
    pub audit_outbox_max_age_ms: Option<i64>,
    pub background_job_max_age_ms: Option<i64>,
    pub kyb_scan_backlog_max_age_ms: Option<i64>,
    pub journal_default_partition: Option<bool>,
    pub certificate_files: Vec<CertificateFile>,
    pub certificate_warn_within_ms: Option<i64>,
    pub certificate_reader: Option<Arc<dyn CertificateValidityReader>>,
    pub redis_probe: Option<Arc<dyn ServiceProbe>>,
    pub redis_timeout_ms: Option<u64>,
}

/// Builds the phase-1 check list from configuration (no environment reads), mirroring
/// `createStandardPlatformChecks` (`platformMonitorChecks.ts:390`).
#[must_use]
pub fn create_standard_platform_checks(
    config: StandardChecksConfig,
) -> Vec<Arc<dyn PlatformMonitorCheck>> {
    let mut checks: Vec<Arc<dyn PlatformMonitorCheck>> = vec![Arc::new(WorkerStalenessCheck::new(
        config.worker_stale_multiplier.unwrap_or(3.0),
        config.worker_stale_ignore,
        MonitorPriority::P1,
    ))];
    if let Some(max_age_ms) = config.checkpoint_max_age_ms {
        checks.push(Arc::new(CheckpointStalenessCheck::new(
            max_age_ms,
            config.checkpoint_grace_factor.unwrap_or(2.0),
            100,
            MonitorPriority::P2,
        )));
    }
    if let Some(max_age_ms) = config.outbox_max_age_ms {
        checks.push(Arc::new(OldestPendingCheck::outbox(max_age_ms)));
    }
    if let Some(max_age_ms) = config.audit_outbox_max_age_ms {
        checks.push(Arc::new(OldestPendingCheck::audit_outbox(max_age_ms)));
    }
    if let Some(max_age_ms) = config.background_job_max_age_ms {
        checks.push(Arc::new(BackgroundJobQueueAgeCheck::new(
            max_age_ms,
            MonitorPriority::P1,
        )));
    }
    if let Some(max_age_ms) = config.kyb_scan_backlog_max_age_ms {
        checks.push(Arc::new(KybScanBacklogCheck::new(
            max_age_ms,
            MonitorPriority::P2,
        )));
    }
    if config.journal_default_partition.unwrap_or(true) {
        checks.push(Arc::new(JournalDefaultPartitionCheck::new(
            1_000,
            MonitorPriority::P1,
        )));
    }
    if !config.certificate_files.is_empty() {
        if let Some(reader) = config.certificate_reader {
            checks.push(Arc::new(CertificateExpiryCheck::new(
                config.certificate_files,
                config.certificate_warn_within_ms.unwrap_or(30 * DAY_MS),
                reader,
                MonitorPriority::P1,
            )));
        } else {
            warn!("platform monitor: certificate files configured without a PEM reader; check skipped");
        }
    }
    if let Some(probe) = config.redis_probe {
        checks.push(Arc::new(ServiceReachabilityCheck::redis(
            probe,
            config.redis_timeout_ms.unwrap_or(2_000),
        )));
    }
    checks
}

/// True when a database error is a transient one a check may retry next tick.
#[must_use]
pub fn is_transient(error: &sqlx::Error) -> bool {
    crate::db::sqlstate(error)
        .as_deref()
        .is_some_and(is_transient_sqlstate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::{WorkerSnapshot, WorkerState};
    use chrono::{TimeZone, Utc};

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 28, 12, 0, 0)
            .single()
            .expect("datetime")
    }

    fn iso(at: DateTime<Utc>) -> String {
        at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    #[test]
    fn age_formatting_matches_the_typescript_steps() {
        assert_eq!(format_age(30_000), "30 s");
        assert_eq!(format_age(120_000), "2 min");
        assert_eq!(format_age(3_600_000), "60 min");
        assert_eq!(format_age(7_200_000), "2.0 h");
        assert_eq!(format_age(2 * DAY_MS), "2.0 days");
        assert_eq!(format_age(36 * DAY_MS / 10), "3.6 days");
    }

    #[test]
    fn stale_workers_trip_after_three_intervals() {
        let snapshot = WorkerSnapshot::new();
        let mut state = WorkerState::new("PollWorker", false);
        state.running = true;
        state.interval_ms = 5_000;
        state.started_at = Some(iso(now() - ChronoDuration::seconds(60)));
        state.last_success_at = Some(iso(now() - ChronoDuration::seconds(20)));
        state.consecutive_failures = 4;
        state.last_error = Some("boom".to_owned());
        snapshot.register(state);
        let findings = WorkerStalenessCheck::findings(now(), &snapshot);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].key.as_deref(), Some("PollWorker"));
        assert!(findings[0].detail.contains("consecutive failures 4"));
        assert!(findings[0].detail.contains("last error: boom"));
    }

    #[test]
    fn healthy_idle_and_disabled_workers_do_not_trip() {
        let snapshot = WorkerSnapshot::new();
        let mut healthy = WorkerState::new("PollWorker", false);
        healthy.running = true;
        healthy.interval_ms = 5_000;
        healthy.started_at = Some(iso(now() - ChronoDuration::seconds(60)));
        healthy.last_success_at = Some(iso(now() - ChronoDuration::seconds(1)));
        snapshot.register(healthy);
        let mut stopped = WorkerState::new("StoppedWorker", false);
        stopped.running = false;
        stopped.interval_ms = 5_000;
        stopped.started_at = Some(iso(now() - ChronoDuration::seconds(600)));
        snapshot.register(stopped);
        let mut never_started = WorkerState::new("PendingWorker", false);
        never_started.running = true;
        never_started.interval_ms = 5_000;
        snapshot.register(never_started);
        assert!(WorkerStalenessCheck::findings(now(), &snapshot).is_empty());
    }

    #[test]
    fn ignored_workers_are_skipped() {
        let snapshot = WorkerSnapshot::new();
        let mut state = WorkerState::new("NoisyWorker", false);
        state.running = true;
        state.interval_ms = 1_000;
        state.started_at = Some(iso(now() - ChronoDuration::seconds(600)));
        snapshot.register(state);
        let check =
            WorkerStalenessCheck::new(3.0, vec!["NoisyWorker".to_owned()], MonitorPriority::P1);
        assert!(check.findings_with(now(), &snapshot).is_empty());
    }

    fn run(overview: &BackupOverview, full_age: i64, drill_age: i64) -> Vec<MonitorFinding> {
        backup_findings(now(), overview, full_age, drill_age)
    }

    fn passed_full(target: &str, finished_minutes_ago: i64) -> BackupRun {
        BackupRun {
            id: "run-1".to_owned(),
            target: target.to_owned(),
            kind: "full".to_owned(),
            engine: "pg-native".to_owned(),
            status: "PASSED".to_owned(),
            started_at: now() - ChronoDuration::minutes(finished_minutes_ago + 5),
            completed_at: Some(now() - ChronoDuration::minutes(finished_minutes_ago)),
            error_message: None,
        }
    }

    fn healthy_drill(minutes_ago: i64) -> BackupDrill {
        BackupDrill {
            id: "drill-1".to_owned(),
            status: "PASSED".to_owned(),
            started_at: now() - ChronoDuration::minutes(minutes_ago + 1),
            completed_at: Some(now() - ChronoDuration::minutes(minutes_ago)),
            error_message: None,
            double_entry_drift: Some("0.0000".to_owned()),
            balance_mismatches: Some(0),
            audit_broken_links: Some(0),
        }
    }

    #[test]
    fn a_healthy_backup_estate_is_quiet() {
        let overview = BackupOverview {
            healthy: Some(true),
            engine_mode: "pg-native".to_owned(),
            targets: vec![BackupTargetStatus {
                name: "local".to_owned(),
                healthy: true,
                detail: None,
            }],
            wal: BackupWalStatus {
                archive_lag_seconds: Some(3),
                lag_bytes: Some(512),
                last_archived_lsn: Some("0/16B6C50".to_owned()),
            },
            backups: vec![passed_full("local", 60)],
            latest_drill: Some(healthy_drill(600)),
            policy: Some(BackupPolicySummary {
                alert_lag_seconds: Some(300),
            }),
        };
        assert!(run(
            &overview,
            DEFAULT_BACKUP_MAX_FULL_AGE_MS,
            DEFAULT_BACKUP_MAX_DRILL_AGE_MS
        )
        .is_empty());
    }

    #[test]
    fn every_backup_condition_has_its_own_key() {
        let mut failed = passed_full("local", 60);
        failed.status = "FAILED".to_owned();
        failed.error_message = Some("no space".to_owned());
        let overview = BackupOverview {
            healthy: Some(false),
            engine_mode: "pg-native".to_owned(),
            targets: vec![
                BackupTargetStatus {
                    name: "local".to_owned(),
                    healthy: false,
                    detail: Some("disk full".to_owned()),
                },
                BackupTargetStatus {
                    name: "s3".to_owned(),
                    healthy: true,
                    detail: None,
                },
            ],
            wal: BackupWalStatus {
                archive_lag_seconds: Some(900),
                lag_bytes: Some(1024),
                last_archived_lsn: Some("0/AAA".to_owned()),
            },
            backups: vec![failed],
            latest_drill: Some(BackupDrill {
                status: "FAILED".to_owned(),
                error_message: Some("drift".to_owned()),
                double_entry_drift: Some("0.0100".to_owned()),
                balance_mismatches: Some(2),
                audit_broken_links: Some(1),
                ..healthy_drill(60)
            }),
            policy: Some(BackupPolicySummary {
                alert_lag_seconds: Some(300),
            }),
        };
        let findings = run(
            &overview,
            DEFAULT_BACKUP_MAX_FULL_AGE_MS,
            DEFAULT_BACKUP_MAX_DRILL_AGE_MS,
        );
        let keys: Vec<&str> = findings
            .iter()
            .map(|finding| finding.key.as_deref().unwrap_or(""))
            .collect();
        for expected in [
            "unhealthy",
            "wal-lag",
            "backup-failed:local",
            "backup-stale",
            "drill-failed",
        ] {
            assert!(keys.contains(&expected), "missing {expected} in {keys:?}");
        }
    }

    #[test]
    fn stale_full_and_missing_drill_are_reported() {
        let overview = BackupOverview {
            healthy: Some(true),
            engine_mode: "pg-native".to_owned(),
            backups: vec![passed_full("local", 60 * 48)],
            ..BackupOverview::default()
        };
        let findings = run(
            &overview,
            DEFAULT_BACKUP_MAX_FULL_AGE_MS,
            DEFAULT_BACKUP_MAX_DRILL_AGE_MS,
        );
        let keys: Vec<&str> = findings
            .iter()
            .map(|finding| finding.key.as_deref().unwrap_or(""))
            .collect();
        assert!(keys.contains(&"backup-stale"));
        assert!(keys.contains(&"drill-stale"));
        assert!(!keys.contains(&"backup-failed:local"));
    }

    #[test]
    fn the_newest_run_per_target_decides() {
        let mut older_failure = passed_full("local", 60);
        older_failure.id = "run-old".to_owned();
        older_failure.status = "FAILED".to_owned();
        older_failure.completed_at = Some(now() - ChronoDuration::hours(5));
        let newer_success = passed_full("local", 30);
        let overview = BackupOverview {
            healthy: Some(true),
            engine_mode: "pg-native".to_owned(),
            backups: vec![older_failure, newer_success],
            latest_drill: Some(healthy_drill(60)),
            ..BackupOverview::default()
        };
        let findings = run(
            &overview,
            DEFAULT_BACKUP_MAX_FULL_AGE_MS,
            DEFAULT_BACKUP_MAX_DRILL_AGE_MS,
        );
        assert!(findings.is_empty(), "{findings:?}");
    }

    #[test]
    fn check_ids_match_the_case_subject_prefixes() {
        assert_eq!(WorkerStalenessCheck::standard().id(), "worker_stale");
        let reader = Arc::new(NoopReader);
        assert_eq!(
            CertificateExpiryCheck::new(vec![], 1, reader, MonitorPriority::P1).id(),
            "cert_expiry"
        );
        assert_eq!(OldestPendingCheck::outbox(1).id(), "outbox_age");
        assert_eq!(OldestPendingCheck::audit_outbox(1).id(), "audit_outbox_age");
    }

    struct NoopReader;
    #[async_trait]
    impl CertificateValidityReader for NoopReader {
        async fn read_valid_to(&self, _path: &str) -> Result<DateTime<Utc>, String> {
            Ok(now())
        }
    }

    #[test]
    fn standard_checks_follow_the_configuration() {
        let checks = create_standard_platform_checks(StandardChecksConfig::default());
        assert_eq!(checks.len(), 2); // worker_stale + journal_default_rows
        let ids: Vec<&str> = checks.iter().map(|check| check.id()).collect();
        assert_eq!(ids, vec!["worker_stale", "journal_default_rows"]);

        let checks = create_standard_platform_checks(StandardChecksConfig {
            checkpoint_max_age_ms: Some(900_000),
            outbox_max_age_ms: Some(300_000),
            audit_outbox_max_age_ms: Some(300_000),
            background_job_max_age_ms: Some(300_000),
            kyb_scan_backlog_max_age_ms: Some(7_200_000),
            journal_default_partition: Some(false),
            certificate_files: vec![CertificateFile {
                label: "mtls_server".to_owned(),
                path: "/tmp/server.pem".to_owned(),
            }],
            certificate_reader: Some(Arc::new(NoopReader)),
            redis_probe: Some(Arc::new(AlwaysOk)),
            ..StandardChecksConfig::default()
        });
        let ids: Vec<&str> = checks.iter().map(|check| check.id()).collect();
        assert_eq!(
            ids,
            vec![
                "worker_stale",
                "checkpoint_stale",
                "outbox_age",
                "audit_outbox_age",
                "background_job_age",
                "kyb_scan_backlog",
                "cert_expiry",
                "redis_unreachable",
            ]
        );
    }

    struct AlwaysOk;
    #[async_trait]
    impl ServiceProbe for AlwaysOk {
        async fn probe(&self) -> Result<bool, String> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn a_failing_probe_becomes_a_finding() {
        struct AlwaysDown;
        #[async_trait]
        impl ServiceProbe for AlwaysDown {
            async fn probe(&self) -> Result<bool, String> {
                Err("connection refused".to_owned())
            }
        }
        let check = ServiceReachabilityCheck::redis(Arc::new(AlwaysDown), 100);
        let pool = sqlx::PgPool::connect_lazy("postgres://unused/unused").expect("lazy");
        let ctx = MonitorContext {
            now: now(),
            registry: WorkerSnapshot::new(),
            pool: &pool,
        };
        let result = check.run(&ctx).await.expect("check");
        assert_eq!(result.findings.len(), 1);
        assert!(result.findings[0].detail.contains("connection refused"));
    }

    #[test]
    fn sql_predicates_match_the_typescript_checks() {
        assert!(CHECKPOINT_STALE_SQL.contains("COALESCE(c.status, 'OK') = 'OK'"));
        assert!(CHECKPOINT_STALE_SQL.contains("s.line_seq > COALESCE(c.checkpoint_seq, 0)"));
        assert!(OUTBOX_OLDEST_SQL.contains("processed_at IS NULL"));
        assert!(AUDIT_OUTBOX_OLDEST_SQL.contains("shipped_at IS NULL"));
        assert!(BACKGROUND_JOB_OLDEST_SQL.contains("state = 'QUEUED'"));
        assert!(KYB_SCAN_BACKLOG_SQL.contains("av_status = 'PENDING'"));
        assert!(JOURNAL_DEFAULT_SQL.contains("journal_lines_default"));
        assert!(STALE_UNKNOWN_SUMMARY_SQL.contains("kind = 'UNKNOWN'"));
        assert!(UNSCHEDULED_REFUND_SQL.contains("REFUND_INQUIRY"));
        assert!(COMMUNICATION_STATUS_SQL.contains("consecutive_failures"));
        assert!(OBJECT_STORAGE_SCRUB_ERRORS_SQL.contains("scrub_error_count > 0"));
        assert!(OBJECT_STORAGE_QUARANTINE_SQL.contains("QUARANTINE_PENDING_AV"));
    }

    #[test]
    fn parse_iso_accepts_the_health_timestamps() {
        let at = now();
        assert_eq!(parse_iso(&iso(at)), Some(at));
        assert_eq!(parse_iso("not a date"), None);
    }
}
