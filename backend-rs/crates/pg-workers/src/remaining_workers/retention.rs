//! The record retention worker (OD-4), `engine/workers/RetentionWorker.ts`.
//!
//! The platform has to keep its regulatory evidence for five years and must not purge anything
//! before that. This worker is the only place where evidence is removed, and it removes it in
//! bounded batches, in dependency order and inside a transaction per batch.
//!
//! Rules:
//!
//! - `notifications` rows older than the period;
//! - `inbound_events` rows received before the period;
//! - `attempt_step_logs` rows older than the period whose attempt is older than the period (the
//!   log of a live attempt is never purged);
//! - `audit_log` rows older than the period, through the sanctioned `pgw.audit_retention`
//!   transaction-local GUC (GAP-013);
//! - `detail_change_logs` rows older than the period;
//! - `payment_attempts` terminal attempts older than the period, together with their dependent
//!   rows. An attempt only goes when its journal entry is retained (or when it never had one).
//!
//! The ledger (`journal_entries` / `journal_lines`) is deliberately OUT of the retention scope. A GL
//! account balance is the sum of its shards, and every shard checkpoint is proven against the
//! journal lines of its gapless sequence; deleting a journal line would break that proof. The ledger
//! is the immutable audit evidence of money that really moved, so the purger never removes it.
//!
//! Every delete is guarded by a cutoff (`created_at < cutoff` and friends); there is no broad
//! `DELETE` without one. The worker is a dry run when `dry_run` is set: it then reports what it would
//! purge and deletes nothing.

#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDateTime;
use serde_json::Value;
use sqlx::{PgConnection, PgPool, Row};
use tracing::{info, warn};
use uuid::Uuid;

use crate::cases::tick_now;
use crate::remaining_workers::RemainingWorkerError;
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

/// The management decision that carries the record retention period (`OD-4`).
pub const RETENTION_SETTING_KEY: &str = "OD-4";

/// The number of days of a retention year.
pub const DAYS_PER_YEAR: i64 = 365;

/// The default retention period of OD-4: five years.
pub const DEFAULT_RETENTION_DAYS: i64 = 5 * DAYS_PER_YEAR;

/// The milliseconds of a retention day.
pub const RETENTION_MS_PER_DAY: i64 = 86_400_000;

/// The number of batches a single table is purged in during one tick (TS `MAX_BATCHES_PER_TABLE`).
pub const MAX_BATCHES_PER_TABLE: u32 = 100;

/// What a retention pass purged (`RetentionSummary`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RetentionSummary {
    pub notifications: u64,
    pub inbound_events: u64,
    pub attempt_step_logs: u64,
    pub audit_log: u64,
    pub detail_change_logs: u64,
    pub payment_attempts: u64,
    /// Always 0: the ledger is never purged (kept for parity with TypeScript).
    pub journal_entries: u64,
    /// Always 0: the ledger is never purged (kept for parity with TypeScript).
    pub journal_lines: u64,
    pub adjustments: u64,
    pub disputes: u64,
    pub operator_cases: u64,
    pub attempt_groups: u64,
}

impl RetentionSummary {
    #[must_use]
    pub fn total(&self) -> u64 {
        self.notifications
            + self.inbound_events
            + self.attempt_step_logs
            + self.audit_log
            + self.detail_change_logs
            + self.payment_attempts
            + self.journal_entries
            + self.journal_lines
            + self.adjustments
            + self.disputes
            + self.operator_cases
            + self.attempt_groups
    }
}

/// Reads the retention period out of a platform-setting value.
///
/// The OD-4 setting carries the period in years (`kybYears`), but a deployment may also state the
/// period in days (`retentionDays`). A value that is not a positive whole number is ignored, so the
/// default applies.
#[must_use]
pub fn retention_days_from_setting(value: &Value) -> Option<i64> {
    let record = value.as_object()?;
    if let Some(days) = positive_integer(record.get("retentionDays")) {
        return Some(days);
    }
    let years = positive_integer(record.get("kybYears"))
        .or_else(|| positive_integer(record.get("retentionYears")))
        .or_else(|| positive_integer(record.get("years")))?;
    years.checked_mul(DAYS_PER_YEAR)
}

fn positive_integer(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(integer) = value.as_i64() {
        return (integer > 0).then_some(integer);
    }
    let number = value.as_f64()?;
    if !number.is_finite() || number <= 0.0 || number.fract() != 0.0 {
        return None;
    }
    // JavaScript safe-integer ceiling, so a crazy setting cannot overflow the cast.
    if number > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(number as i64)
}

/// The configuration of the worker (`RetentionWorkerDeps`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetentionConfig {
    pub interval_ms: u64,
    pub batch_size: i64,
    /// The retention period in days; `None` reads OD-4 and falls back to five years.
    pub retention_days: Option<i64>,
    /// Report only: delete nothing.
    pub dry_run: bool,
    /// The per-table batch bound of one tick (TS `MAX_BATCHES_PER_TABLE`).
    pub max_batches_per_table: u32,
}

impl Default for RetentionConfig {
    fn default() -> Self {
        Self {
            interval_ms: 60 * 60 * 1_000,
            batch_size: 500,
            retention_days: None,
            dry_run: false,
            max_batches_per_table: MAX_BATCHES_PER_TABLE,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StandaloneTable {
    Notifications,
    InboundEvents,
    AttemptStepLogs,
    AuditLog,
    DetailChangeLogs,
}

impl StandaloneTable {
    const ALL: [Self; 5] = [
        Self::Notifications,
        Self::InboundEvents,
        Self::AttemptStepLogs,
        Self::AuditLog,
        Self::DetailChangeLogs,
    ];

    fn table(self) -> &'static str {
        match self {
            Self::Notifications => "notifications",
            Self::InboundEvents => "inbound_events",
            Self::AttemptStepLogs => "attempt_step_logs",
            Self::AuditLog => "audit_log",
            Self::DetailChangeLogs => "detail_change_logs",
        }
    }

    fn predicate(self) -> &'static str {
        match self {
            Self::Notifications | Self::AuditLog | Self::DetailChangeLogs => "created_at < $1",
            Self::InboundEvents => "received_at < $1",
            Self::AttemptStepLogs => {
                "created_at < $1 AND attempt_id IN (SELECT id FROM payment_attempts WHERE created_at < $2)"
            }
        }
    }

    fn order_by(self) -> &'static str {
        match self {
            Self::InboundEvents => "received_at ASC",
            _ => "created_at ASC",
        }
    }

    fn second_param(self) -> bool {
        matches!(self, Self::AttemptStepLogs)
    }
}

#[derive(Debug, Clone)]
struct AttemptCandidate {
    id: Uuid,
    ledger_entry_id: Option<Uuid>,
    attempt_group_id: Uuid,
}

/// OD-4: the only place where the platform's evidence is removed.
pub struct RetentionWorker {
    pool: PgPool,
    config: RetentionConfig,
}

impl RetentionWorker {
    pub fn new(pool: PgPool, config: RetentionConfig) -> Self {
        Self { pool, config }
    }

    pub async fn tick_once(&self) -> Result<RetentionSummary, WorkerError> {
        if self.config.batch_size < 1 {
            return Err(RemainingWorkerError::Config(
                "RetentionWorker: batchSize must be positive".to_owned(),
            )
            .into());
        }
        if let Some(days) = self.config.retention_days {
            if days < 1 {
                return Err(RemainingWorkerError::Config(format!(
                    "RetentionWorker: retentionDays must be positive (got {days})"
                ))
                .into());
            }
        }
        let now = tick_now();
        let retention_days = self.resolve_retention_days().await?;
        let cutoff = now - chrono::Duration::days(retention_days);
        let mut summary = RetentionSummary::default();
        for table in StandaloneTable::ALL {
            self.purge_table(table, cutoff, &mut summary).await?;
        }
        self.purge_attempts(cutoff, &mut summary).await?;
        info!(
            dry_run = self.config.dry_run,
            retention_days,
            cutoff = %cutoff
                .and_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            purged = ?summary,
            "retention worker: the retention pass is over"
        );
        Ok(summary)
    }

    /// The period of the pass: explicit configuration, then the platform setting, then five years.
    async fn resolve_retention_days(&self) -> Result<i64, WorkerError> {
        if let Some(days) = self.config.retention_days {
            return Ok(days);
        }
        let value: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
            "SELECT value_json FROM platform_settings WHERE key = $1 ORDER BY version DESC LIMIT 1",
        )
        .bind(RETENTION_SETTING_KEY)
        .fetch_optional(&self.pool)
        .await;
        match value {
            Ok(Some(value)) => {
                if let Some(days) = retention_days_from_setting(&value) {
                    info!(
                        key = RETENTION_SETTING_KEY,
                        retention_days = days,
                        "retention worker: the retention period comes from the platform settings"
                    );
                    return Ok(days);
                }
            }
            Ok(None) => {}
            Err(error) => {
                warn!(
                    key = RETENTION_SETTING_KEY,
                    %error,
                    "retention worker: unable to read the retention period, the default is used"
                );
            }
        }
        Ok(DEFAULT_RETENTION_DAYS)
    }

    async fn purge_table(
        &self,
        table: StandaloneTable,
        cutoff: NaiveDateTime,
        summary: &mut RetentionSummary,
    ) -> Result<(), WorkerError> {
        let select_sql = format!(
            "SELECT id FROM {} WHERE {} ORDER BY {} LIMIT ${}",
            table.table(),
            table.predicate(),
            table.order_by(),
            if table.second_param() { 3 } else { 2 }
        );
        let count_sql = format!(
            "SELECT count(*)::bigint FROM {} WHERE {}",
            table.table(),
            table.predicate()
        );
        for _ in 0..self.config.max_batches_per_table.max(1) {
            let mut tx = self.pool.begin().await.map_err(retention_error)?;
            if self.config.dry_run {
                let mut query =
                    sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql.as_str()))
                        .bind(cutoff);
                if table.second_param() {
                    query = query.bind(cutoff);
                }
                let total = query.fetch_one(&mut *tx).await.map_err(retention_error)?;
                tx.commit().await.map_err(retention_error)?;
                add_count(summary, table, u64::try_from(total.max(0)).unwrap_or(0));
                return Ok(());
            }
            let mut query = sqlx::query_scalar::<_, Uuid>(sqlx::AssertSqlSafe(select_sql.as_str()))
                .bind(cutoff);
            if table.second_param() {
                query = query.bind(cutoff);
            }
            let ids = query
                .bind(self.config.batch_size)
                .fetch_all(&mut *tx)
                .await
                .map_err(retention_error)?;
            if ids.is_empty() {
                tx.commit().await.map_err(retention_error)?;
                return Ok(());
            }
            if table == StandaloneTable::AuditLog {
                // `audit_log` is append-only (GAP-013). The retention purge is the one sanctioned
                // DELETE: the trigger accepts it only inside a transaction that declares it
                // (transaction-local, never session).
                sqlx::query("SELECT set_config('pgw.audit_retention', 'on', true)")
                    .execute(&mut *tx)
                    .await
                    .map_err(retention_error)?;
            }
            let deleted = sqlx::query(sqlx::AssertSqlSafe(format!(
                "DELETE FROM {} WHERE id = ANY($1::uuid[])",
                table.table()
            )))
            .bind(&ids)
            .execute(&mut *tx)
            .await
            .map_err(retention_error)?
            .rows_affected();
            tx.commit().await.map_err(retention_error)?;
            add_count(summary, table, deleted);
            if deleted > 0 {
                info!(
                    table = table.table(),
                    rows = deleted,
                    dry_run = self.config.dry_run,
                    "retention worker: purged the expired rows"
                );
            }
            if deleted < u64::try_from(self.config.batch_size).unwrap_or(1) {
                return Ok(());
            }
        }
        warn!(
            table = table.table(),
            "retention worker: the batch bound of the tick is reached"
        );
        Ok(())
    }

    /// Purges the terminal attempts that passed the retention period.
    ///
    /// The journal entries and their lines are NEVER removed here. An attempt only goes when its
    /// ledger entry is retained (or when it never had one), so the ledger evidence of the money and
    /// the GL balances stay intact. The dependent rows are removed first, in the order the foreign
    /// keys demand.
    ///
    /// Deviation from TypeScript: `dispute_attachments` (added after the TS worker, ON DELETE
    /// RESTRICT) is removed before its disputes, otherwise the delete would be refused. The
    /// dependent deletes are also not chunked a second time inside a batch; each batch is already
    /// bounded by `batch_size` attempts.
    async fn purge_attempts(
        &self,
        cutoff: NaiveDateTime,
        summary: &mut RetentionSummary,
    ) -> Result<(), WorkerError> {
        for _ in 0..self.config.max_batches_per_table.max(1) {
            let mut tx = self.pool.begin().await.map_err(retention_error)?;
            let candidates = lock_expired_attempts(&mut tx, cutoff, self.config.batch_size).await?;
            if candidates.is_empty() {
                tx.commit().await.map_err(retention_error)?;
                return Ok(());
            }
            let selected = candidates.len();
            let retained = retained_journal_entries(&mut tx, &candidates).await?;
            let attempts: Vec<AttemptCandidate> = candidates
                .into_iter()
                .filter(|candidate| {
                    candidate
                        .ledger_entry_id
                        .is_none_or(|entry| retained.contains(&entry))
                })
                .collect();
            if attempts.is_empty() {
                tx.commit().await.map_err(retention_error)?;
                warn!(
                    selected,
                    "retention worker: an expired attempt waits for its journal entry"
                );
                return Ok(());
            }
            let attempt_ids: Vec<Uuid> = attempts.iter().map(|attempt| attempt.id).collect();
            let mut entry_ids: Vec<Uuid> = attempts
                .iter()
                .filter_map(|attempt| attempt.ledger_entry_id)
                .collect();
            entry_ids.sort_unstable();
            entry_ids.dedup();
            let dispute_ids = select_ids(
                &mut tx,
                "SELECT id FROM disputes WHERE attempt_id = ANY($1::uuid[])",
                &attempt_ids,
            )
            .await?;
            let purged = if self.config.dry_run {
                let adjustment_ids =
                    count_adjustments(&mut tx, &attempt_ids, &dispute_ids, &entry_ids).await?;
                summary.adjustments += adjustment_ids;
                summary.disputes += u64::try_from(dispute_ids.len()).unwrap_or(0);
                summary.operator_cases += count_rows(
                    &mut tx,
                    "SELECT count(*)::bigint FROM operator_cases WHERE attempt_id = ANY($1::uuid[])",
                    &attempt_ids,
                )
                .await?;
                summary.inbound_events += count_rows(
                    &mut tx,
                    "SELECT count(*)::bigint FROM inbound_events WHERE attempt_id = ANY($1::uuid[])",
                    &attempt_ids,
                )
                .await?;
                summary.attempt_step_logs += count_rows(
                    &mut tx,
                    "SELECT count(*)::bigint FROM attempt_step_logs WHERE attempt_id = ANY($1::uuid[])",
                    &attempt_ids,
                )
                .await?;
                u64::try_from(attempt_ids.len()).unwrap_or(0)
            } else {
                summary.adjustments +=
                    delete_adjustments(&mut tx, &attempt_ids, &dispute_ids, &entry_ids).await?;
                delete_where_any(&mut tx, "dispute_attachments", "dispute_id", &dispute_ids)
                    .await?;
                summary.disputes +=
                    delete_where_any(&mut tx, "disputes", "id", &dispute_ids).await?;
                summary.operator_cases +=
                    delete_where_any(&mut tx, "operator_cases", "attempt_id", &attempt_ids).await?;
                summary.inbound_events +=
                    delete_where_any(&mut tx, "inbound_events", "attempt_id", &attempt_ids).await?;
                summary.attempt_step_logs +=
                    delete_where_any(&mut tx, "attempt_step_logs", "attempt_id", &attempt_ids)
                        .await?;
                delete_where_any(&mut tx, "payment_attempts", "id", &attempt_ids).await?
            };
            summary.payment_attempts += purged;
            let group_ids: Vec<Uuid> = {
                let mut ids: Vec<Uuid> = attempts
                    .iter()
                    .map(|attempt| attempt.attempt_group_id)
                    .collect();
                ids.sort_unstable();
                ids.dedup();
                ids
            };
            let free_groups =
                free_attempt_groups(&mut tx, cutoff, &group_ids, &attempt_ids).await?;
            if self.config.dry_run {
                summary.attempt_groups += u64::try_from(free_groups.len()).unwrap_or(0);
            } else {
                summary.attempt_groups +=
                    delete_where_any(&mut tx, "attempt_groups", "id", &free_groups).await?;
            }
            tx.commit().await.map_err(retention_error)?;
            if purged > 0 {
                info!(
                    attempts = purged,
                    dry_run = self.config.dry_run,
                    "retention worker: purged the expired attempts"
                );
            }
            if self.config.dry_run {
                // The dry run reports the first batch and deletes nothing.
                return Ok(());
            }
            if purged == 0 {
                // Nothing could be purged: the remaining attempts wait for the ledger entry that
                // protects them, so the pass stops here.
                if selected > 0 {
                    warn!(
                        selected,
                        "retention worker: an expired attempt waits for its journal entry"
                    );
                }
                return Ok(());
            }
            if selected < usize::try_from(self.config.batch_size).unwrap_or(1) {
                return Ok(());
            }
        }
        warn!(
            table = "payment_attempts",
            "retention worker: the batch bound of the tick is reached"
        );
        Ok(())
    }
}

fn add_count(summary: &mut RetentionSummary, table: StandaloneTable, count: u64) {
    match table {
        StandaloneTable::Notifications => summary.notifications += count,
        StandaloneTable::InboundEvents => summary.inbound_events += count,
        StandaloneTable::AttemptStepLogs => summary.attempt_step_logs += count,
        StandaloneTable::AuditLog => summary.audit_log += count,
        StandaloneTable::DetailChangeLogs => summary.detail_change_logs += count,
    }
}

async fn lock_expired_attempts(
    conn: &mut PgConnection,
    cutoff: NaiveDateTime,
    limit: i64,
) -> Result<Vec<AttemptCandidate>, WorkerError> {
    let rows = sqlx::query(
        "SELECT id, ledger_entry_id, attempt_group_id FROM payment_attempts
          WHERE terminal_at IS NOT NULL AND created_at < $1
          ORDER BY created_at ASC LIMIT $2",
    )
    .bind(cutoff)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await
    .map_err(retention_error)?;
    let mut candidates = Vec::with_capacity(rows.len());
    for row in &rows {
        candidates.push(AttemptCandidate {
            id: row.try_get("id").map_err(retention_error)?,
            ledger_entry_id: row.try_get("ledger_entry_id").map_err(retention_error)?,
            attempt_group_id: row.try_get("attempt_group_id").map_err(retention_error)?,
        });
    }
    Ok(candidates)
}

async fn retained_journal_entries(
    conn: &mut PgConnection,
    candidates: &[AttemptCandidate],
) -> Result<HashSet<Uuid>, WorkerError> {
    let mut entry_ids: Vec<Uuid> = candidates
        .iter()
        .filter_map(|candidate| candidate.ledger_entry_id)
        .collect();
    entry_ids.sort_unstable();
    entry_ids.dedup();
    if entry_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let existing = select_ids(
        conn,
        "SELECT id FROM journal_entries WHERE id = ANY($1::uuid[])",
        &entry_ids,
    )
    .await?;
    Ok(existing.into_iter().collect())
}

async fn select_ids(
    conn: &mut PgConnection,
    sql: &'static str,
    ids: &[Uuid],
) -> Result<Vec<Uuid>, WorkerError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(retention_error)?;
    Ok(rows)
}

async fn count_rows(
    conn: &mut PgConnection,
    sql: &'static str,
    ids: &[Uuid],
) -> Result<u64, WorkerError> {
    if ids.is_empty() {
        return Ok(0);
    }
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(ids)
        .fetch_one(&mut *conn)
        .await
        .map_err(retention_error)?;
    Ok(u64::try_from(total.max(0)).unwrap_or(0))
}

async fn count_adjustments(
    conn: &mut PgConnection,
    attempt_ids: &[Uuid],
    dispute_ids: &[Uuid],
    entry_ids: &[Uuid],
) -> Result<u64, WorkerError> {
    if attempt_ids.is_empty() && dispute_ids.is_empty() && entry_ids.is_empty() {
        return Ok(0);
    }
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM adjustments
          WHERE source_attempt_id = ANY($1::uuid[])
             OR dispute_id = ANY($2::uuid[])
             OR journal_entry_id = ANY($3::uuid[])",
    )
    .bind(attempt_ids)
    .bind(dispute_ids)
    .bind(entry_ids)
    .fetch_one(&mut *conn)
    .await
    .map_err(retention_error)?;
    Ok(u64::try_from(total.max(0)).unwrap_or(0))
}

async fn delete_adjustments(
    conn: &mut PgConnection,
    attempt_ids: &[Uuid],
    dispute_ids: &[Uuid],
    entry_ids: &[Uuid],
) -> Result<u64, WorkerError> {
    if attempt_ids.is_empty() && dispute_ids.is_empty() && entry_ids.is_empty() {
        return Ok(0);
    }
    let deleted = sqlx::query(
        "DELETE FROM adjustments
          WHERE source_attempt_id = ANY($1::uuid[])
             OR dispute_id = ANY($2::uuid[])
             OR journal_entry_id = ANY($3::uuid[])",
    )
    .bind(attempt_ids)
    .bind(dispute_ids)
    .bind(entry_ids)
    .execute(&mut *conn)
    .await
    .map_err(retention_error)?
    .rows_affected();
    Ok(deleted)
}

async fn delete_where_any(
    conn: &mut PgConnection,
    table: &'static str,
    column: &'static str,
    ids: &[Uuid],
) -> Result<u64, WorkerError> {
    if ids.is_empty() {
        return Ok(0);
    }
    let sql = format!("DELETE FROM {table} WHERE {column} = ANY($1::uuid[])");
    let deleted = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(ids)
        .execute(&mut *conn)
        .await
        .map_err(retention_error)?
        .rows_affected();
    Ok(deleted)
}

/// The attempt groups that no remaining attempt references any more.
async fn free_attempt_groups(
    conn: &mut PgConnection,
    cutoff: NaiveDateTime,
    group_ids: &[Uuid],
    purged_attempt_ids: &[Uuid],
) -> Result<Vec<Uuid>, WorkerError> {
    if group_ids.is_empty() {
        return Ok(Vec::new());
    }
    let referenced: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT attempt_group_id FROM payment_attempts
          WHERE attempt_group_id = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))",
    )
    .bind(group_ids)
    .bind(purged_attempt_ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(retention_error)?;
    let still_used: HashSet<Uuid> = referenced.into_iter().collect();
    let groups: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM attempt_groups WHERE id = ANY($1::uuid[]) AND created_at < $2 ORDER BY id",
    )
    .bind(group_ids)
    .bind(cutoff)
    .fetch_all(&mut *conn)
    .await
    .map_err(retention_error)?;
    Ok(groups
        .into_iter()
        .filter(|group| !still_used.contains(group))
        .collect())
}

#[async_trait]
impl Worker for RetentionWorker {
    fn name(&self) -> &'static str {
        "RetentionWorker"
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
        let summary = self.tick_once().await?;
        if summary.total() == 0 {
            Ok(WorkerOutcome::Skipped)
        } else {
            Ok(WorkerOutcome::Processed(summary.total()))
        }
    }
}

fn retention_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("retention: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retention_days_are_read_from_days_or_years() {
        assert_eq!(
            retention_days_from_setting(&json!({ "retentionDays": 30 })),
            Some(30)
        );
        assert_eq!(
            retention_days_from_setting(&json!({ "kybYears": 5 })),
            Some(5 * DAYS_PER_YEAR)
        );
        assert_eq!(
            retention_days_from_setting(&json!({ "retentionYears": 7 })),
            Some(7 * DAYS_PER_YEAR)
        );
        assert_eq!(
            retention_days_from_setting(&json!({ "years": 2.0 })),
            Some(2 * DAYS_PER_YEAR)
        );
        // Malformed values fall back to the default.
        assert_eq!(retention_days_from_setting(&json!([])), None);
        assert_eq!(retention_days_from_setting(&json!({ "kybYears": 0 })), None);
        assert_eq!(
            retention_days_from_setting(&json!({ "kybYears": 1.5 })),
            None
        );
        assert_eq!(
            retention_days_from_setting(&json!({ "kybYears": "5" })),
            None
        );
    }

    #[test]
    fn the_default_period_is_five_years() {
        assert_eq!(DEFAULT_RETENTION_DAYS, 1_825);
        let config = RetentionConfig::default();
        assert!(!config.dry_run);
        assert_eq!(config.batch_size, 500);
        assert!(config.retention_days.is_none());
    }

    #[test]
    fn every_standalone_predicate_has_a_cutoff() {
        for table in StandaloneTable::ALL {
            assert!(
                table.predicate().contains("< $1"),
                "{} must be bounded by a cutoff",
                table.table()
            );
        }
        assert_eq!(
            StandaloneTable::AttemptStepLogs.table(),
            "attempt_step_logs"
        );
    }
}
