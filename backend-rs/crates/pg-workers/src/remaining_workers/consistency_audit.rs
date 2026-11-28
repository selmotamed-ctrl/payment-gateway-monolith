//! Slot counter self-healing (AUTO-12), `engine/workers/ConsistencyAuditWorker.ts`.
//!
//! `payment_links.active_locked_count` should equal the number of live (non-terminal) attempts of
//! the link. It can drift when a crash leaves a reservation behind or a release path was missed; a
//! drifted counter makes a link unusable (`confirmed + active >= use_count`) or over-sells it. The
//! worker compares the counter with the attempts for finite-use links that have not changed for
//! `settle_ms`, opens ONE keyed case per drifted link (`link.slot_drift:<id>`, P3, with both
//! numbers), and, only when `repair` is on, corrects the counter under the row lock (re-checking the
//! live count inside the lock) and audits it. The daily cap counters against the read models are not
//! audited here.

#![forbid(unsafe_code)]

use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDateTime;
use serde_json::json;
use sqlx::{PgPool, Row};
use tracing::warn;
use uuid::Uuid;

use crate::cases::tick_now;
use crate::cases::{
    raise_keyed_case, write_system_audit, CaseKind, KeyedCaseInput, MonitorPriority, SystemAudit,
};
use crate::remaining_workers::RemainingWorkerError;
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

/// Attempt statuses that hold a payment-link slot: every non-terminal one.
pub const SLOT_HOLDING_STATUSES: [&str; 6] = [
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
    "UNKNOWN",
];

/// The configuration of the worker (`ConsistencyAuditWorkerDeps`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsistencyAuditConfig {
    pub interval_ms: u64,
    pub batch_size: i64,
    /// Repair the drifted counters. Default false: report only.
    pub repair: bool,
    /// A link changed more recently than this is skipped (an in-flight reservation looks like drift).
    pub settle_ms: i64,
    pub case_sla_hours: i64,
    /// Restricts the audit to these links (production leaves it unset).
    pub link_ids: Option<Vec<Uuid>>,
}

impl Default for ConsistencyAuditConfig {
    fn default() -> Self {
        Self {
            interval_ms: 60 * 60 * 1_000,
            batch_size: 200,
            repair: false,
            settle_ms: 15 * 60 * 1_000,
            case_sla_hours: 72,
            link_ids: None,
        }
    }
}

/// What one tick did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConsistencyAuditSummary {
    pub drifted: u64,
    pub repaired: u64,
}

/// AUTO-12: compares the slot counters with the live attempts.
pub struct ConsistencyAuditWorker {
    pool: PgPool,
    config: ConsistencyAuditConfig,
}

impl ConsistencyAuditWorker {
    pub fn new(pool: PgPool, config: ConsistencyAuditConfig) -> Self {
        Self { pool, config }
    }

    pub async fn tick_once(&self) -> Result<ConsistencyAuditSummary, WorkerError> {
        if self.config.batch_size < 1 || self.config.settle_ms < 0 {
            return Err(RemainingWorkerError::Config(
                "ConsistencyAuditWorker: batchSize must be positive and settleMs must not be negative"
                    .to_owned(),
            )
            .into());
        }
        let now = tick_now();
        let settled = now - chrono::Duration::milliseconds(self.config.settle_ms);
        let scoped = self
            .config
            .link_ids
            .as_ref()
            .is_some_and(|ids| !ids.is_empty());
        let sql = if scoped {
            "SELECT l.id, l.key, l.active_locked_count::bigint AS recorded,
                    coalesce(a.n, 0)::bigint AS live
               FROM payment_links l
               LEFT JOIN (SELECT link_id, count(*) AS n FROM payment_attempts
                           WHERE status::text = ANY($1::text[]) GROUP BY link_id) a
                 ON a.link_id = l.id
              WHERE l.infinite_use = false AND l.updated_at < $2
                AND l.active_locked_count <> coalesce(a.n, 0)
                AND l.id = ANY($4::uuid[])
              ORDER BY l.updated_at ASC LIMIT $3"
        } else {
            "SELECT l.id, l.key, l.active_locked_count::bigint AS recorded,
                    coalesce(a.n, 0)::bigint AS live
               FROM payment_links l
               LEFT JOIN (SELECT link_id, count(*) AS n FROM payment_attempts
                           WHERE status::text = ANY($1::text[]) GROUP BY link_id) a
                 ON a.link_id = l.id
              WHERE l.infinite_use = false AND l.updated_at < $2
                AND l.active_locked_count <> coalesce(a.n, 0)
              ORDER BY l.updated_at ASC LIMIT $3"
        };
        let statuses: Vec<String> = SLOT_HOLDING_STATUSES
            .iter()
            .map(|status| (*status).to_owned())
            .collect();
        let mut query = sqlx::query(sql)
            .bind(&statuses)
            .bind(settled)
            .bind(self.config.batch_size);
        if let Some(ids) = self.config.link_ids.as_ref().filter(|ids| !ids.is_empty()) {
            query = query.bind(ids.clone());
        }
        let rows = query.fetch_all(&self.pool).await.map_err(audit_error)?;
        let mut summary = ConsistencyAuditSummary::default();
        for row in &rows {
            let id: Uuid = row.try_get("id").map_err(audit_error)?;
            let key: String = row.try_get("key").map_err(audit_error)?;
            let recorded: i64 = row.try_get("recorded").map_err(audit_error)?;
            let live: i64 = row.try_get("live").map_err(audit_error)?;
            summary.drifted += 1;
            let message = format!(
                "Payment link {key} ({id}) records {recorded} locked slot(s) but has {live} live attempt(s)."
            );
            if self.config.repair {
                summary.repaired += self.repair(id, &message, now).await?;
                continue;
            }
            let notes = format!(
                "{message} Slot repair is switched off; correct it by hand or enable the repair flag."
            );
            let subject_key = format!("link.slot_drift:{id}");
            let mut tx = self.pool.begin().await.map_err(audit_error)?;
            let result = raise_keyed_case(
                &mut tx,
                &KeyedCaseInput {
                    kind: CaseKind::Mismatch,
                    priority: MonitorPriority::P3,
                    subject_key: &subject_key,
                    attempt_id: None,
                    reconciliation_item_id: None,
                    notes: &notes,
                    sla_hours: self.config.case_sla_hours.max(1),
                    now,
                    dedupe_on_attempt: false,
                    title: None,
                },
            )
            .await?;
            tx.commit().await.map_err(audit_error)?;
            if result.created {
                warn!(
                    link_id = %id,
                    recorded,
                    live,
                    "consistency audit worker: slot drift"
                );
            }
        }
        Ok(summary)
    }

    async fn repair(
        &self,
        link_id: Uuid,
        message: &str,
        now: NaiveDateTime,
    ) -> Result<u64, WorkerError> {
        let statuses: Vec<String> = SLOT_HOLDING_STATUSES
            .iter()
            .map(|status| (*status).to_owned())
            .collect();
        let mut tx = self.pool.begin().await.map_err(audit_error)?;
        let locked = sqlx::query(
            "SELECT active_locked_count::bigint AS recorded FROM payment_links
              WHERE id = $1 AND infinite_use = false FOR UPDATE",
        )
        .bind(link_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(audit_error)?;
        let Some(locked) = locked else {
            tx.commit().await.map_err(audit_error)?;
            return Ok(0);
        };
        let recorded: i64 = locked.try_get("recorded").map_err(audit_error)?;
        let live: i64 = sqlx::query_scalar(
            "SELECT count(*)::bigint FROM payment_attempts
              WHERE link_id = $1 AND status::text = ANY($2::text[])",
        )
        .bind(link_id)
        .bind(&statuses)
        .fetch_one(&mut *tx)
        .await
        .map_err(audit_error)?;
        if recorded == live {
            // Healed or still in flight.
            tx.commit().await.map_err(audit_error)?;
            return Ok(0);
        }
        sqlx::query(
            "UPDATE payment_links SET active_locked_count = $2, updated_at = $3 WHERE id = $1",
        )
        .bind(link_id)
        .bind(i32::try_from(live).unwrap_or(i32::MAX))
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(audit_error)?;
        write_system_audit(
            &mut tx,
            &SystemAudit::new(
                "PAYMENT_LINK_SLOTS_REPAIRED",
                "PAYMENT_LINK",
                &link_id.to_string(),
                json!({ "activeLockedCount": recorded }),
                json!({ "activeLockedCount": live, "note": message }),
            ),
        )
        .await?;
        tx.commit().await.map_err(audit_error)?;
        Ok(1)
    }
}

#[async_trait]
impl Worker for ConsistencyAuditWorker {
    fn name(&self) -> &'static str {
        "ConsistencyAuditWorker"
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
        if summary.drifted == 0 {
            Ok(WorkerOutcome::Skipped)
        } else {
            Ok(WorkerOutcome::Processed(summary.drifted))
        }
    }
}

fn audit_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("consistency audit: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_holding_statuses_are_the_non_terminal_ones() {
        assert!(SLOT_HOLDING_STATUSES.contains(&"UNKNOWN"));
        assert!(!SLOT_HOLDING_STATUSES.contains(&"SUCCEEDED"));
        assert!(!SLOT_HOLDING_STATUSES.contains(&"FAILED"));
    }

    #[test]
    fn the_default_is_report_only() {
        let config = ConsistencyAuditConfig::default();
        assert!(!config.repair);
        assert_eq!(config.settle_ms, 900_000);
        assert_eq!(config.case_sla_hours, 72);
    }
}
