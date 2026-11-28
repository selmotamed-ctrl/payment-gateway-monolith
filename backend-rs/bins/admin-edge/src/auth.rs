//! Administrative session shape checks and the advisory edge authority guard.
//!
//! Port of `admin-back/api/middleware/authorityGuard.ts`. The edge cannot verify the signature
//! (core owns the HKDF-derived key), so it refuses every credential that is not shaped like a
//! live core session and lets core re-verify it. Failing closed is the contract: an unreadable,
//! malformed, expired or wrong-algorithm token never reaches a privileged route.

#![forbid(unsafe_code)]

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{ApiError, EdgeResult};

const SESSION_TOKEN_TYPE: &str = "session";
const SESSION_TOKEN_ISSUER: &str = "payment-gateway-core";
const SESSION_TOKEN_AUDIENCE: &str = "payment-gateway-admin";
const SESSION_TOKEN_ALGORITHM: &str = "HS256";
const MAX_CLOCK_SKEW_SECONDS: u64 = 5;

/// Authorities that grant the same access as a confidential role.
///
/// Mirrors `roleHasConfidentialAccess` in `core-back/api/internal/admin.ts`.
const ROLE_AUTHORITY_ALIASES: &[(&str, &[&str])] = &[
    ("COMPLIANCE", &["aml:read", "aml:write"]),
    ("MLRO", &["aml:read", "aml:write"]),
];

/// Claims the edge reads. Never trusted beyond "core will re-verify the signature".
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AuthorityHints {
    pub roles: Vec<String>,
    pub authorities: Vec<String>,
}

#[cfg(test)]
#[must_use]
pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn decode_segment(segment: &str) -> Option<String> {
    let padded = match segment.len() % 4 {
        0 => segment.to_owned(),
        2 => format!("{segment}=="),
        3 => format!("{segment}="),
        _ => return None,
    };
    let bytes = base64::engine::general_purpose::URL_SAFE
        .decode(padded.as_bytes())
        .ok()?;
    String::from_utf8(bytes).ok()
}

fn bearer_token(authorization: &str) -> Option<&str> {
    let mut parts = authorization.split(' ');
    let scheme = parts.next()?;
    let token = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return None;
    }
    Some(token)
}

fn is_signature_shape(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Reads the authority hints carried by a core session token.
///
/// Returns `None` when the credential is not shaped like a live administrative session; the
/// caller must deny instead of assuming the authority is present.
#[must_use]
pub fn extract_authority_hints(authorization: Option<&str>, now_ms: u64) -> Option<AuthorityHints> {
    let token = bearer_token(authorization?)?;
    let segments: Vec<&str> = token.split('.').collect();
    if segments.len() != 3 {
        return None;
    }
    let header_raw = decode_segment(segments[0])?;
    let header: Value = serde_json::from_str(&header_raw).ok()?;
    if header.get("alg").and_then(Value::as_str) != Some(SESSION_TOKEN_ALGORITHM) {
        return None;
    }
    if !is_signature_shape(segments[2]) {
        return None;
    }
    let payload_raw = decode_segment(segments[1])?;
    let payload: Value = serde_json::from_str(&payload_raw).ok()?;
    let object = payload.as_object()?;
    if object.get("typ").and_then(Value::as_str) != Some(SESSION_TOKEN_TYPE) {
        return None;
    }
    if object.get("iss").and_then(Value::as_str) != Some(SESSION_TOKEN_ISSUER) {
        return None;
    }
    let audience_ok = match object.get("aud") {
        Some(Value::String(value)) => value == SESSION_TOKEN_AUDIENCE,
        Some(Value::Array(values)) => values
            .iter()
            .any(|value| value.as_str() == Some(SESSION_TOKEN_AUDIENCE)),
        _ => false,
    };
    if !audience_ok {
        return None;
    }
    let now = now_ms / 1000;
    let exp = object.get("exp").and_then(Value::as_f64)?;
    if !exp.is_finite() || (now as f64) >= exp {
        return None;
    }
    if let Some(nbf) = object.get("nbf") {
        let nbf = nbf.as_f64()?;
        if !nbf.is_finite() || nbf > (now + MAX_CLOCK_SKEW_SECONDS) as f64 {
            return None;
        }
    }

    let mut roles = Vec::new();
    if let Some(role) = object.get("role").and_then(Value::as_str) {
        let role = role.trim();
        if !role.is_empty() {
            roles.push(role.to_owned());
        }
    }
    if let Some(Value::Array(list)) = object.get("roles") {
        for role in list {
            if let Some(role) = role.as_str() {
                let role = role.trim();
                if !role.is_empty() {
                    roles.push(role.to_owned());
                }
            }
        }
    }

    let mut authorities = Vec::new();
    if let Some(Value::Array(list)) = object.get("authorities") {
        for authority in list {
            if let Some(authority) = authority.as_str() {
                let authority = authority.trim();
                if !authority.is_empty() {
                    authorities.push(authority.to_owned());
                }
            }
        }
    }
    if let Some(Value::Object(map)) = object.get("authorities_map") {
        for (key, value) in map {
            match value {
                Value::Bool(true) => authorities.push(key.clone()),
                Value::Array(list) => {
                    for entry in list {
                        if let Some(entry) = entry.as_str() {
                            authorities.push(entry.to_owned());
                        }
                    }
                }
                Value::String(entry) => authorities.push(entry.clone()),
                _ => {}
            }
        }
    }
    Some(AuthorityHints { roles, authorities })
}

/// `requireSession`: a bearer must be present and shaped like a live core session.
pub fn require_session(authorization: Option<&str>) -> EdgeResult<()> {
    let Some(authorization) = authorization else {
        return Err(ApiError::auth_required());
    };
    if extract_authority_hints(Some(authorization), now_millis()).is_none() {
        return Err(ApiError::auth_invalid());
    }
    Ok(())
}

/// `requireAuthorities`: any-of list, role aliases, wildcard, and the optional restriction list
/// (`ADMIN_AUTHORITY_HINTS`) that can only narrow a guard, never disable it.
pub fn require_authorities(
    required: &[&str],
    authorization: Option<&str>,
    configured: &[String],
) -> EdgeResult<()> {
    let Some(authorization) = authorization else {
        return Err(ApiError::auth_required());
    };
    if required.is_empty() {
        return Err(ApiError::authority_denied(required));
    }
    if !configured.is_empty()
        && !required
            .iter()
            .any(|authority| configured.iter().any(|entry| entry == authority))
    {
        return Err(ApiError::authority_denied(required));
    }
    let Some(hints) = extract_authority_hints(Some(authorization), now_millis()) else {
        return Err(ApiError::authority_denied(required));
    };
    let roles: Vec<String> = hints.roles.iter().map(|role| role.to_uppercase()).collect();
    let authorities: Vec<&str> = hints.authorities.iter().map(String::as_str).collect();
    let satisfied = authorities.contains(&"*")
        || required.iter().any(|authority| {
            if authorities.contains(authority) {
                return true;
            }
            let upper = authority.to_uppercase();
            if roles.contains(&upper) {
                return true;
            }
            ROLE_AUTHORITY_ALIASES
                .iter()
                .find(|(role, _)| *role == upper)
                .is_some_and(|(_, aliases)| aliases.iter().any(|alias| authorities.contains(alias)))
        });
    if satisfied {
        Ok(())
    } else {
        Err(ApiError::authority_denied(required))
    }
}

/// Whether a request is treated as a read by a method guard.
#[must_use]
pub fn is_read_method(method: &str, path: &str, read_paths: &[&str]) -> bool {
    matches!(method, "GET" | "HEAD" | "OPTIONS")
        || read_paths.iter().any(|pattern| path_matches(pattern, path))
}

fn path_matches(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim_end_matches('/');
    let path = path.trim_end_matches('/');
    let pattern_segments: Vec<&str> = pattern.trim_matches('/').split('/').collect();
    let path_segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    if pattern_segments.len() != path_segments.len() {
        return false;
    }
    pattern_segments
        .iter()
        .zip(path_segments.iter())
        .all(|(expected, actual)| expected.starts_with(':') || expected == actual)
}

/// The unverified `sub` claim, used only to bucket a limiter. Never used as authority.
#[must_use]
pub fn subject_of(authorization: Option<&str>) -> Option<String> {
    let token = bearer_token(authorization?)?;
    let payload = decode_segment(token.split('.').nth(1)?)?;
    let value: Value = serde_json::from_str(&payload).ok()?;
    value.as_object()?.get("sub")?.as_str().map(str::to_owned)
}

/// SHA-256 hex truncated to 32 characters, the TS `digestKeyPart`.
#[must_use]
pub fn digest_key_part(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(digest)[..32].to_owned()
}

/// Current wall clock in milliseconds.
#[must_use]
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Role names carried by a token (`role` plus the legacy `roles` array), upper-cased.
#[must_use]
pub fn roles_of(authorization: Option<&str>) -> Vec<String> {
    extract_authority_hints(authorization, now_millis())
        .map(|hints| {
            hints
                .roles
                .into_iter()
                .map(|role| role.to_uppercase())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn b64(value: &Value) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
    }

    fn token(payload: Value, header: Value, signature: &str) -> String {
        format!("{}.{}.{}", b64(&header), b64(&payload), signature)
    }

    fn live(authorities: &[&str]) -> String {
        token(
            json!({
                "typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin",
                "sub":"u-1","role":"OPERATOR","authorities":authorities,
                "exp": now_seconds() + 600,
            }),
            json!({"alg":"HS256","typ":"JWT"}),
            &"A".repeat(43),
        )
    }

    #[test]
    fn accepts_a_shaped_live_session() {
        let hints = extract_authority_hints(
            Some(&format!("Bearer {}", live(&["merchant:read"]))),
            now_millis(),
        )
        .expect("hints");
        assert_eq!(hints.authorities, vec!["merchant:read"]);
        assert_eq!(hints.roles, vec!["OPERATOR"]);
    }

    #[test]
    fn rejects_alg_none_expired_missing_exp_and_bad_signature_shapes() {
        let none = token(
            json!({"typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin",
                   "exp": now_seconds() + 600, "authorities":["security:write"]}),
            json!({"alg":"none","typ":"JWT"}),
            "",
        );
        assert!(extract_authority_hints(Some(&format!("Bearer {none}")), now_millis()).is_none());
        let expired = token(
            json!({"typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin",
                   "exp": 1, "authorities":["*"]}),
            json!({"alg":"HS256","typ":"JWT"}),
            &"A".repeat(43),
        );
        assert!(
            extract_authority_hints(Some(&format!("Bearer {expired}")), now_millis()).is_none()
        );
        let missing = token(
            json!({"typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin"}),
            json!({"alg":"HS256","typ":"JWT"}),
            &"A".repeat(43),
        );
        assert!(
            extract_authority_hints(Some(&format!("Bearer {missing}")), now_millis()).is_none()
        );
        let short = token(
            json!({"typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin","exp": now_seconds()+60}),
            json!({"alg":"HS256","typ":"JWT"}),
            "garbage",
        );
        assert!(extract_authority_hints(Some(&format!("Bearer {short}")), now_millis()).is_none());
    }

    #[test]
    fn rejects_not_before_and_foreign_audience() {
        let future = token(
            json!({"typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin",
                   "exp": now_seconds() + 600, "nbf": now_seconds() + 3600}),
            json!({"alg":"HS256","typ":"JWT"}),
            &"A".repeat(43),
        );
        assert!(extract_authority_hints(Some(&format!("Bearer {future}")), now_millis()).is_none());
        let merchant = token(
            json!({"typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-merchant",
                   "exp": now_seconds() + 600}),
            json!({"alg":"HS256","typ":"JWT"}),
            &"A".repeat(43),
        );
        assert!(
            extract_authority_hints(Some(&format!("Bearer {merchant}")), now_millis()).is_none()
        );
    }

    #[test]
    fn authority_guard_is_case_sensitive_and_honours_wildcard_and_aliases() {
        let scoped = live(&["SECURITY:WRITE"]);
        assert!(
            require_authorities(&["security:write"], Some(&format!("Bearer {scoped}")), &[])
                .is_err()
        );
        let wildcard = live(&["*"]);
        assert!(require_authorities(
            &["security:write"],
            Some(&format!("Bearer {wildcard}")),
            &[]
        )
        .is_ok());
        let aml = token(
            json!({"typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin",
                   "role":"COMPLIANCE","authorities":["aml:read"],"exp": now_seconds() + 600}),
            json!({"alg":"HS256","typ":"JWT"}),
            &"A".repeat(43),
        );
        assert!(require_authorities(&["COMPLIANCE"], Some(&format!("Bearer {aml}")), &[]).is_ok());
        let hinted = live(&["security:write"]);
        assert!(require_authorities(
            &["security:write"],
            Some(&format!("Bearer {hinted}")),
            &["something:else".to_owned()]
        )
        .is_err());
    }

    #[test]
    fn reads_the_legacy_authorities_map() {
        let legacy = token(
            json!({"typ":"session","iss":"payment-gateway-core","aud":"payment-gateway-admin",
                   "exp": now_seconds() + 600,
                   "authorities_map":{"security":["read","write"],"user":true}}),
            json!({"alg":"HS256","typ":"JWT"}),
            &"A".repeat(43),
        );
        let hints = extract_authority_hints(Some(&format!("Bearer {legacy}")), now_millis())
            .expect("hints");
        assert!(hints.authorities.contains(&"read".to_owned()));
        assert!(hints.authorities.contains(&"user".to_owned()));
    }

    #[test]
    fn read_paths_count_as_reads() {
        assert!(is_read_method(
            "POST",
            "/catalog/x/execute",
            &["/catalog/x/execute"]
        ));
        assert!(!is_read_method("POST", "/catalog/x/execute", &[]));
        assert!(is_read_method("GET", "/anything", &[]));
    }
}
