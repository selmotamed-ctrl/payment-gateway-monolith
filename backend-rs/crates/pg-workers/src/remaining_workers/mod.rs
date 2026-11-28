//! The remaining P6 workers (journal partitions, join-request expiry, expiry housekeeping,
//! statement schedules, slot-counter audit and record retention).
//!
//! This module is the registration list for the six workers of the P6 remainder. Each worker is a
//! [`Worker`] with a stable TypeScript class name, a singleton flag (all six are cluster singletons)
//! and a bounded tick. The TypeScript sources are the contract:
//!
//! | Module | TypeScript source |
//! | :--- | :--- |
//! | [`journal_partition`] | `engine/workers/JournalPartitionWorker.ts`, `engine/ledger/partitionMaintenance.ts` |
//! | [`join_request_expiry`] | `engine/workers/JoinRequestExpiryWorker.ts` |
//! | [`expiry_housekeeping`] | `engine/workers/ExpiryHousekeepingWorker.ts` |
//! | [`statement_schedule`] | `engine/workers/StatementScheduleWorker.ts`, `lib/cron.ts` |
//! | [`consistency_audit`] | `engine/workers/ConsistencyAuditWorker.ts` |
//! | [`retention`] | `engine/workers/RetentionWorker.ts` |
//!
//! `productionRuntime` wiring belongs to core-rs: [`create_remaining_workers`] returns the six
//! `Arc<dyn Worker>` values for a runtime to register, and nothing here starts a timer.
//!
//! Money is `rust_decimal::Decimal`; no floating-point type is used for money. Secrets and
//! ciphertext are never logged.

#![forbid(unsafe_code)]

use std::sync::Arc;

use sqlx::PgPool;
use thiserror::Error;

use crate::cron::CronError;
use crate::notices::NoticeAddressCipher;
use crate::runtime::{Worker, WorkerError};

pub mod consistency_audit;
pub mod expiry_housekeeping;
pub mod join_request_expiry;
pub mod journal_partition;
pub mod retention;
pub mod statement_schedule;

pub use consistency_audit::{
    ConsistencyAuditConfig, ConsistencyAuditSummary, ConsistencyAuditWorker, SLOT_HOLDING_STATUSES,
};
pub use expiry_housekeeping::{
    normalize_approval_subject_type, ExpiryHousekeepingConfig, ExpiryHousekeepingWorker,
    HousekeepingCounts, HousekeepingPass, HousekeepingSummary,
    APPROVAL_SUBJECTS_WITH_OWN_LIFECYCLE,
};
pub use join_request_expiry::{
    ExpiredJoinRequest, JoinRequestExpiryConfig, JoinRequestExpiryReason, JoinRequestExpiryWorker,
    DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS,
};
pub use journal_partition::{
    ensure_journal_partitions, inspect_journal_partitions, DefaultPartitionMonth,
    JournalPartitionConfig, JournalPartitionTick, JournalPartitionWorker, PartitionInspection,
    JOURNAL_PARTITION_CASE_DEFAULT_ROWS, JOURNAL_PARTITION_CASE_ENSURE_FAILED,
    MAX_PARTITION_MONTHS_AHEAD,
};
pub use retention::{
    retention_days_from_setting, RetentionConfig, RetentionSummary, RetentionWorker, DAYS_PER_YEAR,
    DEFAULT_RETENTION_DAYS, RETENTION_MS_PER_DAY, RETENTION_SETTING_KEY,
};
pub use statement_schedule::{
    statement_missing_subject_key, StatementScheduleConfig, StatementScheduleSummary,
    StatementScheduleWorker,
};

/// The stable worker names, in the order the runtime registers them.
pub const REMAINING_WORKER_NAMES: [&str; 6] = [
    "JournalPartitionWorker",
    "JoinRequestExpiryWorker",
    "ExpiryHousekeepingWorker",
    "StatementScheduleWorker",
    "ConsistencyAuditWorker",
    "RetentionWorker",
];

/// A typed error shared by the six workers.
#[derive(Debug, Error)]
pub enum RemainingWorkerError {
    #[error("invalid configuration: {0}")]
    Config(String),
    #[error(transparent)]
    Cron(#[from] CronError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Worker(#[from] WorkerError),
}

impl From<RemainingWorkerError> for WorkerError {
    fn from(error: RemainingWorkerError) -> Self {
        match error {
            RemainingWorkerError::Worker(error) => error,
            other => WorkerError::Failed(other.to_string()),
        }
    }
}

/// `sanitizeWorkerError`: one line, at most 300 characters (`workerRuntime.ts:87-94`).
#[must_use]
pub fn sanitize_error_message(message: &str) -> String {
    let line = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let line = if line.is_empty() {
        "unknown error".to_owned()
    } else {
        line
    };
    if line.chars().count() > 300 {
        let truncated: String = line.chars().take(297).collect();
        format!("{truncated}...")
    } else {
        line
    }
}

/// Defaults and injected ports for the six workers.
#[derive(Clone, Default)]
pub struct RemainingWorkersConfig {
    pub journal_partition: JournalPartitionConfig,
    pub join_request_expiry: JoinRequestExpiryConfig,
    pub expiry_housekeeping: ExpiryHousekeepingConfig,
    pub statement_schedule: StatementScheduleConfig,
    pub consistency_audit: ConsistencyAuditConfig,
    pub retention: RetentionConfig,
    /// Seals merchant/staff notice addresses (Vault). Without it only in-app notices are queued.
    pub notice_cipher: Option<Arc<dyn NoticeAddressCipher>>,
}

impl std::fmt::Debug for RemainingWorkersConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RemainingWorkersConfig")
            .field("journal_partition", &self.journal_partition)
            .field("join_request_expiry", &self.join_request_expiry)
            .field("expiry_housekeeping", &self.expiry_housekeeping)
            .field("statement_schedule", &self.statement_schedule)
            .field("consistency_audit", &self.consistency_audit)
            .field("retention", &self.retention)
            .field("notice_cipher", &self.notice_cipher.is_some())
            .finish()
    }
}

/// Builds the six workers for registration with [`crate::runtime::WorkerRuntime`].
///
/// The caller decides enablement (`WORKER_*_ENABLED`) and passes only the enabled workers.
#[must_use]
pub fn create_remaining_workers(
    pool: PgPool,
    config: &RemainingWorkersConfig,
) -> Vec<Arc<dyn Worker>> {
    vec![
        Arc::new(JournalPartitionWorker::new(
            pool.clone(),
            config.journal_partition.clone(),
        )),
        Arc::new(JoinRequestExpiryWorker::new(
            pool.clone(),
            config.join_request_expiry.clone(),
            config.notice_cipher.clone(),
        )),
        Arc::new(ExpiryHousekeepingWorker::new(
            pool.clone(),
            config.expiry_housekeeping.clone(),
            config.notice_cipher.clone(),
        )),
        Arc::new(StatementScheduleWorker::new(
            pool.clone(),
            config.statement_schedule.clone(),
        )),
        Arc::new(ConsistencyAuditWorker::new(
            pool.clone(),
            config.consistency_audit.clone(),
        )),
        Arc::new(RetentionWorker::new(pool, config.retention.clone())),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_messages_are_sanitized_and_bounded() {
        assert_eq!(sanitize_error_message("  a\n b  "), "a b");
        assert_eq!(sanitize_error_message("   "), "unknown error");
        let long = "x".repeat(400);
        let sanitized = sanitize_error_message(&long);
        assert_eq!(sanitized.chars().count(), 300);
        assert!(sanitized.ends_with("..."));
    }

    #[test]
    fn the_six_worker_names_are_the_typescript_class_names() {
        assert_eq!(REMAINING_WORKER_NAMES.len(), 6);
        for name in REMAINING_WORKER_NAMES {
            assert!(!name.is_empty());
        }
    }

    #[tokio::test]
    async fn every_worker_is_a_cluster_singleton_with_the_documented_name() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://postgres@127.0.0.1:1/unreachable")
            .expect("lazy pool");
        let workers = create_remaining_workers(pool, &RemainingWorkersConfig::default());
        let names: Vec<&'static str> = workers.iter().map(|worker| worker.name()).collect();
        assert_eq!(names, REMAINING_WORKER_NAMES);
        assert!(workers.iter().all(|worker| worker.singleton()));
        assert!(workers.iter().all(|worker| !worker.interval().is_zero()));
    }
}
