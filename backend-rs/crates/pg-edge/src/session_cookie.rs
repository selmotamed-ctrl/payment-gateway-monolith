//! Session cookie helpers and the advisory JWT shape checks used by the edges.
//!
//! Port of `{admin,merchant}-back/lib/security/sessionCookie.ts` (GAP-019/GAP-020).
//!
//! With `SESSION_COOKIE_MODE=true` the core-issued session token is never exposed to browser
//! JavaScript: login/MFA responses set it as `HttpOnly; SameSite=Strict` cookie and the body
//! carries `sessionCookie: true` instead of `token`. The edge turns the cookie back into the
//! `Authorization: Bearer` header forwarded to core, which still verifies signature, audience and
//! revoke list. Unsafe methods authenticated by cookie must also carry `x-pg-csrf: 1`.
//!
//! The JWT checks here are advisory exactly like the TypeScript ones: the signature is verified by
//! core; the edge only refuses an obviously malformed/expired/wrong-audience credential before it
//! does work (and, for uploads, before it buffers a file).

#![forbid(unsafe_code)]

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde_json::Value;

use crate::error::EdgeError;

pub const ADMIN_SESSION_COOKIE_NAME: &str = "pg_admin_session";
pub const ADMIN_SESSION_COOKIE_PATH: &str = "/api/v1/admin";
pub const MERCHANT_SESSION_COOKIE_NAME: &str = "pg_merchant_session";
pub const MERCHANT_SESSION_COOKIE_PATH: &str = "/api/v1/merchant";

pub const ADMIN_SESSION_AUDIENCE: &str = "payment-gateway-admin";
pub const MERCHANT_SESSION_AUDIENCE: &str = "payment-gateway-merchant";

/// `Max-Age` of every session cookie: 12 hours, the session JWT lifetime.
pub const SESSION_COOKIE_MAX_AGE_SECONDS: u64 = 43_200;

pub const CSRF_HEADER: &str = "x-pg-csrf";
pub const CSRF_REQUIRED_VALUE: &str = "1";

const SESSION_ALGORITHM: &str = "HS256";
const SESSION_TYPE: &str = "session";
const MAX_CLOCK_SKEW_SECONDS: i64 = 60;

/// Cookie name, path and audience of an edge channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionChannel {
    Admin,
    Merchant,
}

impl SessionChannel {
    #[must_use]
    pub fn cookie_name(self) -> &'static str {
        match self {
            Self::Admin => ADMIN_SESSION_COOKIE_NAME,
            Self::Merchant => MERCHANT_SESSION_COOKIE_NAME,
        }
    }

    #[must_use]
    pub fn cookie_path(self) -> &'static str {
        match self {
            Self::Admin => ADMIN_SESSION_COOKIE_PATH,
            Self::Merchant => MERCHANT_SESSION_COOKIE_PATH,
        }
    }

    #[must_use]
    pub fn audience(self) -> &'static str {
        match self {
            Self::Admin => ADMIN_SESSION_AUDIENCE,
            Self::Merchant => MERCHANT_SESSION_AUDIENCE,
        }
    }
}

/// A channel's `Set-Cookie` builder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionCookieConfig {
    pub name: &'static str,
    pub path: &'static str,
    /// `SESSION_COOKIE_SECURE` (default `true`); only tests/dev drop `Secure`.
    pub secure: bool,
}

impl SessionCookieConfig {
    #[must_use]
    pub const fn new(name: &'static str, path: &'static str, secure: bool) -> Self {
        Self { name, path, secure }
    }

    #[must_use]
    pub fn for_channel(channel: SessionChannel, secure: bool) -> Self {
        Self::new(channel.cookie_name(), channel.cookie_path(), secure)
    }

    fn attributes(&self, max_age_seconds: u64) -> String {
        let secure = if self.secure { "; Secure" } else { "" };
        format!(
            "Path={}; HttpOnly; SameSite=Strict{secure}; Max-Age={max_age_seconds}",
            self.path
        )
    }

    /// The `Set-Cookie` value for a successful login.
    #[must_use]
    pub fn set_header(&self, token: &str) -> String {
        format!(
            "{}={token}; {}",
            self.name,
            self.attributes(SESSION_COOKIE_MAX_AGE_SECONDS)
        )
    }

    /// The `Set-Cookie` value that removes the cookie (`Max-Age=0`).
    #[must_use]
    pub fn clear_header(&self) -> String {
        format!("{}=; {}", self.name, self.attributes(0))
    }
}

/// `^[A-Za-z0-9._-]{20,4096}$`.
#[must_use]
pub fn session_cookie_value_valid(value: &str) -> bool {
    (20..=4096).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Port of `readSessionCookie`: first matching cookie wins; an invalid value counts as absent.
#[must_use]
pub fn read_session_cookie(cookie_header: Option<&str>, name: &str) -> Option<String> {
    let header = cookie_header?;
    for part in header.split(';') {
        let Some(index) = part.find('=') else {
            continue;
        };
        if part[..index].trim() == name {
            let value = part[index + 1..].trim();
            return session_cookie_value_valid(value).then(|| value.to_owned());
        }
    }
    None
}

/// What `cookieSession` does next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CookieDecision {
    /// Continue without adding a credential (no usable header and no usable cookie, or an auth
    /// route where the cookie must not participate).
    Skip,
    /// Use this `Authorization` value: either the caller's own header, forwarded verbatim, or
    /// `Bearer <cookie token>` derived from a valid session cookie.
    Bearer(String),
    /// Refuse with `403 CSRF_HEADER_REQUIRED`.
    CsrfRequired,
}

/// The auth routes exempt from the cookie→bearer rewrite.
///
/// Port of the TS regex
/// `(?:^|\/)(?:auth\/)?(?:login|mfa|mfa\/resend|mfa\/verify|accept-invitation|register|verify-identity|google)$`.
#[must_use]
pub fn is_auth_exempt_path(path: &str) -> bool {
    const TAILS: [&str; 8] = [
        "login",
        "mfa",
        "mfa/resend",
        "mfa/verify",
        "accept-invitation",
        "register",
        "verify-identity",
        "google",
    ];
    TAILS.iter().any(|tail| {
        path == *tail
            || path.ends_with(&format!("/{tail}"))
            || path.ends_with(&format!("/auth/{tail}"))
    })
}

fn is_safe_method(method: &str) -> bool {
    method.eq_ignore_ascii_case("GET")
        || method.eq_ignore_ascii_case("HEAD")
        || method.eq_ignore_ascii_case("OPTIONS")
}

/// Port of the `cookieSession` middleware decision.
///
/// Decision order (the TypeScript middleware order expressed as an effective credential):
/// 1. A non-blank caller `Authorization` header wins and is forwarded verbatim — even when cookie
///    mode is off — and it is never subject to the cookie CSRF rule
///    (TS: `if (req.headers.authorization) { next(); return; }` before the cookie logic).
/// 2. Cookie mode off → no cookie credential, continue.
/// 3. An auth route (`login`, `mfa`, …) → the cookie must not authenticate it, continue.
/// 4. No valid session cookie → continue.
/// 5. An unsafe method without `x-pg-csrf: 1` → refuse.
/// 6. Otherwise use the cookie as `Bearer <token>`.
#[must_use]
pub fn cookie_session_decision(
    cookie_mode: bool,
    authorization: Option<&str>,
    method: &str,
    path: &str,
    cookie_header: Option<&str>,
    csrf_header: Option<&str>,
    config: &SessionCookieConfig,
) -> CookieDecision {
    if let Some(header) = authorization
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return CookieDecision::Bearer(header.to_owned());
    }
    // A leftover cookie must not authenticate (or block a login) when the mode is off.
    if !cookie_mode {
        return CookieDecision::Skip;
    }
    // Login/MFA are not authenticated by the cookie; a stale cookie must not force CSRF there.
    if is_auth_exempt_path(path) {
        return CookieDecision::Skip;
    }
    let Some(token) = read_session_cookie(cookie_header, config.name) else {
        return CookieDecision::Skip;
    };
    if !is_safe_method(method) && csrf_header != Some(CSRF_REQUIRED_VALUE) {
        return CookieDecision::CsrfRequired;
    }
    CookieDecision::Bearer(format!("Bearer {token}"))
}

/// Port of `captureSessionToken`: move `token` from a successful JSON body into the cookie.
///
/// Returns the `Set-Cookie` value when the body was rewritten. Error responses and bodies without
/// a string `token` are left untouched.
#[must_use]
pub fn capture_session_token(
    config: &SessionCookieConfig,
    status: u16,
    body: &mut Value,
) -> Option<String> {
    if status >= 400 {
        return None;
    }
    let object = body.as_object_mut()?;
    let token = object.get("token")?.as_str()?.to_owned();
    object.remove("token");
    object.insert("sessionCookie".to_owned(), Value::Bool(true));
    Some(config.set_header(&token))
}

fn bearer_token(authorization: &str) -> &str {
    let trimmed = authorization.trim();
    match trimmed.find(char::is_whitespace) {
        Some(index) if trimmed[..index].eq_ignore_ascii_case("bearer") => {
            trimmed[index..].trim_start()
        }
        _ => trimmed,
    }
}

fn decode_segment(segment: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(segment)
        .ok()
        .or_else(|| URL_SAFE.decode(segment).ok())
}

fn parse_segment(segment: &str) -> Option<Value> {
    serde_json::from_slice(&decode_segment(segment)?).ok()
}

fn audiences(payload: &Value) -> Vec<String> {
    match payload.get("aud") {
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(value) => Some(value.clone()),
                Value::Number(value) => Some(value.to_string()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Port of `assertMerchantSessionShape`, parameterised by audience so the admin edge can use the
/// same guard before buffering an upload.
///
/// It is signature-less on purpose: core still verifies the token. A successful check means
/// "HS256, `typ: session`, expected audience, unexpired, `nbf` within 60 s".
pub fn assert_session_shape(
    authorization: Option<&str>,
    audience: &str,
    now_ms: i64,
) -> Result<(), EdgeError> {
    let authorization = authorization.ok_or(EdgeError::AuthInvalid)?;
    let token = bearer_token(authorization);
    if token.starts_with("pg_live_")
        || token.starts_with("pg_test_")
        || token.split('.').count() != 3
    {
        return Err(EdgeError::AuthInvalid);
    }

    let mut parts = token.split('.');
    let header = parts
        .next()
        .and_then(parse_segment)
        .ok_or(EdgeError::AuthInvalid)?;
    let payload = parts
        .next()
        .and_then(parse_segment)
        .ok_or(EdgeError::AuthInvalid)?;

    if header.get("alg").and_then(Value::as_str) != Some(SESSION_ALGORITHM) {
        return Err(EdgeError::AuthInvalid);
    }
    if payload.get("typ").and_then(Value::as_str) != Some(SESSION_TYPE) {
        return Err(EdgeError::AuthInvalid);
    }
    if !audiences(&payload).iter().any(|value| value == audience) {
        return Err(EdgeError::AuthInvalid);
    }

    let now_seconds = now_ms.div_euclid(1_000);
    let expires = payload
        .get("exp")
        .and_then(Value::as_f64)
        .ok_or(EdgeError::AuthInvalid)?;
    if (now_seconds as f64) >= expires {
        return Err(EdgeError::AuthInvalid);
    }
    if let Some(not_before) = payload.get("nbf") {
        let not_before = not_before.as_f64().ok_or(EdgeError::AuthInvalid)?;
        if not_before > (now_seconds + MAX_CLOCK_SKEW_SECONDS) as f64 {
            return Err(EdgeError::AuthInvalid);
        }
    }
    Ok(())
}

/// Port of `requireMerchantAudience`: API tokens and non-JWTs pass (core decides); a JWT must
/// contain the channel audience.
pub fn require_audience(authorization: Option<&str>, audience: &str) -> Result<(), EdgeError> {
    let Some(header) = authorization else {
        return Ok(());
    };
    let token = bearer_token(header);
    if token.starts_with("pg_live_")
        || token.starts_with("pg_test_")
        || token.split('.').count() != 3
    {
        return Ok(());
    }
    let Some(payload) = token.split('.').nth(1).and_then(parse_segment) else {
        // Unreadable payload: core will refuse it.
        return Ok(());
    };
    if audiences(&payload).iter().any(|value| value == audience) {
        Ok(())
    } else {
        Err(EdgeError::AuthAudienceInvalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn token(header: Value, payload: Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).expect("header"));
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("payload"));
        format!("{header}.{payload}.signature")
    }

    fn valid_merchant(now_ms: i64) -> String {
        token(
            json!({ "alg": "HS256", "typ": "JWT" }),
            json!({
                "sub": "user-1",
                "typ": "session",
                "aud": "payment-gateway-merchant",
                "exp": now_ms / 1000 + 3600,
            }),
        )
    }

    #[test]
    fn cookie_headers_match_the_typescript_strings() {
        let config = SessionCookieConfig::for_channel(SessionChannel::Admin, true);
        assert_eq!(
            config.set_header("abcdefghijklmnopqrstuvwx"),
            "pg_admin_session=abcdefghijklmnopqrstuvwx; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Secure; Max-Age=43200"
        );
        assert_eq!(
            config.clear_header(),
            "pg_admin_session=; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Secure; Max-Age=0"
        );
        let insecure = SessionCookieConfig::for_channel(SessionChannel::Merchant, false);
        assert_eq!(
            insecure.set_header("abcdefghijklmnopqrstuvwx"),
            "pg_merchant_session=abcdefghijklmnopqrstuvwx; Path=/api/v1/merchant; HttpOnly; SameSite=Strict; Max-Age=43200"
        );
        assert_eq!(SESSION_COOKIE_MAX_AGE_SECONDS, 43_200);
    }

    #[test]
    fn cookie_value_regex() {
        assert!(session_cookie_value_valid("abcdefghijklmnopqrst")); // 20
        assert!(!session_cookie_value_valid("abcdefghijklmnopqrs")); // 19
        assert!(session_cookie_value_valid(&"a".repeat(4096)));
        assert!(!session_cookie_value_valid(&"a".repeat(4097)));
        assert!(!session_cookie_value_valid("abc defghijklmnopqrst"));
        assert!(!session_cookie_value_valid("abc+defghijklmnopqrst"));
    }

    #[test]
    fn reads_only_a_valid_matching_cookie() {
        let valid = "a".repeat(24);
        let header = format!("theme=dark; pg_admin_session={valid}; other=1");
        assert_eq!(
            read_session_cookie(Some(header.as_str()), "pg_admin_session"),
            Some(valid)
        );
        assert_eq!(
            read_session_cookie(Some("pg_admin_session=too-short"), "pg_admin_session"),
            None
        );
        assert_eq!(
            read_session_cookie(Some("other=1"), "pg_admin_session"),
            None
        );
        assert_eq!(read_session_cookie(None, "pg_admin_session"), None);
        assert_eq!(
            read_session_cookie(Some("pg_admin_session = abc"), "pg_admin_session"),
            None
        );
    }

    #[test]
    fn auth_exempt_paths_match_the_typescript_regex() {
        assert!(is_auth_exempt_path("/api/v1/admin/login"));
        assert!(is_auth_exempt_path("/api/v1/admin/auth/login"));
        assert!(is_auth_exempt_path("/api/v1/merchant/mfa"));
        assert!(is_auth_exempt_path("/api/v1/merchant/mfa/verify"));
        assert!(is_auth_exempt_path("/api/v1/admin/auth/mfa/resend"));
        assert!(is_auth_exempt_path("/accept-invitation"));
        assert!(is_auth_exempt_path("/api/v1/merchant/auth/google"));
        assert!(!is_auth_exempt_path("/api/v1/admin/merchants"));
        assert!(!is_auth_exempt_path("/api/v1/admin/login/extra"));
        assert!(!is_auth_exempt_path("/api/v1/merchant/mfa/verify/extra"));
    }

    #[test]
    fn cookie_session_decisions() {
        let config = SessionCookieConfig::for_channel(SessionChannel::Admin, true);
        let cookie = format!("{}={}", config.name, "b".repeat(24));
        let cookie_bearer = CookieDecision::Bearer(format!("Bearer {}", "b".repeat(24)));

        // Mode off and no header: a leftover cookie is ignored.
        assert_eq!(
            cookie_session_decision(
                false,
                None,
                "POST",
                "/x",
                Some(cookie.as_str()),
                None,
                &config
            ),
            CookieDecision::Skip
        );
        // A caller Authorization header wins over cookie mode and over the cookie, and is not
        // subject to the cookie CSRF rule.
        assert_eq!(
            cookie_session_decision(
                true,
                Some("Bearer x"),
                "POST",
                "/x",
                Some(cookie.as_str()),
                None,
                &config
            ),
            CookieDecision::Bearer("Bearer x".to_owned())
        );
        assert_eq!(
            cookie_session_decision(false, Some("Bearer x"), "POST", "/x", None, None, &config),
            CookieDecision::Bearer("Bearer x".to_owned())
        );
        // A blank header is not a credential.
        assert_eq!(
            cookie_session_decision(false, Some("   "), "POST", "/x", None, None, &config),
            CookieDecision::Skip
        );
        // Login/MFA never use the cookie.
        assert_eq!(
            cookie_session_decision(
                true,
                None,
                "POST",
                "/api/v1/admin/login",
                Some(cookie.as_str()),
                None,
                &config
            ),
            CookieDecision::Skip
        );

        assert_eq!(
            cookie_session_decision(
                true,
                None,
                "GET",
                "/x",
                Some(cookie.as_str()),
                None,
                &config
            ),
            cookie_bearer
        );
        assert_eq!(
            cookie_session_decision(
                true,
                None,
                "POST",
                "/x",
                Some(cookie.as_str()),
                Some("1"),
                &config
            ),
            cookie_bearer
        );
        assert_eq!(
            cookie_session_decision(
                true,
                None,
                "POST",
                "/x",
                Some(cookie.as_str()),
                None,
                &config
            ),
            CookieDecision::CsrfRequired
        );
        assert_eq!(
            cookie_session_decision(
                true,
                None,
                "POST",
                "/x",
                Some(cookie.as_str()),
                Some("0"),
                &config
            ),
            CookieDecision::CsrfRequired
        );
    }

    #[test]
    fn capture_moves_the_token_and_marks_the_body() {
        let config = SessionCookieConfig::for_channel(SessionChannel::Merchant, true);
        let token = "a".repeat(24);
        let mut body = json!({ "token": token, "user": { "id": "u1" } });
        let header = capture_session_token(&config, 200, &mut body).expect("rewrites");
        assert!(header.starts_with("pg_merchant_session="));
        assert!(header.contains("HttpOnly"));
        assert_eq!(
            body,
            json!({ "user": { "id": "u1" }, "sessionCookie": true })
        );

        let mut error_body = json!({ "token": "a".repeat(24) });
        assert_eq!(capture_session_token(&config, 401, &mut error_body), None);
        assert!(error_body.get("token").is_some());

        let mut no_token = json!({ "ok": true });
        assert_eq!(capture_session_token(&config, 200, &mut no_token), None);
    }

    #[test]
    fn session_shape_accepts_a_live_merchant_token() {
        let now_ms = 1_700_000_000_000;
        let jwt = valid_merchant(now_ms);
        let bearer = format!("Bearer {jwt}");
        let lower = format!("bearer {jwt}");
        assert_eq!(
            assert_session_shape(Some(bearer.as_str()), MERCHANT_SESSION_AUDIENCE, now_ms),
            Ok(())
        );
        assert_eq!(
            assert_session_shape(Some(lower.as_str()), MERCHANT_SESSION_AUDIENCE, now_ms),
            Ok(())
        );
    }

    #[test]
    fn session_shape_refuses_wrong_audience_alg_type_and_expiry() {
        let now_ms = 1_700_000_000_000;
        let jwt = valid_merchant(now_ms);
        assert_eq!(
            assert_session_shape(Some(jwt.as_str()), ADMIN_SESSION_AUDIENCE, now_ms),
            Err(EdgeError::AuthInvalid)
        );

        let wrong_alg = token(
            json!({ "alg": "none" }),
            json!({ "typ": "session", "aud": MERCHANT_SESSION_AUDIENCE, "exp": now_ms / 1000 + 60 }),
        );
        assert_eq!(
            assert_session_shape(Some(wrong_alg.as_str()), MERCHANT_SESSION_AUDIENCE, now_ms),
            Err(EdgeError::AuthInvalid)
        );

        let wrong_type = token(
            json!({ "alg": "HS256" }),
            json!({ "typ": "api", "aud": MERCHANT_SESSION_AUDIENCE, "exp": now_ms / 1000 + 60 }),
        );
        assert_eq!(
            assert_session_shape(Some(wrong_type.as_str()), MERCHANT_SESSION_AUDIENCE, now_ms),
            Err(EdgeError::AuthInvalid)
        );

        let expired = token(
            json!({ "alg": "HS256" }),
            json!({ "typ": "session", "aud": MERCHANT_SESSION_AUDIENCE, "exp": now_ms / 1000 }),
        );
        assert_eq!(
            assert_session_shape(Some(expired.as_str()), MERCHANT_SESSION_AUDIENCE, now_ms),
            Err(EdgeError::AuthInvalid)
        );
    }

    #[test]
    fn session_shape_refuses_api_tokens_and_malformed_values() {
        assert_eq!(
            assert_session_shape(Some("Bearer pg_live_abc"), MERCHANT_SESSION_AUDIENCE, 0),
            Err(EdgeError::AuthInvalid)
        );
        assert_eq!(
            assert_session_shape(Some("Bearer pg_test_abc"), MERCHANT_SESSION_AUDIENCE, 0),
            Err(EdgeError::AuthInvalid)
        );
        assert_eq!(
            assert_session_shape(Some("Bearer not.a.jwt"), MERCHANT_SESSION_AUDIENCE, 0),
            Err(EdgeError::AuthInvalid)
        );
        assert_eq!(
            assert_session_shape(None, MERCHANT_SESSION_AUDIENCE, 0),
            Err(EdgeError::AuthInvalid)
        );
    }

    #[test]
    fn session_shape_checks_nbf_with_skew() {
        let now_ms = 1_700_000_000_000;
        let now_seconds = now_ms / 1000;
        let future = token(
            json!({ "alg": "HS256" }),
            json!({
                "typ": "session",
                "aud": MERCHANT_SESSION_AUDIENCE,
                "exp": now_seconds + 3600,
                "nbf": now_seconds + 61,
            }),
        );
        assert_eq!(
            assert_session_shape(Some(future.as_str()), MERCHANT_SESSION_AUDIENCE, now_ms),
            Err(EdgeError::AuthInvalid)
        );
        let within_skew = token(
            json!({ "alg": "HS256" }),
            json!({
                "typ": "session",
                "aud": [MERCHANT_SESSION_AUDIENCE],
                "exp": now_seconds + 3600,
                "nbf": now_seconds + 60,
            }),
        );
        assert_eq!(
            assert_session_shape(
                Some(within_skew.as_str()),
                MERCHANT_SESSION_AUDIENCE,
                now_ms
            ),
            Ok(())
        );
    }

    #[test]
    fn audience_requirement_only_checks_jwts() {
        assert_eq!(require_audience(None, MERCHANT_SESSION_AUDIENCE), Ok(()));
        assert_eq!(
            require_audience(Some("Bearer pg_live_abc"), MERCHANT_SESSION_AUDIENCE),
            Ok(())
        );
        assert_eq!(
            require_audience(Some("Bearer not-a-jwt"), MERCHANT_SESSION_AUDIENCE),
            Ok(())
        );
        let jwt = token(
            json!({ "alg": "HS256" }),
            json!({ "aud": MERCHANT_SESSION_AUDIENCE }),
        );
        assert_eq!(
            require_audience(Some(jwt.as_str()), MERCHANT_SESSION_AUDIENCE),
            Ok(())
        );
        assert_eq!(
            require_audience(Some(jwt.as_str()), ADMIN_SESSION_AUDIENCE),
            Err(EdgeError::AuthAudienceInvalid)
        );
    }
}
