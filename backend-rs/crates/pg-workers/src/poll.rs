//! Gateway status poller (`core-back/engine/workers/PollWorker.ts`).
//!
//! Claims attempts whose `next_check_at` is due inside one transaction (leasing them by pushing
//! `next_check_at` forward before the lock is released), then asks the gateway OUTSIDE the
//! transaction through [`InquiryPort`] and writes the outcome with conditional statements.
//!
//! The backoff arithmetic is the pure [`compute_backoff_delay_seconds`] port of the TS function.
//! An `UNKNOWN` attempt whose polling window elapses is never failed: it is handed to an operator
//! through one keyed case (`attempt.unknown:<id>`), and the attempt stays due if the case cannot be
//! recorded.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDateTime;
use sqlx::{PgPool, Row};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::cases::{raise_keyed_case, CaseKind, KeyedCaseInput, MonitorPriority};
use crate::db::{now_tz, now_utc};
use crate::expiry::{AttemptRow, InquiryOutcome, InquiryPort};
use crate::outbox::{enqueue_outbox_event, OutboxEnvelope};
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

/// `POLLABLE_STATUSES` (`PollWorker.ts:47`).
pub const POLLABLE_STATUSES: [&str; 6] = [
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
    "UNKNOWN",
];

/// `TERMINAL_STATUSES` (`PollWorker.ts:48`).
pub const TERMINAL_STATUSES: [&str; 5] = ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED"];

/// `ACTIVE_GATEWAY_INQUIRY_STATUSES` (`GatewayInquirySchedules.ts:3`).
pub const ACTIVE_INQUIRY_STATUSES: [&str; 3] = ["SCHEDULED", "RUNNING", "RETRYING"];

pub const DEFAULT_UNKNOWN_CASE_SLA_HOURS: i64 = 24;
pub const DEFAULT_UNKNOWN_CASE_PRIORITY: MonitorPriority = MonitorPriority::P1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollPolicy {
    pub route_id: Uuid,
    pub first_after_seconds: i64,
    pub backoff_seconds: Vec<i64>,
    pub max_duration_seconds: i64,
    pub stop_on_states: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PollConfig {
    pub interval_ms: u64,
    pub batch_size: i64,
    pub claim_lease_seconds: i64,
    pub default_first_after_seconds: i64,
    pub default_backoff_seconds: Vec<i64>,
    pub default_max_duration_seconds: i64,
    pub unknown_case_sla_hours: i64,
    pub unknown_case_priority: MonitorPriority,
    pub unknown_escalation_retry_seconds: i64,
}

impl Default for PollConfig {
    fn default() -> Self {
        Self {
            interval_ms: 5_000,
            batch_size: 50,
            claim_lease_seconds: 120,
            default_first_after_seconds: 5,
            default_backoff_seconds: vec![5, 15, 30, 60, 120, 300],
            default_max_duration_seconds: 900,
            unknown_case_sla_hours: DEFAULT_UNKNOWN_CASE_SLA_HOURS,
            unknown_case_priority: DEFAULT_UNKNOWN_CASE_PRIORITY,
            unknown_escalation_retry_seconds: 300,
        }
    }
}

/// `computeBackoffDelaySeconds` (`PollWorker.ts:50-66`). `None` means the polling window elapsed.
#[must_use]
pub fn compute_backoff_delay_seconds(policy: &PollPolicy, elapsed_seconds: i64) -> Option<i64> {
    if elapsed_seconds >= policy.max_duration_seconds {
        return None;
    }
    let schedule: &[i64] = if policy.backoff_seconds.is_empty() {
        std::slice::from_ref(&policy.first_after_seconds)
    } else {
        &policy.backoff_seconds
    };
    let mut accumulated = 0_i64;
    for step in schedule {
        accumulated += *step;
        if elapsed_seconds < accumulated {
            return Some(*step);
        }
    }
    schedule
        .last()
        .copied()
        .or(Some(policy.first_after_seconds))
}

/// The claim (`PollWorker.ts:136-147`): one statement, `SKIP LOCKED`, lease written before commit.
pub const POLL_CLAIM_SQL: &str = "WITH claimed AS (
    SELECT id FROM payment_attempts
     WHERE next_check_at IS NOT NULL
       AND next_check_at <= $1
       AND terminal_at IS NULL
       AND status IN ('CREATED', 'INITIATING', 'AWAITING_CUSTOMER', 'AUTHORIZING', 'VERIFYING', 'UNKNOWN')
     ORDER BY next_check_at ASC
     LIMIT $2
     FOR UPDATE SKIP LOCKED
)
UPDATE payment_attempts p SET next_check_at = $3, updated_at = now()
  FROM claimed WHERE p.id = claimed.id
 RETURNING p.id, p.merchant_id, p.link_id, p.route_id, p.status::text AS status, p.substatus,
           p.point_of_no_return, p.expires_at, p.grace_expires_at, p.created_at, p.terminal_at,
           p.next_check_at, p.currency, p.total_charged_amount, p.net_merchant_amount,
           p.canonical_error, p.settled_amount, p.gateway_fee_amount";

/// `updateOpenAttempt` (`PollWorker.ts:310-318`): only while the attempt is still open.
pub const POLL_UPDATE_OPEN_SQL: &str = "UPDATE payment_attempts
   SET status = $1::\"AttemptStatus\",
       substatus = CASE WHEN $2::boolean THEN $3::text ELSE substatus END,
       canonical_error = COALESCE($4::text, canonical_error),
       next_check_at = $5,
       updated_at = now()
 WHERE id = $6::uuid AND terminal_at IS NULL";

/// Conditional terminal write (`PollWorker.ts:349-357`).
pub const POLL_TERMINATE_SQL: &str = "UPDATE payment_attempts
   SET status = $1::\"AttemptStatus\", terminal_at = $2, next_check_at = NULL, updated_at = now()
 WHERE id = $3::uuid AND terminal_at IS NULL";

/// `findActiveGatewayInquiry` (`GatewayInquirySchedules.ts:32`).
pub const ACTIVE_INQUIRY_SQL: &str = "SELECT id, created_at, window_started_at
   FROM gateway_inquiry_schedules
  WHERE attempt_id = $1::uuid
    AND status IN ('SCHEDULED', 'RUNNING', 'RETRYING')
  ORDER BY created_at DESC LIMIT 1";

/// `markGatewayInquiryRunning` (`GatewayInquirySchedules.ts:46`).
pub const INQUIRY_RUNNING_SQL: &str = "UPDATE gateway_inquiry_schedules
   SET status = 'RUNNING', last_run_at = $2, attempts = attempts + 1, last_error = NULL, updated_at = now()
 WHERE id = $1::uuid AND status IN ('SCHEDULED', 'RUNNING', 'RETRYING')";

pub const INQUIRY_COMPLETED_SQL: &str = "UPDATE gateway_inquiry_schedules
   SET status = 'COMPLETED', completed_at = $2, last_result = $3, updated_at = now()
 WHERE id = $1::uuid";

pub const INQUIRY_RETRYING_SQL: &str = "UPDATE gateway_inquiry_schedules
   SET status = 'RETRYING', next_run_at = $2, last_result = COALESCE($3, last_result),
       last_error = COALESCE($4, last_error), updated_at = now()
 WHERE id = $1::uuid";

pub const INQUIRY_EXPIRED_SQL: &str = "UPDATE gateway_inquiry_schedules
   SET status = 'EXPIRED', completed_at = $2, last_result = $3, last_error = $4, updated_at = now()
 WHERE id = $1::uuid";

/// `reconcileGatewayInquiries` (`GatewayInquirySchedules.ts:85`).
pub const INQUIRY_RECONCILE_SQL: &str = "SELECT s.id, s.status::text AS status,
        a.status::text AS attempt_status, a.terminal_at, a.next_check_at, a.id AS attempt_id
   FROM gateway_inquiry_schedules s
   LEFT JOIN payment_attempts a ON a.id = s.attempt_id
  WHERE s.status IN ('SCHEDULED', 'RUNNING', 'RETRYING')
  ORDER BY s.created_at ASC
  LIMIT 500";

pub const POLL_POLICIES_SQL: &str = "SELECT route_id, first_after_seconds, backoff_seconds,
        max_duration_seconds, stop_on_states FROM poll_policies";

#[derive(Debug, Clone)]
struct ScheduleRow {
    id: Uuid,
    created_at: NaiveDateTime,
    window_started_at: Option<NaiveDateTime>,
}

pub struct PollWorker {
    pool: PgPool,
    config: PollConfig,
    inquiry: Option<Arc<dyn InquiryPort>>,
    policies: parking_lot::Mutex<BTreeMap<Uuid, PollPolicy>>,
}

impl PollWorker {
    #[must_use]
    pub fn new(pool: PgPool, config: PollConfig, inquiry: Option<Arc<dyn InquiryPort>>) -> Self {
        Self {
            pool,
            config,
            inquiry,
            policies: parking_lot::Mutex::new(BTreeMap::new()),
        }
    }

    pub async fn tick_once(&self) -> Result<u64, WorkerError> {
        let now = now_utc();
        self.reconcile_gateway_inquiries(now).await?;
        let attempts = self.lock_due_attempts(now).await?;
        if attempts.is_empty() {
            return Ok(0);
        }
        self.refresh_policies().await;
        let count = attempts.len() as u64;
        for attempt in attempts {
            self.poll_attempt(attempt, now).await;
        }
        Ok(count)
    }

    async fn refresh_policies(&self) {
        match sqlx::query(POLL_POLICIES_SQL).fetch_all(&self.pool).await {
            Ok(rows) => {
                let mut policies = self.policies.lock();
                policies.clear();
                for row in rows {
                    let Ok(route_id) = row.try_get::<Uuid, _>("route_id") else {
                        continue;
                    };
                    let backoff: Vec<i64> = json_i64_array(row.try_get("backoff_seconds").ok());
                    let stop_on_states: Vec<String> =
                        json_string_array(row.try_get("stop_on_states").ok());
                    policies.insert(
                        route_id,
                        PollPolicy {
                            route_id,
                            first_after_seconds: row.try_get("first_after_seconds").unwrap_or(5),
                            backoff_seconds: backoff,
                            max_duration_seconds: row
                                .try_get("max_duration_seconds")
                                .unwrap_or(900),
                            stop_on_states,
                        },
                    );
                }
            }
            Err(error) => {
                warn!(%error, "poll worker: unable to refresh poll policies");
            }
        }
    }

    fn policy_for(&self, attempt: &AttemptRow) -> PollPolicy {
        if let Some(policy) = self.policies.lock().get(&attempt.route_id) {
            return policy.clone();
        }
        PollPolicy {
            route_id: attempt.route_id,
            first_after_seconds: self.config.default_first_after_seconds,
            backoff_seconds: self.config.default_backoff_seconds.clone(),
            max_duration_seconds: self.config.default_max_duration_seconds,
            stop_on_states: Vec::new(),
        }
    }

    async fn lock_due_attempts(&self, now: NaiveDateTime) -> Result<Vec<AttemptRow>, WorkerError> {
        let lease_until = now + chrono::Duration::seconds(self.config.claim_lease_seconds.max(1));
        let mut tx = self.pool.begin().await.map_err(poll_error)?;
        let rows = sqlx::query_as::<_, AttemptRow>(POLL_CLAIM_SQL)
            .bind(now)
            .bind(self.config.batch_size)
            .bind(lease_until)
            .fetch_all(&mut *tx)
            .await
            .map_err(poll_error)?;
        tx.commit().await.map_err(poll_error)?;
        Ok(rows)
    }

    async fn poll_attempt(&self, attempt: AttemptRow, now: NaiveDateTime) {
        let policy = self.policy_for(&attempt);
        let schedule = match self.find_active_inquiry(attempt.id).await {
            Ok(schedule) => schedule,
            Err(error) => {
                warn!(attempt_id = %attempt.id, %error, "poll worker: cannot read the inquiry schedule");
                None
            }
        };

        if policy.stop_on_states.contains(&attempt.status) {
            let _ = self.set_next_check(attempt.id, None).await;
            if let Some(schedule) = &schedule {
                let _ = self
                    .complete_inquiry(schedule.id, now, Some(attempt.status.as_str()))
                    .await;
            }
            return;
        }

        let reference_at = schedule
            .as_ref()
            .and_then(|schedule| schedule.window_started_at.or(Some(schedule.created_at)))
            .unwrap_or(attempt.created_at);
        let elapsed_seconds = (now - reference_at).num_seconds().max(0);
        let Some(delay_seconds) = compute_backoff_delay_seconds(&policy, elapsed_seconds) else {
            if attempt.status == "UNKNOWN"
                && !self.escalate_unknown(&attempt, now, elapsed_seconds).await
            {
                let retry_at = now
                    + chrono::Duration::seconds(
                        self.config.unknown_escalation_retry_seconds.max(1),
                    );
                let _ = self.set_next_check(attempt.id, Some(retry_at)).await;
                return;
            }
            let _ = self.set_next_check(attempt.id, None).await;
            if let Some(schedule) = &schedule {
                let _ = sqlx::query(INQUIRY_EXPIRED_SQL)
                    .bind(schedule.id)
                    .bind(now)
                    .bind(&attempt.status)
                    .bind("The polling window elapsed before a definitive result")
                    .execute(&self.pool)
                    .await;
            }
            return;
        };

        if let Some(schedule) = &schedule {
            match sqlx::query(INQUIRY_RUNNING_SQL)
                .bind(schedule.id)
                .bind(now)
                .execute(&self.pool)
                .await
            {
                Ok(result) if result.rows_affected() > 0 => {}
                Ok(_) => return,
                Err(error) => {
                    warn!(attempt_id = %attempt.id, %error, "poll worker: cannot mark the inquiry running");
                    return;
                }
            }
        }

        let next_check_at = now + chrono::Duration::seconds(delay_seconds);
        let Some(inquiry) = &self.inquiry else {
            let _ = self.set_next_check(attempt.id, Some(next_check_at)).await;
            if let Some(schedule) = &schedule {
                let _ = self
                    .retry_inquiry(
                        schedule.id,
                        next_check_at,
                        Some(&attempt.status),
                        Some("The gateway inquiry runtime is not configured"),
                    )
                    .await;
            }
            return;
        };

        let outcome = match inquiry.inquire(&attempt).await {
            Ok(outcome) => outcome,
            Err(error) => {
                warn!(attempt_id = %attempt.id, %error, "poll worker: inquiry failed");
                // Never over a terminal attempt: a webhook may have settled it meanwhile.
                let _ = self
                    .update_open_attempt(
                        attempt.id,
                        "UNKNOWN",
                        None,
                        None,
                        Some(next_check_at),
                        false,
                    )
                    .await;
                if let Some(schedule) = &schedule {
                    let _ = self
                        .retry_inquiry(schedule.id, next_check_at, None, Some(&error.to_string()))
                        .await;
                }
                return;
            }
        };

        let terminal = TERMINAL_STATUSES.contains(&outcome.status.as_str());
        if terminal {
            let transitioned = match self.terminate(attempt.id, &outcome.status, now).await {
                Ok(value) => value,
                Err(error) => {
                    error!(attempt_id = %attempt.id, %error, "poll worker: cannot terminate the attempt");
                    return;
                }
            };
            if !transitioned {
                return;
            }
            if outcome.substatus.is_some() || outcome.canonical_error.is_some() {
                let _ = self.update_details(attempt.id, &outcome, false).await;
            }
            if outcome.settled_amount.is_some() {
                let _ = self.update_details(attempt.id, &outcome, true).await;
            }
            let _ = self
                .emit_terminal(&attempt, &outcome.status, &outcome.substatus)
                .await;
            if let Some(schedule) = &schedule {
                let _ = self
                    .complete_inquiry(schedule.id, now, Some(outcome.status.as_str()))
                    .await;
            }
        } else {
            let _ = self
                .update_open_attempt(
                    attempt.id,
                    &outcome.status,
                    outcome
                        .substatus
                        .as_deref()
                        .or(attempt.substatus.as_deref()),
                    outcome.canonical_error.as_deref(),
                    Some(next_check_at),
                    false,
                )
                .await;
            if let Some(schedule) = &schedule {
                let _ = self
                    .retry_inquiry(
                        schedule.id,
                        next_check_at,
                        Some(outcome.status.as_str()),
                        None,
                    )
                    .await;
            }
        }

        if terminal && (outcome.status == "FAILED" || outcome.status == "CANCELLED") {
            self.release_slot(&attempt).await;
        }
    }

    async fn find_active_inquiry(
        &self,
        attempt_id: Uuid,
    ) -> Result<Option<ScheduleRow>, WorkerError> {
        let row = sqlx::query(ACTIVE_INQUIRY_SQL)
            .bind(attempt_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(poll_error)?;
        Ok(row.map(|row| ScheduleRow {
            id: row.get("id"),
            created_at: row.get("created_at"),
            window_started_at: row.get("window_started_at"),
        }))
    }

    async fn complete_inquiry(
        &self,
        schedule_id: Uuid,
        now: NaiveDateTime,
        last_result: Option<&str>,
    ) -> Result<(), WorkerError> {
        sqlx::query(INQUIRY_COMPLETED_SQL)
            .bind(schedule_id)
            .bind(now)
            .bind(last_result)
            .execute(&self.pool)
            .await
            .map_err(poll_error)?;
        Ok(())
    }

    async fn retry_inquiry(
        &self,
        schedule_id: Uuid,
        next_run_at: NaiveDateTime,
        last_result: Option<&str>,
        last_error: Option<&str>,
    ) -> Result<(), WorkerError> {
        sqlx::query(INQUIRY_RETRYING_SQL)
            .bind(schedule_id)
            .bind(next_run_at)
            .bind(last_result)
            .bind(last_error)
            .execute(&self.pool)
            .await
            .map_err(poll_error)?;
        Ok(())
    }

    async fn reconcile_gateway_inquiries(&self, now: NaiveDateTime) -> Result<(), WorkerError> {
        let rows = sqlx::query(INQUIRY_RECONCILE_SQL)
            .fetch_all(&self.pool)
            .await
            .map_err(poll_error)?;
        for row in rows {
            let schedule_id: Uuid = row.get("id");
            let status: String = row.get("status");
            let attempt_status: Option<String> = row.try_get("attempt_status").ok();
            let terminal_at: Option<NaiveDateTime> = row.try_get("terminal_at").ok().flatten();
            let next_check_at: Option<NaiveDateTime> = row.try_get("next_check_at").ok().flatten();
            let Some(attempt_status) = attempt_status else {
                sqlx::query(
                    "UPDATE gateway_inquiry_schedules SET status = 'COMPLETED', completed_at = $2,
                            last_error = 'The payment attempt no longer exists', updated_at = now()
                      WHERE id = $1",
                )
                .bind(schedule_id)
                .bind(now)
                .execute(&self.pool)
                .await
                .map_err(poll_error)?;
                continue;
            };
            let terminal =
                terminal_at.is_some() || TERMINAL_STATUSES.contains(&attempt_status.as_str());
            if terminal {
                sqlx::query(
                    "UPDATE gateway_inquiry_schedules SET status = 'COMPLETED', completed_at = $2,
                            last_result = $3, updated_at = now() WHERE id = $1",
                )
                .bind(schedule_id)
                .bind(now)
                .bind(&attempt_status)
                .execute(&self.pool)
                .await
                .map_err(poll_error)?;
                continue;
            }
            if status != "RUNNING" && next_check_at.is_none() {
                sqlx::query(
                    "UPDATE gateway_inquiry_schedules SET status = 'EXPIRED', completed_at = $2,
                            last_result = $3,
                            last_error = 'The polling window elapsed before a definitive result',
                            updated_at = now()
                      WHERE id = $1",
                )
                .bind(schedule_id)
                .bind(now)
                .bind(&attempt_status)
                .execute(&self.pool)
                .await
                .map_err(poll_error)?;
            }
        }
        Ok(())
    }

    async fn set_next_check(
        &self,
        attempt_id: Uuid,
        next_check_at: Option<NaiveDateTime>,
    ) -> Result<(), WorkerError> {
        sqlx::query(
            "UPDATE payment_attempts SET next_check_at = $2, updated_at = now() WHERE id = $1",
        )
        .bind(attempt_id)
        .bind(next_check_at)
        .execute(&self.pool)
        .await
        .map_err(poll_error)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn update_open_attempt(
        &self,
        attempt_id: Uuid,
        status: &str,
        substatus: Option<&str>,
        canonical_error: Option<&str>,
        next_check_at: Option<NaiveDateTime>,
        substatus_explicit: bool,
    ) -> Result<(), WorkerError> {
        sqlx::query(POLL_UPDATE_OPEN_SQL)
            .bind(status)
            .bind(substatus_explicit)
            .bind(substatus)
            .bind(canonical_error)
            .bind(next_check_at)
            .bind(attempt_id)
            .execute(&self.pool)
            .await
            .map_err(poll_error)?;
        Ok(())
    }

    async fn update_details(
        &self,
        attempt_id: Uuid,
        outcome: &InquiryOutcome,
        amounts: bool,
    ) -> Result<(), WorkerError> {
        if amounts {
            sqlx::query(
                "UPDATE payment_attempts SET settled_amount = COALESCE($2, settled_amount),
                        gateway_fee_amount = COALESCE($3, gateway_fee_amount), updated_at = now()
                  WHERE id = $1::uuid",
            )
            .bind(attempt_id)
            .bind(outcome.settled_amount)
            .bind(outcome.provider_fee)
            .execute(&self.pool)
            .await
            .map_err(poll_error)?;
        } else {
            sqlx::query(
                "UPDATE payment_attempts SET substatus = COALESCE($2, substatus),
                        canonical_error = COALESCE($3, canonical_error), updated_at = now()
                  WHERE id = $1::uuid",
            )
            .bind(attempt_id)
            .bind(&outcome.substatus)
            .bind(&outcome.canonical_error)
            .execute(&self.pool)
            .await
            .map_err(poll_error)?;
        }
        Ok(())
    }

    async fn emit_terminal(
        &self,
        attempt: &AttemptRow,
        status: &str,
        substatus: &Option<String>,
    ) -> Result<(), WorkerError> {
        let mut tx = self.pool.begin().await.map_err(poll_error)?;
        enqueue_outbox_event(
            &mut tx,
            &OutboxEnvelope::attempt_transitioned(crate::outbox::AttemptTransition {
                attempt_id: attempt.id,
                merchant_id: Some(attempt.merchant_id),
                route_id: Some(attempt.route_id),
                currency: &attempt.currency,
                status,
                substatus: substatus.as_deref(),
                total_charged_amount: &attempt.total_charged_amount.to_string(),
                net_merchant_amount: &attempt.net_merchant_amount.to_string(),
                occurred_at: now_tz(),
            }),
            now_tz(),
        )
        .await?;
        tx.commit().await.map_err(poll_error)
    }

    /// Returns false only when the escalation could not be recorded (`PollWorker.ts:322`).
    async fn escalate_unknown(
        &self,
        attempt: &AttemptRow,
        now: NaiveDateTime,
        elapsed_seconds: i64,
    ) -> bool {
        let notes = format!(
            "Stale UNKNOWN attempt: the polling window elapsed after {elapsed_seconds}s without a \
             definitive gateway answer. Attempt {} is still UNKNOWN; confirm the outcome with the \
             gateway or the statement and resolve the case. The attempt is never failed automatically.",
            attempt.id
        );
        let mut tx = match self.pool.begin().await {
            Ok(tx) => tx,
            Err(error) => {
                error!(attempt_id = %attempt.id, %error, "poll worker: cannot open the escalation transaction");
                return false;
            }
        };
        let input = KeyedCaseInput {
            kind: CaseKind::Unknown,
            priority: self.config.unknown_case_priority,
            subject_key: &crate::cases::unknown_attempt_subject_key(&attempt.id.to_string()),
            attempt_id: Some(attempt.id),
            reconciliation_item_id: None,
            notes: &notes,
            sla_hours: self.config.unknown_case_sla_hours,
            now,
            dedupe_on_attempt: true,
            title: None,
        };
        match raise_keyed_case(&mut tx, &input).await {
            Ok(result) => {
                if let Err(error) = tx.commit().await {
                    error!(attempt_id = %attempt.id, %error, "poll worker: cannot commit the escalation");
                    return false;
                }
                if result.created {
                    info!(
                        attempt_id = %attempt.id,
                        operator_case_id = ?result.id,
                        "poll worker: stale UNKNOWN attempt escalated to an operator"
                    );
                }
                true
            }
            Err(error) => {
                error!(attempt_id = %attempt.id, %error, "poll worker: unable to escalate a stale UNKNOWN attempt");
                false
            }
        }
    }

    async fn terminate(
        &self,
        attempt_id: Uuid,
        status: &str,
        now: NaiveDateTime,
    ) -> Result<bool, WorkerError> {
        let result = sqlx::query(POLL_TERMINATE_SQL)
            .bind(status)
            .bind(now)
            .bind(attempt_id)
            .execute(&self.pool)
            .await
            .map_err(poll_error)?;
        Ok(result.rows_affected() > 0)
    }

    async fn release_slot(&self, attempt: &AttemptRow) {
        if let Err(error) = sqlx::query(
            "UPDATE payment_links SET active_locked_count = GREATEST(0, active_locked_count - 1) WHERE id = $1",
        )
        .bind(attempt.link_id)
        .execute(&self.pool)
        .await
        {
            error!(
                attempt_id = %attempt.id,
                link_id = %attempt.link_id,
                %error,
                "poll worker: unable to release the link slot"
            );
        }
    }
}

fn json_i64_array(value: Option<serde_json::Value>) -> Vec<i64> {
    value
        .and_then(|value| value.as_array().cloned())
        .map(|items| {
            items
                .into_iter()
                .filter_map(|item| item.as_i64())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn json_string_array(value: Option<serde_json::Value>) -> Vec<String> {
    value
        .and_then(|value| value.as_array().cloned())
        .map(|items| {
            items
                .into_iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[async_trait]
impl Worker for PollWorker {
    fn name(&self) -> &'static str {
        "Poll"
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.config.interval_ms.max(1))
    }

    async fn tick(&self, ctx: &WorkerContext) -> Result<WorkerOutcome, WorkerError> {
        if ctx.shutting_down() {
            return Ok(WorkerOutcome::Deferred);
        }
        let count = self.tick_once().await?;
        if count == 0 {
            Ok(WorkerOutcome::Skipped)
        } else {
            Ok(WorkerOutcome::Processed(count))
        }
    }
}

fn poll_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("poll worker: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(backoff: Vec<i64>, max: i64) -> PollPolicy {
        PollPolicy {
            route_id: Uuid::now_v7(),
            first_after_seconds: 5,
            backoff_seconds: backoff,
            max_duration_seconds: max,
            stop_on_states: Vec::new(),
        }
    }

    #[test]
    fn backoff_walks_the_schedule() {
        let schedule = policy(vec![5, 15, 30, 60, 120, 300], 900);
        assert_eq!(compute_backoff_delay_seconds(&schedule, 0), Some(5));
        assert_eq!(compute_backoff_delay_seconds(&schedule, 4), Some(5));
        assert_eq!(compute_backoff_delay_seconds(&schedule, 5), Some(15));
        assert_eq!(compute_backoff_delay_seconds(&schedule, 19), Some(15));
        assert_eq!(compute_backoff_delay_seconds(&schedule, 20), Some(30));
        assert_eq!(compute_backoff_delay_seconds(&schedule, 800), Some(300));
        assert_eq!(compute_backoff_delay_seconds(&schedule, 899), Some(300));
        assert_eq!(compute_backoff_delay_seconds(&schedule, 900), None);
        assert_eq!(compute_backoff_delay_seconds(&schedule, 5_000), None);
    }

    #[test]
    fn an_empty_schedule_uses_the_first_after_and_a_zero_window_stops_at_once() {
        let empty = policy(Vec::new(), 900);
        assert_eq!(compute_backoff_delay_seconds(&empty, 0), Some(5));
        assert_eq!(compute_backoff_delay_seconds(&empty, 600), Some(5));
        let disabled = policy(vec![5, 15], 0);
        assert_eq!(compute_backoff_delay_seconds(&disabled, 0), None);
    }

    #[test]
    fn the_status_lists_match_the_generated_enum() {
        use pg_types::generated::enums::AttemptStatus;
        let pollable = [
            AttemptStatus::Created.as_str(),
            AttemptStatus::Initiating.as_str(),
            AttemptStatus::AwaitingCustomer.as_str(),
            AttemptStatus::Authorizing.as_str(),
            AttemptStatus::Verifying.as_str(),
            AttemptStatus::Unknown.as_str(),
        ];
        assert_eq!(POLLABLE_STATUSES, pollable);
        let terminal = [
            AttemptStatus::Succeeded.as_str(),
            AttemptStatus::Failed.as_str(),
            AttemptStatus::Expired.as_str(),
            AttemptStatus::Cancelled.as_str(),
            AttemptStatus::Blocked.as_str(),
        ];
        assert_eq!(TERMINAL_STATUSES, terminal);
    }

    #[test]
    fn the_status_lists_match_typescript() {
        assert_eq!(POLLABLE_STATUSES.len(), 6);
        assert!(POLLABLE_STATUSES.contains(&"UNKNOWN"));
        assert!(!POLLABLE_STATUSES.contains(&"SUCCEEDED"));
        assert_eq!(TERMINAL_STATUSES.len(), 5);
        assert!(!TERMINAL_STATUSES.contains(&"UNKNOWN"));
        assert_eq!(ACTIVE_INQUIRY_STATUSES.len(), 3);
    }

    #[test]
    fn claim_sql_leases_and_skips_locked_rows() {
        assert!(POLL_CLAIM_SQL.contains("FOR UPDATE SKIP LOCKED"));
        assert!(POLL_CLAIM_SQL.contains("next_check_at <= $1"));
        assert!(POLL_CLAIM_SQL.contains("SET next_check_at = $3"));
        assert!(POLL_CLAIM_SQL.contains("terminal_at IS NULL"));
        for status in POLLABLE_STATUSES {
            assert!(POLL_CLAIM_SQL.contains(status), "{status}");
        }
    }

    #[test]
    fn terminal_and_open_writes_are_conditional() {
        assert!(POLL_UPDATE_OPEN_SQL.contains("terminal_at IS NULL"));
        assert!(POLL_UPDATE_OPEN_SQL.contains("CASE WHEN $2::boolean"));
        assert!(POLL_UPDATE_OPEN_SQL.contains("COALESCE($4::text, canonical_error)"));
        assert!(POLL_TERMINATE_SQL.contains("terminal_at IS NULL"));
        assert!(POLL_TERMINATE_SQL.contains("next_check_at = NULL"));
    }

    #[test]
    fn schedule_sql_matches_the_gateway_inquiry_contract() {
        assert!(ACTIVE_INQUIRY_SQL.contains("ORDER BY created_at DESC LIMIT 1"));
        assert!(INQUIRY_RUNNING_SQL.contains("attempts = attempts + 1"));
        assert!(INQUIRY_RUNNING_SQL.contains("last_error = NULL"));
        assert!(INQUIRY_COMPLETED_SQL.contains("completed_at = $2"));
        assert!(INQUIRY_RETRYING_SQL.contains("next_run_at = $2"));
        assert!(INQUIRY_EXPIRED_SQL.contains("status = 'EXPIRED'"));
    }

    #[test]
    fn reconcile_sql_reads_the_attempt_state() {
        assert!(INQUIRY_RECONCILE_SQL.contains("LEFT JOIN payment_attempts"));
        assert!(INQUIRY_RECONCILE_SQL.contains("LIMIT 500"));
        assert!(INQUIRY_RECONCILE_SQL.contains("terminal_at"));
    }

    #[test]
    fn json_policy_helpers_ignore_bad_shapes() {
        assert_eq!(json_i64_array(None), Vec::<i64>::new());
        assert_eq!(
            json_i64_array(Some(serde_json::json!([5, "x", 15.0, 30]))),
            vec![5, 30]
        );
        assert_eq!(
            json_string_array(Some(serde_json::json!(["AWAITING_CUSTOMER", 3]))),
            vec!["AWAITING_CUSTOMER".to_owned()]
        );
        assert_eq!(
            json_string_array(Some(serde_json::json!({"a": true}))),
            Vec::<String>::new()
        );
    }
}
