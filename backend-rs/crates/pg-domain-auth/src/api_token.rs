//! API access tokens, planes and IP allow-lists.
//!
//! Port of `core-back/lib/executionPlane.ts`, `core-back/lib/auth/index.ts:82-85`
//! (`hashAccessToken`, `generateAccessToken`), `core-back/api/middleware/authDoubleCheck.ts:100-157`
//! (`resolveApiTokenPrincipal`, `ipWithinCidr`, `ipAllowed`) and the API-token scope gate in
//! `core-back/api/internal/merchant.ts:1388-1395`.
//!
//! Token format: `pg_live_` (Live plane) or `pg_test_` (Sandbox plane) followed by
//! `base64url(32 random bytes)` — 43 characters, no padding. The database stores the hex SHA-256 of
//! the **whole** string (`AccessToken.tokenHash`), never the token.
//!
//! Deviation (recorded for `DEVIATIONS.md`): `pg-domain-auth` has no `rand` dependency, so random
//! bytes come from `uuid` v4 values (two UUIDs = 32 bytes; 244 random bits) instead of
//! `crypto.randomBytes`. Token shape, prefix, length and hash are unchanged.

#![forbid(unsafe_code)]

use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::b64url;
use crate::error::AuthError;

/// Live plane token prefix.
pub const LIVE_TOKEN_PREFIX: &str = "pg_live_";
/// Sandbox plane token prefix.
pub const SANDBOX_TOKEN_PREFIX: &str = "pg_test_";
/// Random bytes in the token payload.
pub const API_TOKEN_BYTES: usize = 32;
/// Base64url length of 32 bytes without padding.
pub const API_TOKEN_PAYLOAD_LEN: usize = 43;

/// The execution plane a process (or token) belongs to.
///
/// `getExecutionPlane` fails closed to `LIVE`; an explicitly invalid `EXECUTION_PLANE` aborts the
/// process at boot through the environment schema, which the caller implements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ExecutionPlane {
    Live,
    Sandbox,
}

impl ExecutionPlane {
    /// Parse `EXECUTION_PLANE` (case-insensitive, trimmed). `None` → [`Self::Live`] (fail closed),
    /// an unrecognised non-empty value is an error.
    #[must_use]
    pub fn parse(raw: Option<&str>) -> Option<Self> {
        match raw.unwrap_or("LIVE").trim().to_ascii_uppercase().as_str() {
            "LIVE" => Some(Self::Live),
            "SANDBOX" => Some(Self::Sandbox),
            _ => None,
        }
    }

    /// `LIVE` / `SANDBOX`, the value stored in `access_tokens.env` and `payment_links.env`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "LIVE",
            Self::Sandbox => "SANDBOX",
        }
    }

    /// The token prefix of this plane.
    #[must_use]
    pub fn token_prefix(self) -> &'static str {
        match self {
            Self::Live => LIVE_TOKEN_PREFIX,
            Self::Sandbox => SANDBOX_TOKEN_PREFIX,
        }
    }

    /// The other plane.
    #[must_use]
    pub fn opposite(self) -> Self {
        match self {
            Self::Live => Self::Sandbox,
            Self::Sandbox => Self::Live,
        }
    }
}

/// A structurally valid API token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiToken {
    raw: String,
    plane: ExecutionPlane,
}

impl ApiToken {
    /// Parse `pg_live_…` / `pg_test_…` and verify the payload is 32 base64url bytes.
    ///
    /// Any defect is `401 ACCESS_TOKEN_INVALID`, the same answer the TS lookup produces for a token
    /// it cannot find (chapter 2 §5).
    pub fn parse(raw: &str) -> Result<Self, AuthError> {
        let plane = if raw.starts_with(LIVE_TOKEN_PREFIX) {
            ExecutionPlane::Live
        } else if raw.starts_with(SANDBOX_TOKEN_PREFIX) {
            ExecutionPlane::Sandbox
        } else {
            return Err(AuthError::access_token_invalid(
                "The supplied access token is not recognised",
            ));
        };
        let payload = &raw[plane.token_prefix().len()..];
        match b64url::decode(payload) {
            Some(bytes) if bytes.len() == API_TOKEN_BYTES => Ok(Self {
                raw: raw.to_owned(),
                plane,
            }),
            _ => Err(AuthError::access_token_invalid(
                "The supplied access token is not recognised",
            )),
        }
    }

    /// The plane encoded in the prefix.
    #[must_use]
    pub fn plane(&self) -> ExecutionPlane {
        self.plane
    }

    /// The raw token (for the `Authorization` relay only — never log it).
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.raw
    }

    /// `hashAccessToken`: hex SHA-256 of the whole token.
    #[must_use]
    pub fn token_hash(&self) -> String {
        hash_access_token(&self.raw)
    }

    /// API tokens may only call the external API: `403 API_TOKEN_SCOPE_VIOLATION` for every path
    /// that does not start with `/external/` (router-relative, as in `merchant.ts:1392`).
    #[must_use]
    pub fn scope_violation(&self, router_path: &str) -> Option<AuthError> {
        if router_path.starts_with("/external/") {
            None
        } else {
            Some(AuthError::api_token_scope_violation())
        }
    }

    /// Refuse a token minted for the other plane (`401 SANDBOX_TOKEN_ON_LIVE_PLANE` /
    /// `401 LIVE_TOKEN_ON_SANDBOX_PLANE`).
    pub fn check_plane(&self, process_plane: ExecutionPlane) -> Result<(), AuthError> {
        if self.plane == process_plane {
            Ok(())
        } else {
            Err(plane_mismatch_error(self.plane, process_plane))
        }
    }
}

/// The plane-mismatch error for a presented token on a process plane.
#[must_use]
pub fn plane_mismatch_error(
    token_plane: ExecutionPlane,
    process_plane: ExecutionPlane,
) -> AuthError {
    match (token_plane, process_plane) {
        (ExecutionPlane::Sandbox, ExecutionPlane::Live) => AuthError::sandbox_token_on_live_plane(),
        (ExecutionPlane::Live, ExecutionPlane::Sandbox) => AuthError::live_token_on_sandbox_plane(),
        _ => AuthError::access_token_invalid("The supplied access token is not recognised"),
    }
}

/// True when the bearer value is an API token rather than a session JWT.
#[must_use]
pub fn is_api_token(value: &str) -> bool {
    value.starts_with(LIVE_TOKEN_PREFIX) || value.starts_with(SANDBOX_TOKEN_PREFIX)
}

/// `tokenMatchesPlane`: a plane-tagged token must match; a non-API-token value always passes
/// (the caller then treats it as a session JWT).
#[must_use]
pub fn token_matches_plane(token: &str, plane: ExecutionPlane) -> bool {
    if token.starts_with(SANDBOX_TOKEN_PREFIX) {
        return plane == ExecutionPlane::Sandbox;
    }
    if token.starts_with(LIVE_TOKEN_PREFIX) {
        return plane == ExecutionPlane::Live;
    }
    true
}

/// `hashAccessToken`.
#[must_use]
pub fn hash_access_token(token: &str) -> String {
    pg_crypto::sha256_hex(token.as_bytes())
}

/// `generateAccessToken` for an explicit plane.
#[must_use]
pub fn generate_api_token(plane: ExecutionPlane) -> String {
    api_token_from_bytes(plane, &random_bytes())
}

/// Deterministic token construction (golden vectors and tests).
#[must_use]
pub fn api_token_from_bytes(plane: ExecutionPlane, payload: &[u8; API_TOKEN_BYTES]) -> String {
    format!("{}{}", plane.token_prefix(), b64url::encode(payload))
}

/// 32 random bytes. Uses `uuid` v4 (the only randomness source in this crate's dependency set).
#[must_use]
pub fn random_bytes() -> [u8; API_TOKEN_BYTES] {
    let mut bytes = [0_u8; API_TOKEN_BYTES];
    let mut filled = 0;
    while filled < API_TOKEN_BYTES {
        let uuid = Uuid::new_v4();
        let chunk = uuid.as_bytes();
        let take = (API_TOKEN_BYTES - filled).min(chunk.len());
        bytes[filled..filled + take].copy_from_slice(&chunk[..take]);
        filled += take;
    }
    bytes
}

/// `ipWithinCidr`: address and network must be the same family; a CIDR without a prefix is a host
/// route (`/32` or `/128`). Unparsable input is `false`, never an error.
#[must_use]
pub fn ip_within_cidr(address: &str, cidr: &str) -> bool {
    let Ok(address) = address.trim().parse::<IpAddr>() else {
        return false;
    };
    let (network_part, prefix_part) = match cidr.trim().split_once('/') {
        Some((network, prefix)) => (network, Some(prefix)),
        None => (cidr.trim(), None),
    };
    let Ok(network) = network_part.parse::<IpAddr>() else {
        return false;
    };
    let prefix = match prefix_part {
        Some(prefix) => match prefix.parse::<u8>() {
            Ok(prefix) => prefix,
            Err(_) => return false,
        },
        None if address.is_ipv4() => 32,
        None => 128,
    };
    let Some(network) = ipnet::IpNet::new(network, prefix).ok() else {
        return false;
    };
    network.contains(&address)
}

/// `ipAllowed`: an empty allow-list allows every address; a missing address is refused when a list
/// is configured.
#[must_use]
pub fn ip_allowed(address: Option<&str>, cidrs: &[String]) -> bool {
    if cidrs.is_empty() {
        return true;
    }
    let Some(address) = address else {
        return false;
    };
    cidrs.iter().any(|cidr| ip_within_cidr(address, cidr))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> [u8; API_TOKEN_BYTES] {
        let mut bytes = [0_u8; API_TOKEN_BYTES];
        for (index, slot) in bytes.iter_mut().enumerate() {
            *slot = index as u8;
        }
        bytes
    }

    #[test]
    fn token_shape_is_prefix_plus_43_base64url_characters() {
        let live = api_token_from_bytes(ExecutionPlane::Live, &payload());
        assert!(live.starts_with("pg_live_"));
        assert_eq!(live.len(), "pg_live_".len() + API_TOKEN_PAYLOAD_LEN);
        let sandbox = api_token_from_bytes(ExecutionPlane::Sandbox, &payload());
        assert!(sandbox.starts_with("pg_test_"));
        assert_eq!(sandbox.len(), "pg_test_".len() + API_TOKEN_PAYLOAD_LEN);
        assert!(live["pg_live_".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
    }

    #[test]
    fn parse_returns_the_plane_and_the_golden_hash() {
        // hex SHA-256("pg_live_AAAA") from an independent implementation.
        assert_eq!(
            hash_access_token("pg_live_AAAA"),
            "a836833ee0056c5dedb3f2aea8a9cadddc9e809b056a094b9be9dd1bbf441e07"
        );
        let token = api_token_from_bytes(ExecutionPlane::Sandbox, &payload());
        let parsed = ApiToken::parse(&token).expect("parse");
        assert_eq!(parsed.plane(), ExecutionPlane::Sandbox);
        assert_eq!(parsed.token_hash(), pg_crypto::sha256_hex(token.as_bytes()));
        assert_eq!(parsed.token_hash().len(), 64);
    }

    #[test]
    fn malformed_tokens_are_access_token_invalid() {
        for value in [
            "",
            "pg_live_",
            "pg_live_short",
            // 43 characters but standard-alphabet characters that base64url rejects.
            "pg_live_+++++++++++++++++++++++++++++++++++++++++++",
            // JWT-like value: not an API token at all.
            "eyJhbGciOiJIUzI1NiJ9.e30.signature",
        ] {
            let error = ApiToken::parse(value).expect_err("malformed");
            assert_eq!(error.code, "ACCESS_TOKEN_INVALID");
            assert_eq!(error.status, 401);
        }
        // A valid alphabet but the wrong decoded length (31 bytes).
        let short = format!("pg_live_{}", b64url::encode(&[7_u8; 31]));
        assert!(ApiToken::parse(&short).is_err());
    }

    #[test]
    fn prefix_helpers() {
        assert!(is_api_token("pg_live_x"));
        assert!(is_api_token("pg_test_x"));
        assert!(!is_api_token("Bearer pg_live_x"));
        assert!(!is_api_token("eyJhbGciOi"));
        assert!(token_matches_plane("a-session-jwt", ExecutionPlane::Live));
        assert!(token_matches_plane("pg_live_x", ExecutionPlane::Live));
        assert!(!token_matches_plane("pg_test_x", ExecutionPlane::Live));
        assert!(token_matches_plane("pg_test_x", ExecutionPlane::Sandbox));
        assert!(!token_matches_plane("pg_live_x", ExecutionPlane::Sandbox));
    }

    #[test]
    fn plane_mismatch_messages_match_the_ts_strings() {
        let live =
            ApiToken::parse(&api_token_from_bytes(ExecutionPlane::Live, &payload())).expect("live");
        let sandbox = ApiToken::parse(&api_token_from_bytes(ExecutionPlane::Sandbox, &payload()))
            .expect("sandbox");
        let error = sandbox
            .check_plane(ExecutionPlane::Live)
            .expect_err("mismatch");
        assert_eq!(error.code, "SANDBOX_TOKEN_ON_LIVE_PLANE");
        assert_eq!(
            error.message,
            "A sandbox (pg_test_) token cannot be used on the LIVE execution plane"
        );
        let error = live
            .check_plane(ExecutionPlane::Sandbox)
            .expect_err("mismatch");
        assert_eq!(error.code, "LIVE_TOKEN_ON_SANDBOX_PLANE");
        assert!(live.check_plane(ExecutionPlane::Live).is_ok());
        assert!(sandbox.check_plane(ExecutionPlane::Sandbox).is_ok());
    }

    #[test]
    fn api_tokens_only_reach_the_external_api() {
        let token = ApiToken::parse(&api_token_from_bytes(ExecutionPlane::Live, &payload()))
            .expect("token");
        assert!(token.scope_violation("/external/links").is_none());
        for path in ["/external", "/links", "/", "/users", "/external"] {
            assert_eq!(
                token.scope_violation(path).expect("violation").code,
                "API_TOKEN_SCOPE_VIOLATION"
            );
        }
        assert_eq!(
            token.scope_violation("/users").expect("violation").message,
            "API access tokens can only call the external API"
        );
    }

    #[test]
    fn execution_plane_parse_fails_closed_to_live() {
        assert_eq!(ExecutionPlane::parse(None), Some(ExecutionPlane::Live));
        assert_eq!(
            ExecutionPlane::parse(Some(" sandbox ")),
            Some(ExecutionPlane::Sandbox)
        );
        assert_eq!(
            ExecutionPlane::parse(Some("live")),
            Some(ExecutionPlane::Live)
        );
        assert_eq!(ExecutionPlane::parse(Some("staging")), None);
        assert_eq!(ExecutionPlane::Sandbox.as_str(), "SANDBOX");
        assert_eq!(ExecutionPlane::Live.token_prefix(), "pg_live_");
        assert_eq!(ExecutionPlane::Sandbox.token_prefix(), "pg_test_");
        assert_eq!(ExecutionPlane::Live.opposite(), ExecutionPlane::Sandbox);
    }

    #[test]
    fn cidr_matching_follows_ipaddr_js() {
        assert!(ip_within_cidr("203.0.113.9", "203.0.113.0/24"));
        assert!(!ip_within_cidr("203.0.114.9", "203.0.113.0/24"));
        assert!(ip_within_cidr("203.0.113.9", "203.0.113.9"));
        assert!(!ip_within_cidr("203.0.113.10", "203.0.113.9"));
        assert!(ip_within_cidr("::1", "::1/128"));
        assert!(ip_within_cidr("2001:db8::5", "2001:db8::/32"));
        // Family mismatch never matches.
        assert!(!ip_within_cidr("2001:db8::5", "10.0.0.0/8"));
        assert!(!ip_within_cidr("10.0.0.1", "::/0"));
        // Malformed input is false, not an error.
        assert!(!ip_within_cidr("not-an-ip", "10.0.0.0/8"));
        assert!(!ip_within_cidr("10.0.0.1", "10.0.0.0/99"));
        assert!(!ip_within_cidr("10.0.0.1", "10.0.0.0/x"));
    }

    #[test]
    fn allow_list_semantics() {
        let cidrs = vec!["10.0.0.0/8".to_owned(), "192.168.1.0/24".to_owned()];
        assert!(ip_allowed(Some("10.1.2.3"), &cidrs));
        assert!(ip_allowed(Some("192.168.1.44"), &cidrs));
        assert!(!ip_allowed(Some("203.0.113.9"), &cidrs));
        assert!(!ip_allowed(None, &cidrs));
        // No list → everything allowed, including an unknown address.
        assert!(ip_allowed(None, &[]));
        assert!(ip_allowed(Some("203.0.113.9"), &[]));
    }

    #[test]
    fn generated_tokens_are_unique_and_parseable() {
        let first = generate_api_token(ExecutionPlane::Live);
        let second = generate_api_token(ExecutionPlane::Live);
        assert_ne!(first, second);
        assert!(ApiToken::parse(&first).is_ok());
        assert_eq!(first.len(), "pg_live_".len() + API_TOKEN_PAYLOAD_LEN);
    }
}
