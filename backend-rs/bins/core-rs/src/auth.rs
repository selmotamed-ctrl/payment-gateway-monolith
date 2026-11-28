//! Authentication double check: session JWTs and API tokens.
//!
//! Port of `core-back/api/middleware/authDoubleCheck.ts` (`authenticate`, `resolveApiTokenPrincipal`,
//! `resolveSessionPrincipal`), `core-back/lib/auth/revocation.ts` and
//! `core-back/api/middleware/mtlsGuard.ts`.
//!
//! Order and error codes are the TS contract (chapter 2 §5):
//!
//! - bearer token required → `401 AUTH_REQUIRED`;
//! - `pg_live_`/`pg_test_` prefix → API token: plane prefix → row by hex SHA-256 → plane column →
//!   revoked → scopes → IP allow-list → expiry → merchant ACTIVE → `lastUsedAt`;
//! - otherwise a session JWT: HS256 signature/audience/expiry → `jti` revocation (Redis then the
//!   `session_revocations` table) → user row ACTIVE → `sessionsInvalidBefore` → authorities from
//!   the row (must be non-empty).
//!
//! Deliberate parity notes:
//!
//! - the `mfa` claim is **not** re-checked after login (S-SEC-04 fixes it);
//! - the Sandbox user mirror (`authDoubleCheck.ts:232-290`) is **not** ported yet: a session whose
//!   user does not exist in the Sandbox database answers `SESSION_USER_MISSING` until P8-T05
//!   ports the mirror.

#![forbid(unsafe_code)]

use std::time::Duration;

use chrono::{DateTime, Utc};
use ntex::http::HeaderMap;
use ntex::web::HttpRequest;
use ntex_tls::PeerCertDer;
use pg_db::{AccessTokenRow, DbError};
use pg_domain_auth::{
    hash_access_token, is_api_token, parse_authorities, plane_mismatch_error, token_matches_plane,
    verify_session, ApiToken, AuthError, ExecutionPlane, Principal, SessionClaims,
};
use pg_http::ApiError;
use pg_redis::revocation::{decide, RevocationEntry, MIN_REVOCATION_TTL_MS};
use redis::aio::ConnectionManager;
use redis::AsyncCommands;

/// Result of authenticating one request.
pub type AuthResult = Result<Principal, ApiError>;

/// Server-side revoke list: Redis fast path, `session_revocations` durable copy.
#[derive(Debug, Clone)]
pub struct RevocationStore {
    pool: sqlx::PgPool,
    redis: Option<ConnectionManager>,
}

impl RevocationStore {
    #[must_use]
    pub fn new(pool: sqlx::PgPool, redis: Option<ConnectionManager>) -> Self {
        Self { pool, redis }
    }

    /// `flagRemainingMs(key)`: 0 when absent or when Redis is unavailable (the TS store falls back
    /// to memory, which is "no flag" for a fresh process; the table still decides).
    async fn flag_remaining_ms(&self, jti: &str) -> u64 {
        let Some(redis) = &self.redis else {
            return 0;
        };
        let key = pg_redis::revocation_key(jti);
        let mut connection = redis.clone();
        match connection.pttl::<_, i64>(key).await {
            Ok(ttl) if ttl > 0 => u64::try_from(ttl).unwrap_or(0),
            _ => 0,
        }
    }

    async fn set_flag(&self, jti: &str, ttl_ms: u64) {
        let Some(redis) = &self.redis else {
            return;
        };
        let key = pg_redis::revocation_key(jti);
        let mut connection = redis.clone();
        let millis = i64::try_from(ttl_ms.max(MIN_REVOCATION_TTL_MS)).unwrap_or(i64::MAX);
        let _: Result<(), _> = redis::cmd("SET")
            .arg(key)
            .arg("1")
            .arg("PX")
            .arg(millis)
            .query_async(&mut connection)
            .await;
    }

    /// `isSessionRevoked(jti, nowMs)`. A missing `jti` is never revoked.
    pub async fn is_revoked(&self, jti: Option<&str>, now: DateTime<Utc>) -> bool {
        let Some(jti) = jti.filter(|value| !value.is_empty()) else {
            return false;
        };
        let now_ms = now.timestamp_millis();
        let remaining = self.flag_remaining_ms(jti).await;
        let table = match pg_db::find_session_revocation(&self.pool, jti).await {
            Ok(row) => row.map(|expires_at| RevocationEntry {
                jti: jti.to_owned(),
                expires_at_ms: expires_at.timestamp_millis(),
            }),
            // The table is best effort in one direction: if it cannot be read the Redis answer
            // stands (`revocation.ts:isSessionRevoked` catch).
            Err(_) => return remaining > 0,
        };
        let decision = decide(remaining, table.as_ref(), now_ms);
        if decision.revoked {
            if let Some(ttl) = decision.warm_ttl_ms {
                self.set_flag(jti, ttl).await;
            }
        }
        decision.revoked
    }

    /// `revokeSession(jti, expiresAtSeconds)`: flag + durable row (+ prune ~1 in 50).
    pub async fn revoke(
        &self,
        jti: &str,
        expires_at_seconds: i64,
        now: DateTime<Utc>,
    ) -> Result<(), DbError> {
        let now_ms = now.timestamp_millis();
        let entry = RevocationEntry::from_expiry_seconds(jti, expires_at_seconds, now_ms);
        self.set_flag(jti, entry.remaining_ms(now_ms)).await;
        pg_db::upsert_session_revocation(
            &self.pool,
            jti,
            DateTime::<Utc>::from_timestamp_millis(entry.expires_at_ms)
                .unwrap_or_else(|| now + chrono::Duration::hours(12)),
        )
        .await?;
        // `Math.floor(Math.random() * 50) === 0` with the crate's randomness source.
        let sample = pg_domain_auth::api_token::random_bytes()[0] % 50;
        if pg_redis::revocation::should_prune(u32::from(sample)) {
            let _ = pg_db::prune_expired_revocations(&self.pool, now).await;
        }
        Ok(())
    }
}

/// The authenticator of one process.
#[derive(Debug, Clone)]
pub struct AuthService {
    pool: sqlx::PgPool,
    master_key: String,
    plane: ExecutionPlane,
    revocations: RevocationStore,
}

impl AuthService {
    #[must_use]
    pub fn new(
        pool: sqlx::PgPool,
        master_key: String,
        plane: ExecutionPlane,
        redis: Option<ConnectionManager>,
    ) -> Self {
        Self {
            revocations: RevocationStore::new(pool.clone(), redis),
            pool,
            master_key,
            plane,
        }
    }

    #[must_use]
    pub fn plane(&self) -> ExecutionPlane {
        self.plane
    }

    #[must_use]
    pub fn revocations(&self) -> &RevocationStore {
        &self.revocations
    }

    /// `authenticate(request)`: choose the token family and resolve the principal.
    pub async fn authenticate(&self, headers: &HeaderMap, now: DateTime<Utc>) -> AuthResult {
        let token = bearer_token(headers).ok_or_else(|| api_error(AuthError::auth_required()))?;
        if is_api_token(&token) {
            if !token_matches_plane(&token, self.plane) {
                return Err(api_error(plane_mismatch_error(
                    token_plane(&token),
                    self.plane,
                )));
            }
            return self.resolve_api_token(&token, headers).await;
        }
        self.resolve_session(&token, now).await
    }

    /// `resolveApiTokenPrincipal`.
    async fn resolve_api_token(&self, token: &str, headers: &HeaderMap) -> AuthResult {
        let parsed = ApiToken::parse(token).map_err(api_error)?;
        let row = pg_db::find_access_token(&self.pool, &hash_access_token(token))
            .await
            .map_err(db_error)?
            .ok_or_else(|| {
                api_error(AuthError::access_token_invalid(
                    "The supplied access token is not recognised",
                ))
            })?;
        if row.env != self.plane.as_str() {
            return Err(api_error(plane_mismatch_error(
                plane_from_record(&row),
                self.plane,
            )));
        }
        if row.is_revoked() {
            return Err(api_error(AuthError::access_token_revoked()));
        }
        let scopes = parse_authorities(&row.scopes);
        if row.ip_whitelist_enabled && !ip_allowed(client_ip(headers), &row.cidrs) {
            return Err(api_error(AuthError::access_token_ip_not_allowed()));
        }
        if row.is_expired(Utc::now()) {
            return Err(api_error(AuthError::access_token_expired()));
        }
        if row.merchant_id.is_some() {
            match row.merchant_status.as_deref() {
                None => {
                    return Err(api_error(AuthError::access_token_invalid(
                        "The token's merchant no longer exists",
                    )))
                }
                Some("ACTIVE") => {}
                Some(status) => return Err(api_error(AuthError::merchant_not_active(status))),
            }
        }
        // `lastUsedAt` is best effort: a failed touch must not fail the request.
        let _ = pg_db::touch_access_token(&self.pool, row.id, Utc::now()).await;
        Ok(Principal::from_api_token(
            &parsed,
            row.id.to_string(),
            row.merchant_id.map(|id| id.to_string()),
            row.application_id.map(|id| id.to_string()),
            scopes,
        ))
    }

    /// `resolveSessionPrincipal`.
    async fn resolve_session(&self, token: &str, now: DateTime<Utc>) -> AuthResult {
        let verified = verify_session(token, &self.master_key, None, now)
            .map_err(|_| api_error(AuthError::session_invalid()))?;
        if self.revocations.is_revoked(verified.jti(), now).await {
            return Err(api_error(AuthError::session_revoked(
                "The session has been revoked",
            )));
        }
        let claims: &SessionClaims = &verified.claims;
        let user_id = claims
            .sub
            .parse::<uuid::Uuid>()
            .map_err(|_| api_error(AuthError::session_user_missing()))?;
        let user = pg_db::find_user(&self.pool, user_id)
            .await
            .map_err(db_error)?
            .ok_or_else(|| api_error(AuthError::session_user_missing()))?;
        if !user.is_active() {
            return Err(api_error(AuthError::session_user_inactive()));
        }
        if let (Some(invalid_before), Some(issued_at)) =
            (user.sessions_invalid_before, claims.issued_at_millis())
        {
            if issued_at < i128::from(invalid_before.timestamp_millis()) {
                return Err(api_error(AuthError::session_revoked(
                    "The session was invalidated by a security action",
                )));
            }
        }
        let authorities = parse_authorities(&user.authorities_map);
        if authorities.is_empty() {
            return Err(api_error(AuthError::session_authorities_empty()));
        }
        Ok(Principal::from_session(
            &verified,
            user.id.to_string(),
            user.role,
            user.merchant_id.map(|id| id.to_string()),
            authorities,
            string_array(&user.app_scope_ids),
        ))
    }
}

fn token_plane(token: &str) -> ExecutionPlane {
    if token.starts_with(pg_domain_auth::SANDBOX_TOKEN_PREFIX) {
        ExecutionPlane::Sandbox
    } else {
        ExecutionPlane::Live
    }
}

fn plane_from_record(row: &AccessTokenRow) -> ExecutionPlane {
    if row.env == "SANDBOX" {
        ExecutionPlane::Sandbox
    } else {
        ExecutionPlane::Live
    }
}

/// `parseAuthorities` for a JSON array of strings (`appScopeIds`).
#[must_use]
pub fn string_array(value: &serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::Array(entries) => entries
            .iter()
            .filter_map(|entry| match entry {
                serde_json::Value::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `^Bearer\s+(.+)$` (case-insensitive scheme, trimmed value).
#[must_use]
pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("authorization")?.to_str().ok()?;
    let (scheme, rest) = value.split_once(char::is_whitespace)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_owned())
    }
}

/// `clientIp`: `x-real-client-ip`, else the peer address.
#[must_use]
pub fn client_ip(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-real-client-ip")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// `ipAllowed`: an empty list allows every address; a missing address never matches a list.
#[must_use]
pub fn ip_allowed(address: Option<String>, cidrs: &[String]) -> bool {
    if cidrs.is_empty() {
        return true;
    }
    let Some(address) = address else {
        return false;
    };
    cidrs
        .iter()
        .any(|cidr| pg_domain_auth::ip_within_cidr(&address, cidr))
}

/// Convert an authentication refusal into the HTTP envelope.
#[must_use]
pub fn api_error(error: AuthError) -> ApiError {
    let mut api = ApiError::new(error.status, error.code, error.message);
    if let Some(details) = error.details {
        api = api.with_details(details);
    }
    api
}

/// Convert a database failure into the generic 500 envelope (the TS handler does the same for an
/// unmapped error).
#[must_use]
pub fn db_error(error: DbError) -> ApiError {
    tracing::error!(error = %error, "authentication database read failed");
    ApiError::server_error()
}

/// mTLS channel guard: the CN table of chapter 2 §1.
///
/// `/health` accepted a valid client certificate without a CN check in TS, so it is not passed
/// here. When `mtls_required` is false (development and tests) the guard is skipped entirely.
pub fn require_channel_identity(
    request: &HttpRequest,
    mtls_required: bool,
) -> Result<(), ApiError> {
    if !mtls_required {
        return Ok(());
    }
    let allowed = pg_mtls::allowed_channel_cns(request.path()).ok_or_else(|| {
        ApiError::new(
            403,
            "FORBIDDEN_SERVICE_IDENTITY",
            "This route has no client-identity channel",
        )
    })?;
    let identity = peer_identity(request).ok_or_else(ApiError::mtls_uninspectable)?;
    if !identity.authorized_by_ca {
        return Err(ApiError::mtls_unauthorized());
    }
    let Some(common_name) = identity.primary_cn() else {
        return Err(ApiError::mtls_uninspectable());
    };
    if allowed.contains(&common_name) {
        return Ok(());
    }
    Err(ApiError::new(
        403,
        "FORBIDDEN_SERVICE_IDENTITY",
        format!(
            "Certificate CN '{common_name}' is not permitted on {} channel",
            allowed.join(", ")
        ),
    ))
}

/// Peer certificate identity when the connection presented one.
#[must_use]
pub fn peer_identity(request: &HttpRequest) -> Option<pg_mtls::PeerIdentity> {
    let io = request.io()?;
    let certificate = io.query::<PeerCertDer>().into_inner()?;
    pg_mtls::identity_from_ntex(&certificate.0).ok()
}

/// Revoke the session that authenticated a request (`POST /auth/logout` behaviour).
pub async fn revoke_principal_session(
    auth: &AuthService,
    principal: &Principal,
    now: DateTime<Utc>,
) -> Result<(), ApiError> {
    let jti = principal.session_jti.as_deref().ok_or_else(|| {
        api_error(AuthError::new(
            400,
            "NOT_A_SESSION",
            "Only an interactive session can be logged out",
        ))
    })?;
    let expires = principal
        .session_exp
        .unwrap_or_else(|| now.timestamp() + pg_domain_auth::SESSION_TTL_SECONDS);
    auth.revocations
        .revoke(jti, expires, now)
        .await
        .map_err(db_error)
}

/// Default Redis connect timeout used when a process builds the manager.
pub const REDIS_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_parsing_is_case_insensitive_and_trims() {
        use ntex::http::header::{HeaderName, HeaderValue};
        let name = HeaderName::from_static("authorization");
        let mut headers = HeaderMap::new();
        headers.insert(
            name.clone(),
            HeaderValue::from_static("Bearer  abc.def.ghi "),
        );
        assert_eq!(bearer_token(&headers).as_deref(), Some("abc.def.ghi"));
        headers.insert(name.clone(), HeaderValue::from_static("basic abc"));
        assert_eq!(bearer_token(&headers), None);
        headers.insert(name.clone(), HeaderValue::from_static("Bearer   "));
        assert_eq!(bearer_token(&headers), None);
        headers.remove(name);
        assert_eq!(bearer_token(&headers), None);
    }

    #[test]
    fn ip_allowlist_rules_match_the_ts_helper() {
        assert!(ip_allowed(None, &[]));
        assert!(!ip_allowed(None, &["10.0.0.0/8".to_owned()]));
        assert!(ip_allowed(
            Some("10.1.2.3".to_owned()),
            &["10.0.0.0/8".to_owned()]
        ));
        assert!(!ip_allowed(
            Some("11.1.2.3".to_owned()),
            &["10.0.0.0/8".to_owned()]
        ));
        assert!(ip_allowed(
            Some("::1".to_owned()),
            &["::1/128".to_owned(), "10.0.0.0/8".to_owned()]
        ));
    }

    #[test]
    fn auth_errors_keep_status_and_code() {
        let error = api_error(AuthError::session_invalid());
        assert_eq!(error.status, 401);
        assert_eq!(error.code, "SESSION_INVALID");
        let error = api_error(AuthError::session_authorities_empty());
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "SESSION_AUTHORITIES_EMPTY");
    }

    #[test]
    fn string_arrays_ignore_non_strings() {
        assert_eq!(
            string_array(&serde_json::json!(["a", 1, "b"])),
            vec!["a".to_owned(), "b".to_owned()]
        );
        assert!(string_array(&serde_json::json!(null)).is_empty());
    }
}
