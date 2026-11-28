//! Authentication and health repository reads.
//!
//! Port of the Prisma calls in `core-back/api/middleware/authDoubleCheck.ts`
//! (`resolveApiTokenPrincipal`, `resolveSessionPrincipal`) and the queue probe of
//! `core-back/engine/workers/productionRuntime.ts:readBackgroundJobQueueHealth`.
//!
//! The decisions stay in `pg-domain-auth`; these functions only load the rows the decisions need.

#![forbid(unsafe_code)]

use chrono::{DateTime, NaiveDateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::error::DbError;

/// An `access_tokens` row plus the merchant status and IP allow-list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessTokenRow {
    pub id: Uuid,
    /// `LIVE` / `SANDBOX` (`"GatewayEnvironmentType"`).
    pub env: String,
    pub merchant_id: Option<Uuid>,
    pub application_id: Option<Uuid>,
    /// `scopes` jsonb (an array or a `{scope: true}` map).
    pub scopes: serde_json::Value,
    pub ip_whitelist_enabled: bool,
    pub revoked_at: Option<NaiveDateTime>,
    pub expires_at: Option<NaiveDateTime>,
    /// `merchants.status` (`PENDING|ACTIVE|SUSPENDED|CLOSED`) or `None` when there is no merchant.
    pub merchant_status: Option<String>,
    /// `access_token_ips.cidr` entries.
    pub cidrs: Vec<String>,
}

impl AccessTokenRow {
    #[must_use]
    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }

    /// Expired when `expiresAt.getTime() <= Date.now()`.
    #[must_use]
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at
            .is_some_and(|expires| expires.and_utc() <= now)
    }

    #[must_use]
    pub fn merchant_active(&self, expected: Option<&str>) -> bool {
        expected.is_some_and(|status| status == "ACTIVE")
    }
}

/// The subset of `users` the session double check reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserRow {
    pub id: Uuid,
    /// `INVITED|ACTIVE|SUSPENDED|DISABLED`.
    pub status: String,
    /// `"UserRole"` as text (`COMPLIANCE`, `MERCHANT_ADMIN`, …).
    pub role: String,
    pub merchant_id: Option<Uuid>,
    pub authorities_map: serde_json::Value,
    pub app_scope_ids: serde_json::Value,
    pub sessions_invalid_before: Option<DateTime<Utc>>,
}

impl UserRow {
    #[must_use]
    pub fn is_active(&self) -> bool {
        self.status == "ACTIVE"
    }
}

/// `findUnique({ where: { tokenHash }, include: { ips: true } })`.
///
/// The env is read as text (`::text`) so the enum never has to be registered with sqlx.
pub async fn find_access_token(
    pool: &PgPool,
    token_hash: &str,
) -> Result<Option<AccessTokenRow>, DbError> {
    let row = sqlx::query(
        "SELECT t.id,
                t.env::text AS env,
                t.merchant_id,
                t.application_id,
                t.scopes,
                t.ip_whitelist_enabled,
                t.revoked_at,
                t.expires_at,
                m.status::text AS merchant_status,
                COALESCE(
                    (SELECT array_agg(i.cidr ORDER BY i.cidr) FROM access_token_ips i WHERE i.token_id = t.id),
                    ARRAY[]::text[]
                ) AS cidrs
           FROM access_tokens t
           LEFT JOIN merchants m ON m.id = t.merchant_id
          WHERE t.token_hash = $1",
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| AccessTokenRow {
        id: row.get("id"),
        env: row.get("env"),
        merchant_id: row.get("merchant_id"),
        application_id: row.get("application_id"),
        scopes: row.get("scopes"),
        ip_whitelist_enabled: row.get("ip_whitelist_enabled"),
        revoked_at: row.get("revoked_at"),
        expires_at: row.get("expires_at"),
        merchant_status: row.get("merchant_status"),
        cidrs: row.get("cidrs"),
    }))
}

/// `accessToken.update({ where: { id }, data: { lastUsedAt: new Date() } })`.
pub async fn touch_access_token(
    pool: &PgPool,
    id: Uuid,
    now: DateTime<Utc>,
) -> Result<(), DbError> {
    sqlx::query("UPDATE access_tokens SET last_used_at = $2 WHERE id = $1")
        .bind(id)
        .bind(now.naive_utc())
        .execute(pool)
        .await?;
    Ok(())
}

/// `user.findUnique({ where: { id } })`.
pub async fn find_user(pool: &PgPool, id: Uuid) -> Result<Option<UserRow>, DbError> {
    let row = sqlx::query(
        "SELECT id, status::text AS status, role::text AS role, merchant_id,
                authorities_map, app_scope_ids, sessions_invalid_before
           FROM users
          WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| UserRow {
        id: row.get("id"),
        status: row.get("status"),
        role: row.get("role"),
        merchant_id: row.get("merchant_id"),
        authorities_map: row.get("authorities_map"),
        // `app_scope_ids` is a nullable jsonb column in the schema.
        app_scope_ids: row
            .try_get::<Option<serde_json::Value>, _>("app_scope_ids")
            .ok()
            .flatten()
            .unwrap_or_else(|| serde_json::json!([])),
        sessions_invalid_before: row.get("sessions_invalid_before"),
    }))
}

/// `sessionRevocation.findUnique({ where: { jti }, select: { expiresAt: true } })`.
pub async fn find_session_revocation(
    pool: &PgPool,
    jti: &str,
) -> Result<Option<DateTime<Utc>>, DbError> {
    let expires_at: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT expires_at FROM session_revocations WHERE jti = $1")
            .bind(jti)
            .fetch_optional(pool)
            .await?;
    Ok(expires_at)
}

/// `sessionRevocation.upsert({ where: { jti }, create, update })`.
pub async fn upsert_session_revocation(
    pool: &PgPool,
    jti: &str,
    expires_at: DateTime<Utc>,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO session_revocations (jti, expires_at)
         VALUES ($1, $2)
         ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at",
    )
    .bind(jti)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// `sessionRevocation.deleteMany({ where: { expiresAt: { lt: now } } })`.
pub async fn prune_expired_revocations(pool: &PgPool, now: DateTime<Utc>) -> Result<u64, DbError> {
    let result = sqlx::query("DELETE FROM session_revocations WHERE expires_at < $1")
        .bind(now)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// The raw result of the durable queue probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueCounts {
    pub queued: i64,
    pub oldest_created_at: Option<NaiveDateTime>,
}

/// `readBackgroundJobQueueHealth` without the derived fields: count + the oldest QUEUED row.
pub async fn read_background_job_queue(pool: &PgPool) -> Result<QueueCounts, DbError> {
    let row = sqlx::query(
        "SELECT count(*) AS queued, min(created_at) AS oldest
           FROM background_jobs
          WHERE state = 'QUEUED'",
    )
    .fetch_one(pool)
    .await?;
    Ok(QueueCounts {
        queued: row.get("queued"),
        oldest_created_at: row.get("oldest"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> AccessTokenRow {
        AccessTokenRow {
            id: Uuid::new_v4(),
            env: "LIVE".to_owned(),
            merchant_id: Some(Uuid::new_v4()),
            application_id: Some(Uuid::new_v4()),
            scopes: serde_json::json!(["payment:read"]),
            ip_whitelist_enabled: false,
            revoked_at: None,
            expires_at: None,
            merchant_status: Some("ACTIVE".to_owned()),
            cidrs: Vec::new(),
        }
    }

    #[test]
    fn token_expiry_and_merchant_status_are_read_from_the_row() {
        let mut row = token();
        let now = Utc::now();
        assert!(!row.is_expired(now));
        row.expires_at = Some((now - chrono::Duration::seconds(1)).naive_utc());
        assert!(row.is_expired(now));
        assert!(row.merchant_active(Some("ACTIVE")));
        assert!(!row.merchant_active(Some("SUSPENDED")));
        assert!(!row.merchant_active(None));
        row.revoked_at = Some(now.naive_utc());
        assert!(row.is_revoked());
    }

    #[test]
    fn only_active_users_pass() {
        let mut user = UserRow {
            id: Uuid::new_v4(),
            status: "ACTIVE".to_owned(),
            role: "COMPLIANCE".to_owned(),
            merchant_id: None,
            authorities_map: serde_json::json!(["merchant:read"]),
            app_scope_ids: serde_json::json!([]),
            sessions_invalid_before: None,
        };
        assert!(user.is_active());
        user.status = "SUSPENDED".to_owned();
        assert!(!user.is_active());
    }
}
