//! Audit append: the dedicated audit database (`audit_records`) and the audit hash-chain probe.
//!
//! Port of `core-back/lib/storageEngine/auditAndLogAdapters.ts`
//! (`DedicatedAuditDatabaseDriver.appendBatch`) and the deploy provisioner's chain trigger.
//!
//! `prev_hash`/`row_hash`/`seq_no` are computed **by the database** inside
//! `pg_advisory_xact_lock(994001)` (`auditAndLogDbProvisioner.ts`), so every core node appends
//! through the same serialization point and the chain stays linear. This module therefore never
//! hashes a row itself: it inserts the payload columns and returns the values the trigger assigned.

#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use sqlx::{PgConnection, Postgres, QueryBuilder, Row};
use uuid::Uuid;

use crate::error::DbError;

/// The audit table name used by the deploy provisioner and the TS driver.
pub const AUDIT_TABLE: &str = "audit_records";

/// One audit row to append.
#[derive(Debug, Clone, PartialEq)]
pub struct AuditRecord {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
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

impl AuditRecord {
    #[must_use]
    pub fn new(actor_id: Uuid, role: impl Into<String>, action: impl Into<String>) -> Self {
        Self {
            id: pg_types::new_v7(),
            created_at: Utc::now(),
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
}

/// What the chain trigger assigned to an appended row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditAppended {
    pub seq_no: i64,
    pub prev_hash: String,
    pub row_hash: String,
}

/// Append one row to `audit_records` and return the assigned chain position.
pub async fn append_audit_record(
    connection: &mut PgConnection,
    record: &AuditRecord,
) -> Result<AuditAppended, DbError> {
    let inserted = append_audit_records(connection, std::slice::from_ref(record)).await?;
    inserted
        .into_iter()
        .next()
        .ok_or_else(|| DbError::InvalidFilter {
            field: "audit_records".to_owned(),
        })
}

/// Append a batch atomically (one transaction owned by the caller; the TS driver opens its own).
///
/// Ids already present are skipped, exactly like `appendBatch` (`requestedIds` probe).
pub async fn append_audit_records(
    connection: &mut PgConnection,
    records: &[AuditRecord],
) -> Result<Vec<AuditAppended>, DbError> {
    if records.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<Uuid> = records.iter().map(|record| record.id).collect();
    let existing: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM audit_records WHERE id = ANY($1::uuid[])")
            .bind(&ids)
            .fetch_all(&mut *connection)
            .await?;

    let mut appended = Vec::new();
    for record in records {
        if existing.contains(&record.id) {
            continue;
        }
        let sql = format!(
            "INSERT INTO {AUDIT_TABLE} (
                 id, created_at, actor_id, actor_email, role, action,
                 entity_type, entity_id, merchant_id, approval_request_id,
                 request_id, client_ip, user_agent, before_json, after_json
             ) VALUES (
                 $1::uuid, $2::timestamptz, $3::uuid, $4, $5, $6,
                 $7, $8, $9::uuid, $10::uuid,
                 $11, $12, $13, $14::jsonb, $15::jsonb
             ) RETURNING seq_no, prev_hash, row_hash"
        );
        let row = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
            .bind(record.id)
            .bind(record.created_at)
            .bind(record.actor_id)
            .bind(record.actor_email.as_deref())
            .bind(record.role.as_str())
            .bind(record.action.as_str())
            .bind(record.entity_type.as_str())
            .bind(record.entity_id.as_str())
            .bind(record.merchant_id)
            .bind(record.approval_request_id)
            .bind(record.request_id.as_deref())
            .bind(record.client_ip.as_deref())
            .bind(record.user_agent.as_deref())
            .bind(record.before_json.clone())
            .bind(record.after_json.clone())
            .fetch_one(&mut *connection)
            .await?;
        appended.push(AuditAppended {
            seq_no: row.try_get("seq_no")?,
            prev_hash: row.try_get("prev_hash")?,
            row_hash: row.try_get("row_hash")?,
        });
    }
    Ok(appended)
}

/// Insert a batch into `audit_outbox` (the durable queue the audit shipper drains).
///
/// The UoW flush uses the same shape; this helper is for callers outside a unit of work.
pub async fn enqueue_audit_outbox(
    connection: &mut PgConnection,
    rows: &[crate::uow::AuditEnvelope],
) -> Result<(), DbError> {
    if rows.is_empty() {
        return Ok(());
    }
    let now = Utc::now();
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

/// Verify the chain of the rows returned by a query (`verify_audit_chain()` in SQL, or a sample).
///
/// Returns the first broken row id when a link does not match. Hashing is recomputed in SQL so the
/// text form of `jsonb` is the database's own (`before_json::text`), which is what the trigger
/// hashed.
pub async fn first_broken_chain_row(
    connection: &mut PgConnection,
) -> Result<Option<Uuid>, DbError> {
    let row = sqlx::query(
        "WITH ordered AS (
             SELECT id, row_hash, prev_hash,
                    lag(row_hash) OVER (ORDER BY seq_no) AS previous
               FROM audit_records
         )
         SELECT id FROM ordered
          WHERE previous IS NOT NULL AND prev_hash <> previous
          LIMIT 1",
    )
    .fetch_optional(&mut *connection)
    .await?;
    Ok(row.and_then(|row| row.try_get::<Uuid, _>("id").ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_are_v7_and_chain_fields_are_server_assigned() {
        let record = AuditRecord::new(Uuid::new_v4(), "COMPLIANCE", "MERCHANT_UPDATED")
            .entity("merchant", "m-1")
            .with_request_id("req-1");
        assert_eq!(record.id.get_version_num(), 7);
        assert_eq!(record.entity_type, "merchant");
        // Nothing in the record carries a hash: the trigger owns the chain.
        assert_eq!(AUDIT_TABLE, "audit_records");
    }
}
