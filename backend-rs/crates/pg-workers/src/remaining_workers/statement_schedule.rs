//! Statement schedules and missing-statement alerts (AUTO-07),
//! `engine/workers/StatementScheduleWorker.ts` with `lib/cron.ts`.
//!
//! `statement_sources.schedule_cron` was stored and editable but nothing read it. For every source
//! with a cron, in `Africa/Tripoli` time, the worker takes the last `lookback_slots` scheduled
//! times that are more than `grace_minutes` old. A slot is SATISFIED when a reconciliation run of
//! that source was created at or after the slot and before the next slot (plus its grace): the
//! statement arrived for that period. An unsatisfied slot opens ONE keyed case
//! `statement.missing:<source>:<slot>` (one case per missed slot, so a daily source that misses
//! three days has three cases); when the statement arrives later the open case is resolved with a
//! note. A source created after a slot never owes that slot. An invalid cron expression is reported
//! once as its own keyed case and skipped.
//!
//! Not built (same as TypeScript): pulling the statement from the provider (`STATEMENT_FETCH`) and
//! the settlement sweep AUTO-15 would schedule after a successful run.

#![forbid(unsafe_code)]

use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDateTime, Utc};
use parking_lot::Mutex;
use serde_json::json;
use sqlx::{PgPool, Row};
use tracing::info;
use uuid::Uuid;

use crate::cases::tick_now;
use crate::cases::{
    clear_keyed_case, raise_keyed_case, write_system_audit_pool, CaseKind, KeyedCaseInput,
    MonitorPriority, SystemAudit,
};
use crate::cron::{last_scheduled_at_or_before, parse_cron, DEFAULT_TIME_ZONE};
use crate::remaining_workers::{sanitize_error_message, RemainingWorkerError};
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

/// The grace period of the TypeScript default (`STATEMENT_SCHEDULE_GRACE_MINUTES`).
pub const DEFAULT_GRACE_MINUTES: i64 = 120;

/// `statementMissingSubjectKey`.
#[must_use]
pub fn statement_missing_subject_key(source_id: &str, slot: DateTime<Utc>) -> String {
    format!(
        "statement.missing:{source_id}:{}",
        slot.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    )
}

/// The configuration of the worker (`StatementScheduleWorkerDeps`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementScheduleConfig {
    pub interval_ms: u64,
    pub batch_size: i64,
    /// Minutes after a scheduled time before a missing statement is reported.
    pub grace_minutes: i64,
    /// Scheduled slots looked at per source, newest first (older ones are ignored).
    pub lookback_slots: u32,
    pub time_zone: String,
    pub case_sla_hours: i64,
    /// Restricts the worker to these sources (production leaves it unset).
    pub source_ids: Option<Vec<Uuid>>,
}

impl Default for StatementScheduleConfig {
    fn default() -> Self {
        Self {
            interval_ms: 5 * 60 * 1_000,
            batch_size: 50,
            grace_minutes: DEFAULT_GRACE_MINUTES,
            lookback_slots: 7,
            time_zone: DEFAULT_TIME_ZONE.to_owned(),
            case_sla_hours: 24,
            source_ids: None,
        }
    }
}

/// What one tick did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatementScheduleSummary {
    pub opened: u64,
    pub resolved: u64,
    pub errors: Vec<String>,
}

/// AUTO-07: raises a keyed case for every scheduled statement that did not arrive.
pub struct StatementScheduleWorker {
    pool: PgPool,
    config: StatementScheduleConfig,
    last_summary: Mutex<Option<StatementScheduleSummary>>,
}

#[derive(Debug, Clone)]
struct SourceRow {
    id: Uuid,
    schedule_cron: String,
    created_at: NaiveDateTime,
    gateway_name: Option<String>,
}

impl StatementScheduleWorker {
    pub fn new(pool: PgPool, config: StatementScheduleConfig) -> Self {
        Self {
            pool,
            config,
            last_summary: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn last_summary(&self) -> Option<StatementScheduleSummary> {
        self.last_summary.lock().clone()
    }

    pub async fn tick_once(&self) -> Result<StatementScheduleSummary, WorkerError> {
        if self.config.batch_size < 1 || self.config.lookback_slots < 1 {
            return Err(RemainingWorkerError::Config(
                "StatementScheduleWorker: batchSize and lookbackSlots must be positive".to_owned(),
            )
            .into());
        }
        let now = tick_now().and_utc();
        let grace = chrono::Duration::minutes(self.config.grace_minutes.max(0));
        let lookback = self.config.lookback_slots.max(1);
        let sources = self.load_sources().await?;
        let mut summary = StatementScheduleSummary::default();
        for source in &sources {
            match self.check_source(source, now, grace, lookback).await {
                Ok((opened, resolved)) => {
                    summary.opened += opened;
                    summary.resolved += resolved;
                }
                Err(error) => {
                    summary.errors.push(format!(
                        "{}: {}",
                        source.id,
                        sanitize_error_message(&error.to_string())
                    ));
                }
            }
        }
        *self.last_summary.lock() = Some(summary.clone());
        if summary.opened + summary.resolved > 0 {
            info!(
                opened = summary.opened,
                resolved = summary.resolved,
                "statement schedule worker: statement alerts"
            );
        }
        if let Some(first) = summary.errors.first() {
            return Err(WorkerError::Failed(format!(
                "statement schedule failed for {} source(s) ({first})",
                summary.errors.len()
            )));
        }
        Ok(summary)
    }

    async fn load_sources(&self) -> Result<Vec<SourceRow>, WorkerError> {
        let scoped = self
            .config
            .source_ids
            .as_ref()
            .is_some_and(|ids| !ids.is_empty());
        let sql = if scoped {
            "SELECT s.id, s.schedule_cron, s.created_at, g.name AS gateway_name
               FROM statement_sources s LEFT JOIN gateways g ON g.id = s.gateway_id
              WHERE s.schedule_cron IS NOT NULL AND btrim(s.schedule_cron) <> ''
                AND s.id = ANY($2::uuid[])
              ORDER BY s.created_at ASC, s.id ASC LIMIT $1"
        } else {
            "SELECT s.id, s.schedule_cron, s.created_at, g.name AS gateway_name
               FROM statement_sources s LEFT JOIN gateways g ON g.id = s.gateway_id
              WHERE s.schedule_cron IS NOT NULL AND btrim(s.schedule_cron) <> ''
              ORDER BY s.created_at ASC, s.id ASC LIMIT $1"
        };
        let mut query = sqlx::query(sql).bind(self.config.batch_size);
        if let Some(ids) = self
            .config
            .source_ids
            .as_ref()
            .filter(|ids| !ids.is_empty())
        {
            query = query.bind(ids.clone());
        }
        let rows = query.fetch_all(&self.pool).await.map_err(schedule_error)?;
        Ok(rows
            .iter()
            .map(|row| SourceRow {
                id: row.get("id"),
                schedule_cron: row.get("schedule_cron"),
                created_at: row.get("created_at"),
                gateway_name: row.get("gateway_name"),
            })
            .collect())
    }

    async fn check_source(
        &self,
        source: &SourceRow,
        now: DateTime<Utc>,
        grace: chrono::Duration,
        lookback: u32,
    ) -> Result<(u64, u64), WorkerError> {
        let cron = match parse_cron(&source.schedule_cron) {
            Ok(cron) => cron,
            Err(error) => {
                let subject_key = format!("statement.schedule_invalid:{}", source.id);
                self.raise_case(
                    &subject_key,
                    &format!(
                        "The statement schedule \"{}\" of source {} is not a valid cron expression ({}); \
                         no missing-statement alert can run for it.",
                        source.schedule_cron, source.id, error
                    ),
                    MonitorPriority::P3,
                    72,
                    now,
                )
                .await?;
                return Ok((0, 0));
            }
        };
        // Newest slot that is already past its grace, then the earlier ones.
        let mut slots: Vec<DateTime<Utc>> = Vec::new();
        let mut cursor =
            last_scheduled_at_or_before(&cron, now - grace, &self.config.time_zone, None)?;
        while let Some(slot) = cursor {
            if slots.len() >= usize::try_from(lookback).unwrap_or(1) {
                break;
            }
            slots.push(slot);
            cursor = last_scheduled_at_or_before(
                &cron,
                slot - chrono::Duration::minutes(1),
                &self.config.time_zone,
                None,
            )?;
        }
        if slots.is_empty() {
            return Ok((0, 0));
        }
        let Some(oldest) = slots.last().copied() else {
            return Ok((0, 0));
        };
        let runs = sqlx::query(
            "SELECT created_at FROM reconciliation_runs
              WHERE statement_source_id = $1 AND created_at >= $2
              ORDER BY created_at ASC LIMIT 500",
        )
        .bind(source.id)
        .bind(oldest.naive_utc())
        .fetch_all(&self.pool)
        .await
        .map_err(schedule_error)?;
        let arrivals: Vec<i64> = runs
            .iter()
            .map(|row| {
                row.get::<NaiveDateTime, _>("created_at")
                    .and_utc()
                    .timestamp_millis()
            })
            .collect();
        let source_created = source.created_at.and_utc();
        let grace_ms = grace.num_milliseconds();
        let mut opened = 0_u64;
        let mut resolved = 0_u64;
        for (index, slot) in slots.iter().enumerate() {
            if source_created > *slot {
                // The source did not exist yet.
                continue;
            }
            let upper = match index
                .checked_sub(1)
                .and_then(|previous| slots.get(previous))
            {
                Some(next) => next.timestamp_millis() + grace_ms,
                None => i64::MAX,
            };
            let slot_ms = slot.timestamp_millis();
            let satisfied = arrivals
                .iter()
                .any(|arrived| *arrived >= slot_ms && *arrived < upper);
            let key = statement_missing_subject_key(&source.id.to_string(), *slot);
            if satisfied {
                if self.clear_case(&key, now).await? {
                    resolved += 1;
                }
                continue;
            }
            let gateway = source
                .gateway_name
                .as_deref()
                .map(|name| format!(" ({name})"))
                .unwrap_or_default();
            let notes = format!(
                "No statement arrived for source {}{} for the schedule of {} (cron \"{}\", {} min grace). \
                 Upload the statement or ask the provider; the case resolves itself when it arrives.",
                source.id,
                gateway,
                slot.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                source.schedule_cron,
                grace_ms / 60_000
            );
            let created = self
                .raise_case(
                    &key,
                    &notes,
                    MonitorPriority::P2,
                    self.config.case_sla_hours.max(1),
                    now,
                )
                .await?;
            if created {
                opened += 1;
                write_system_audit_pool(
                    &self.pool,
                    &SystemAudit::new(
                        "STATEMENT_MISSING",
                        "STATEMENT_SOURCE",
                        &source.id.to_string(),
                        json!({}),
                        json!({
                            "slot": slot.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                            "cron": source.schedule_cron,
                        }),
                    ),
                )
                .await?;
            }
        }
        Ok((opened, resolved))
    }

    async fn raise_case(
        &self,
        subject_key: &str,
        notes: &str,
        priority: MonitorPriority,
        sla_hours: i64,
        now: DateTime<Utc>,
    ) -> Result<bool, WorkerError> {
        let mut tx = self.pool.begin().await.map_err(schedule_error)?;
        let result = raise_keyed_case(
            &mut tx,
            &KeyedCaseInput {
                kind: CaseKind::UnmatchedStatement,
                priority,
                subject_key,
                attempt_id: None,
                reconciliation_item_id: None,
                notes,
                sla_hours,
                now: now.naive_utc(),
                dedupe_on_attempt: false,
                title: None,
            },
        )
        .await?;
        tx.commit().await.map_err(schedule_error)?;
        Ok(result.created)
    }

    async fn clear_case(&self, subject_key: &str, now: DateTime<Utc>) -> Result<bool, WorkerError> {
        let mut tx = self.pool.begin().await.map_err(schedule_error)?;
        let cleared = clear_keyed_case(
            &mut tx,
            CaseKind::UnmatchedStatement,
            subject_key,
            "The statement arrived.",
            now.naive_utc(),
        )
        .await?;
        tx.commit().await.map_err(schedule_error)?;
        Ok(cleared)
    }
}

#[async_trait]
impl Worker for StatementScheduleWorker {
    fn name(&self) -> &'static str {
        "StatementScheduleWorker"
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
        let processed = summary.opened + summary.resolved;
        if processed == 0 {
            Ok(WorkerOutcome::Skipped)
        } else {
            Ok(WorkerOutcome::Processed(processed))
        }
    }
}

fn schedule_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("statement schedule: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_subject_key_uses_the_iso_slot() {
        let slot = DateTime::parse_from_rfc3339("2026-11-28T04:00:00.000Z")
            .expect("instant")
            .with_timezone(&Utc);
        assert_eq!(
            statement_missing_subject_key("source-1", slot),
            "statement.missing:source-1:2026-11-28T04:00:00.000Z"
        );
    }

    #[test]
    fn the_defaults_match_the_typescript_worker() {
        let config = StatementScheduleConfig::default();
        assert_eq!(config.grace_minutes, 120);
        assert_eq!(config.lookback_slots, 7);
        assert_eq!(config.time_zone, DEFAULT_TIME_ZONE);
        assert_eq!(config.case_sla_hours, 24);
        assert!(config.source_ids.is_none());
    }
}
