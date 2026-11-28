//! Join-request expiry (AUTO-13), `engine/workers/JoinRequestExpiryWorker.ts`.
//!
//! Expires the onboarding drafts that were abandoned and the submitted requests whose review SLA
//! elapsed. A `DRAFT` never reaches the review queue, so without this worker it lives forever and
//! the merchant is stuck; a `SUBMITTED`/`IN_REVIEW`/`INFO_REQUESTED` request past `sla_due_at` is
//! expired too.
//!
//! Each batch is ONE `UPDATE … RETURNING` statement inside ONE transaction together with its audit
//! rows and notices: a request is never expired without its audit row, and a crash between them
//! cannot lose the notice (the notification event id is unique per request, so a repeat never sends
//! twice). `PENDING_CHECKER` is never touched: a decision waiting for its checker is not overdue.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDateTime;
use pg_types::generated::enums::NotificationLang;
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool, Row};
use tracing::info;
use uuid::Uuid;

use crate::cases::tick_now;
use crate::cases::{write_system_audit, SystemAudit};
use crate::notices::{
    join_request_draft_expired_notice, join_request_review_expired_notice, queue_notice,
    NoticeAddressCipher, QueueNoticeInput,
};
use crate::remaining_workers::RemainingWorkerError;
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

/// `DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS`: 30 days.
pub const DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

/// `JoinRequestExpiryReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinRequestExpiryReason {
    DraftAbandoned,
    ReviewOverdue,
}

impl JoinRequestExpiryReason {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DraftAbandoned => "DRAFT_ABANDONED",
            Self::ReviewOverdue => "REVIEW_OVERDUE",
        }
    }
}

/// One expired request (`ExpiredJoinRequest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpiredJoinRequest {
    pub id: Uuid,
    pub merchant_id: Uuid,
    pub submitted_by_user_id: Uuid,
    pub previous_status: String,
}

const EXPIRE_DRAFTS_SQL: &str = "WITH target AS (
       SELECT id, status FROM join_requests
        WHERE status = 'DRAFT' AND created_at < $2 AND updated_at < $3
        ORDER BY created_at ASC LIMIT $4 FOR UPDATE SKIP LOCKED
     )
     UPDATE join_requests j SET status = 'EXPIRED', updated_at = $1
       FROM target t WHERE j.id = t.id
     RETURNING j.id, j.merchant_id, j.submitted_by_user_id, t.status::text AS previous_status";

const EXPIRE_REVIEWS_SQL: &str = "WITH target AS (
       SELECT id, status FROM join_requests
        WHERE status IN ('SUBMITTED', 'IN_REVIEW', 'INFO_REQUESTED') AND sla_due_at <= $2
        ORDER BY sla_due_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED
     )
     UPDATE join_requests j SET status = 'EXPIRED', updated_at = $1
       FROM target t WHERE j.id = t.id
     RETURNING j.id, j.merchant_id, j.submitted_by_user_id, t.status::text AS previous_status";

/// The configuration of the worker (`JoinRequestExpiryWorkerDeps`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinRequestExpiryConfig {
    pub interval_ms: u64,
    pub batch_size: i64,
    /// How long an untouched draft may stay open.
    pub draft_ttl_ms: i64,
    /// Batches one tick may process per kind (the next tick continues).
    pub max_batches_per_tick: u32,
}

impl Default for JoinRequestExpiryConfig {
    fn default() -> Self {
        Self {
            interval_ms: 5_000,
            batch_size: 50,
            draft_ttl_ms: DEFAULT_JOIN_REQUEST_DRAFT_TTL_MS,
            max_batches_per_tick: 5,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum ExpireMode {
    Drafts { cutoff: NaiveDateTime },
    Reviews,
}

/// AUTO-13: expires abandoned drafts and overdue reviews with an audit row and a merchant notice.
pub struct JoinRequestExpiryWorker {
    pool: PgPool,
    config: JoinRequestExpiryConfig,
    notice_cipher: Option<Arc<dyn NoticeAddressCipher>>,
}

impl JoinRequestExpiryWorker {
    pub fn new(
        pool: PgPool,
        config: JoinRequestExpiryConfig,
        notice_cipher: Option<Arc<dyn NoticeAddressCipher>>,
    ) -> Self {
        Self {
            pool,
            config,
            notice_cipher,
        }
    }

    pub async fn tick_once(&self) -> Result<u64, WorkerError> {
        if self.config.draft_ttl_ms < 0 {
            return Err(RemainingWorkerError::Config(
                "JoinRequestExpiryWorker: draftTtlMs must not be negative".to_owned(),
            )
            .into());
        }
        if self.config.batch_size < 1 {
            return Err(RemainingWorkerError::Config(
                "JoinRequestExpiryWorker: batchSize must be positive".to_owned(),
            )
            .into());
        }
        let now = tick_now();
        let drafts = self.expire_abandoned_drafts(now).await?;
        let reviews = self.expire_overdue_reviews(now).await?;
        Ok(drafts + reviews)
    }

    async fn expire_abandoned_drafts(&self, now: NaiveDateTime) -> Result<u64, WorkerError> {
        let cutoff = now - chrono::Duration::milliseconds(self.config.draft_ttl_ms);
        let days = ((self.config.draft_ttl_ms as f64 / 86_400_000.0).round() as i64).max(1);
        let extra = json!({ "cutoff": utc_iso(cutoff) });
        let total = self
            .drain(
                now,
                JoinRequestExpiryReason::DraftAbandoned,
                days,
                &extra,
                ExpireMode::Drafts { cutoff },
            )
            .await?;
        if total > 0 {
            info!(
                expired = total,
                cutoff = %utc_iso(cutoff),
                "join request expiry worker: expired abandoned drafts"
            );
        }
        Ok(total)
    }

    async fn expire_overdue_reviews(&self, now: NaiveDateTime) -> Result<u64, WorkerError> {
        let total = self
            .drain(
                now,
                JoinRequestExpiryReason::ReviewOverdue,
                0,
                &Value::Null,
                ExpireMode::Reviews,
            )
            .await?;
        if total > 0 {
            info!(
                expired = total,
                "join request expiry worker: expired overdue reviews"
            );
        }
        Ok(total)
    }

    /// Runs batches (each in its own transaction with its audit rows and notices) until one comes
    /// back short, at most `max_batches_per_tick` times.
    async fn drain(
        &self,
        now: NaiveDateTime,
        reason: JoinRequestExpiryReason,
        days: i64,
        extra: &Value,
        mode: ExpireMode,
    ) -> Result<u64, WorkerError> {
        let limit = self.config.batch_size.max(1);
        let mut total = 0_u64;
        for _ in 0..self.config.max_batches_per_tick.max(1) {
            let mut tx = self.pool.begin().await.map_err(join_error)?;
            let rows = match mode {
                ExpireMode::Drafts { cutoff } => sqlx::query(EXPIRE_DRAFTS_SQL)
                    .bind(now)
                    .bind(cutoff)
                    .bind(cutoff)
                    .bind(limit)
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(join_error)?,
                ExpireMode::Reviews => sqlx::query(EXPIRE_REVIEWS_SQL)
                    .bind(now)
                    .bind(now)
                    .bind(limit)
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(join_error)?,
            };
            let requests = decode_rows(&rows)?;
            for request in &requests {
                let mut after = json!({
                    "status": "EXPIRED",
                    "reason": reason.as_str(),
                });
                if let (Some(after), Some(extra)) = (after.as_object_mut(), extra.as_object()) {
                    for (key, value) in extra {
                        after.insert(key.clone(), value.clone());
                    }
                }
                write_system_audit(
                    &mut tx,
                    &SystemAudit::new(
                        "JOIN_REQUEST_EXPIRED",
                        "JOIN_REQUEST",
                        &request.id.to_string(),
                        json!({ "status": request.previous_status }),
                        after,
                    ),
                )
                .await?;
                self.notify(&mut tx, request, reason, days).await?;
            }
            let expired = u64::try_from(requests.len()).unwrap_or(0);
            tx.commit().await.map_err(join_error)?;
            total += expired;
            if expired < u64::try_from(limit).unwrap_or(1) {
                break;
            }
        }
        Ok(total)
    }

    async fn notify(
        &self,
        conn: &mut PgConnection,
        request: &ExpiredJoinRequest,
        reason: JoinRequestExpiryReason,
        days: i64,
    ) -> Result<(), WorkerError> {
        let definition = match reason {
            JoinRequestExpiryReason::DraftAbandoned => join_request_draft_expired_notice(),
            JoinRequestExpiryReason::ReviewOverdue => join_request_review_expired_notice(),
        };
        let event_key = format!("join-request-expired:{}", request.id);
        queue_notice(
            conn,
            &QueueNoticeInput {
                definition: &definition,
                event_key: &event_key,
                payload: json!({ "days": days }),
                user_id: Some(request.submitted_by_user_id),
                merchant_id: Some(request.merchant_id),
                channels: None,
                lang: NotificationLang::En,
                cipher: self.notice_cipher.as_deref(),
            },
        )
        .await?;
        Ok(())
    }
}

fn decode_rows(rows: &[sqlx::postgres::PgRow]) -> Result<Vec<ExpiredJoinRequest>, WorkerError> {
    let mut requests = Vec::with_capacity(rows.len());
    for row in rows {
        requests.push(ExpiredJoinRequest {
            id: row.try_get("id").map_err(join_error)?,
            merchant_id: row.try_get("merchant_id").map_err(join_error)?,
            submitted_by_user_id: row.try_get("submitted_by_user_id").map_err(join_error)?,
            previous_status: row.try_get("previous_status").map_err(join_error)?,
        });
    }
    Ok(requests)
}

fn utc_iso(value: NaiveDateTime) -> String {
    value
        .and_utc()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[async_trait]
impl Worker for JoinRequestExpiryWorker {
    fn name(&self) -> &'static str {
        "JoinRequestExpiryWorker"
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
        let expired = self.tick_once().await?;
        if expired == 0 {
            Ok(WorkerOutcome::Skipped)
        } else {
            Ok(WorkerOutcome::Processed(expired))
        }
    }
}

fn join_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("join request expiry: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_match_the_typescript_strings() {
        assert_eq!(
            JoinRequestExpiryReason::DraftAbandoned.as_str(),
            "DRAFT_ABANDONED"
        );
        assert_eq!(
            JoinRequestExpiryReason::ReviewOverdue.as_str(),
            "REVIEW_OVERDUE"
        );
    }

    #[test]
    fn the_default_draft_ttl_is_thirty_days() {
        let config = JoinRequestExpiryConfig::default();
        assert_eq!(config.draft_ttl_ms, 30 * 24 * 60 * 60 * 1_000);
        assert_eq!(config.batch_size, 50);
    }
}
