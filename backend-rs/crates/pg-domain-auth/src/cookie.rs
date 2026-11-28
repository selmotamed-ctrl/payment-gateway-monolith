//! Session-cookie mode (GAP-019).
//!
//! Port of `admin-back/lib/security/sessionCookie.ts` and the merchant copy
//! (`merchant-back/lib/security/sessionCookie.ts:19-50`), chapter 2 §5.
//!
//! With `SESSION_COOKIE_MODE=true` the session token is never handed to browser JavaScript: the
//! login/MFA response sets it as an `HttpOnly; SameSite=Strict` cookie and the body carries
//! `sessionCookie: true` instead of `token`. The edge turns the cookie back into the
//! `Authorization: Bearer` header it forwards to core, so core still verifies the same JWT.
//!
//! Unsafe methods authenticated by the cookie must also send `x-pg-csrf: 1` — a header a cross-site
//! HTML form cannot set.

#![forbid(unsafe_code)]

use crate::channel::Channel;
use crate::error::AuthError;

/// The admin cookie name.
pub const ADMIN_SESSION_COOKIE: &str = "pg_admin_session";
/// The admin cookie path.
pub const ADMIN_SESSION_COOKIE_PATH: &str = "/api/v1/admin";
/// The merchant cookie name.
pub const MERCHANT_SESSION_COOKIE: &str = "pg_merchant_session";
/// The merchant cookie path.
pub const MERCHANT_SESSION_COOKIE_PATH: &str = "/api/v1/merchant";

/// The CSRF header a cookie-authenticated write must carry.
pub const CSRF_HEADER: &str = "x-pg-csrf";
/// The CSRF header value that satisfies the check.
pub const CSRF_HEADER_VALUE: &str = "1";

/// Cookie lifetime, equal to the session TTL.
pub const SESSION_COOKIE_MAX_AGE_SECONDS: i64 = 43_200;

/// The value regex `^[A-Za-z0-9._-]{20,4096}$` of the edge helpers.
pub const SESSION_COOKIE_VALUE_MIN_LEN: usize = 20;
/// Upper bound of the accepted cookie value.
pub const SESSION_COOKIE_VALUE_MAX_LEN: usize = 4096;

/// Where a channel's session cookie lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionCookieSpec {
    pub name: &'static str,
    pub path: &'static str,
}

/// The admin cookie specification.
pub const ADMIN_COOKIE: SessionCookieSpec = SessionCookieSpec {
    name: ADMIN_SESSION_COOKIE,
    path: ADMIN_SESSION_COOKIE_PATH,
};
/// The merchant cookie specification.
pub const MERCHANT_COOKIE: SessionCookieSpec = SessionCookieSpec {
    name: MERCHANT_SESSION_COOKIE,
    path: MERCHANT_SESSION_COOKIE_PATH,
};

/// The cookie of a channel. `Checkout` (a payer has no session) and `Sandbox` (it re-uses the
/// admin/merchant cookie) have none.
#[must_use]
pub fn cookie_for(channel: Channel) -> Option<SessionCookieSpec> {
    match channel {
        Channel::Admin => Some(ADMIN_COOKIE),
        Channel::Merchant => Some(MERCHANT_COOKIE),
        Channel::Checkout | Channel::Sandbox => None,
    }
}

/// `^[A-Za-z0-9._-]{20,4096}$` without a regex dependency.
#[must_use]
pub fn is_valid_cookie_value(value: &str) -> bool {
    (SESSION_COOKIE_VALUE_MIN_LEN..=SESSION_COOKIE_VALUE_MAX_LEN).contains(&value.len())
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-'
        })
}

/// `readSessionCookie`: the value of the named cookie from a `Cookie` header, or `None` when it is
/// absent or does not match the value regex.
#[must_use]
pub fn read_session_cookie(cookie_header: Option<&str>, spec: SessionCookieSpec) -> Option<String> {
    let header = cookie_header?;
    for part in header.split(';') {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        if name.trim() != spec.name {
            continue;
        }
        let value = value.trim();
        return if is_valid_cookie_value(value) {
            Some(value.to_owned())
        } else {
            None
        };
    }
    None
}

fn cookie_attributes(spec: SessionCookieSpec, secure: bool, max_age_seconds: i64) -> String {
    let mut attributes = format!("Path={}; HttpOnly; SameSite=Strict", spec.path);
    if secure {
        attributes.push_str("; Secure");
    }
    attributes.push_str(&format!("; Max-Age={max_age_seconds}"));
    attributes
}

/// `setSessionCookie`: `name=token; Path=…; HttpOnly; SameSite=Strict[; Secure]; Max-Age=…`.
#[must_use]
pub fn set_cookie_header(
    spec: SessionCookieSpec,
    token: &str,
    secure: bool,
    max_age_seconds: i64,
) -> String {
    format!(
        "{}={}; {}",
        spec.name,
        token,
        cookie_attributes(spec, secure, max_age_seconds)
    )
}

/// `clearSessionCookie`: the same attributes with `Max-Age=0` and an empty value.
#[must_use]
pub fn clear_cookie_header(spec: SessionCookieSpec, secure: bool) -> String {
    format!("{}=; {}", spec.name, cookie_attributes(spec, secure, 0))
}

/// True for the methods that do not need the CSRF header.
#[must_use]
pub fn is_safe_method(method: &str) -> bool {
    matches!(
        method.to_ascii_uppercase().as_str(),
        "GET" | "HEAD" | "OPTIONS"
    )
}

/// The CSRF rule of `cookieSession`: an unsafe method authenticated by the cookie must send
/// `x-pg-csrf: 1`, else `403 CSRF_HEADER_REQUIRED`.
pub fn require_csrf(
    method: &str,
    cookie_authenticated: bool,
    csrf_header: Option<&str>,
) -> Result<(), AuthError> {
    if !cookie_authenticated || is_safe_method(method) {
        return Ok(());
    }
    if csrf_header == Some(CSRF_HEADER_VALUE) {
        Ok(())
    } else {
        Err(AuthError::csrf_header_required())
    }
}

/// Paths that are exempt from the cookie→bearer conversion, so a stale cookie cannot force the CSRF
/// header onto a login or MFA request (`sessionCookie.ts:70-78`).
///
/// The TS regular expression is
/// `/(?:^|\/)(?:auth\/)?(?:login|mfa|mfa\/resend|mfa\/verify|accept-invitation|register|verify-identity|google)$/`;
/// it is reproduced here as a segment-boundary suffix match (no regex dependency).
#[must_use]
pub fn is_auth_entry_path(path: &str) -> bool {
    const EXEMPT_SUFFIXES: [&str; 8] = [
        "login",
        "mfa",
        "mfa/resend",
        "mfa/verify",
        "accept-invitation",
        "register",
        "verify-identity",
        "google",
    ];
    EXEMPT_SUFFIXES
        .iter()
        .any(|suffix| match path.strip_suffix(suffix) {
            Some(prefix) => prefix.is_empty() || prefix.ends_with('/'),
            None => false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

    #[test]
    fn names_and_paths_match_the_edges() {
        assert_eq!(ADMIN_COOKIE.name, "pg_admin_session");
        assert_eq!(ADMIN_COOKIE.path, "/api/v1/admin");
        assert_eq!(MERCHANT_COOKIE.name, "pg_merchant_session");
        assert_eq!(MERCHANT_COOKIE.path, "/api/v1/merchant");
        assert_eq!(cookie_for(Channel::Admin), Some(ADMIN_COOKIE));
        assert_eq!(cookie_for(Channel::Merchant), Some(MERCHANT_COOKIE));
        assert_eq!(cookie_for(Channel::Checkout), None);
        assert_eq!(cookie_for(Channel::Sandbox), None);
    }

    #[test]
    fn value_regex_is_enforced() {
        assert!(is_valid_cookie_value(TOKEN));
        assert!(!is_valid_cookie_value("short"));
        assert!(!is_valid_cookie_value(
            &"a".repeat(SESSION_COOKIE_VALUE_MAX_LEN + 1)
        ));
        assert!(is_valid_cookie_value(
            &"a".repeat(SESSION_COOKIE_VALUE_MAX_LEN)
        ));
        assert!(!is_valid_cookie_value("aaaaaaaaaaaaaaaaaaaa+"));
        assert!(!is_valid_cookie_value("aaaaaaaaaaaaaaaaaaaa "));
        assert!(!is_valid_cookie_value(""));
    }

    #[test]
    fn reads_the_named_cookie_only() {
        let header = format!("other=1; {}={}; trailing=2", ADMIN_SESSION_COOKIE, TOKEN);
        assert_eq!(
            read_session_cookie(Some(&header), ADMIN_COOKIE),
            Some(TOKEN.to_owned())
        );
        assert_eq!(read_session_cookie(Some(&header), MERCHANT_COOKIE), None);
        assert_eq!(read_session_cookie(None, ADMIN_COOKIE), None);
        // An invalid value is treated as absent, never forwarded.
        let bad = format!("{}={}", ADMIN_SESSION_COOKIE, "short");
        assert_eq!(read_session_cookie(Some(&bad), ADMIN_COOKIE), None);
        // No '=' in a part is skipped.
        assert_eq!(
            read_session_cookie(
                Some(&format!("junk; {}={}", ADMIN_SESSION_COOKIE, TOKEN)),
                ADMIN_COOKIE
            ),
            Some(TOKEN.to_owned())
        );
    }

    #[test]
    fn set_cookie_attributes_follow_the_ts_order() {
        assert_eq!(
            set_cookie_header(ADMIN_COOKIE, TOKEN, true, SESSION_COOKIE_MAX_AGE_SECONDS),
            format!(
                "pg_admin_session={TOKEN}; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Secure; Max-Age=43200"
            )
        );
        // Secure is dropped when SESSION_COOKIE_SECURE=false.
        assert_eq!(
            set_cookie_header(MERCHANT_COOKIE, TOKEN, false, 60),
            format!("pg_merchant_session={TOKEN}; Path=/api/v1/merchant; HttpOnly; SameSite=Strict; Max-Age=60")
        );
    }

    #[test]
    fn clear_cookie_expires_it() {
        assert_eq!(
            clear_cookie_header(ADMIN_COOKIE, true),
            "pg_admin_session=; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Secure; Max-Age=0"
        );
    }

    #[test]
    fn csrf_is_required_only_for_unsafe_cookie_writes() {
        assert!(require_csrf("GET", true, None).is_ok());
        assert!(require_csrf("HEAD", true, None).is_ok());
        assert!(require_csrf("OPTIONS", true, None).is_ok());
        // Bearer-authenticated requests never need the header.
        assert!(require_csrf("POST", false, None).is_ok());
        assert!(require_csrf("POST", true, Some("1")).is_ok());
        assert!(require_csrf("post", true, Some("1")).is_ok());
        let error = require_csrf("POST", true, None).expect_err("csrf");
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "CSRF_HEADER_REQUIRED");
        assert_eq!(
            require_csrf("DELETE", true, Some("true"))
                .expect_err("not 1")
                .code,
            "CSRF_HEADER_REQUIRED"
        );
        assert_eq!(
            require_csrf("PUT", true, None).expect_err("csrf").code,
            "CSRF_HEADER_REQUIRED"
        );
    }

    #[test]
    fn auth_entry_paths_are_exempt() {
        for path in [
            "/auth/login",
            "/login",
            "/auth/mfa",
            "/auth/mfa/resend",
            "/auth/mfa/verify",
            "/auth/accept-invitation",
            "/auth/register",
            "/auth/verify-identity",
            "/auth/google",
        ] {
            assert!(is_auth_entry_path(path), "{path} should be exempt");
        }
        for path in [
            "/merchants",
            "/auth/logout",
            "/external/payments",
            "/",
            "/resend",
            "/auth/resend",
        ] {
            assert!(!is_auth_entry_path(path), "{path} should not be exempt");
        }
    }
}
