//! Principals, sessions, API tokens, merchant authorities, throttles, MFA and cookie sessions.
//!
//! Port of `core-back/lib/auth/**`, `core-back/api/middleware/authDoubleCheck.ts`,
//! `core-back/lib/auth/uiAuthorities.ts` (merchant half) and the edge
//! `lib/security/sessionCookie.ts`, per chapter 2 §5 of the Rust/ntex port plan.
//!
//! | Module | TypeScript source |
//! | :--- | :--- |
//! | [`channel`] | `lib/auth/index.ts:6-19`, `authDoubleCheck.ts:399-428` |
//! | [`session`] | `lib/auth/index.ts:21-138`, `authDoubleCheck.ts:292-338` |
//! | [`api_token`] | `lib/executionPlane.ts`, `lib/auth/index.ts:82-85`, `authDoubleCheck.ts:100-157` |
//! | [`authorities`] | `lib/auth/merchantAuthorities.ts`, `uiAuthorities.ts:100-158` |
//! | [`principal`] | `authDoubleCheck.ts:12-33,385-460` |
//! | [`throttle`] | `lib/auth/throttle.ts`, `lib/auth/sharedState.ts:120-124` |
//! | [`cookie`] | `admin-back/lib/security/sessionCookie.ts` (+ merchant copy) |
//! | [`mfa`] | `lib/auth/mfaChallenges.ts`, `lib/auth/index.ts:87-93` |
//!
//! The Prisma access (user rows, `mfa_challenges`, `access_tokens`, `session_revocations`) is a
//! repository concern and stays out of this crate: every decision here is pure and takes the row
//! values as arguments, so parity tests do not need a database.
//!
//! ## Build note (not a behavioural contract)
//!
//! Session signing uses `jsonwebtoken` 12 HS256. That crate's default feature set is only
//! `use_pem`, so the workspace dependency must enable one crypto provider (`rust_crypto` on this
//! build image, which has no cmake/NASM — the same reason `pg-crypto` uses RustCrypto, DEV-001).
//! Without it HS256 signing/verification fails at runtime even though this crate compiles.
//!
//! ## Recorded deviations
//!
//! - `DEV`: random bytes for API tokens and MFA codes come from `uuid` v4 values because `rand` is
//!   not in this crate's dependency list. Prefixes, lengths, the modulo rule and every hash are
//!   unchanged.
//! - `DEV`: session expiry is evaluated against the caller-supplied `now` instead of
//!   `jsonwebtoken`'s own clock, so one instant governs verification, revocation and tests.

#![forbid(unsafe_code)]

pub mod api_token;
pub mod authorities;
pub mod b64url;
pub mod channel;
pub mod cookie;
pub mod error;
pub mod mfa;
pub mod principal;
pub mod session;
pub mod throttle;

pub use api_token::{
    generate_api_token, hash_access_token, ip_allowed, ip_within_cidr, is_api_token,
    plane_mismatch_error, token_matches_plane, ApiToken, ExecutionPlane, API_TOKEN_BYTES,
    API_TOKEN_PAYLOAD_LEN, LIVE_TOKEN_PREFIX, SANDBOX_TOKEN_PREFIX,
};
pub use authorities::{
    assert_authority, assert_grantable_authorities, assert_grantable_role,
    assert_known_authorities, assert_known_token_scopes, build_ui_authorities_map,
    effective_merchant_authorities, expand_legacy, has_authority, normalize_token_scopes,
    parse_authorities, ui_projection, MerchantPrincipal, PrincipalKind, API_TOKEN_SCOPE_CATALOGUE,
    MERCHANT_AUTHORITY_CATALOGUE, MERCHANT_UI_PROJECTION, PRIVILEGED_MERCHANT_AUTHORITIES,
    TOKEN_SCOPE_ALIASES,
};
pub use channel::{
    Audience, Channel, ADMIN_AUDIENCE, ALL_AUDIENCES, CHECKOUT_AUDIENCE, MERCHANT_AUDIENCE,
    SESSION_ISSUER, SESSION_TTL_SECONDS,
};
pub use cookie::{
    clear_cookie_header, cookie_for, is_auth_entry_path, is_safe_method, is_valid_cookie_value,
    read_session_cookie, require_csrf, set_cookie_header, SessionCookieSpec, ADMIN_COOKIE,
    ADMIN_SESSION_COOKIE, ADMIN_SESSION_COOKIE_PATH, CSRF_HEADER, CSRF_HEADER_VALUE,
    MERCHANT_COOKIE, MERCHANT_SESSION_COOKIE, MERCHANT_SESSION_COOKIE_PATH,
    SESSION_COOKIE_MAX_AGE_SECONDS,
};
pub use error::{codes, AuthError, AuthErrorEnvelope};
pub use mfa::{
    assert_challenge_verifiable, assert_issue_allowed, attempts_exhausted, generate_mfa_code,
    hash_mfa_code, masked_last4, mfa_code_from_bytes, verify_mfa_code, wrong_code_outcome,
    DeliveryChannel, MfaChallengeSummary, MfaChannel, MfaDelivery, MfaPurpose, WrongCodeOutcome,
    MFA_ADDRESS_VAULT_KEY_ID, MFA_CODE_VAULT_KEY_ID, MFA_ISSUE_WINDOW_SECONDS,
    MFA_LOCK_COOLDOWN_SECONDS, MFA_MAX_ATTEMPTS, MFA_MAX_ISSUES_PER_WINDOW, MFA_TTL_MS,
    MFA_TTL_SECONDS,
};
pub use principal::Principal;
pub use session::{
    mfa_key, session_key, sign_session, sign_session_at, verify_session,
    verify_session_with_cutoff, SessionClaims, VerifiedSession, SESSION_SIGNING_FAILED,
    SESSION_TOKEN_TYPE,
};
pub use throttle::{
    assert_not_throttled, decision, distinct_keys, login_check_keys, login_failure_keys,
    login_success_keys, mfa_key as mfa_throttle_key, retry_after_seconds, ThrottleDecision,
    ThrottleKey, ThrottlePolicy, ThrottleScope, KEY_PREFIX, LOGIN_IDENTIFIER_POLICY,
    LOGIN_IP_POLICY, LOGIN_PAIR_POLICY, MFA_IP_POLICY, THROTTLE_WINDOW_MS,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end: mint a merchant session, verify it for the merchant channel, build the
    /// principal, and apply the merchant authority rules — the sequence a merchant route performs.
    #[test]
    fn merchant_session_flow() {
        let master = "flow-master-key";
        let claims = SessionClaims::new("user-9", "MERCHANT_ADMIN")
            .with_merchant("merchant-9")
            .with_authorities(["merchant:write"])
            .with_app_scope_ids(["app-9"])
            .with_mfa(true)
            .with_channel(Channel::Merchant)
            .expect("channel");
        let token = sign_session(&claims, master).expect("sign");
        let verified = verify_session(&token, master, Some(Audience::MERCHANT), chrono::Utc::now())
            .expect("verify");
        assert_eq!(verified.channel, Some(Channel::Merchant));
        let principal = Principal::from_session(
            &verified,
            "user-9",
            "MERCHANT_ADMIN",
            Some("merchant-9".to_owned()),
            verified.claims.authorities.clone(),
            verified.claims.app_scope_ids.clone(),
        );
        assert!(principal.require_merchant().is_ok());
        assert!(principal.require_merchant_scope(Some("merchant-9")).is_ok());
        assert!(principal.require_application_scope(Some("app-9")).is_ok());
        assert!(principal
            .require_merchant_authority(&["user:manage"])
            .is_ok());
        assert!(principal
            .require_merchant_authority(&["cashout:request"])
            .is_ok());
        assert!(principal
            .require_merchant_authority(&["onboarding:manage"])
            .is_err());
    }

    /// End-to-end: a sandbox API token is refused by a Live process and only reaches `/external/`.
    #[test]
    fn sandbox_token_on_live_plane_is_refused() {
        let raw = generate_api_token(ExecutionPlane::Sandbox);
        let token = ApiToken::parse(&raw).expect("parse");
        assert_eq!(
            token
                .check_plane(ExecutionPlane::Live)
                .expect_err("plane")
                .code,
            "SANDBOX_TOKEN_ON_LIVE_PLANE"
        );
        assert!(token.scope_violation("/external/payments").is_none());
        assert_eq!(
            token.scope_violation("/settings").expect("scope").code,
            "API_TOKEN_SCOPE_VIOLATION"
        );
    }
}
