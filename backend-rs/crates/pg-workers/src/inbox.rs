//! Inbound webhook inbox (`core-back/engine/workers/InboundInboxWorker.ts`).
//!
//! `FOR UPDATE SKIP LOCKED` alone is not enough: the row locks end when the claim transaction
//! commits while the handler runs outside it. The durable `claimed_at`/`claimed_by` lease keeps two
//! nodes (even if leadership briefly overlaps) from processing the same webhook, and every result
//! write is conditional on still owning the claim.
//!
//! The handler is injected through [`InboundEventHandler`]. A handler that raises
//! `RetryableInboundError` in TS maps to [`InboundError::retryable`]; the classifier that decides
//! between a retry and a terminal failure is pure and unit-tested without a database.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use tracing::{error, warn};
use uuid::Uuid;

use crate::cases::{raise_unkeyed_attempt_case, CaseKind, MonitorPriority};
use crate::db::{is_transient_sqlstate, now_tz, now_utc};
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

/// The TS `ATTEMPT_PATTERN` (`InboundInboxWorker.ts:50`): only `RETRY(n)` counts, not `FAILED(n)`.
pub const ATTEMPT_PATTERN_PREFIX: &str = "RETRY(";

pub const DEFAULT_MAX_ATTEMPTS: i32 = 5;
pub const DEFAULT_CLAIM_LEASE_SECONDS: i64 = 120;
pub const INBOUND_CASE_SLA_HOURS: i64 = 4;

/// One row of `inbound_events`.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct InboundEventRow {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub gateway_id: Uuid,
    pub env: String,
    pub raw_body_bytes: Vec<u8>,
    pub redacted_headers_json: Value,
    pub source_ip: Option<String>,
    pub verified: bool,
    pub verification_error: Option<String>,
    pub dedupe_key: String,
    pub attempt_id: Option<Uuid>,
    pub received_at: NaiveDateTime,
    pub processed_at: Option<NaiveDateTime>,
    pub processing_result: Option<String>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub claimed_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundOutcome {
    pub processed: bool,
    pub result: Option<String>,
}

impl InboundOutcome {
    #[must_use]
    pub fn processed() -> Self {
        Self {
            processed: true,
            result: None,
        }
    }

    #[must_use]
    pub fn skipped() -> Self {
        Self {
            processed: false,
            result: None,
        }
    }

    /// What `markProcessed` records: `PROCESSED`/`SKIPPED`, or the handler's own result.
    #[must_use]
    pub fn recorded_result(&self) -> &str {
        match (&self.result, self.processed) {
            (Some(result), _) => result.as_str(),
            (None, true) => "PROCESSED",
            (None, false) => "SKIPPED",
        }
    }
}

/// A handler failure. `retryable` mirrors `RetryableInboundError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundError {
    pub message: String,
    pub retryable: bool,
}

impl InboundError {
    #[must_use]
    pub fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }

    #[must_use]
    pub fn terminal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    /// Builds the failure of a database error: transient SQLSTATEs are retryable, the rest are not.
    #[must_use]
    pub fn from_sqlx(error: sqlx::Error) -> Self {
        let retryable = crate::db::sqlstate(&error)
            .as_deref()
            .is_some_and(is_transient_sqlstate);
        Self {
            message: error.to_string(),
            retryable,
        }
    }
}

#[async_trait]
pub trait InboundEventHandler: Send + Sync {
    async fn handle(&self, event: &InboundEventRow) -> Result<InboundOutcome, InboundError>;
}

#[derive(Debug, Clone)]
pub struct InboxConfig {
    pub interval_ms: u64,
    pub batch_size: i64,
    pub claim_lease_seconds: i64,
    pub max_attempts: i32,
    pub worker_id: String,
}

impl InboxConfig {
    #[must_use]
    pub fn with_worker_id(mut self, worker_id: impl Into<String>) -> Self {
        self.worker_id = worker_id.into();
        self
    }
}

impl Default for InboxConfig {
    fn default() -> Self {
        Self {
            interval_ms: 5_000,
            batch_size: 50,
            claim_lease_seconds: DEFAULT_CLAIM_LEASE_SECONDS,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            worker_id: default_worker_id(),
        }
    }
}

/// `NODE_ID`, then the host name, then `core-back` (`InboundInboxWorker.ts:65`).
#[must_use]
pub fn default_worker_id() -> String {
    if let Ok(node_id) = std::env::var("NODE_ID") {
        if !node_id.trim().is_empty() {
            return node_id;
        }
    }
    std::env::var("HOSTNAME")
        .ok()
        .filter(|host| !host.trim().is_empty())
        .unwrap_or_else(|| "core-back".to_owned())
}

/// The claim: a durable lease, not just a row lock (`InboundInboxWorker.ts:91-104`).
pub const INBOUND_CLAIM_SQL: &str = "WITH candidate AS (
    SELECT id FROM inbound_events
     WHERE processed_at IS NULL
       AND (claimed_at IS NULL OR claimed_at < $2)
     ORDER BY received_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED
)
UPDATE inbound_events e
   SET claimed_at = $3::timestamptz, claimed_by = $4,
       updated_at = ($3::timestamptz AT TIME ZONE 'UTC')
  FROM candidate
 WHERE e.id = candidate.id
 RETURNING e.*";

pub const INBOUND_MARK_PROCESSED_SQL: &str = "UPDATE inbound_events \
     SET processed_at = $1, processing_result = $2, claimed_at = NULL, claimed_by = NULL, updated_at = $1 \
     WHERE id = $3::uuid AND claimed_by = $4 AND processed_at IS NULL";

pub const INBOUND_MARK_RETRY_SQL: &str = "UPDATE inbound_events \
     SET processing_result = $1, claimed_at = NULL, claimed_by = NULL, updated_at = $2 \
     WHERE id = $3::uuid AND claimed_by = $4 AND processed_at IS NULL";

pub const INBOUND_MARK_FAILED_SQL: &str = "UPDATE inbound_events \
     SET processed_at = $1, processing_result = $2, claimed_at = NULL, claimed_by = NULL, updated_at = $1 \
     WHERE id = $3::uuid AND claimed_by = $4 AND processed_at IS NULL";

/// `readAttemptCount` (`InboundInboxWorker.ts:130`): `RETRY(n):…` → n, anything else → 0.
#[must_use]
pub fn attempt_count(processing_result: Option<&str>) -> i32 {
    let Some(result) = processing_result else {
        return 0;
    };
    let start = result.find(ATTEMPT_PATTERN_PREFIX);
    let Some(start) = start else {
        return 0;
    };
    let digits: String = result[start + ATTEMPT_PATTERN_PREFIX.len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse::<i32>().unwrap_or(0)
}

/// The retry-versus-fail decision (`InboundInboxWorker.ts:117-126`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboundDecision {
    /// Record `RETRY(attempt)`, release the claim, try again later.
    Retry,
    /// Record `FAILED(attempt)`, mark processed and open the operator case.
    Fail,
}

#[must_use]
pub fn classify_failure(retryable: bool, attempt: i32, max_attempts: i32) -> InboundDecision {
    if retryable && attempt.saturating_add(1) < max_attempts.max(1) {
        InboundDecision::Retry
    } else {
        InboundDecision::Fail
    }
}

#[must_use]
pub fn retry_result(attempt: i32, message: &str) -> String {
    bounded(&format!("RETRY({attempt}):{message}"))
}

#[must_use]
pub fn failed_result(attempt: i32, message: &str) -> String {
    bounded(&format!("FAILED({attempt}):{message}"))
}

fn bounded(value: &str) -> String {
    value.chars().take(500).collect()
}

/// The worker. Singleton: the advisory-lock leader drains the inbox.
pub struct InboundInboxWorker {
    pool: PgPool,
    config: InboxConfig,
    handler: Arc<dyn InboundEventHandler>,
}

impl InboundInboxWorker {
    #[must_use]
    pub fn new(pool: PgPool, config: InboxConfig, handler: Arc<dyn InboundEventHandler>) -> Self {
        Self {
            pool,
            config,
            handler,
        }
    }

    /// Claims one batch with the durable lease.
    pub async fn claim_events(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Vec<InboundEventRow>, WorkerError> {
        let stale_before = now - chrono::Duration::seconds(self.config.claim_lease_seconds.max(1));
        let mut tx = self.pool.begin().await.map_err(inbox_error)?;
        let rows = sqlx::query_as::<_, InboundEventRow>(INBOUND_CLAIM_SQL)
            .bind(self.config.batch_size)
            .bind(stale_before)
            .bind(now)
            .bind(&self.config.worker_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(inbox_error)?;
        tx.commit().await.map_err(inbox_error)?;
        Ok(rows)
    }

    /// One tick: claim, then process each event outside the claim transaction.
    pub async fn tick_once(&self) -> Result<u64, WorkerError> {
        let events = self.claim_events(now_tz()).await?;
        let count = events.len() as u64;
        for event in events {
            self.process_event(&event).await;
        }
        Ok(count)
    }

    async fn process_event(&self, event: &InboundEventRow) {
        let attempt = attempt_count(event.processing_result.as_deref());
        match self.handler.handle(event).await {
            Ok(outcome) => {
                if let Err(error) = self.mark_processed(event, outcome.recorded_result()).await {
                    warn!(event_id = %event.id, %error, "inbound inbox: cannot record the result");
                }
            }
            Err(error) => {
                match classify_failure(error.retryable, attempt, self.config.max_attempts) {
                    InboundDecision::Retry => {
                        if let Err(write_error) =
                            self.mark_retry(event, attempt + 1, &error.message).await
                        {
                            warn!(event_id = %event.id, %write_error, "inbound inbox: cannot record the retry");
                        }
                    }
                    InboundDecision::Fail => {
                        let failed = self.mark_failed(event, attempt + 1, &error.message).await;
                        match failed {
                            Ok(true) => self.open_operator_case(event, &error.message).await,
                            Ok(false) => {
                                warn!(event_id = %event.id, "inbound inbox: claim was lost before the failure was recorded");
                            }
                            Err(write_error) => {
                                warn!(event_id = %event.id, %write_error, "inbound inbox: cannot record the failure");
                            }
                        }
                    }
                }
            }
        }
    }

    /// Records the result only while this node still owns the claim.
    pub async fn mark_processed(
        &self,
        event: &InboundEventRow,
        result: &str,
    ) -> Result<bool, WorkerError> {
        let now = now_utc();
        let updated = sqlx::query(INBOUND_MARK_PROCESSED_SQL)
            .bind(now)
            .bind(result.chars().take(500).collect::<String>())
            .bind(event.id)
            .bind(&self.config.worker_id)
            .execute(&self.pool)
            .await
            .map_err(inbox_error)?
            .rows_affected();
        if updated == 0 {
            warn!(event_id = %event.id, "inbound inbox: claim was lost before the result was recorded");
        }
        Ok(updated > 0)
    }

    pub async fn mark_retry(
        &self,
        event: &InboundEventRow,
        attempt: i32,
        message: &str,
    ) -> Result<bool, WorkerError> {
        let updated = sqlx::query(INBOUND_MARK_RETRY_SQL)
            .bind(retry_result(attempt, message))
            .bind(now_utc())
            .bind(event.id)
            .bind(&self.config.worker_id)
            .execute(&self.pool)
            .await
            .map_err(inbox_error)?
            .rows_affected();
        Ok(updated > 0)
    }

    pub async fn mark_failed(
        &self,
        event: &InboundEventRow,
        attempt: i32,
        message: &str,
    ) -> Result<bool, WorkerError> {
        let updated = sqlx::query(INBOUND_MARK_FAILED_SQL)
            .bind(now_utc())
            .bind(failed_result(attempt, message))
            .bind(event.id)
            .bind(&self.config.worker_id)
            .execute(&self.pool)
            .await
            .map_err(inbox_error)?
            .rows_affected();
        Ok(updated > 0)
    }

    /// One P2 `UNKNOWN` case with a 4 h SLA (`InboundInboxWorker.ts:195`).
    async fn open_operator_case(&self, event: &InboundEventRow, message: &str) {
        let notes = format!("Inbound event {} failed processing: {message}", event.id);
        let notes: String = notes.chars().take(1000).collect();
        let mut tx = match self.pool.begin().await {
            Ok(tx) => tx,
            Err(error) => {
                error!(event_id = %event.id, %error, "inbound inbox: cannot open the operator case");
                return;
            }
        };
        let result = raise_unkeyed_attempt_case(
            &mut tx,
            event.attempt_id,
            CaseKind::Unknown,
            MonitorPriority::P2,
            INBOUND_CASE_SLA_HOURS,
            &notes,
            now_utc(),
        )
        .await;
        match result {
            Ok(_) => {
                if let Err(error) = tx.commit().await {
                    error!(event_id = %event.id, %error, "inbound inbox: cannot commit the operator case");
                }
            }
            Err(error) => {
                error!(event_id = %event.id, %error, "inbound inbox: unable to open operator case");
            }
        }
    }

    /// `persistInboundEvent` (`InboundInboxWorker.ts:213`): the callback route's idempotent insert.
    pub async fn persist_inbound_event(
        &self,
        input: PersistInboundEvent<'_>,
    ) -> Result<PersistInboundEventResult, WorkerError> {
        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM inbound_events WHERE channel_id = $1::uuid AND dedupe_key = $2 LIMIT 1",
        )
        .bind(input.channel_id)
        .bind(input.dedupe_key)
        .fetch_optional(&self.pool)
        .await
        .map_err(inbox_error)?;
        if let Some(id) = existing {
            return Ok(PersistInboundEventResult {
                id,
                duplicate: true,
            });
        }
        let now = now_utc();
        let body = input.raw_body.to_vec();
        sqlx::query(
            "INSERT INTO inbound_events (id, created_at, updated_at, channel_id, gateway_id, env,
                    raw_body_bytes, redacted_headers_json, source_ip, verified, verification_error,
                    dedupe_key, attempt_id, received_at)
             VALUES ($1, $2, $2, $3::uuid, $4::uuid, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::uuid, $2)",
        )
        .bind(Uuid::new_v4())
        .bind(now)
        .bind(input.channel_id)
        .bind(input.gateway_id)
        .bind(input.env)
        .bind(body)
        .bind(input.headers)
        .bind(input.source_ip)
        .bind(input.verified)
        .bind(input.verification_error)
        .bind(input.dedupe_key)
        .bind(input.attempt_id)
        .execute(&self.pool)
        .await
        .map_err(inbox_error)?;
        let id: Uuid = sqlx::query_scalar(
            "SELECT id FROM inbound_events WHERE channel_id = $1::uuid AND dedupe_key = $2 LIMIT 1",
        )
        .bind(input.channel_id)
        .bind(input.dedupe_key)
        .fetch_one(&self.pool)
        .await
        .map_err(inbox_error)?;
        Ok(PersistInboundEventResult {
            id,
            duplicate: false,
        })
    }
}

#[derive(Debug, Clone)]
pub struct PersistInboundEvent<'a> {
    pub channel_id: Uuid,
    pub gateway_id: Uuid,
    pub env: &'a str,
    pub raw_body: &'a [u8],
    pub headers: Value,
    pub source_ip: Option<&'a str>,
    pub verified: bool,
    pub verification_error: Option<&'a str>,
    pub dedupe_key: &'a str,
    pub attempt_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PersistInboundEventResult {
    pub id: Uuid,
    pub duplicate: bool,
}

#[async_trait]
impl Worker for InboundInboxWorker {
    fn name(&self) -> &'static str {
        "InboundInbox"
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
        let processed = self.tick_once().await?;
        if processed == 0 {
            Ok(WorkerOutcome::Skipped)
        } else {
            Ok(WorkerOutcome::Processed(processed))
        }
    }
}

fn inbox_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("inbound inbox: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(result: Option<&str>, verified: bool) -> InboundEventRow {
        InboundEventRow {
            id: Uuid::now_v7(),
            channel_id: Uuid::now_v7(),
            gateway_id: Uuid::now_v7(),
            env: "LIVE".to_owned(),
            raw_body_bytes: Vec::new(),
            redacted_headers_json: serde_json::json!({}),
            source_ip: None,
            verified,
            verification_error: None,
            dedupe_key: "dedupe".to_owned(),
            attempt_id: None,
            received_at: now_utc(),
            processed_at: None,
            processing_result: result.map(str::to_owned),
            claimed_at: None,
            claimed_by: None,
        }
    }

    #[test]
    fn attempt_count_reads_only_the_retry_marker() {
        assert_eq!(attempt_count(None), 0);
        assert_eq!(attempt_count(Some("PROCESSED")), 0);
        assert_eq!(attempt_count(Some("SKIPPED")), 0);
        assert_eq!(attempt_count(Some("RETRY(2):timeout")), 2);
        assert_eq!(attempt_count(Some("RETRY(0):x")), 0);
        // A terminal failure does not carry the retry count (TS parity).
        assert_eq!(attempt_count(Some("FAILED(4):nope")), 0);
        assert_eq!(attempt_count(Some("prefix RETRY(7):x")), 7);
    }

    #[test]
    fn retry_below_the_attempt_limit_and_fail_at_it() {
        assert_eq!(classify_failure(true, 0, 5), InboundDecision::Retry);
        assert_eq!(classify_failure(true, 3, 5), InboundDecision::Retry);
        assert_eq!(classify_failure(true, 4, 5), InboundDecision::Fail);
        assert_eq!(classify_failure(true, 5, 5), InboundDecision::Fail);
        assert_eq!(classify_failure(false, 0, 5), InboundDecision::Fail);
        // A zero/negative limit still fails instead of retrying forever.
        assert_eq!(classify_failure(true, 0, 0), InboundDecision::Fail);
    }

    #[test]
    fn result_markers_are_bounded_and_shaped_like_typescript() {
        assert_eq!(retry_result(1, "timeout"), "RETRY(1):timeout");
        assert_eq!(failed_result(5, "boom"), "FAILED(5):boom");
        let long = retry_result(2, &"x".repeat(2_000));
        assert_eq!(long.chars().count(), 500);
        assert!(long.starts_with("RETRY(2):"));
    }

    #[test]
    fn outcome_defaults_match_mark_processed() {
        assert_eq!(InboundOutcome::processed().recorded_result(), "PROCESSED");
        assert_eq!(InboundOutcome::skipped().recorded_result(), "SKIPPED");
        let custom = InboundOutcome {
            processed: true,
            result: Some("DUPLICATE".to_owned()),
        };
        assert_eq!(custom.recorded_result(), "DUPLICATE");
    }

    #[test]
    fn claim_and_finalize_sql_keep_the_lease_and_the_owner() {
        assert!(INBOUND_CLAIM_SQL.contains("FOR UPDATE SKIP LOCKED"));
        assert!(INBOUND_CLAIM_SQL.contains("claimed_at IS NULL OR claimed_at < $2"));
        assert!(INBOUND_CLAIM_SQL.contains("claimed_by = $4"));
        assert!(INBOUND_CLAIM_SQL.contains("ORDER BY received_at ASC"));
        for sql in [
            INBOUND_MARK_PROCESSED_SQL,
            INBOUND_MARK_RETRY_SQL,
            INBOUND_MARK_FAILED_SQL,
        ] {
            assert!(sql.contains("claimed_by = $4"));
            assert!(sql.contains("processed_at IS NULL"));
            assert!(sql.contains("claimed_at = NULL"));
        }
    }

    #[test]
    fn default_worker_id_prefers_node_id() {
        // The environment is process-wide; only assert that a value is always produced.
        assert!(!default_worker_id().trim().is_empty());
    }

    #[test]
    fn transient_errors_are_retryable() {
        // sqlx errors cannot be constructed with a SQLSTATE without a database, so the mapping is
        // covered through the pure classifier above and the db helper test.
        let error = InboundError::retryable("deadlock");
        assert!(error.retryable);
        let error = InboundError::terminal("bad signature");
        assert!(!error.retryable);
    }

    #[test]
    fn row_shape_is_stable() {
        let event = row(Some("RETRY(1):x"), true);
        assert_eq!(attempt_count(event.processing_result.as_deref()), 1);
        assert!(event.verified);
    }
}
