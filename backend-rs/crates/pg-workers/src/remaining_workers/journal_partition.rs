//! Journal partition maintenance (AUTO-01), `engine/workers/JournalPartitionWorker.ts`.
//!
//! `journal_lines` has one partition per month. The deploy cron calls
//! `ensure_journal_line_partitions`, but a database provisioned any other way, or a cron that
//! stopped, would get no new months, and the first posting of a missing month lands in
//! `journal_lines_default`, after which that month can no longer be created. This worker:
//!
//! 1. keeps the next `months_ahead` months in existence by calling the SAME database function the
//!    cron calls (SECURITY DEFINER, bounded 1..60, TRUNCATE guard and `pgw_app` grants installed
//!    identically);
//! 2. raises one P1 `ledger.partition.default_rows` case while the default partition holds rows
//!    (moving them edits ledger rows, so it is an operator action under the ledger maintenance
//!    flag: `core-back/scripts/repair-journal-default-partition.ts`);
//! 3. raises one P1 `ledger.partition.ensure_failed` case when creating the months fails, with the
//!    database's own (sanitized) error.
//!
//! Cases are never resolved here; a person closes them after the repair. An audit row
//! `JOURNAL_PARTITIONS_ENSURED` records the months this worker created.

#![forbid(unsafe_code)]

use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::json;
use sqlx::{PgPool, Row};
use tracing::{error, info};

use crate::cases::tick_now;
use crate::cases::{
    raise_keyed_case, write_system_audit_pool, CaseKind, KeyedCaseInput, MonitorPriority,
    SystemAudit,
};
use crate::remaining_workers::{sanitize_error_message, RemainingWorkerError};
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

/// `MAX_PARTITION_MONTHS_AHEAD` (`partitionMaintenance.ts:18`).
pub const MAX_PARTITION_MONTHS_AHEAD: i64 = 60;

/// `JOURNAL_PARTITION_CASE_KEYS.defaultRows`.
pub const JOURNAL_PARTITION_CASE_DEFAULT_ROWS: &str = "ledger.partition.default_rows";

/// `JOURNAL_PARTITION_CASE_KEYS.ensureFailed`.
pub const JOURNAL_PARTITION_CASE_ENSURE_FAILED: &str = "ledger.partition.ensure_failed";

/// One month found in the default partition (`DefaultPartitionMonth`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultPartitionMonth {
    /// `YYYY_MM`.
    pub month: String,
    pub rows: i64,
}

/// The result of inspecting the monthly partitions (`PartitionInspection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartitionInspection {
    pub months_ahead: i64,
    /// Months (`YYYY_MM`) among the next `months_ahead` that have no partition yet.
    pub missing: Vec<String>,
    pub monthly_partitions: i64,
    /// Rows in `journal_lines_default`, counted up to the cap.
    pub default_rows: i64,
    pub default_rows_capped: bool,
    pub default_months: Vec<DefaultPartitionMonth>,
}

/// `inspectJournalPartitions`.
pub async fn inspect_journal_partitions(
    pool: &PgPool,
    months_ahead: i64,
    cap: i64,
) -> Result<PartitionInspection, WorkerError> {
    let cap = cap.max(1);
    let months_ahead = months_ahead.clamp(1, MAX_PARTITION_MONTHS_AHEAD);
    let missing = sqlx::query(
        "WITH want AS (
           SELECT to_char(date_trunc('month', now())::date + (g || ' months')::interval, 'YYYY_MM') AS suffix
           FROM generate_series(0, $1::int - 1) AS g
         )
         SELECT suffix FROM want
          WHERE to_regclass('\"journal_lines_' || suffix || '\"') IS NULL
          ORDER BY suffix",
    )
    .bind(i32::try_from(months_ahead).unwrap_or(1))
    .fetch_all(pool)
    .await
    .map_err(partition_error)?;
    let missing: Vec<String> = missing
        .iter()
        .map(|row| row.get::<String, _>("suffix"))
        .collect();
    let monthly_partitions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'journal_lines'::regclass AND c.relname ~ '^journal_lines_[0-9]{4}_[0-9]{2}$'",
    )
    .fetch_one(pool)
    .await
    .map_err(partition_error)?;
    let default_exists: bool =
        sqlx::query_scalar("SELECT to_regclass('journal_lines_default') IS NOT NULL")
            .fetch_one(pool)
            .await
            .map_err(partition_error)?;
    let mut default_months = Vec::new();
    if default_exists {
        let rows = sqlx::query(
            "SELECT to_char(date_trunc('month', created_at), 'YYYY_MM') AS month, count(*) AS n
               FROM (SELECT created_at FROM journal_lines_default LIMIT $1) AS capped
              GROUP BY 1 ORDER BY 1",
        )
        .bind(cap)
        .fetch_all(pool)
        .await
        .map_err(partition_error)?;
        default_months = rows
            .iter()
            .map(|row| DefaultPartitionMonth {
                month: row.get("month"),
                rows: row.get("n"),
            })
            .collect();
    }
    let default_rows = default_months.iter().map(|entry| entry.rows).sum();
    Ok(PartitionInspection {
        months_ahead,
        missing,
        monthly_partitions,
        default_rows,
        default_rows_capped: default_rows >= cap,
        default_months,
    })
}

/// `ensureJournalPartitions`: calls the SECURITY DEFINER function the deploy cron calls.
pub async fn ensure_journal_partitions(
    pool: &PgPool,
    months_ahead: i64,
) -> Result<(), WorkerError> {
    if !(1..=MAX_PARTITION_MONTHS_AHEAD).contains(&months_ahead) {
        return Err(WorkerError::Failed(format!(
            "monthsAhead must be between 1 and {MAX_PARTITION_MONTHS_AHEAD} (got {months_ahead})"
        )));
    }
    sqlx::query("SELECT 1 AS ok FROM (SELECT ensure_journal_line_partitions($1::int)) AS ensured")
        .bind(i32::try_from(months_ahead).unwrap_or(6))
        .execute(pool)
        .await
        .map_err(partition_error)?;
    Ok(())
}

/// The configuration of the worker (`JournalPartitionWorkerDeps`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalPartitionConfig {
    pub interval_ms: u64,
    /// How many months (counting the current one) must exist ahead of the clock. 1..60.
    pub months_ahead: i64,
    /// SLA of the cases in hours (the most urgent cases the platform raises).
    pub case_sla_hours: i64,
    /// Inspect cap for the default partition.
    pub default_rows_cap: i64,
}

impl Default for JournalPartitionConfig {
    fn default() -> Self {
        Self {
            interval_ms: 6 * 60 * 60 * 1_000,
            months_ahead: 6,
            case_sla_hours: 2,
            default_rows_cap: 10_000,
        }
    }
}

impl JournalPartitionConfig {
    fn validated(&self) -> Result<(), RemainingWorkerError> {
        if !(1..=MAX_PARTITION_MONTHS_AHEAD).contains(&self.months_ahead) {
            return Err(RemainingWorkerError::Config(format!(
                "JournalPartitionWorker: monthsAhead must be 1..{MAX_PARTITION_MONTHS_AHEAD} (got {})",
                self.months_ahead
            )));
        }
        Ok(())
    }
}

/// What one tick did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalPartitionTick {
    pub created: Vec<String>,
    pub inspection: PartitionInspection,
}

/// AUTO-01: keeps the next monthly journal partitions in existence.
pub struct JournalPartitionWorker {
    pool: PgPool,
    config: JournalPartitionConfig,
    last_inspection: Mutex<Option<PartitionInspection>>,
}

impl JournalPartitionWorker {
    pub fn new(pool: PgPool, config: JournalPartitionConfig) -> Self {
        Self {
            pool,
            config,
            last_inspection: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn last_inspection(&self) -> Option<PartitionInspection> {
        self.last_inspection.lock().clone()
    }

    pub async fn tick_once(&self) -> Result<JournalPartitionTick, WorkerError> {
        self.config.validated()?;
        let now = tick_now();
        let before = inspect_journal_partitions(
            &self.pool,
            self.config.months_ahead,
            self.config.default_rows_cap,
        )
        .await?;
        let mut ensure_error: Option<String> = None;
        if !before.missing.is_empty() {
            if let Err(error) =
                ensure_journal_partitions(&self.pool, self.config.months_ahead).await
            {
                ensure_error = Some(sanitize_error_message(&error.to_string()));
                error!(
                    missing = ?before.missing,
                    error = ensure_error.as_deref().unwrap_or_default(),
                    "journal partition worker: creating the monthly partitions failed"
                );
            }
        }
        let after = if before.missing.is_empty() {
            before.clone()
        } else {
            inspect_journal_partitions(
                &self.pool,
                self.config.months_ahead,
                self.config.default_rows_cap,
            )
            .await?
        };
        *self.last_inspection.lock() = Some(after.clone());
        let created: Vec<String> = before
            .missing
            .iter()
            .filter(|month| !after.missing.contains(month))
            .cloned()
            .collect();
        if !created.is_empty() {
            write_system_audit_pool(
                &self.pool,
                &SystemAudit::new(
                    "JOURNAL_PARTITIONS_ENSURED",
                    "LEDGER",
                    "journal_lines",
                    json!({}),
                    json!({
                        "created": created,
                        "monthsAhead": self.config.months_ahead,
                        "stillMissing": after.missing,
                    }),
                ),
            )
            .await?;
            info!(created = ?created, "journal partition worker: monthly partitions created");
        }
        if ensure_error.is_some() || !after.missing.is_empty() {
            let mut notes = format!(
                "The monthly journal partitions {} could not be created",
                after.missing.join(", ")
            );
            if let Some(error) = &ensure_error {
                notes.push_str(&format!(": {error}"));
            }
            notes.push_str(
                ". Until they exist, lines of those months land in journal_lines_default and block creating the month. ",
            );
            if after.default_rows > 0 {
                notes.push_str(
                    "Rows are already in the default partition: run scripts/repair-journal-default-partition.ts with ledger maintenance privileges. ",
                );
            }
            notes.push_str(
                "Check the privileges on ensure_journal_line_partitions and the deploy cron.",
            );
            self.raise_case(JOURNAL_PARTITION_CASE_ENSURE_FAILED, &notes, now)
                .await?;
        }
        if after.default_rows > 0 {
            let months = after
                .default_months
                .iter()
                .map(|entry| format!("{}={}", entry.month, entry.rows))
                .collect::<Vec<_>>()
                .join(", ");
            let notes = format!(
                "{}{} journal line(s) are in journal_lines_default (months: {}). \
                 Their months have no partition. Run scripts/repair-journal-default-partition.ts \
                 (dry run first) with a ledger maintenance connection.",
                if after.default_rows_capped {
                    "At least "
                } else {
                    ""
                },
                after.default_rows,
                months
            );
            self.raise_case(JOURNAL_PARTITION_CASE_DEFAULT_ROWS, &notes, now)
                .await?;
        }
        Ok(JournalPartitionTick {
            created,
            inspection: after,
        })
    }

    async fn raise_case(
        &self,
        subject_key: &str,
        notes: &str,
        now: chrono::NaiveDateTime,
    ) -> Result<(), WorkerError> {
        let mut tx = self.pool.begin().await.map_err(partition_error)?;
        raise_keyed_case(
            &mut tx,
            &KeyedCaseInput {
                kind: CaseKind::Mismatch,
                priority: MonitorPriority::P1,
                subject_key,
                attempt_id: None,
                reconciliation_item_id: None,
                notes,
                sla_hours: self.config.case_sla_hours.max(1),
                now,
                dedupe_on_attempt: false,
                title: None,
            },
        )
        .await?;
        tx.commit().await.map_err(partition_error)?;
        Ok(())
    }
}

#[async_trait]
impl Worker for JournalPartitionWorker {
    fn name(&self) -> &'static str {
        "JournalPartitionWorker"
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.config.interval_ms.max(1))
    }

    fn singleton(&self) -> bool {
        true
    }

    async fn tick(&self, ctx: &WorkerContext) -> Result<WorkerOutcome, WorkerError> {
        if ctx.shutting_down() {
            return Ok(WorkerOutcome::Deferred);
        }
        let tick = self.tick_once().await?;
        if tick.created.is_empty() {
            Ok(WorkerOutcome::Skipped)
        } else {
            Ok(WorkerOutcome::Processed(
                u64::try_from(tick.created.len()).unwrap_or(0),
            ))
        }
    }
}

fn partition_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("journal partition: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_configuration_is_bounded() {
        assert!(JournalPartitionConfig {
            months_ahead: 0,
            ..JournalPartitionConfig::default()
        }
        .validated()
        .is_err());
        assert!(JournalPartitionConfig {
            months_ahead: 61,
            ..JournalPartitionConfig::default()
        }
        .validated()
        .is_err());
        assert!(JournalPartitionConfig::default().validated().is_ok());
    }

    #[test]
    fn defaults_match_the_typescript_worker() {
        let config = JournalPartitionConfig::default();
        assert_eq!(config.interval_ms, 21_600_000);
        assert_eq!(config.months_ahead, 6);
        assert_eq!(config.case_sla_hours, 2);
    }
}
