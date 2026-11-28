//! Authentication error codes and envelope.
//!
//! Port of the `ApiError(...)` throws of `core-back/lib/auth/index.ts`,
//! `core-back/lib/auth/{throttle,mfaChallenges,merchantAuthorities}.ts`,
//! `core-back/api/middleware/authDoubleCheck.ts` and the edge session-cookie helpers.
//!
//! Every code string and status below is copied from chapter 2 §5. The envelope shape is the same
//! as `pg-http::ApiError` (`{code,message,details?}`) but this crate cannot depend on `pg-http`
//! (domain crates never depend on the HTTP crate), so the mapping lives here as
//! [`AuthError::to_envelope`] for the caller to convert.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The exact `code` strings of the authentication contract (chapter 2 §5).
pub mod codes {
    pub const AUTH_REQUIRED: &str = "AUTH_REQUIRED";
    pub const SESSION_INVALID: &str = "SESSION_INVALID";
    pub const SESSION_REVOKED: &str = "SESSION_REVOKED";
    pub const SESSION_USER_MISSING: &str = "SESSION_USER_MISSING";
    pub const SESSION_USER_INACTIVE: &str = "SESSION_USER_INACTIVE";
    pub const SESSION_AUDIENCE_INVALID: &str = "SESSION_AUDIENCE_INVALID";
    pub const SESSION_AUTHORITIES_EMPTY: &str = "SESSION_AUTHORITIES_EMPTY";
    pub const STAFF_PRINCIPAL_REQUIRED: &str = "STAFF_PRINCIPAL_REQUIRED";
    pub const MERCHANT_PRINCIPAL_REQUIRED: &str = "MERCHANT_PRINCIPAL_REQUIRED";
    pub const MERCHANT_SCOPE_VIOLATION: &str = "MERCHANT_SCOPE_VIOLATION";
    pub const AUTHORITY_REQUIRED: &str = "AUTHORITY_REQUIRED";
    pub const UNKNOWN_AUTHORITY: &str = "UNKNOWN_AUTHORITY";
    pub const UNKNOWN_TOKEN_SCOPE: &str = "UNKNOWN_TOKEN_SCOPE";
    pub const AUTHORITY_ESCALATION_FORBIDDEN: &str = "AUTHORITY_ESCALATION_FORBIDDEN";
    pub const ROLE_ESCALATION_FORBIDDEN: &str = "ROLE_ESCALATION_FORBIDDEN";
    pub const ACCESS_TOKEN_INVALID: &str = "ACCESS_TOKEN_INVALID";
    pub const ACCESS_TOKEN_REVOKED: &str = "ACCESS_TOKEN_REVOKED";
    pub const ACCESS_TOKEN_EXPIRED: &str = "ACCESS_TOKEN_EXPIRED";
    pub const ACCESS_TOKEN_IP_NOT_ALLOWED: &str = "ACCESS_TOKEN_IP_NOT_ALLOWED";
    pub const API_TOKEN_SCOPE_VIOLATION: &str = "API_TOKEN_SCOPE_VIOLATION";
    pub const MERCHANT_NOT_ACTIVE: &str = "MERCHANT_NOT_ACTIVE";
    pub const LIVE_TOKEN_ON_SANDBOX_PLANE: &str = "LIVE_TOKEN_ON_SANDBOX_PLANE";
    pub const SANDBOX_TOKEN_ON_LIVE_PLANE: &str = "SANDBOX_TOKEN_ON_LIVE_PLANE";
    pub const AUTH_THROTTLED: &str = "AUTH_THROTTLED";
    pub const CSRF_HEADER_REQUIRED: &str = "CSRF_HEADER_REQUIRED";
    pub const MFA_CHALLENGE_INVALID: &str = "MFA_CHALLENGE_INVALID";
    pub const MFA_CODE_INVALID: &str = "MFA_CODE_INVALID";
    pub const MFA_LOCKED: &str = "MFA_LOCKED";
    pub const MFA_RATE_LIMITED: &str = "MFA_RATE_LIMITED";
    pub const NO_DELIVERY_CHANNEL: &str = "NO_DELIVERY_CHANNEL";
    pub const NOT_A_SESSION: &str = "NOT_A_SESSION";
}

/// The `{code,message,details?}` body the core error handler renders.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthErrorEnvelope {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

/// One refusal, carrying the HTTP status the TS code throws with.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
}

impl AuthError {
    #[must_use]
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    #[must_use]
    pub fn to_envelope(&self) -> AuthErrorEnvelope {
        AuthErrorEnvelope {
            code: self.code.to_owned(),
            message: self.message.clone(),
            details: self.details.clone(),
        }
    }

    // --- Sessions (`authDoubleCheck.ts:292-338`, `index.ts:112-138`) ---

    /// `401 SESSION_INVALID "The session token is invalid or expired"`.
    #[must_use]
    pub fn session_invalid() -> Self {
        Self::new(
            401,
            codes::SESSION_INVALID,
            "The session token is invalid or expired",
        )
    }

    /// `401 SESSION_INVALID` with a payload-shape message (`index.ts:122`).
    #[must_use]
    pub fn session_payload_invalid() -> Self {
        Self::new(
            401,
            codes::SESSION_INVALID,
            "Session token payload is invalid",
        )
    }

    /// `401 SESSION_REVOKED "The session has been revoked"` or the security-action message.
    #[must_use]
    pub fn session_revoked(message: &str) -> Self {
        Self::new(401, codes::SESSION_REVOKED, message)
    }

    /// `401 SESSION_USER_MISSING`.
    #[must_use]
    pub fn session_user_missing() -> Self {
        Self::new(
            401,
            codes::SESSION_USER_MISSING,
            "The session principal no longer exists",
        )
    }

    /// `403 SESSION_USER_INACTIVE`.
    #[must_use]
    pub fn session_user_inactive() -> Self {
        Self::new(
            403,
            codes::SESSION_USER_INACTIVE,
            "The session principal is not active",
        )
    }

    /// `401 SESSION_AUDIENCE_INVALID`, channel specific.
    #[must_use]
    pub fn session_audience_invalid(message: &str) -> Self {
        Self::new(401, codes::SESSION_AUDIENCE_INVALID, message)
    }

    /// `403 SESSION_AUTHORITIES_EMPTY`.
    #[must_use]
    pub fn session_authorities_empty() -> Self {
        Self::new(
            403,
            codes::SESSION_AUTHORITIES_EMPTY,
            "The session principal has no granted authorities",
        )
    }

    /// `401 AUTH_REQUIRED "A bearer token is required for this endpoint"`.
    #[must_use]
    pub fn auth_required() -> Self {
        Self::new(
            401,
            codes::AUTH_REQUIRED,
            "A bearer token is required for this endpoint",
        )
    }

    /// `403 STAFF_PRINCIPAL_REQUIRED`.
    #[must_use]
    pub fn staff_principal_required() -> Self {
        Self::new(
            403,
            codes::STAFF_PRINCIPAL_REQUIRED,
            "This channel is reserved for platform staff",
        )
    }

    /// `403 MERCHANT_PRINCIPAL_REQUIRED`.
    #[must_use]
    pub fn merchant_principal_required() -> Self {
        Self::new(
            403,
            codes::MERCHANT_PRINCIPAL_REQUIRED,
            "This channel is reserved for merchant principals",
        )
    }

    /// `403 MERCHANT_SCOPE_VIOLATION`, API-token wording.
    #[must_use]
    pub fn token_merchant_scope_violation() -> Self {
        Self::new(
            403,
            codes::MERCHANT_SCOPE_VIOLATION,
            "The token is not bound to this merchant",
        )
    }

    /// `403 MERCHANT_SCOPE_VIOLATION`, session wording.
    #[must_use]
    pub fn principal_merchant_scope_violation() -> Self {
        Self::new(
            403,
            codes::MERCHANT_SCOPE_VIOLATION,
            "The principal is not bound to this merchant",
        )
    }

    /// `400 NOT_A_SESSION`.
    #[must_use]
    pub fn not_a_session() -> Self {
        Self::new(
            400,
            codes::NOT_A_SESSION,
            "Only an interactive session can be logged out",
        )
    }

    // --- API tokens (`authDoubleCheck.ts:100-157`, `merchant.ts:1389-1395`) ---

    /// `401 ACCESS_TOKEN_INVALID`.
    #[must_use]
    pub fn access_token_invalid(message: &str) -> Self {
        Self::new(401, codes::ACCESS_TOKEN_INVALID, message)
    }

    /// `401 ACCESS_TOKEN_REVOKED`.
    #[must_use]
    pub fn access_token_revoked() -> Self {
        Self::new(
            401,
            codes::ACCESS_TOKEN_REVOKED,
            "The supplied access token has been revoked",
        )
    }

    /// `401 ACCESS_TOKEN_EXPIRED`.
    #[must_use]
    pub fn access_token_expired() -> Self {
        Self::new(
            401,
            codes::ACCESS_TOKEN_EXPIRED,
            "The supplied access token has expired",
        )
    }

    /// `403 ACCESS_TOKEN_IP_NOT_ALLOWED`.
    #[must_use]
    pub fn access_token_ip_not_allowed() -> Self {
        Self::new(
            403,
            codes::ACCESS_TOKEN_IP_NOT_ALLOWED,
            "The request origin is not allowed for this access token",
        )
    }

    /// `403 API_TOKEN_SCOPE_VIOLATION` (API tokens only reach `/external/*`).
    #[must_use]
    pub fn api_token_scope_violation() -> Self {
        Self::new(
            403,
            codes::API_TOKEN_SCOPE_VIOLATION,
            "API access tokens can only call the external API",
        )
    }

    /// `403 MERCHANT_NOT_ACTIVE` with the merchant status in `details`.
    #[must_use]
    pub fn merchant_not_active(status: &str) -> Self {
        Self::new(
            403,
            codes::MERCHANT_NOT_ACTIVE,
            "The merchant is not active",
        )
        .with_details(serde_json::json!({ "status": status }))
    }

    /// `401 SANDBOX_TOKEN_ON_LIVE_PLANE`.
    #[must_use]
    pub fn sandbox_token_on_live_plane() -> Self {
        Self::new(
            401,
            codes::SANDBOX_TOKEN_ON_LIVE_PLANE,
            "A sandbox (pg_test_) token cannot be used on the LIVE execution plane",
        )
    }

    /// `401 LIVE_TOKEN_ON_SANDBOX_PLANE`.
    #[must_use]
    pub fn live_token_on_sandbox_plane() -> Self {
        Self::new(
            401,
            codes::LIVE_TOKEN_ON_SANDBOX_PLANE,
            "A live (pg_live_) token cannot be used on the SANDBOX execution plane",
        )
    }

    /// The plane mismatch for a record whose `env` belongs to the other plane
    /// (`authDoubleCheck.ts:109-115`).
    #[must_use]
    pub fn record_plane_mismatch(process_plane: crate::api_token::ExecutionPlane) -> Self {
        match process_plane {
            crate::api_token::ExecutionPlane::Live => Self::new(
                401,
                codes::SANDBOX_TOKEN_ON_LIVE_PLANE,
                "The access token belongs to the other execution plane",
            ),
            crate::api_token::ExecutionPlane::Sandbox => Self::new(
                401,
                codes::LIVE_TOKEN_ON_SANDBOX_PLANE,
                "The access token belongs to the other execution plane",
            ),
        }
    }

    // --- Authorities (`merchantAuthorities.ts`) ---

    /// `403 AUTHORITY_REQUIRED` with the required list in `details`.
    #[must_use]
    pub fn authority_required(required: &[&str]) -> Self {
        Self::new(
            403,
            codes::AUTHORITY_REQUIRED,
            "The principal lacks the required authority",
        )
        .with_details(serde_json::json!({ "required": required }))
    }

    /// `400 UNKNOWN_AUTHORITY`.
    #[must_use]
    pub fn unknown_authority(unknown: &[String]) -> Self {
        Self::new(
            400,
            codes::UNKNOWN_AUTHORITY,
            "The authority list contains unknown authorities",
        )
        .with_details(serde_json::json!({ "unknown": unknown }))
    }

    /// `400 UNKNOWN_TOKEN_SCOPE`.
    #[must_use]
    pub fn unknown_token_scope(unknown: &[String], allowed: &[&str]) -> Self {
        Self::new(
            400,
            codes::UNKNOWN_TOKEN_SCOPE,
            "The scope list contains unknown scopes",
        )
        .with_details(serde_json::json!({ "unknown": unknown, "allowed": allowed }))
    }

    /// `403 AUTHORITY_ESCALATION_FORBIDDEN`.
    #[must_use]
    pub fn authority_escalation_forbidden(excess: &[String]) -> Self {
        Self::new(
            403,
            codes::AUTHORITY_ESCALATION_FORBIDDEN,
            "You cannot grant authorities you do not hold",
        )
        .with_details(serde_json::json!({ "authorities": excess }))
    }

    /// `403 ROLE_ESCALATION_FORBIDDEN`.
    #[must_use]
    pub fn role_escalation_forbidden() -> Self {
        Self::new(
            403,
            codes::ROLE_ESCALATION_FORBIDDEN,
            "Only a merchant administrator can grant the administrator role",
        )
    }

    // --- Throttles (`throttle.ts:39-46`) ---

    /// `429 AUTH_THROTTLED` with `details.retryAfterSeconds = ceil(remaining / 1000)`.
    #[must_use]
    pub fn throttled(retry_after_ms: i64) -> Self {
        let seconds = crate::throttle::retry_after_seconds(retry_after_ms);
        Self::new(
            429,
            codes::AUTH_THROTTLED,
            "Too many failed attempts. Try again later",
        )
        .with_details(serde_json::json!({ "retryAfterSeconds": seconds }))
    }

    // --- Cookies (`sessionCookie.ts`) ---

    /// `403 CSRF_HEADER_REQUIRED`.
    #[must_use]
    pub fn csrf_header_required() -> Self {
        Self::new(
            403,
            codes::CSRF_HEADER_REQUIRED,
            "Cookie-authenticated writes must send the x-pg-csrf header",
        )
    }

    // --- MFA (`mfaChallenges.ts`) ---

    /// `401 MFA_CHALLENGE_INVALID`.
    #[must_use]
    pub fn mfa_challenge_invalid() -> Self {
        Self::new(
            401,
            codes::MFA_CHALLENGE_INVALID,
            "The verification challenge is invalid or expired",
        )
    }

    /// `401 MFA_CODE_INVALID`.
    #[must_use]
    pub fn mfa_code_invalid() -> Self {
        Self::new(
            401,
            codes::MFA_CODE_INVALID,
            "The supplied MFA code is not valid",
        )
    }

    /// `429 MFA_LOCKED`.
    #[must_use]
    pub fn mfa_locked() -> Self {
        Self::new(
            429,
            codes::MFA_LOCKED,
            "Too many failed codes. Try again later",
        )
    }

    /// `429 MFA_RATE_LIMITED`.
    #[must_use]
    pub fn mfa_rate_limited() -> Self {
        Self::new(
            429,
            codes::MFA_RATE_LIMITED,
            "Too many verification codes were requested. Try again later",
        )
    }

    /// `503 NO_DELIVERY_CHANNEL`.
    #[must_use]
    pub fn no_delivery_channel() -> Self {
        Self::new(
            503,
            codes::NO_DELIVERY_CHANNEL,
            "No configured channel can deliver a verification code to this account. Contact an administrator",
        )
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for AuthError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_invalid_matches_the_ts_message() {
        let error = AuthError::session_invalid();
        assert_eq!(error.status, 401);
        assert_eq!(error.code, "SESSION_INVALID");
        assert_eq!(error.message, "The session token is invalid or expired");
    }

    #[test]
    fn throttle_details_use_whole_seconds_rounded_up() {
        let error = AuthError::throttled(1_500);
        let details = error.details.clone().unwrap_or_default();
        assert_eq!(details["retryAfterSeconds"], 2);
        assert_eq!(error.status, 429);
        assert_eq!(error.code, "AUTH_THROTTLED");
    }

    #[test]
    fn envelope_omits_absent_details() {
        let envelope = AuthError::auth_required().to_envelope();
        assert!(envelope.details.is_none());
        assert_eq!(envelope.code, "AUTH_REQUIRED");
    }

    #[test]
    fn plane_mismatch_codes_follow_the_process_plane() {
        use crate::api_token::ExecutionPlane;
        assert_eq!(
            AuthError::record_plane_mismatch(ExecutionPlane::Live).code,
            "SANDBOX_TOKEN_ON_LIVE_PLANE"
        );
        assert_eq!(
            AuthError::record_plane_mismatch(ExecutionPlane::Sandbox).code,
            "LIVE_TOKEN_ON_SANDBOX_PLANE"
        );
    }
}
