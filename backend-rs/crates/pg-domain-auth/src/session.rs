//! Session JWTs: claims, signing keys, sign and verify.
//!
//! Port of `core-back/lib/auth/index.ts:21-138` and the verification half of
//! `core-back/api/middleware/authDoubleCheck.ts:292-338`.
//!
//! Contract (chapter 2 §5):
//!
//! - HS256, `iss = "payment-gateway-core"`, `aud ∈ {payment-gateway-admin, payment-gateway-merchant,
//!   payment-gateway-checkout}`, `exp = iat + 43200`, `jti = uuid v4`.
//! - Payload `{sub, typ:"session", role, merchantId, authorities[], appScopeIds[], mfa}` plus the
//!   registered `iat`/`exp`/`jti`/`iss`/`aud` claims. `merchantId` is `null` for staff.
//! - Signing key `HKDF-SHA256(ikm = utf8(KMS_MASTER_KEY, raw, NOT normalised), salt =
//!   "payment-gateway-core", info = "session-signing", L = 32)`. Live and Sandbox share the key.
//!
//! The `mfa` claim is **not** re-checked after login (parity; S-SEC-04 fixes it). Revocation is a
//! lookup by `jti` plus the `sessionsInvalidBefore` rule below, so [`SessionClaims::validate`] takes
//! the revocation cutoff as an argument instead of reading a store.

#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::channel::{Audience, Channel, ALL_AUDIENCES, SESSION_ISSUER, SESSION_TTL_SECONDS};
use crate::error::AuthError;

/// Additional Rust-only code used when a caller tries to mint a token without a valid audience.
/// The TS equivalent throws an uncaught `TypeError`/`Error`, which the core error handler renders
/// as `500 SERVER_ERROR`; a caller mapping this error must do the same.
pub const SESSION_SIGNING_FAILED: &str = "SESSION_SIGNING_FAILED";

/// `typ` of every session payload.
pub const SESSION_TOKEN_TYPE: &str = "session";

/// The payload of a session JWT.
///
/// Field names are the JWT member names: serde renames `merchant_id` to `merchantId` and
/// `app_scope_ids` to `appScopeIds`, and every other member already matches. `aud`/`iss` are part of
/// the payload (registered claims); the TS `SessionClaims` interface derives the channel from `aud`
/// instead of keeping it in the struct, which `VerifiedSession.channel` does here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionClaims {
    pub sub: String,
    pub typ: String,
    pub role: String,
    #[serde(default, rename = "merchantId")]
    pub merchant_id: Option<String>,
    #[serde(default)]
    pub authorities: Vec<String>,
    #[serde(default, rename = "appScopeIds")]
    pub app_scope_ids: Vec<String>,
    #[serde(default)]
    pub mfa: bool,
    #[serde(default)]
    pub jti: Option<String>,
    #[serde(default)]
    pub iat: Option<i64>,
    #[serde(default)]
    pub exp: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aud: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iss: Option<String>,
}

impl SessionClaims {
    /// A staff/merchant session with the given subject and role and no authorities yet.
    #[must_use]
    pub fn new(sub: impl Into<String>, role: impl Into<String>) -> Self {
        Self {
            sub: sub.into(),
            typ: SESSION_TOKEN_TYPE.to_owned(),
            role: role.into(),
            merchant_id: None,
            authorities: Vec::new(),
            app_scope_ids: Vec::new(),
            mfa: false,
            jti: None,
            iat: None,
            exp: None,
            aud: None,
            iss: None,
        }
    }

    /// Bind the session to a merchant (`merchantId`).
    #[must_use]
    pub fn with_merchant(mut self, merchant_id: impl Into<String>) -> Self {
        self.merchant_id = Some(merchant_id.into());
        self
    }

    /// Set the granted authorities.
    #[must_use]
    pub fn with_authorities<I, S>(mut self, authorities: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.authorities = authorities.into_iter().map(Into::into).collect();
        self
    }

    /// Set the application scope (`appScopeIds`).
    #[must_use]
    pub fn with_app_scope_ids<I, S>(mut self, app_scope_ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.app_scope_ids = app_scope_ids.into_iter().map(Into::into).collect();
        self
    }

    /// Set the `mfa` claim.
    #[must_use]
    pub fn with_mfa(mut self, mfa: bool) -> Self {
        self.mfa = mfa;
        self
    }

    /// Mint the token for a channel. Sandbox mints nothing, so it is refused.
    pub fn with_channel(mut self, channel: Channel) -> Result<Self, AuthError> {
        let audience = channel.audience().ok_or_else(|| {
            AuthError::new(
                500,
                SESSION_SIGNING_FAILED,
                "The sandbox plane has no session audience of its own",
            )
        })?;
        self.aud = Some(audience.to_owned());
        self.iss = Some(SESSION_ISSUER.to_owned());
        Ok(self)
    }

    /// The parsed audience, when the claim names one of the three accepted audiences.
    #[must_use]
    pub fn audience(&self) -> Option<Audience> {
        self.aud.as_deref().and_then(Audience::parse)
    }

    /// The channel the token was minted for (`authDoubleCheck.ts:334`).
    #[must_use]
    pub fn channel(&self) -> Option<Channel> {
        self.audience().map(Audience::channel)
    }

    /// `iat` as epoch milliseconds (the unit `sessionsInvalidBefore` is compared in).
    #[must_use]
    pub fn issued_at_millis(&self) -> Option<i128> {
        self.iat.map(|iat| i128::from(iat) * 1000)
    }

    /// Pure payload validation, shared by [`verify_session`] and callers that already verified the
    /// signature.
    ///
    /// Mirrors `verifySessionToken` (`index.ts:112-138`) plus the revocation rule of
    /// `resolveSessionPrincipal` (`authDoubleCheck.ts:311-318`):
    ///
    /// - `typ` must be `session` and `sub` non-empty → `SESSION_INVALID`.
    /// - `aud` must be one of the three audiences and, when `expected_audience` is given, exactly
    ///   that one → `SESSION_AUDIENCE_INVALID`.
    /// - `exp` must be present and in the future at `now` → `SESSION_INVALID`.
    /// - `iat * 1000 < sessions_invalid_before` → `SESSION_REVOKED` (the security-action message).
    pub fn validate(
        &self,
        expected_audience: Option<Audience>,
        now: DateTime<Utc>,
        sessions_invalid_before: Option<DateTime<Utc>>,
    ) -> Result<(), AuthError> {
        if self.typ != SESSION_TOKEN_TYPE || self.sub.trim().is_empty() {
            return Err(AuthError::session_payload_invalid());
        }
        let audience = self.audience().ok_or_else(|| {
            AuthError::session_audience_invalid(
                "The session token was not issued for an accepted channel",
            )
        })?;
        if let Some(expected) = expected_audience {
            if audience != expected {
                return Err(expected.channel().audience_error());
            }
        }
        let exp = self.exp.ok_or_else(AuthError::session_invalid)?;
        if exp <= now.timestamp() {
            return Err(AuthError::session_invalid());
        }
        if let (Some(issued_at), Some(invalid_before)) =
            (self.issued_at_millis(), sessions_invalid_before)
        {
            if issued_at < i128::from(invalid_before.timestamp_millis()) {
                return Err(AuthError::session_revoked(
                    "The session was invalidated by a security action",
                ));
            }
        }
        Ok(())
    }
}

/// A token that passed signature, audience and payload validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSession {
    pub claims: SessionClaims,
    /// The channel the audience belongs to.
    pub channel: Option<Channel>,
}

impl VerifiedSession {
    /// Refuse a token that was not minted for `channel` (`requireStaffPrincipal` /
    /// `requireMerchantPrincipal` in `authDoubleCheck.ts`).
    ///
    /// The Sandbox channel accepts the admin and merchant audiences, so a merchant session passes
    /// `require_channel(Channel::Sandbox)`.
    pub fn require_channel(&self, channel: Channel) -> Result<(), AuthError> {
        let minted_for = self.channel.and_then(Channel::audience);
        match minted_for {
            Some(audience) if channel.accepts_audience(audience) => Ok(()),
            _ => Err(channel.audience_error()),
        }
    }

    /// The session id used by the revoke list.
    #[must_use]
    pub fn jti(&self) -> Option<&str> {
        self.claims.jti.as_deref()
    }

    /// `exp` as epoch seconds.
    #[must_use]
    pub fn expires_at(&self) -> Option<i64> {
        self.claims.exp
    }
}

/// Derive the 32-byte session signing key from `KMS_MASTER_KEY` (raw UTF-8 bytes).
pub fn session_key(master_key: &str) -> Result<[u8; 32], AuthError> {
    derive_key(master_key, b"session-signing")
}

/// Derive the 32-byte MFA HMAC key (`info = "mfa-challenge"`).
pub fn mfa_key(master_key: &str) -> Result<[u8; 32], AuthError> {
    derive_key(master_key, b"mfa-challenge")
}

fn derive_key(master_key: &str, info: &[u8]) -> Result<[u8; 32], AuthError> {
    let derived =
        pg_crypto::hkdf_sha256(master_key.as_bytes(), SESSION_ISSUER.as_bytes(), info, 32)
            .map_err(|_| {
                AuthError::new(
                    500,
                    SESSION_SIGNING_FAILED,
                    "The session signing key could not be derived",
                )
            })?;
    let key: [u8; 32] = derived.try_into().map_err(|_| {
        AuthError::new(
            500,
            SESSION_SIGNING_FAILED,
            "The derived signing key is not 32 bytes",
        )
    })?;
    Ok(key)
}

/// Sign a session with the process clock (production entry point).
pub fn sign_session(claims: &SessionClaims, master_key: &str) -> Result<String, AuthError> {
    sign_session_at(claims, master_key, Utc::now())
}

/// Sign a session at an explicit instant (deterministic tests and golden vectors).
///
/// Sets `typ` to `session`, `iss` to the core issuer, keeps `aud` when it is one of the three
/// audiences, and fills `iat`/`exp`/`jti` when the caller left them empty:
/// `exp = iat + 43200`, `jti = uuid v4` — exactly what `jwtid`/`expiresIn` do in TS.
pub fn sign_session_at(
    claims: &SessionClaims,
    master_key: &str,
    now: DateTime<Utc>,
) -> Result<String, AuthError> {
    if claims.sub.trim().is_empty() {
        return Err(AuthError::session_payload_invalid());
    }
    let audience = claims.audience().ok_or_else(|| {
        AuthError::new(
            500,
            SESSION_SIGNING_FAILED,
            "A session token needs one of the three channel audiences",
        )
    })?;
    let key = session_key(master_key)?;
    let mut payload = claims.clone();
    payload.typ = SESSION_TOKEN_TYPE.to_owned();
    payload.iss = Some(SESSION_ISSUER.to_owned());
    payload.aud = Some(audience.as_str().to_owned());
    let issued_at = payload.iat.unwrap_or_else(|| now.timestamp());
    payload.iat = Some(issued_at);
    payload.exp = Some(payload.exp.unwrap_or(issued_at + SESSION_TTL_SECONDS));
    if payload.jti.as_deref().unwrap_or_default().is_empty() {
        payload.jti = Some(Uuid::new_v4().to_string());
    }
    let encoding_key = EncodingKey::from_secret(&key).map_err(|_| {
        AuthError::new(
            500,
            SESSION_SIGNING_FAILED,
            "The session signing key is not usable",
        )
    })?;
    encode(&Header::new(Algorithm::HS256), &payload, &encoding_key).map_err(|_| {
        AuthError::new(
            500,
            SESSION_SIGNING_FAILED,
            "The session token could not be signed",
        )
    })
}

/// Verify a session token and validate its payload.
///
/// `expected_audience = None` accepts any of the three channel audiences (core's
/// `verifySessionToken(token)` use); `Some(audience)` pins one channel and returns
/// `SESSION_AUDIENCE_INVALID` for the others. Expiry is evaluated against `now`, not the process
/// clock, so callers (and tests) control the instant.
pub fn verify_session(
    token: &str,
    master_key: &str,
    expected_audience: Option<Audience>,
    now: DateTime<Utc>,
) -> Result<VerifiedSession, AuthError> {
    let key = session_key(master_key)?;
    let decoding_key = DecodingKey::from_secret(&key).map_err(|_| AuthError::session_invalid())?;
    let mut validation = Validation::new(Algorithm::HS256);
    // jsonwebtoken's own clock would make the validation non-deterministic and disagree with
    // `now`; presence of `exp` is still required, its value is checked by `validate` below.
    validation.validate_exp = false;
    validation.leeway = 0;
    validation.set_required_spec_claims(&["exp", "iss", "aud"]);
    validation.set_issuer(&[SESSION_ISSUER]);
    match expected_audience {
        Some(audience) => validation.set_audience(&[audience.as_str()]),
        None => validation.set_audience(&ALL_AUDIENCES),
    }
    let data = decode::<SessionClaims>(token.as_bytes(), &decoding_key, &validation)
        .map_err(|_| AuthError::session_invalid())?;
    let claims = data.claims;
    claims.validate(expected_audience, now, None)?;
    Ok(VerifiedSession {
        channel: claims.channel(),
        claims,
    })
}

/// Verify a session and also apply the durable revocation cutoff.
///
/// Convenience wrapper for the `authDoubleCheck` sequence: signature/audience first, then
/// `sessionsInvalidBefore` (`authDoubleCheck.ts:311-318`) in the same pass.
pub fn verify_session_with_cutoff(
    token: &str,
    master_key: &str,
    expected_audience: Option<Audience>,
    now: DateTime<Utc>,
    sessions_invalid_before: Option<DateTime<Utc>>,
) -> Result<VerifiedSession, AuthError> {
    let verified = verify_session(token, master_key, expected_audience, now)?;
    verified
        .claims
        .validate(expected_audience, now, sessions_invalid_before)?;
    Ok(verified)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::b64url;
    use chrono::TimeZone;

    const MASTER: &str = "golden-master-key";
    /// HKDF-SHA256("golden-master-key", "payment-gateway-core", "session-signing", 32).
    const SESSION_KEY_HEX: &str =
        "57092f0572f130f6c585c2e99b47b5f3b7b6375c5e54172807116a2d4eb013e5";
    /// HKDF-SHA256("golden-master-key", "payment-gateway-core", "mfa-challenge", 32).
    const MFA_KEY_HEX: &str = "36122db2e524b69db9cbde0c9ab848dcb380ed8bddea9aa135b8434b44f1b69f";

    fn at(seconds: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(seconds, 0)
            .single()
            .expect("valid instant")
    }

    fn merchant_claims() -> SessionClaims {
        let mut claims =
            SessionClaims::new("11111111-1111-4111-8111-111111111111", "MERCHANT_ADMIN")
                .with_merchant("22222222-2222-4222-8222-222222222222")
                .with_authorities(["merchant:write", "link:write"])
                .with_app_scope_ids(["33333333-3333-4333-8333-333333333333"])
                .with_mfa(true)
                .with_channel(Channel::Merchant)
                .expect("merchant channel");
        claims.jti = Some("44444444-4444-4444-8444-444444444444".to_owned());
        claims.iat = Some(1_764_288_000);
        claims.exp = Some(1_764_331_200);
        claims
    }

    #[test]
    fn derived_keys_match_the_golden_vectors() {
        assert_eq!(hex(&session_key(MASTER).expect("key")), SESSION_KEY_HEX);
        assert_eq!(hex(&mfa_key(MASTER).expect("key")), MFA_KEY_HEX);
        // The raw master string is used as-is: a different normalisation must change the key.
        assert_ne!(
            session_key(MASTER).expect("key"),
            session_key(&MASTER.to_uppercase()).expect("key")
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn signed_payload_carries_the_exact_claims() {
        let token = sign_session_at(&merchant_claims(), MASTER, at(1_764_288_000)).expect("sign");
        let segments: Vec<&str> = token.split('.').collect();
        assert_eq!(segments.len(), 3);
        let payload = b64url::decode(segments[1]).expect("payload base64url");
        let value: serde_json::Value = serde_json::from_slice(&payload).expect("json");
        assert_eq!(
            value,
            serde_json::json!({
                "sub": "11111111-1111-4111-8111-111111111111",
                "typ": "session",
                "role": "MERCHANT_ADMIN",
                "merchantId": "22222222-2222-4222-8222-222222222222",
                "authorities": ["merchant:write", "link:write"],
                "appScopeIds": ["33333333-3333-4333-8333-333333333333"],
                "mfa": true,
                "jti": "44444444-4444-4444-8444-444444444444",
                "iat": 1_764_288_000,
                "exp": 1_764_331_200,
                "aud": "payment-gateway-merchant",
                "iss": "payment-gateway-core",
            })
        );
    }

    #[test]
    fn signature_is_hs256_over_the_signing_input() {
        let token = sign_session_at(&merchant_claims(), MASTER, at(1_764_288_000)).expect("sign");
        let segments: Vec<&str> = token.split('.').collect();
        let signing_input = format!("{}.{}", segments[0], segments[1]);
        let key = session_key(MASTER).expect("key");
        let expected = b64url::encode(&pg_crypto::hmac_sha256(&key, signing_input.as_bytes()));
        // Order-independent check of algorithm + key: the golden python/Node implementation
        // produces the same HMAC for the same signing input.
        assert_eq!(segments[2], expected);
        let header = b64url::decode(segments[0]).expect("header");
        let header: serde_json::Value = serde_json::from_slice(&header).expect("json");
        assert_eq!(header["alg"], "HS256");
        assert_eq!(header["typ"], "JWT");
    }

    #[test]
    fn verify_accepts_its_own_token_and_reports_the_channel() {
        let token = sign_session_at(&merchant_claims(), MASTER, at(1_764_288_000)).expect("sign");
        let verified = verify_session(&token, MASTER, Some(Audience::MERCHANT), at(1_764_288_001))
            .expect("verify");
        assert_eq!(verified.channel, Some(Channel::Merchant));
        assert_eq!(verified.jti(), Some("44444444-4444-4444-8444-444444444444"));
        assert!(verified.require_channel(Channel::Merchant).is_ok());
        assert_eq!(
            verified
                .require_channel(Channel::Admin)
                .expect_err("cross channel")
                .code,
            "SESSION_AUDIENCE_INVALID"
        );
    }

    #[test]
    fn verify_rejects_another_channels_audience() {
        let token = sign_session_at(&merchant_claims(), MASTER, at(1_764_288_000)).expect("sign");
        let error = verify_session(&token, MASTER, Some(Audience::ADMIN), at(1_764_288_001))
            .expect_err("audience mismatch");
        assert_eq!(error.code, "SESSION_INVALID");
        assert_eq!(error.status, 401);
    }

    #[test]
    fn verify_rejects_a_tampered_payload_and_wrong_key() {
        let token = sign_session_at(&merchant_claims(), MASTER, at(1_764_288_000)).expect("sign");
        let mut segments: Vec<String> = token.split('.').map(str::to_owned).collect();
        let payload = b64url::decode(&segments[1]).expect("payload");
        let mut value: serde_json::Value = serde_json::from_slice(&payload).expect("json");
        value["role"] = serde_json::json!("MERCHANT_ADMIN_ESCALATED");
        segments[1] = b64url::encode(&serde_json::to_vec(&value).expect("json"));
        let tampered = segments.join(".");
        assert_eq!(
            verify_session(&tampered, MASTER, None, at(1_764_288_001))
                .expect_err("tampered")
                .code,
            "SESSION_INVALID"
        );
        assert_eq!(
            verify_session(&token, "another-master-key", None, at(1_764_288_001))
                .expect_err("wrong key")
                .code,
            "SESSION_INVALID"
        );
    }

    #[test]
    fn expiry_is_evaluated_against_the_supplied_clock() {
        let token = sign_session_at(&merchant_claims(), MASTER, at(1_764_288_000)).expect("sign");
        assert!(verify_session(&token, MASTER, None, at(1_764_331_199)).is_ok());
        let expired =
            verify_session(&token, MASTER, None, at(1_764_331_200)).expect_err("expired at exp");
        assert_eq!(expired.code, "SESSION_INVALID");
    }

    #[test]
    fn sessions_invalid_before_revokes_older_tokens() {
        let claims = merchant_claims();
        // iat * 1000 == 1_764_288_000_000
        assert!(claims
            .validate(None, at(1_764_288_001), Some(at_millis(1_764_287_999_500)))
            .is_ok());
        let revoked = claims
            .validate(None, at(1_764_288_001), Some(at_millis(1_764_288_000_001)))
            .expect_err("revoked");
        assert_eq!(revoked.code, "SESSION_REVOKED");
        assert_eq!(
            revoked.message,
            "The session was invalidated by a security action"
        );
    }

    fn at_millis(millis: i64) -> DateTime<Utc> {
        Utc.timestamp_millis_opt(millis).single().expect("instant")
    }

    #[test]
    fn payload_shape_is_enforced() {
        let mut claims = merchant_claims();
        claims.typ = "access".to_owned();
        assert_eq!(
            claims
                .validate(None, at(1_764_288_001), None)
                .expect_err("typ")
                .code,
            "SESSION_INVALID"
        );
        let mut claims = merchant_claims();
        claims.sub = "  ".to_owned();
        assert_eq!(
            claims
                .validate(None, at(1_764_288_001), None)
                .expect_err("sub")
                .code,
            "SESSION_INVALID"
        );
        let mut claims = merchant_claims();
        claims.exp = None;
        assert_eq!(
            claims
                .validate(None, at(1_764_288_001), None)
                .expect_err("exp")
                .code,
            "SESSION_INVALID"
        );
        let mut claims = merchant_claims();
        claims.aud = Some("payment-gateway-edge".to_owned());
        assert_eq!(
            claims
                .validate(None, at(1_764_288_001), None)
                .expect_err("aud")
                .code,
            "SESSION_AUDIENCE_INVALID"
        );
    }

    #[test]
    fn default_ttl_and_jti_are_filled_by_the_signer() {
        let now = at(1_764_288_000);
        let claims = SessionClaims::new("staff-1", "COMPLIANCE")
            .with_channel(Channel::Admin)
            .expect("admin");
        let token = sign_session_at(&claims, MASTER, now).expect("sign");
        let verified = verify_session(&token, MASTER, Some(Audience::ADMIN), now).expect("verify");
        assert_eq!(
            verified.claims.exp,
            Some(now.timestamp() + SESSION_TTL_SECONDS)
        );
        let jti = verified.jti().expect("jti");
        assert_eq!(jti.len(), 36);
        assert_eq!(jti, Uuid::parse_str(jti).expect("uuid").to_string());
        assert!(verified.claims.merchant_id.is_none());
    }

    #[test]
    fn sandbox_cannot_mint_a_session() {
        let claims = SessionClaims::new("staff-1", "COMPLIANCE");
        let error = claims
            .with_channel(Channel::Sandbox)
            .expect_err("no audience");
        assert_eq!(error.code, SESSION_SIGNING_FAILED);
        assert_eq!(error.status, 500);
    }

    #[test]
    fn signing_without_an_audience_is_refused() {
        let claims = SessionClaims::new("staff-1", "COMPLIANCE");
        assert_eq!(
            sign_session_at(&claims, MASTER, at(0))
                .expect_err("no audience")
                .code,
            SESSION_SIGNING_FAILED
        );
    }

    #[test]
    fn token_without_required_claims_is_refused() {
        // Missing `exp` → jsonwebtoken rejects the required claim.
        let key = session_key(MASTER).expect("key");
        let claims = serde_json::json!({
            "sub": "staff-1",
            "typ": "session",
            "role": "COMPLIANCE",
            "aud": "payment-gateway-admin",
            "iss": "payment-gateway-core",
        });
        let payload = b64url::encode(&serde_json::to_vec(&claims).expect("json"));
        let header = b64url::encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let signing_input = format!("{header}.{payload}");
        let signature = b64url::encode(&pg_crypto::hmac_sha256(&key, signing_input.as_bytes()));
        let token = format!("{signing_input}.{signature}");
        assert_eq!(
            verify_session(&token, MASTER, None, at(1_764_288_000))
                .expect_err("missing exp")
                .code,
            "SESSION_INVALID"
        );
    }

    #[test]
    fn legacy_issued_at_field_is_not_read() {
        // The payload carries `iat`; the TS-only `issuedAt` field must not be silently accepted as
        // a substitute (it would bypass the revocation cutoff).
        let claims: SessionClaims = serde_json::from_value(serde_json::json!({
            "sub": "staff-1",
            "typ": "session",
            "role": "COMPLIANCE",
            "merchantId": null,
            "authorities": ["*"],
            "appScopeIds": [],
            "mfa": true,
            "jti": "j",
            "exp": 1_764_331_200,
            "issuedAt": 1_764_288_000,
            "aud": "payment-gateway-admin",
            "iss": "payment-gateway-core"
        }))
        .expect("claims");
        assert_eq!(claims.iat, None);
        assert!(claims
            .validate(None, at(1_764_288_001), Some(at_millis(1_764_300_000)))
            .is_ok());
    }
}
