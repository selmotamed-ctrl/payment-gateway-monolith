//! Transactional outbox relay (`core-back/lib/storageEngine/outboxWorkers.ts:459-952`).
//!
//! The relay claims one batch with `FOR UPDATE SKIP LOCKED`, delivers it to the registered
//! consumers *inside* the same transaction (first as a batch savepoint, then one by one so a poison
//! event cannot block the rows behind it), acknowledges what succeeded, marks an event parked after
//! `max_attempts` failed deliveries and prunes processed rows with a bounded, index-friendly delete.
//!
//! Consumers are injected through [`OutboxConsumer`]. That is the seam for the later HTTP work
//! (merchant webhook fan-out, AUTO-34): a consumer runs in the relay transaction and may write
//! delivery rows; it must not perform network I/O itself.
//!
//! Parity notes (see `DEVIATIONS.md`):
//! - the adaptive cadence is exposed through [`Worker::next_delay`] instead of the TS `setTimeout`;
//! - the `attempt.transitioned` read-model projector is registered as an acknowledging consumer
//!   (the projector SQL stays with the CQRS worker, P6-T02 remainder);
//! - the outbox never logs payloads, only ids and topics.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgConnection, PgPool, Row};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::cases::{
    outbox_parked_subject_key, raise_ledger_case, write_system_audit_pool, SystemAudit,
};
use crate::db::is_transient_sqlstate;
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

pub const RELAY_HEALTH_NAME: &str = "OutboxRelayWorker";
pub const AUDIT_SHIPPER_HEALTH_NAME: &str = "AuditShipperWorker";

/// `DEFAULT_OUTBOX_MAX_ATTEMPTS` (`outboxWorkers.ts:395`).
pub const DEFAULT_OUTBOX_MAX_ATTEMPTS: i32 = 10;

/// `OUTBOX_UNKNOWN_TOPIC_ERROR` (`outboxWorkers.ts:401`).
pub const OUTBOX_UNKNOWN_TOPIC_ERROR: &str =
    "UNKNOWN_TOPIC: no consumer is registered for this topic";

pub const MAX_ERROR_LENGTH: usize = 1_000;

/// Topics the TypeScript relay knows without a real consumer (`outboxWorkers.ts:507-520`) plus the
/// batch-projected `attempt.transitioned`.
pub const DEFAULT_KNOWN_TOPICS: &[&str] = &[
    "ledger.entry_posted",
    "merchant.updated",
    "kyb.document_uploaded",
    "reconciliation.completed",
    "config.invalidated",
    "link.expired",
    "dispute.opened",
    "dispute.closed",
    "cashout.paid",
    "cashout.failed",
    "attempt.transitioned",
];

/// One relational outbox event, serialised with the TS field names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEnvelope {
    /// `String(row.id)`: the TS envelope casts the bigint to a string.
    pub id: String,
    pub topic: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub merchant_id: Option<Uuid>,
    pub payload: Value,
}

/// The inputs of one `attempt.transitioned` payload
/// (`engine/runtime/attemptRepository.ts:280-297`).
#[derive(Debug, Clone, PartialEq)]
pub struct AttemptTransition<'a> {
    pub attempt_id: Uuid,
    pub merchant_id: Option<Uuid>,
    pub route_id: Option<Uuid>,
    pub currency: &'a str,
    pub status: &'a str,
    pub substatus: Option<&'a str>,
    pub total_charged_amount: &'a str,
    pub net_merchant_amount: &'a str,
    pub occurred_at: DateTime<Utc>,
}

impl OutboxEnvelope {
    /// The `attempt.transitioned` payload the engine/workers write.
    #[must_use]
    pub fn attempt_transitioned(transition: AttemptTransition<'_>) -> Self {
        let AttemptTransition {
            attempt_id,
            merchant_id,
            route_id,
            currency,
            status,
            substatus,
            total_charged_amount,
            net_merchant_amount,
            occurred_at,
        } = transition;
        Self {
            id: String::new(),
            topic: "attempt.transitioned".to_owned(),
            aggregate_type: "PAYMENT_ATTEMPT".to_owned(),
            aggregate_id: attempt_id.to_string(),
            merchant_id,
            payload: serde_json::json!({
                "event": "terminal",
                "attemptId": attempt_id,
                "merchantId": merchant_id,
                "routeId": route_id,
                "currency": currency,
                "status": status,
                "substatus": substatus,
                "totalChargedAmount": total_charged_amount,
                "netMerchantAmount": net_merchant_amount,
                "occurredAt": occurred_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            }),
        }
    }
}

/// A consumer of one outbox topic. Runs inside the relay transaction.
#[async_trait]
pub trait OutboxConsumer: Send + Sync {
    async fn consume(
        &self,
        conn: &mut PgConnection,
        events: &[OutboxEnvelope],
    ) -> Result<(), WorkerError>;
}

/// A consumer that does nothing (topics that are acknowledged without side effects yet).
#[derive(Debug, Default)]
pub struct NoopConsumer;

#[async_trait]
impl OutboxConsumer for NoopConsumer {
    async fn consume(
        &self,
        _conn: &mut PgConnection,
        _events: &[OutboxEnvelope],
    ) -> Result<(), WorkerError> {
        Ok(())
    }
}

/// Per-topic consumers, mirroring `OutboxRelayWorker`'s `handlers`, `batchHandlers` and `fanout`.
#[derive(Clone, Default)]
pub struct OutboxRegistry {
    per_event: BTreeMap<String, Arc<dyn OutboxConsumer>>,
    batch: BTreeMap<String, Arc<dyn OutboxConsumer>>,
    fanout: BTreeMap<String, Arc<dyn OutboxConsumer>>,
    known: BTreeSet<String>,
}

impl std::fmt::Debug for OutboxRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OutboxRegistry")
            .field("per_event", &self.per_event.keys().collect::<Vec<_>>())
            .field("batch", &self.batch.keys().collect::<Vec<_>>())
            .field("fanout", &self.fanout.keys().collect::<Vec<_>>())
            .field("known", &self.known)
            .finish()
    }
}

impl OutboxRegistry {
    /// The TypeScript defaults: known topics without side effects, `attempt.transitioned` as the
    /// (not yet ported) batch projector.
    #[must_use]
    pub fn new() -> Self {
        let mut registry = Self::default();
        for topic in DEFAULT_KNOWN_TOPICS {
            registry.known.insert((*topic).to_owned());
        }
        registry
            .batch
            .insert("attempt.transitioned".to_owned(), Arc::new(NoopConsumer));
        registry
    }

    /// A per-event handler. It overrides a batch handler of the same topic (`outboxWorkers.ts:527`).
    #[must_use]
    pub fn with_per_event(mut self, topic: &str, consumer: Arc<dyn OutboxConsumer>) -> Self {
        self.batch.remove(topic);
        self.known.insert(topic.to_owned());
        self.per_event.insert(topic.to_owned(), consumer);
        self
    }

    /// A batch handler (one call per topic and batch).
    #[must_use]
    pub fn with_batch(mut self, topic: &str, consumer: Arc<dyn OutboxConsumer>) -> Self {
        if !self.per_event.contains_key(topic) {
            self.known.insert(topic.to_owned());
            self.batch.insert(topic.to_owned(), consumer);
        }
        self
    }

    /// A consumer that runs in addition to the topic's own handler, in the same transaction
    /// (the merchant webhook fan-out).
    #[must_use]
    pub fn with_fanout(mut self, topic: &str, consumer: Arc<dyn OutboxConsumer>) -> Self {
        self.known.insert(topic.to_owned());
        self.fanout.insert(topic.to_owned(), consumer);
        self
    }

    /// A topic acknowledged without work.
    #[must_use]
    pub fn with_known_topic(mut self, topic: &str) -> Self {
        self.known.insert(topic.to_owned());
        self
    }

    #[must_use]
    pub fn is_known(&self, topic: &str) -> bool {
        self.known.contains(topic)
            || self.per_event.contains_key(topic)
            || self.batch.contains_key(topic)
            || self.fanout.contains_key(topic)
    }
}

#[derive(Debug, Clone)]
pub struct OutboxRetention {
    pub retention_ms: i64,
    pub prune_interval_ms: i64,
    pub prune_batch_size: i64,
}

impl Default for OutboxRetention {
    fn default() -> Self {
        Self {
            retention_ms: 3_600_000,
            prune_interval_ms: 60_000,
            prune_batch_size: 5_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct OutboxRelayConfig {
    pub interval_ms: i64,
    pub max_idle_interval_ms: i64,
    pub batch_size: i64,
    pub max_attempts: i32,
    /// `None` disables pruning (the TS `retentionMs <= 0` case).
    pub retention: Option<OutboxRetention>,
    /// Restricts the drain to these topics. `None` drains every topic (TS parity). Used by tests to
    /// stay away from rows they do not own and available for a topic-scoped emergency drain.
    pub topics: Option<Vec<String>>,
}

impl Default for OutboxRelayConfig {
    fn default() -> Self {
        Self {
            interval_ms: 250,
            max_idle_interval_ms: 2_000,
            batch_size: 100,
            max_attempts: DEFAULT_OUTBOX_MAX_ATTEMPTS,
            retention: Some(OutboxRetention::default()),
            topics: None,
        }
    }
}

/// In-process counters of one relay instance (reset on restart), same shape as the TS view.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OutboxRelayCounters {
    pub processed: u64,
    pub failed_deliveries: u64,
    pub parked: u64,
    pub unknown_topics: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Default)]
pub struct DrainOutcome {
    pub processed: u64,
    pub failed: u64,
    pub parked: Vec<OutboxParkedEvent>,
    pub unknown_topics: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxParkedEvent {
    pub id: String,
    pub topic: String,
    pub attempts: i32,
    pub last_error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxBacklogStats {
    pub oldest_pending_created_at: Option<DateTime<Utc>>,
    pub oldest_pending_age_ms: Option<i64>,
    pub parked_count: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct OutboxRow {
    id: i64,
    topic: String,
    aggregate_type: String,
    aggregate_id: String,
    merchant_id: Option<Uuid>,
    payload_json: Value,
    attempts: i32,
}

impl OutboxRow {
    fn envelope(&self) -> OutboxEnvelope {
        OutboxEnvelope {
            id: self.id.to_string(),
            topic: self.topic.clone(),
            aggregate_type: self.aggregate_type.clone(),
            aggregate_id: self.aggregate_id.clone(),
            merchant_id: self.merchant_id,
            payload: self.payload_json.clone(),
        }
    }
}

#[derive(Debug, Default)]
struct RelayState {
    delay_ms: i64,
    last_prune_ms: i64,
    counters: OutboxRelayCounters,
    pending_cases: BTreeMap<String, Vec<OutboxParkedEvent>>,
}

/// The relay. One instance per process; `drain`/`run_once` may also be driven by tests.
pub struct OutboxRelayWorker {
    pool: PgPool,
    registry: Arc<OutboxRegistry>,
    config: OutboxRelayConfig,
    state: Mutex<RelayState>,
}

impl OutboxRelayWorker {
    #[must_use]
    pub fn new(pool: PgPool, registry: Arc<OutboxRegistry>, config: OutboxRelayConfig) -> Self {
        Self {
            pool,
            registry,
            config,
            state: Mutex::new(RelayState::default()),
        }
    }

    #[must_use]
    pub fn counters(&self) -> OutboxRelayCounters {
        self.state.lock().counters.clone()
    }

    /// One drain + the due prune. The TS `tick` (`outboxWorkers.ts:587`).
    pub async fn run_once(&self) -> Result<u64, WorkerError> {
        let drained = self.drain().await?;
        self.prune_if_due().await?;
        let base = self.config.interval_ms.max(1);
        let previous = self.state.lock().delay_ms;
        let delay = next_poll_delay_ms(
            drained as i64,
            self.config.batch_size,
            previous,
            base,
            self.config.max_idle_interval_ms,
        );
        self.state.lock().delay_ms = delay;
        Ok(drained)
    }

    /// Claims and delivers one batch, then escalates parked events (`outboxWorkers.ts:683`).
    pub async fn drain(&self) -> Result<u64, WorkerError> {
        let outcome = self.drain_in_transaction().await?;
        {
            let mut state = self.state.lock();
            state.counters.processed += outcome.processed;
            state.counters.failed_deliveries += outcome.failed;
            state.counters.parked += outcome.parked.len() as u64;
            for (topic, count) in &outcome.unknown_topics {
                *state
                    .counters
                    .unknown_topics
                    .entry(topic.clone())
                    .or_insert(0) += count;
                warn!(
                    topic,
                    count, "outbox relay acknowledged events of an unknown topic"
                );
            }
        }
        self.escalate_parked(&outcome.parked).await;
        Ok(outcome.processed)
    }

    async fn drain_in_transaction(&self) -> Result<DrainOutcome, WorkerError> {
        let mut tx = self.pool.begin().await.map_err(relay_error)?;
        let rows = sqlx::query_as::<_, OutboxRow>(RELAY_SELECT_SQL)
            .bind(self.config.batch_size)
            .bind(self.config.topics.as_deref())
            .fetch_all(&mut *tx)
            .await
            .map_err(relay_error)?;
        let mut outcome = DrainOutcome::default();
        if rows.is_empty() {
            tx.commit().await.map_err(relay_error)?;
            return Ok(outcome);
        }

        let mut known = Vec::new();
        let mut unknown = Vec::new();
        for row in rows {
            if self.registry.is_known(&row.topic) {
                known.push(row);
            } else {
                unknown.push(row);
            }
        }

        let mut succeeded: Vec<OutboxRow> = Vec::new();
        let mut failures: Vec<(OutboxRow, String)> = Vec::new();
        if !known.is_empty() {
            let retrying = known.iter().any(|row| row.attempts > 0);
            let batch_error = if retrying {
                Some("skipped: batch contains a previously failed event".to_owned())
            } else {
                let events: Vec<OutboxEnvelope> = known.iter().map(OutboxRow::envelope).collect();
                self.dispatch_in_savepoint(&mut tx, "outbox_batch", &events)
                    .await
            };
            match batch_error {
                None => succeeded.extend(known),
                Some(batch_error) => {
                    if !retrying {
                        warn!(
                            events = known.len(),
                            error = %batch_error,
                            "outbox relay batch failed, retrying events one by one"
                        );
                    }
                    for row in known {
                        let events = [row.envelope()];
                        let error = self
                            .dispatch_in_savepoint(&mut tx, "outbox_event", &events)
                            .await;
                        match error {
                            None => succeeded.push(row),
                            Some(error) => failures.push((row, error)),
                        }
                    }
                }
            }
        }

        if !succeeded.is_empty() {
            let ids: Vec<i64> = succeeded.iter().map(|row| row.id).collect();
            sqlx::query(
                "UPDATE outbox_events SET processed_at = now() WHERE id = ANY($1::bigint[])",
            )
            .bind(&ids)
            .execute(&mut *tx)
            .await
            .map_err(relay_error)?;
        }
        if !unknown.is_empty() {
            let ids: Vec<i64> = unknown.iter().map(|row| row.id).collect();
            sqlx::query(
                "UPDATE outbox_events SET processed_at = now(), last_error = $2 \
                  WHERE id = ANY($1::bigint[])",
            )
            .bind(&ids)
            .bind(OUTBOX_UNKNOWN_TOPIC_ERROR)
            .execute(&mut *tx)
            .await
            .map_err(relay_error)?;
            for row in &unknown {
                *outcome.unknown_topics.entry(row.topic.clone()).or_insert(0) += 1;
            }
        }
        if !failures.is_empty() {
            let ids: Vec<i64> = failures.iter().map(|(row, _)| row.id).collect();
            let errors: Vec<String> = failures.iter().map(|(_, error)| error.clone()).collect();
            let updated = sqlx::query(
                "UPDATE outbox_events AS o
                    SET attempts = o.attempts + 1,
                        last_error = f.error,
                        parked_at = CASE WHEN o.attempts + 1 >= $3 THEN now() ELSE NULL END
                   FROM unnest($1::bigint[], $2::text[]) AS f(id, error)
                  WHERE o.id = f.id
                  RETURNING o.id, o.topic, o.attempts, o.parked_at, o.last_error",
            )
            .bind(&ids)
            .bind(&errors)
            .bind(self.config.max_attempts)
            .fetch_all(&mut *tx)
            .await
            .map_err(relay_error)?;
            for row in updated {
                let parked_at: Option<DateTime<Utc>> =
                    row.try_get("parked_at").map_err(relay_error)?;
                if parked_at.is_some() {
                    outcome.parked.push(OutboxParkedEvent {
                        id: row
                            .try_get::<i64, _>("id")
                            .map_err(relay_error)?
                            .to_string(),
                        topic: row.try_get("topic").map_err(relay_error)?,
                        attempts: row.try_get("attempts").map_err(relay_error)?,
                        last_error: row
                            .try_get::<Option<String>, _>("last_error")
                            .map_err(relay_error)?
                            .unwrap_or_default(),
                    });
                }
            }
            warn!(
                failed = failures.len(),
                parked = outcome.parked.len(),
                ids = ?failures.iter().map(|(row, _)| row.id).collect::<Vec<_>>(),
                "outbox relay delivery failed"
            );
        }
        outcome.processed = (succeeded.len() + unknown.len()) as u64;
        outcome.failed = failures.len() as u64;
        tx.commit().await.map_err(relay_error)?;
        Ok(outcome)
    }

    async fn dispatch_in_savepoint(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        name: &str,
        events: &[OutboxEnvelope],
    ) -> Option<String> {
        if let Err(error) = sqlx::query(sqlx::AssertSqlSafe(format!("SAVEPOINT {name}")))
            .execute(&mut **tx)
            .await
        {
            return Some(format!("savepoint {name}: {error}"));
        }
        match self.dispatch(tx, events).await {
            Ok(()) => {
                if let Err(error) =
                    sqlx::query(sqlx::AssertSqlSafe(format!("RELEASE SAVEPOINT {name}")))
                        .execute(&mut **tx)
                        .await
                {
                    return Some(format!("release savepoint {name}: {error}"));
                }
                None
            }
            Err(error) => {
                let _ = sqlx::query(sqlx::AssertSqlSafe(format!("ROLLBACK TO SAVEPOINT {name}")))
                    .execute(&mut **tx)
                    .await;
                let _ = sqlx::query(sqlx::AssertSqlSafe(format!("RELEASE SAVEPOINT {name}")))
                    .execute(&mut **tx)
                    .await;
                Some(error.to_string())
            }
        }
    }

    async fn dispatch(
        &self,
        conn: &mut PgConnection,
        events: &[OutboxEnvelope],
    ) -> Result<(), WorkerError> {
        let mut batched: BTreeMap<String, Vec<OutboxEnvelope>> = BTreeMap::new();
        let mut fanned: BTreeMap<String, Vec<OutboxEnvelope>> = BTreeMap::new();
        for event in events {
            if self.registry.fanout.contains_key(&event.topic) {
                fanned
                    .entry(event.topic.clone())
                    .or_default()
                    .push(event.clone());
            }
            if self.registry.batch.contains_key(&event.topic) {
                batched
                    .entry(event.topic.clone())
                    .or_default()
                    .push(event.clone());
                continue;
            }
            if let Some(consumer) = self.registry.per_event.get(&event.topic) {
                consumer.consume(conn, std::slice::from_ref(event)).await?;
            }
        }
        for (topic, events) in batched {
            if let Some(consumer) = self.registry.batch.get(&topic) {
                consumer.consume(conn, &events).await?;
            }
        }
        for (topic, events) in fanned {
            if let Some(consumer) = self.registry.fanout.get(&topic) {
                consumer.consume(conn, &events).await?;
            }
        }
        Ok(())
    }

    /// One system audit row per parked event and one keyed case per topic
    /// (`outboxWorkers.ts:808-841`). Failures are logged and retried on the next drain.
    async fn escalate_parked(&self, parked: &[OutboxParkedEvent]) {
        for event in parked {
            let audit = SystemAudit::new(
                "OUTBOX_EVENT_PARKED",
                "OUTBOX_EVENT",
                &event.id,
                serde_json::json!({ "parked": false }),
                serde_json::json!({
                    "parked": true,
                    "topic": event.topic,
                    "attempts": event.attempts,
                    "lastError": event.last_error,
                }),
            );
            if let Err(error) = write_system_audit_pool(&self.pool, &audit).await {
                error!(
                    id = %event.id,
                    topic = %event.topic,
                    %error,
                    "outbox relay could not audit a parked event"
                );
            }
            self.state
                .lock()
                .pending_cases
                .entry(event.topic.clone())
                .or_default()
                .push(event.clone());
        }
        let pending: Vec<(String, Vec<OutboxParkedEvent>)> = {
            let state = self.state.lock();
            state
                .pending_cases
                .iter()
                .map(|(topic, events)| (topic.clone(), events.clone()))
                .collect()
        };
        for (topic, events) in pending {
            let ids: Vec<&str> = events.iter().map(|event| event.id.as_str()).collect();
            let shown = ids.iter().take(20).copied().collect::<Vec<_>>().join(", ");
            let suffix = if ids.len() > 20 { ", ..." } else { "" };
            let notes = format!(
                "Outbox topic \"{topic}\" parked {} event(s) after {} failed deliveries (ids {shown}{suffix}). \
                 Last error: {}. Fix the consumer, then requeue the parked events.",
                events.len(),
                self.config.max_attempts,
                events.last().map(|event| event.last_error.as_str()).unwrap_or("")
            );
            let notes: String = notes.chars().take(MAX_ERROR_LENGTH).collect();
            let mut tx = match self.pool.begin().await {
                Ok(tx) => tx,
                Err(error) => {
                    error!(topic, %error, "outbox relay could not open the case transaction");
                    continue;
                }
            };
            match raise_ledger_case(
                &mut tx,
                &outbox_parked_subject_key(&topic),
                &notes,
                crate::db::now_utc(),
            )
            .await
            {
                Ok(_) => {
                    if let Err(error) = tx.commit().await {
                        error!(topic, %error, "outbox relay could not commit the parked-event case");
                        continue;
                    }
                    self.state.lock().pending_cases.remove(&topic);
                }
                Err(error) => {
                    error!(topic, %error, "outbox relay could not raise the parked-event case");
                }
            }
        }
    }

    /// Returns parked events to the queue with their attempts reset (`outboxWorkers.ts:874`).
    pub async fn requeue_parked(&self, topic: Option<&str>) -> Result<u64, WorkerError> {
        let result = match topic {
            Some(topic) => sqlx::query(
                "UPDATE outbox_events SET parked_at = NULL, attempts = 0 \
                  WHERE processed_at IS NULL AND parked_at IS NOT NULL AND topic = $1",
            )
            .bind(topic)
            .execute(&self.pool)
            .await
            .map_err(relay_error)?,
            None => sqlx::query(
                "UPDATE outbox_events SET parked_at = NULL, attempts = 0 \
                  WHERE processed_at IS NULL AND parked_at IS NOT NULL",
            )
            .execute(&self.pool)
            .await
            .map_err(relay_error)?,
        };
        Ok(result.rows_affected())
    }

    /// Backlog figures for the platform monitor (`outboxWorkers.ts:891`).
    pub async fn backlog_stats(
        &self,
        now: DateTime<Utc>,
    ) -> Result<OutboxBacklogStats, WorkerError> {
        let oldest: Option<DateTime<Utc>> = sqlx::query_scalar(
            "SELECT created_at FROM outbox_events \
              WHERE processed_at IS NULL AND parked_at IS NULL ORDER BY id ASC LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(relay_error)?;
        let parked: i64 = sqlx::query_scalar(
            "SELECT count(*)::bigint FROM outbox_events \
              WHERE processed_at IS NULL AND parked_at IS NOT NULL",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(relay_error)?;
        Ok(OutboxBacklogStats {
            oldest_pending_created_at: oldest,
            oldest_pending_age_ms: oldest.map(|created| (now - created).num_milliseconds().max(0)),
            parked_count: parked,
        })
    }

    async fn prune_if_due(&self) -> Result<(), WorkerError> {
        let Some(retention) = &self.config.retention else {
            return Ok(());
        };
        if retention.retention_ms <= 0 {
            return Ok(());
        }
        let now_ms = Utc::now().timestamp_millis();
        {
            let state = self.state.lock();
            if state.last_prune_ms != 0
                && now_ms - state.last_prune_ms < retention.prune_interval_ms
            {
                return Ok(());
            }
        }
        self.state.lock().last_prune_ms = now_ms;
        let pruned = self.prune(Utc::now()).await?;
        if pruned > 0 {
            info!(pruned, "outbox relay pruned processed events");
        }
        Ok(())
    }

    /// Bounded prune below the oldest pending id (`outboxWorkers.ts:930`). Parked rows are kept.
    pub async fn prune(&self, now: DateTime<Utc>) -> Result<u64, WorkerError> {
        let Some(retention) = &self.config.retention else {
            return Ok(0);
        };
        if retention.retention_ms <= 0 {
            return Ok(0);
        }
        let cutoff = now - ChronoDuration::milliseconds(retention.retention_ms);
        let result = sqlx::query(
            "DELETE FROM outbox_events
              WHERE id IN (
                SELECT id FROM outbox_events
                 WHERE id < COALESCE((SELECT min(id) FROM outbox_events WHERE processed_at IS NULL AND parked_at IS NULL), 9223372036854775807)
                   AND processed_at IS NOT NULL
                   AND parked_at IS NULL
                   AND processed_at < $1::timestamptz
                 ORDER BY id ASC
                 LIMIT $2
              )",
        )
        .bind(cutoff)
        .bind(retention.prune_batch_size)
        .execute(&self.pool)
        .await
        .map_err(relay_error)?;
        Ok(result.rows_affected())
    }
}

/// `nextPollDelayMs` (`outboxWorkers.ts:373-388`).
#[must_use]
pub fn next_poll_delay_ms(
    drained: i64,
    batch_size: i64,
    previous_delay_ms: i64,
    base_ms: i64,
    max_idle_ms: i64,
) -> i64 {
    let base = base_ms.max(1);
    let max_idle = max_idle_ms.max(1);
    if drained >= batch_size.max(1) {
        return 0;
    }
    if drained > 0 {
        return base;
    }
    let grown = if previous_delay_ms <= 0 {
        base
    } else {
        previous_delay_ms.saturating_mul(2)
    };
    // `Math.min(Math.max(baseMs, maxIdleMs), Math.max(baseMs, grown))`.
    base.max(max_idle).min(base.max(grown))
}

/// True when the next failed delivery parks the event (`attempts + 1 >= max`).
#[must_use]
pub fn parks_next(attempts: i32, max_attempts: i32) -> bool {
    attempts.saturating_add(1) >= max_attempts.max(1)
}

#[must_use]
pub fn error_text(error: impl std::fmt::Display) -> String {
    let text = error.to_string();
    if text.chars().count() <= MAX_ERROR_LENGTH {
        text
    } else {
        text.chars().take(MAX_ERROR_LENGTH).collect()
    }
}

fn relay_error(error: sqlx::Error) -> WorkerError {
    // The relay retries transient database failures through its next tick, like the TS loop.
    if let Some(code) = crate::db::sqlstate(&error) {
        if is_transient_sqlstate(&code) {
            return WorkerError::Failed(format!("transient database error {code}: {error}"));
        }
    }
    WorkerError::Failed(format!("outbox relay: {error}"))
}

#[async_trait]
impl Worker for OutboxRelayWorker {
    fn name(&self) -> &'static str {
        RELAY_HEALTH_NAME
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.config.interval_ms.max(1) as u64)
    }

    fn next_delay(&self) -> Option<Duration> {
        let delay = self.state.lock().delay_ms;
        if delay <= 0 {
            None
        } else {
            Some(Duration::from_millis(delay as u64))
        }
    }

    async fn tick(&self, ctx: &WorkerContext) -> Result<WorkerOutcome, WorkerError> {
        if ctx.shutting_down() {
            return Ok(WorkerOutcome::Deferred);
        }
        let processed = self.run_once().await?;
        Ok(WorkerOutcome::Processed(processed))
    }
}

/// Enqueues one event (`lib/storageEngine/outbox.ts:21`). Used by the expiry/poll workers.
pub async fn enqueue_outbox_event(
    conn: &mut PgConnection,
    event: &OutboxEnvelope,
    now: DateTime<Utc>,
) -> Result<(), WorkerError> {
    sqlx::query(
        "INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, merchant_id, payload_json, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
    )
    .bind(&event.topic)
    .bind(&event.aggregate_type)
    .bind(&event.aggregate_id)
    .bind(event.merchant_id)
    .bind(&event.payload)
    .bind(now)
    .execute(&mut *conn)
    .await
    .map_err(relay_error)?;
    Ok(())
}

/// The relay's own SQL, exported for the SQL-shape tests.
pub const RELAY_SELECT_SQL: &str =
    "SELECT id, topic, aggregate_type, aggregate_id, merchant_id, payload_json, attempts
   FROM outbox_events
  WHERE processed_at IS NULL
    AND parked_at IS NULL
    AND ($2::text[] IS NULL OR topic = ANY($2::text[]))
  ORDER BY id ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED";

pub const RELAY_PRUNE_SQL: &str = "DELETE FROM outbox_events
  WHERE id IN (
    SELECT id FROM outbox_events
     WHERE id < COALESCE((SELECT min(id) FROM outbox_events WHERE processed_at IS NULL AND parked_at IS NULL), 9223372036854775807)
       AND processed_at IS NOT NULL
       AND parked_at IS NULL
       AND processed_at < $1::timestamptz
     ORDER BY id ASC
     LIMIT $2
  )";

#[cfg(test)]
mod tests {
    use super::*;

    struct Failing;
    #[async_trait]
    impl OutboxConsumer for Failing {
        async fn consume(
            &self,
            _conn: &mut PgConnection,
            _events: &[OutboxEnvelope],
        ) -> Result<(), WorkerError> {
            Err(WorkerError::Failed("consumer failed".to_owned()))
        }
    }

    #[test]
    fn idle_backoff_doubles_to_the_cap() {
        assert_eq!(next_poll_delay_ms(0, 100, 0, 250, 2_000), 250);
        assert_eq!(next_poll_delay_ms(0, 100, 250, 250, 2_000), 500);
        assert_eq!(next_poll_delay_ms(0, 100, 500, 250, 2_000), 1_000);
        assert_eq!(next_poll_delay_ms(0, 100, 1_000, 250, 2_000), 2_000);
        assert_eq!(next_poll_delay_ms(0, 100, 2_000, 250, 2_000), 2_000);
        // A drained batch keeps the base cadence; a full batch is cut short.
        assert_eq!(next_poll_delay_ms(3, 100, 2_000, 250, 2_000), 250);
        assert_eq!(next_poll_delay_ms(100, 100, 2_000, 250, 2_000), 0);
        // A degenerate max idle never delays less than the base.
        assert_eq!(next_poll_delay_ms(0, 100, 5, 100, 10), 100);
    }

    #[test]
    fn parking_happens_on_the_max_attempt() {
        assert!(!parks_next(0, 10));
        assert!(!parks_next(8, 10));
        assert!(parks_next(9, 10));
        assert!(parks_next(10, 10));
        assert!(parks_next(0, 1));
    }

    #[test]
    fn known_topics_match_the_typescript_relay() {
        let registry = OutboxRegistry::new();
        for topic in [
            "ledger.entry_posted",
            "merchant.updated",
            "kyb.document_uploaded",
            "reconciliation.completed",
            "config.invalidated",
            "link.expired",
            "dispute.opened",
            "dispute.closed",
            "cashout.paid",
            "cashout.failed",
            "attempt.transitioned",
        ] {
            assert!(registry.is_known(topic), "{topic} must be known");
        }
        assert!(!registry.is_known("something.else"));
        assert_eq!(DEFAULT_KNOWN_TOPICS.len(), 11);
    }

    #[test]
    fn per_event_registration_overrides_the_batch_handler() {
        let registry = OutboxRegistry::new()
            .with_per_event("attempt.transitioned", Arc::new(NoopConsumer))
            .with_batch("attempt.transitioned", Arc::new(Failing))
            .with_batch("custom.topic", Arc::new(Failing))
            .with_fanout("dispute.opened", Arc::new(Failing))
            .with_known_topic("a.quiet.topic");
        assert!(registry.per_event.contains_key("attempt.transitioned"));
        assert!(!registry.batch.contains_key("attempt.transitioned"));
        assert!(registry.is_known("custom.topic"));
        assert!(registry.is_known("a.quiet.topic"));
        assert!(registry.is_known("dispute.opened"));
        assert_eq!(registry.fanout.len(), 1);
    }

    #[test]
    fn unknown_topic_error_and_subject_key_are_stable() {
        assert_eq!(
            OUTBOX_UNKNOWN_TOPIC_ERROR,
            "UNKNOWN_TOPIC: no consumer is registered for this topic"
        );
        assert_eq!(
            outbox_parked_subject_key("attempt.transitioned"),
            "outbox.parked:attempt.transitioned"
        );
    }

    #[test]
    fn selection_and_prune_sql_keep_the_lease_and_the_parked_exclusion() {
        assert!(RELAY_SELECT_SQL.contains("FOR UPDATE SKIP LOCKED"));
        assert!(RELAY_SELECT_SQL.contains("processed_at IS NULL"));
        assert!(RELAY_SELECT_SQL.contains("parked_at IS NULL"));
        assert!(RELAY_PRUNE_SQL.contains("processed_at IS NOT NULL"));
        assert!(RELAY_PRUNE_SQL.contains("parked_at IS NULL"));
        assert!(RELAY_PRUNE_SQL.contains("min(id)"));
        assert!(RELAY_PRUNE_SQL.contains("LIMIT $2"));
    }

    #[test]
    fn transitioned_payload_has_the_typescript_shape() {
        let attempt = Uuid::parse_str("018f0000-0000-7000-8000-000000000003").expect("uuid");
        let merchant = Uuid::parse_str("018f0000-0000-7000-8000-000000000004").expect("uuid");
        let event = OutboxEnvelope::attempt_transitioned(AttemptTransition {
            attempt_id: attempt,
            merchant_id: Some(merchant),
            route_id: None,
            currency: "LYD",
            status: "EXPIRED",
            substatus: None,
            total_charged_amount: "10.0000",
            net_merchant_amount: "9.7000",
            occurred_at: Utc::now(),
        });
        assert_eq!(event.topic, "attempt.transitioned");
        assert_eq!(event.payload["event"], "terminal");
        assert_eq!(event.payload["attemptId"], attempt.to_string());
        assert_eq!(event.payload["merchantId"], merchant.to_string());
        assert!(event.payload["occurredAt"]
            .as_str()
            .expect("timestamp")
            .ends_with('Z'));
    }

    #[test]
    fn error_text_is_bounded() {
        let text = error_text("x".repeat(5_000));
        assert_eq!(text.chars().count(), MAX_ERROR_LENGTH);
    }
}
