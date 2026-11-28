//! Unit of work: one transaction with a statement timeout, buffered outbox/audit rows and a
//! commit LSN.
//!
//! Port of `core-back/lib/storageEngine/uowAdapter.ts` (`PostgresUnitOfWorkAdapter`) and
//! chapter 2 §17. The transaction boundaries, the flush order (domain writes, then outbox, then
//! audit, then the LSN probe) and the timeout budget are the TS contract:
//!
//! - `statement_timeout = max(1000, timeoutMs − 250)` set with `SET LOCAL` inside the transaction;
//! - the caller's `maxWait` (Prisma `maxWait`, default 2,500 ms in this adapter) bounds the wait
//!   for a pooled connection, not the statement;
//! - outbox rows go to `outbox_events`, audit rows to `audit_outbox` (shipped later by the
//!   audit shipper to the dedicated audit database);
//! - `commit_lsn` is `pg_current_wal_flush_lsn()` read after commit, falling back to the
//!   in-transaction `pg_current_wal_lsn()` (`lsn.ts` semantics).

#![forbid(unsafe_code)]

use std::future::Future;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use futures_util::future::BoxFuture;
use sqlx::{PgConnection, PgPool, Postgres, QueryBuilder, Row};
use uuid::Uuid;

use crate::error::DbError;

/// Default transaction timeout (`Prisma` interactive transaction `timeout`).
pub const DEFAULT_TIMEOUT_MS: u64 = 5_000;
/// Default wait for a pooled connection (`maxWait` in `uowAdapter.ts`).
pub const DEFAULT_MAX_WAIT_MS: u64 = 2_500;

/// A buffered `outbox_events` row.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxEnvelope {
    pub topic: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub merchant_id: Option<Uuid>,
    pub payload: serde_json::Value,
}

impl OutboxEnvelope {
    #[must_use]
    pub fn new(
        topic: impl Into<String>,
        aggregate_type: impl Into<String>,
        aggregate_id: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            topic: topic.into(),
            aggregate_type: aggregate_type.into(),
            aggregate_id: aggregate_id.into(),
            merchant_id: None,
            payload,
        }
    }

    #[must_use]
    pub fn with_merchant(mut self, merchant_id: Uuid) -> Self {
        self.merchant_id = Some(merchant_id);
        self
    }
}

/// A buffered `audit_outbox` row (`AuditEnvelope` + the id the shipper preserves).
#[derive(Debug, Clone, PartialEq)]
pub struct AuditEnvelope {
    pub id: Uuid,
    pub actor_id: Uuid,
    pub actor_email: Option<String>,
    pub role: String,
    pub action: String,
    pub entity_type: String,
    pub entity_id: String,
    pub merchant_id: Option<Uuid>,
    pub approval_request_id: Option<Uuid>,
    pub request_id: Option<String>,
    pub client_ip: Option<String>,
    pub user_agent: Option<String>,
    pub before_json: serde_json::Value,
    pub after_json: serde_json::Value,
}

impl AuditEnvelope {
    /// A minimal audit row (empty before/after objects, like the TS caller default).
    #[must_use]
    pub fn new(actor_id: Uuid, role: impl Into<String>, action: impl Into<String>) -> Self {
        Self {
            // `uuidv7()` in `uowAdapter.ts`.
            id: pg_types::new_v7(),
            actor_id,
            actor_email: None,
            role: role.into(),
            action: action.into(),
            entity_type: String::new(),
            entity_id: String::new(),
            merchant_id: None,
            approval_request_id: None,
            request_id: None,
            client_ip: None,
            user_agent: None,
            before_json: serde_json::json!({}),
            after_json: serde_json::json!({}),
        }
    }

    #[must_use]
    pub fn entity(mut self, entity_type: impl Into<String>, entity_id: impl Into<String>) -> Self {
        self.entity_type = entity_type.into();
        self.entity_id = entity_id.into();
        self
    }

    #[must_use]
    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }

    #[must_use]
    pub fn with_before_after(
        mut self,
        before: serde_json::Value,
        after: serde_json::Value,
    ) -> Self {
        self.before_json = before;
        self.after_json = after;
        self
    }
}

/// Rows the caller buffered during the transaction.
#[derive(Debug, Default)]
pub struct Buffers {
    outbox: Vec<OutboxEnvelope>,
    audit: Vec<AuditEnvelope>,
}

impl Buffers {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// `tx.outbox.enqueue`.
    pub fn enqueue_outbox(&mut self, event: OutboxEnvelope) {
        self.outbox.push(event);
    }

    /// `tx.outbox.enqueueMany`.
    pub fn enqueue_outbox_many(&mut self, events: impl IntoIterator<Item = OutboxEnvelope>) {
        self.outbox.extend(events);
    }

    /// `tx.audit.record`: the caller receives the id it can return to the client.
    pub fn record_audit(&mut self, entry: AuditEnvelope) -> Uuid {
        let id = entry.id;
        self.audit.push(entry);
        id
    }

    #[must_use]
    pub fn outbox_len(&self) -> usize {
        self.outbox.len()
    }

    #[must_use]
    pub fn audit_len(&self) -> usize {
        self.audit.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.outbox.is_empty() && self.audit.is_empty()
    }
}

/// Transaction isolation, mirroring `Prisma.TransactionIsolationLevel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Isolation {
    #[default]
    ReadCommitted,
    RepeatableRead,
    Serializable,
}

impl Isolation {
    #[must_use]
    pub fn sql(self) -> Option<&'static str> {
        match self {
            // The server default; no statement is issued (Prisma does the same).
            Self::ReadCommitted => None,
            Self::RepeatableRead => Some("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"),
            Self::Serializable => Some("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"),
        }
    }
}

/// Timeout and wait budgets for one transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UowOptions {
    pub timeout_ms: u64,
    pub max_wait_ms: u64,
    pub isolation: Isolation,
}

impl Default for UowOptions {
    fn default() -> Self {
        Self {
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_wait_ms: DEFAULT_MAX_WAIT_MS,
            isolation: Isolation::ReadCommitted,
        }
    }
}

impl UowOptions {
    #[must_use]
    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    #[must_use]
    pub fn with_max_wait_ms(mut self, max_wait_ms: u64) -> Self {
        self.max_wait_ms = max_wait_ms;
        self
    }

    #[must_use]
    pub fn with_isolation(mut self, isolation: Isolation) -> Self {
        self.isolation = isolation;
        self
    }

    /// `Math.max(1000, timeoutMs - 250)`.
    #[must_use]
    pub fn statement_timeout_ms(&self) -> u64 {
        self.timeout_ms.saturating_sub(250).max(1_000)
    }
}

/// What a successful unit of work returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UowResult<T> {
    pub data: T,
    /// Flush LSN after commit (in-transaction LSN when the post-commit probe fails).
    pub commit_lsn: String,
    pub duration_ms: u64,
}

/// The future a unit-of-work body returns. Boxed so the closure can borrow the connection.
pub type UowFuture<'a, T> = BoxFuture<'a, Result<T, DbError>>;

/// Run `body` inside one transaction.
///
/// The closure receives the transaction connection and the buffers; every domain write must use the
/// connection so it commits or rolls back with the buffered rows.
pub async fn run<T, F>(pool: &PgPool, options: UowOptions, body: F) -> Result<UowResult<T>, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection, &'c mut Buffers) -> UowFuture<'c, T>,
{
    let started = Instant::now();
    let mut tx = tokio::time::timeout(Duration::from_millis(options.max_wait_ms), pool.begin())
        .await
        .map_err(|_| DbError::PoolWaitTimeout)??;

    if let Some(statement) = options.isolation.sql() {
        sqlx::query(statement).execute(&mut *tx).await?;
    }
    // `set_config(..., is_local = true)` is the parameterised form of `SET LOCAL` (`uowAdapter.ts`).
    sqlx::query("SELECT set_config('statement_timeout', $1, true)")
        .bind(format!("{}ms", options.statement_timeout_ms()))
        .execute(&mut *tx)
        .await?;

    let mut buffers = Buffers::new();
    let data = body(&mut tx, &mut buffers).await?;
    flush_outbox(&mut tx, &buffers.outbox).await?;
    flush_audit(&mut tx, &buffers.audit).await?;

    let in_transaction_lsn: String = sqlx::query("SELECT pg_current_wal_lsn()::text AS lsn")
        .fetch_optional(&mut *tx)
        .await?
        .and_then(|row| row.try_get::<String, _>("lsn").ok())
        .unwrap_or_else(|| "0/0".to_owned());

    tx.commit().await?;

    // Read the flush position after commit: a replica that reached this watermark has definitely
    // replayed the write (uowAdapter.ts:170-186).
    let commit_lsn = sqlx::query("SELECT pg_current_wal_flush_lsn()::text AS lsn")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.try_get::<String, _>("lsn").ok())
        .unwrap_or(in_transaction_lsn);

    Ok(UowResult {
        data,
        commit_lsn,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

async fn flush_outbox(
    connection: &mut PgConnection,
    rows: &[OutboxEnvelope],
) -> Result<(), DbError> {
    if rows.is_empty() {
        return Ok(());
    }
    let now: DateTime<Utc> = Utc::now();
    let mut builder: QueryBuilder<Postgres> = QueryBuilder::new(
        "INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, merchant_id, payload_json, created_at) ",
    );
    builder.push_values(rows, |mut bind, row| {
        bind.push_bind(row.topic.as_str())
            .push_bind(row.aggregate_type.as_str())
            .push_bind(row.aggregate_id.as_str())
            .push_bind(row.merchant_id)
            .push_bind(row.payload.clone())
            .push_bind(now);
    });
    builder.build().execute(connection).await?;
    Ok(())
}

async fn flush_audit(connection: &mut PgConnection, rows: &[AuditEnvelope]) -> Result<(), DbError> {
    if rows.is_empty() {
        return Ok(());
    }
    let now: DateTime<Utc> = Utc::now();
    let mut builder: QueryBuilder<Postgres> = QueryBuilder::new(
        "INSERT INTO audit_outbox (id, actor_id, actor_email, role, action, entity_type, entity_id, merchant_id, approval_request_id, request_id, client_ip, user_agent, before_json, after_json, created_at) ",
    );
    builder.push_values(rows, |mut bind, row| {
        bind.push_bind(row.id)
            .push_bind(row.actor_id)
            .push_bind(row.actor_email.as_deref())
            .push_bind(row.role.as_str())
            .push_bind(row.action.as_str())
            .push_bind(row.entity_type.as_str())
            .push_bind(row.entity_id.as_str())
            .push_bind(row.merchant_id)
            .push_bind(row.approval_request_id)
            .push_bind(row.request_id.as_deref())
            .push_bind(row.client_ip.as_deref())
            .push_bind(row.user_agent.as_deref())
            .push_bind(row.before_json.clone())
            .push_bind(row.after_json.clone())
            .push_bind(now);
    });
    builder.build().execute(connection).await?;
    Ok(())
}

/// Helper for callers that want a boxed future without spelling the type.
pub fn boxed<'a, T>(
    future: impl Future<Output = Result<T, DbError>> + Send + 'a,
) -> UowFuture<'a, T>
where
    T: Send + 'a,
{
    Box::pin(future)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statement_timeout_is_floored() {
        assert_eq!(
            UowOptions::default()
                .with_timeout_ms(5_000)
                .statement_timeout_ms(),
            4_750
        );
        assert_eq!(
            UowOptions::default()
                .with_timeout_ms(1_000)
                .statement_timeout_ms(),
            1_000
        );
        assert_eq!(
            UowOptions::default()
                .with_timeout_ms(100)
                .statement_timeout_ms(),
            1_000
        );
    }

    #[test]
    fn buffers_assign_v7_ids() {
        let mut buffers = Buffers::new();
        let actor = Uuid::new_v4();
        let id = buffers.record_audit(AuditEnvelope::new(actor, "COMPLIANCE", "MERCHANT_UPDATED"));
        assert_eq!(buffers.audit_len(), 1);
        assert_eq!(id.get_version_num(), 7);
        buffers.enqueue_outbox(OutboxEnvelope::new(
            "attempt.transitioned",
            "payment_attempt",
            "a-1",
            serde_json::json!({"status": "SUCCEEDED"}),
        ));
        assert_eq!(buffers.outbox_len(), 1);
        assert!(!buffers.is_empty());
    }

    #[test]
    fn isolation_statements_match_prisma() {
        assert_eq!(Isolation::ReadCommitted.sql(), None);
        assert_eq!(
            Isolation::Serializable.sql(),
            Some("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        );
    }
}
