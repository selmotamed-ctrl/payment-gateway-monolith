//! Expiry sweeper (`core-back/engine/workers/ExpirySweeperWorker.ts`).
//!
//! An attempt whose session expired is only expired after the sweeper asks the route (when it
//! supports status checks), reloads the row and refuses to touch an AML-held attempt, a terminal
//! attempt, or one past the point of no return with money in flight (that one becomes `UNKNOWN` for
//! the poll worker/operator).
//!
//! Terminal writes are conditional on the row still being non-terminal and in the status that was
//! decided on, so two cluster nodes can never expire the same attempt (or release its slot) twice.
//! Every terminal write also enqueues `attempt.transitioned`, exactly like `updateAttempt` in the
//! engine, so the read models/poller see the expiry.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDateTime;
use rust_decimal::Decimal;
use sqlx::{PgConnection, PgPool, Row};
use tracing::{error, warn};
use uuid::Uuid;

use crate::cases::{write_system_audit, SystemAudit};
use crate::db::{now_tz, now_utc};
use crate::outbox::{enqueue_outbox_event, OutboxEnvelope};
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

/// `EXPIRABLE_STATUSES` (`ExpirySweeperWorker.ts:23`).
pub const EXPIRABLE_STATUSES: [&str; 5] = [
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
];

/// `RELEASE_SLOT_STATUSES` (`ExpirySweeperWorker.ts:24`).
pub const RELEASE_SLOT_STATUSES: [&str; 3] = ["FAILED", "EXPIRED", "CANCELLED"];

/// `AML_HOLD_SUBSTATUS` (`ExpirySweeperWorker.ts:30`): the AML case owns the attempt.
pub const AML_HOLD_SUBSTATUS: &str = "AML_HOLD";

/// `MONEY_IN_FLIGHT_STATUSES` (`ExpirySweeperWorker.ts:38`).
pub const MONEY_IN_FLIGHT_STATUSES: [&str; 2] = ["AUTHORIZING", "VERIFYING"];

/// A gateway inquiry answer (`ExpirySweeperWorker.ts:6-13`).
#[derive(Debug, Clone, PartialEq)]
pub struct InquiryOutcome {
    pub status: String,
    pub substatus: Option<String>,
    pub canonical_error: Option<String>,
    pub settled_amount: Option<Decimal>,
    pub provider_fee: Option<Decimal>,
    pub definitive: bool,
}

#[async_trait]
pub trait InquiryPort: Send + Sync {
    async fn inquire(&self, attempt: &AttemptRow) -> Result<InquiryOutcome, WorkerError>;
}

/// The columns the sweeper and the poll worker need, with enums cast to text for stable decoding.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AttemptRow {
    pub id: Uuid,
    pub merchant_id: Uuid,
    pub link_id: Uuid,
    pub route_id: Uuid,
    pub status: String,
    pub substatus: Option<String>,
    pub point_of_no_return: bool,
    pub expires_at: NaiveDateTime,
    pub grace_expires_at: NaiveDateTime,
    pub created_at: NaiveDateTime,
    pub terminal_at: Option<NaiveDateTime>,
    pub next_check_at: Option<NaiveDateTime>,
    pub currency: String,
    pub total_charged_amount: Decimal,
    pub net_merchant_amount: Decimal,
    pub canonical_error: Option<String>,
    pub settled_amount: Option<Decimal>,
    pub gateway_fee_amount: Option<Decimal>,
}

impl AttemptRow {
    /// `moneyMayHaveMoved` (`ExpirySweeperWorker.ts:39-40`): a money-moving step was already sent.
    #[must_use]
    pub fn money_may_have_moved(&self) -> bool {
        self.point_of_no_return && MONEY_IN_FLIGHT_STATUSES.contains(&self.status.as_str())
    }

    #[must_use]
    pub fn is_expirable(&self) -> bool {
        EXPIRABLE_STATUSES.contains(&self.status.as_str())
    }

    #[must_use]
    pub fn releases_slot_on(&self, status: &str) -> bool {
        RELEASE_SLOT_STATUSES.contains(&status)
    }
}

/// The TS select with the AML exclusion and the `FOR UPDATE SKIP LOCKED` claim.
pub const EXPIRY_SELECT_SQL: &str =
    "SELECT id, merchant_id, link_id, route_id, status::text AS status,
        substatus, point_of_no_return, expires_at, grace_expires_at, created_at, terminal_at,
        next_check_at, currency, total_charged_amount, net_merchant_amount, canonical_error,
        settled_amount, gateway_fee_amount
   FROM payment_attempts
  WHERE expires_at IS NOT NULL
    AND expires_at <= $1
    AND terminal_at IS NULL
    AND status IN ('CREATED', 'INITIATING', 'AWAITING_CUSTOMER', 'AUTHORIZING', 'VERIFYING')
    AND (substatus IS NULL OR substatus <> $2)
  ORDER BY expires_at ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED";

/// The conditional terminal write. `point_of_no_return` in flight is never expired.
pub const EXPIRY_TERMINATE_SQL: &str = "UPDATE payment_attempts
   SET status = 'EXPIRED', terminal_at = $1, next_check_at = NULL, updated_at = now()
 WHERE id = $2::uuid AND terminal_at IS NULL AND status = $3
   AND NOT (point_of_no_return = true AND status IN ('AUTHORIZING', 'VERIFYING'))";

/// A non-terminal inquiry answer that refuses to overwrite a terminal attempt.
pub const EXPIRY_TERMINATE_WITH_STATUS_SQL: &str = "UPDATE payment_attempts
   SET status = $1::\"AttemptStatus\", terminal_at = $2, next_check_at = NULL, updated_at = now()
 WHERE id = $3::uuid AND terminal_at IS NULL";

pub const EXPIRY_HOLD_UNKNOWN_SQL: &str = "UPDATE payment_attempts
   SET status = 'UNKNOWN', next_check_at = COALESCE(next_check_at, $1), updated_at = now()
 WHERE id = $2::uuid AND terminal_at IS NULL AND status = $3";

pub const EXPIRY_DEFER_SQL: &str = "UPDATE payment_attempts
   SET status = 'UNKNOWN', next_check_at = $1, updated_at = now()
 WHERE id = $2::uuid AND terminal_at IS NULL";

pub const EXPIRY_RELEASE_SLOT_SQL: &str = "UPDATE payment_links
   SET active_locked_count = GREATEST(0, active_locked_count + $2)
 WHERE id = $1";

/// Inquiry support per route: the live version's `gateway_settings.supports_status_check`.
pub const ROUTE_INQUIRY_SUPPORT_SQL: &str = "SELECT r.id AS route_id,
        COALESCE(gs.supports_status_check, false) AS supports_status_check
   FROM rail_routes r
   LEFT JOIN LATERAL (
     SELECT gv.id FROM gateway_versions gv
      WHERE gv.gateway_id = r.gateway_id AND gv.state = 'LIVE'
      ORDER BY gv.version_number DESC LIMIT 1
   ) v ON true
   LEFT JOIN gateway_settings gs ON gs.gateway_version_id = v.id";

#[derive(Debug, Clone)]
pub struct ExpirySweeperConfig {
    pub interval_ms: u64,
    pub batch_size: i64,
}

impl Default for ExpirySweeperConfig {
    fn default() -> Self {
        Self {
            interval_ms: 5_000,
            batch_size: 50,
        }
    }
}

pub struct ExpirySweeperWorker {
    pool: PgPool,
    config: ExpirySweeperConfig,
    inquiry: Option<Arc<dyn InquiryPort>>,
    inquiry_support: parking_lot::Mutex<BTreeMap<Uuid, bool>>,
}

impl ExpirySweeperWorker {
    #[must_use]
    pub fn new(
        pool: PgPool,
        config: ExpirySweeperConfig,
        inquiry: Option<Arc<dyn InquiryPort>>,
    ) -> Self {
        Self {
            pool,
            config,
            inquiry,
            inquiry_support: parking_lot::Mutex::new(BTreeMap::new()),
        }
    }

    pub async fn tick_once(&self) -> Result<u64, WorkerError> {
        let now = now_utc();
        let attempts = self.lock_expired_attempts(now).await?;
        if attempts.is_empty() {
            return Ok(0);
        }
        self.refresh_inquiry_support().await;
        let count = attempts.len() as u64;
        for attempt in attempts {
            self.handle_attempt(attempt, now).await;
        }
        Ok(count)
    }

    async fn refresh_inquiry_support(&self) {
        match sqlx::query(ROUTE_INQUIRY_SUPPORT_SQL)
            .fetch_all(&self.pool)
            .await
        {
            Ok(rows) => {
                let mut support = self.inquiry_support.lock();
                support.clear();
                for row in rows {
                    if let (Ok(route_id), Ok(supported)) = (
                        row.try_get::<Uuid, _>("route_id"),
                        row.try_get::<bool, _>("supports_status_check"),
                    ) {
                        support.insert(route_id, supported);
                    }
                }
            }
            Err(error) => {
                warn!(%error, "expiry sweeper: unable to refresh inquiry support");
            }
        }
    }

    async fn lock_expired_attempts(
        &self,
        now: NaiveDateTime,
    ) -> Result<Vec<AttemptRow>, WorkerError> {
        let mut tx = self.pool.begin().await.map_err(expiry_error)?;
        let rows = sqlx::query_as::<_, AttemptRow>(EXPIRY_SELECT_SQL)
            .bind(now)
            .bind(AML_HOLD_SUBSTATUS)
            .bind(self.config.batch_size)
            .fetch_all(&mut *tx)
            .await
            .map_err(expiry_error)?;
        tx.commit().await.map_err(expiry_error)?;
        Ok(rows)
    }

    async fn handle_attempt(&self, attempt: AttemptRow, now: NaiveDateTime) {
        if attempt.substatus.as_deref() == Some(AML_HOLD_SUBSTATUS) {
            return;
        }
        let supports_inquiry = self
            .inquiry_support
            .lock()
            .get(&attempt.route_id)
            .copied()
            .unwrap_or(false);
        if supports_inquiry {
            if let Some(inquiry) = &self.inquiry {
                match inquiry.inquire(&attempt).await {
                    Ok(outcome) if outcome.definitive => {
                        self.apply_inquiry_outcome(&attempt, &outcome, now).await;
                        return;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        warn!(
                            attempt_id = %attempt.id,
                            %error,
                            "expiry sweeper: inquiry failed, attempt kept open"
                        );
                        self.defer_attempt(&attempt, now).await;
                        return;
                    }
                }
            }
        }

        // The claim lock is long gone: decide on the row as it is NOW.
        let Ok(Some(fresh)) = self.reload(attempt.id).await else {
            return;
        };
        if fresh.terminal_at.is_some() {
            return;
        }
        if fresh.money_may_have_moved() {
            self.hold_as_unknown(&fresh, now).await;
            return;
        }
        if !fresh.is_expirable() {
            return;
        }
        let expired = self.expire_attempt(&fresh, now).await;
        if expired.is_err() {
            error!(attempt_id = %attempt.id, "expiry sweeper: unable to expire the attempt");
            return;
        }
        if !expired.unwrap_or(false) {
            if let Ok(Some(latest)) = self.reload(attempt.id).await {
                if latest.terminal_at.is_none() && latest.money_may_have_moved() {
                    self.hold_as_unknown(&latest, now).await;
                }
            }
        }
    }

    async fn reload(&self, attempt_id: Uuid) -> Result<Option<AttemptRow>, WorkerError> {
        sqlx::query_as::<_, AttemptRow>(
            "SELECT id, merchant_id, link_id, route_id, status::text AS status, substatus,
                    point_of_no_return, expires_at, grace_expires_at, created_at, terminal_at,
                    next_check_at, currency, total_charged_amount, net_merchant_amount,
                    canonical_error, settled_amount, gateway_fee_amount
               FROM payment_attempts WHERE id = $1::uuid",
        )
        .bind(attempt_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(expiry_error)
    }

    async fn hold_as_unknown(&self, attempt: &AttemptRow, now: NaiveDateTime) {
        let updated = match sqlx::query(EXPIRY_HOLD_UNKNOWN_SQL)
            .bind(now)
            .bind(attempt.id)
            .bind(&attempt.status)
            .execute(&self.pool)
            .await
        {
            Ok(result) => result.rows_affected(),
            Err(error) => {
                error!(attempt_id = %attempt.id, %error, "expiry sweeper: cannot hold the attempt as UNKNOWN");
                return;
            }
        };
        if updated == 0 {
            return;
        }
        warn!(
            attempt_id = %attempt.id,
            previous_status = %attempt.status,
            "expiry sweeper: expired attempt past the point of no return held as UNKNOWN"
        );
        let audit = SystemAudit::new(
            "ATTEMPT_EXPIRY_HELD_UNKNOWN",
            "PAYMENT_ATTEMPT",
            &attempt.id.to_string(),
            serde_json::json!({ "status": attempt.status }),
            serde_json::json!({ "status": "UNKNOWN", "reason": "EXPIRED_PAST_POINT_OF_NO_RETURN" }),
        );
        let mut tx = match self.pool.begin().await {
            Ok(tx) => tx,
            Err(error) => {
                error!(attempt_id = %attempt.id, %error, "expiry sweeper: cannot audit the hold");
                return;
            }
        };
        if let Err(error) = write_system_audit(&mut tx, &audit).await {
            error!(attempt_id = %attempt.id, %error, "expiry sweeper: cannot audit the hold");
            return;
        }
        if let Err(error) = tx.commit().await {
            error!(attempt_id = %attempt.id, %error, "expiry sweeper: cannot commit the hold audit");
        }
    }

    async fn apply_inquiry_outcome(
        &self,
        attempt: &AttemptRow,
        outcome: &InquiryOutcome,
        now: NaiveDateTime,
    ) {
        let terminal =
            ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED"].contains(&outcome.status.as_str());
        if terminal {
            let transitioned = match self.terminate(attempt.id, &outcome.status, now).await {
                Ok(value) => value,
                Err(error) => {
                    error!(attempt_id = %attempt.id, %error, "expiry sweeper: cannot terminate on the inquiry answer");
                    return;
                }
            };
            if !transitioned {
                return;
            }
            if outcome.substatus.is_some() || outcome.canonical_error.is_some() {
                let _ = self.update_details(attempt.id, outcome, false).await;
            }
            if outcome.settled_amount.is_some() || outcome.provider_fee.is_some() {
                let _ = self.update_details(attempt.id, outcome, true).await;
            }
            let _ = self
                .audit_terminal(attempt, &outcome.status, &outcome.substatus)
                .await;
        } else {
            let _ = self
                .update_open_attempt(attempt.id, outcome, attempt.substatus.as_deref())
                .await;
        }
        if terminal && attempt.releases_slot_on(&outcome.status) {
            self.release_slot(attempt).await;
        }
        let audit = SystemAudit::new(
            "ATTEMPT_EXPIRY_INQUIRY_RESOLVED",
            "PAYMENT_ATTEMPT",
            &attempt.id.to_string(),
            serde_json::json!({}),
            serde_json::json!({
                "status": outcome.status,
                "substatus": outcome.substatus,
            }),
        );
        let mut tx = match self.pool.begin().await {
            Ok(tx) => tx,
            Err(error) => {
                error!(attempt_id = %attempt.id, %error, "expiry sweeper: cannot audit the inquiry resolution");
                return;
            }
        };
        if write_system_audit(&mut tx, &audit).await.is_ok() {
            let _ = tx.commit().await;
        }
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
            .map_err(expiry_error)?;
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
            .map_err(expiry_error)?;
        }
        Ok(())
    }

    async fn update_open_attempt(
        &self,
        attempt_id: Uuid,
        outcome: &InquiryOutcome,
        previous_substatus: Option<&str>,
    ) -> Result<(), WorkerError> {
        sqlx::query(
            "UPDATE payment_attempts SET status = $1::\"AttemptStatus\", substatus = $2,
                    canonical_error = COALESCE($3, canonical_error), updated_at = now()
              WHERE id = $4::uuid AND terminal_at IS NULL",
        )
        .bind(&outcome.status)
        .bind(outcome.substatus.as_deref().or(previous_substatus))
        .bind(&outcome.canonical_error)
        .bind(attempt_id)
        .execute(&self.pool)
        .await
        .map_err(expiry_error)?;
        Ok(())
    }

    async fn defer_attempt(&self, attempt: &AttemptRow, now: NaiveDateTime) {
        let retry_at = now + chrono::Duration::seconds(60);
        if let Err(error) = sqlx::query(EXPIRY_DEFER_SQL)
            .bind(retry_at)
            .bind(attempt.id)
            .execute(&self.pool)
            .await
        {
            error!(attempt_id = %attempt.id, %error, "expiry sweeper: cannot defer the attempt");
        }
    }

    /// Returns false when the attempt was not expired (it changed since it was read).
    async fn expire_attempt(
        &self,
        attempt: &AttemptRow,
        now: NaiveDateTime,
    ) -> Result<bool, WorkerError> {
        let result = sqlx::query(EXPIRY_TERMINATE_SQL)
            .bind(now)
            .bind(attempt.id)
            .bind(&attempt.status)
            .execute(&self.pool)
            .await
            .map_err(expiry_error)?;
        if result.rows_affected() == 0 {
            return Ok(false);
        }
        let mut tx = self.pool.begin().await.map_err(expiry_error)?;
        enqueue_outbox_event(
            &mut tx,
            &OutboxEnvelope::attempt_transitioned(crate::outbox::AttemptTransition {
                attempt_id: attempt.id,
                merchant_id: Some(attempt.merchant_id),
                route_id: Some(attempt.route_id),
                currency: &attempt.currency,
                status: "EXPIRED",
                substatus: attempt.substatus.as_deref(),
                total_charged_amount: &attempt.total_charged_amount.to_string(),
                net_merchant_amount: &attempt.net_merchant_amount.to_string(),
                occurred_at: now_tz(),
            }),
            now_tz(),
        )
        .await?;
        tx.commit().await.map_err(expiry_error)?;
        self.release_slot(attempt).await;
        let audit = SystemAudit::new(
            "ATTEMPT_EXPIRED",
            "PAYMENT_ATTEMPT",
            &attempt.id.to_string(),
            serde_json::json!({}),
            serde_json::json!({
                "status": "EXPIRED",
                "graceExpiresAt": attempt.grace_expires_at.and_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            }),
        );
        let mut tx = self.pool.begin().await.map_err(expiry_error)?;
        write_system_audit(&mut tx, &audit).await?;
        tx.commit().await.map_err(expiry_error)?;
        Ok(true)
    }

    async fn audit_terminal(
        &self,
        attempt: &AttemptRow,
        status: &str,
        substatus: &Option<String>,
    ) -> Result<(), WorkerError> {
        let mut tx = self.pool.begin().await.map_err(expiry_error)?;
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
        tx.commit().await.map_err(expiry_error)
    }

    async fn terminate(
        &self,
        attempt_id: Uuid,
        status: &str,
        now: NaiveDateTime,
    ) -> Result<bool, WorkerError> {
        let result = sqlx::query(EXPIRY_TERMINATE_WITH_STATUS_SQL)
            .bind(status)
            .bind(now)
            .bind(attempt_id)
            .execute(&self.pool)
            .await
            .map_err(expiry_error)?;
        Ok(result.rows_affected() > 0)
    }

    async fn release_slot(&self, attempt: &AttemptRow) {
        if let Err(error) = sqlx::query(EXPIRY_RELEASE_SLOT_SQL)
            .bind(attempt.link_id)
            .bind(-1_i32)
            .execute(&self.pool)
            .await
        {
            error!(
                attempt_id = %attempt.id,
                link_id = %attempt.link_id,
                %error,
                "expiry sweeper: unable to release the link slot"
            );
        }
    }
}

#[async_trait]
impl Worker for ExpirySweeperWorker {
    fn name(&self) -> &'static str {
        "ExpirySweeper"
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
        let count = self.tick_once().await?;
        if count == 0 {
            Ok(WorkerOutcome::Skipped)
        } else {
            Ok(WorkerOutcome::Processed(count))
        }
    }
}

fn expiry_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("expiry sweeper: {error}"))
}

/// Kept public so the poll worker can reuse the same conditional terminal write semantics.
pub async fn release_slot(
    conn: &mut PgConnection,
    link_id: Uuid,
    delta: i32,
) -> Result<(), WorkerError> {
    sqlx::query(EXPIRY_RELEASE_SLOT_SQL)
        .bind(link_id)
        .bind(delta)
        .execute(&mut *conn)
        .await
        .map_err(expiry_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn attempt(status: &str, point_of_no_return: bool, substatus: Option<&str>) -> AttemptRow {
        AttemptRow {
            id: Uuid::now_v7(),
            merchant_id: Uuid::now_v7(),
            link_id: Uuid::now_v7(),
            route_id: Uuid::now_v7(),
            status: status.to_owned(),
            substatus: substatus.map(str::to_owned),
            point_of_no_return,
            expires_at: now_utc(),
            grace_expires_at: now_utc(),
            created_at: now_utc(),
            terminal_at: None,
            next_check_at: None,
            currency: "LYD".to_owned(),
            total_charged_amount: Decimal::from_str("10.0000").expect("decimal"),
            net_merchant_amount: Decimal::from_str("9.7000").expect("decimal"),
            canonical_error: None,
            settled_amount: None,
            gateway_fee_amount: None,
        }
    }

    #[test]
    fn status_constants_match_the_generated_enum() {
        use pg_types::generated::enums::AttemptStatus;
        let generated = [
            AttemptStatus::Created.as_str(),
            AttemptStatus::Initiating.as_str(),
            AttemptStatus::AwaitingCustomer.as_str(),
            AttemptStatus::Authorizing.as_str(),
            AttemptStatus::Verifying.as_str(),
        ];
        assert_eq!(EXPIRABLE_STATUSES, generated);
        let release = [
            AttemptStatus::Failed.as_str(),
            AttemptStatus::Expired.as_str(),
            AttemptStatus::Cancelled.as_str(),
        ];
        assert_eq!(RELEASE_SLOT_STATUSES, release);
        let money = [
            AttemptStatus::Authorizing.as_str(),
            AttemptStatus::Verifying.as_str(),
        ];
        assert_eq!(MONEY_IN_FLIGHT_STATUSES, money);
    }

    #[test]
    fn money_in_flight_requires_the_flag_and_a_money_state() {
        assert!(attempt("AUTHORIZING", true, None).money_may_have_moved());
        assert!(attempt("VERIFYING", true, None).money_may_have_moved());
        // A wrong OTP returns to AWAITING_CUSTOMER with the flag still set: it expires normally.
        assert!(!attempt("AWAITING_CUSTOMER", true, None).money_may_have_moved());
        assert!(!attempt("AUTHORIZING", false, None).money_may_have_moved());
        assert!(!attempt("CREATED", true, None).money_may_have_moved());
        assert!(!attempt("UNKNOWN", true, None).money_may_have_moved());
    }

    #[test]
    fn only_the_five_open_states_are_expirable() {
        for status in EXPIRABLE_STATUSES {
            assert!(attempt(status, false, None).is_expirable(), "{status}");
        }
        for status in [
            "UNKNOWN",
            "SUCCEEDED",
            "FAILED",
            "EXPIRED",
            "CANCELLED",
            "BLOCKED",
        ] {
            assert!(!attempt(status, false, None).is_expirable(), "{status}");
        }
    }

    #[test]
    fn slot_release_states_match_typescript() {
        for status in RELEASE_SLOT_STATUSES {
            assert!(attempt("CREATED", false, None).releases_slot_on(status));
        }
        assert!(!attempt("CREATED", false, None).releases_slot_on("SUCCEEDED"));
        assert!(!attempt("CREATED", false, None).releases_slot_on("BLOCKED"));
    }

    #[test]
    fn select_sql_excludes_aml_holds_and_locks_the_batch() {
        assert!(EXPIRY_SELECT_SQL.contains("FOR UPDATE SKIP LOCKED"));
        assert!(EXPIRY_SELECT_SQL.contains("substatus <> $2"));
        assert!(EXPIRY_SELECT_SQL.contains("terminal_at IS NULL"));
        assert!(EXPIRY_SELECT_SQL.contains("expires_at <= $1"));
        for status in EXPIRABLE_STATUSES {
            assert!(EXPIRY_SELECT_SQL.contains(status));
        }
    }

    #[test]
    fn terminate_sql_never_overwrites_a_money_step_in_flight() {
        assert!(EXPIRY_TERMINATE_SQL.contains("terminal_at IS NULL"));
        assert!(EXPIRY_TERMINATE_SQL.contains("status = $3"));
        assert!(EXPIRY_TERMINATE_SQL.contains(
            "NOT (point_of_no_return = true AND status IN ('AUTHORIZING', 'VERIFYING'))"
        ));
    }

    #[test]
    fn inquiry_support_sql_uses_the_live_version_setting() {
        assert!(ROUTE_INQUIRY_SUPPORT_SQL.contains("gv.state = 'LIVE'"));
        assert!(ROUTE_INQUIRY_SUPPORT_SQL.contains("supports_status_check"));
        assert!(ROUTE_INQUIRY_SUPPORT_SQL.contains("version_number DESC"));
    }

    #[test]
    fn release_slot_sql_never_goes_negative() {
        assert!(EXPIRY_RELEASE_SLOT_SQL.contains("GREATEST(0"));
        assert!(EXPIRY_RELEASE_SLOT_SQL.contains("active_locked_count"));
    }
}
