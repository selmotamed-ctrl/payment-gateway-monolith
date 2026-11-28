//! Redis key and channel names.
//!
//! Port of `core-back/lib/storageEngine/redisCacheAndVelocityAdapter.ts` (`pgcache:` cache and
//! velocity keys), `core-back/lib/auth/sharedState.ts` (`pgauth:` counters/flags),
//! `core-back/lib/auth/revocation.ts` (`revoked:<jti>` under the same prefix) and
//! `core-back/lib/invalidationBus/index.ts` (`payment-gateway:invalidation:<topic>`).

#![forbid(unsafe_code)]

use thiserror::Error;

use crate::sha256::sha256_hex;

/// Channel namespace of every invalidation message.
pub const INVALIDATION_CHANNEL_PREFIX: &str = "payment-gateway:invalidation:";

/// Cache namespace (`pgcache:<key>`).
pub const CACHE_PREFIX: &str = "pgcache:";

/// Velocity sorted-set namespace (`pgcache:vel:<ruleId>:<scopeKey>:<windowSeconds>`).
pub const VELOCITY_PREFIX: &str = "pgcache:vel:";

/// Shared auth state namespace (`pgauth:`).
pub const AUTH_PREFIX: &str = "pgauth:";

/// Session revoke flag namespace (`pgauth:revoked:<jti>`).
pub const REVOCATION_PREFIX: &str = "pgauth:revoked:";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum KeyError {
    /// The TS `InvalidationBus.channel` rejects an empty topic or one containing a newline.
    #[error("Invalid invalidation topic")]
    InvalidTopic,
}

/// The pub/sub channel of a topic.
///
/// Port of `InvalidationBus.channel(topic)`; newline injection is refused for the same reason
/// (a multi-line channel name is never a valid Redis channel).
pub fn invalidation_channel(topic: &str) -> Result<String, KeyError> {
    if topic.is_empty() || topic.contains('\r') || topic.contains('\n') {
        return Err(KeyError::InvalidTopic);
    }
    Ok(format!("{INVALIDATION_CHANNEL_PREFIX}{topic}"))
}

/// `pgcache:<key>`.
#[must_use]
pub fn cache_key(key: &str) -> String {
    format!("{CACHE_PREFIX}{key}")
}

/// `pgcache:vel:<ruleId>:<scopeKey>:<windowSeconds>`.
#[must_use]
pub fn velocity_key(rule_id: &str, scope_key: &str, window_seconds: u64) -> String {
    format!("{VELOCITY_PREFIX}{rule_id}:{scope_key}:{window_seconds}")
}

/// `sha256hex(lower(value))`: callers never store a clear identifier.
///
/// Port of `createHash("sha256").update(value.toLowerCase(), "utf8").digest("hex")`.
/// JS `toLowerCase()` and Rust `to_lowercase()` are both Unicode default case mapping (the final
/// sigma exception is shared by both runtimes).
#[must_use]
pub fn auth_digest(value: &str) -> String {
    sha256_hex(value.to_lowercase().as_bytes())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthKeySuffix {
    Count,
    Lock,
}

impl AuthKeySuffix {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Count => "count",
            Self::Lock => "lock",
        }
    }
}

/// `pgauth:<scope>:<sha256(lower(value))>:(count|lock)`.
#[must_use]
pub fn auth_key(scope: &str, value: &str, suffix: AuthKeySuffix) -> String {
    format!(
        "{AUTH_PREFIX}{scope}:{}:{}",
        auth_digest(value),
        suffix.as_str()
    )
}

/// The failure counter of a throttle bucket.
#[must_use]
pub fn auth_count_key(scope: &str, value: &str) -> String {
    auth_key(scope, value, AuthKeySuffix::Count)
}

/// The lock flag of a throttle bucket.
#[must_use]
pub fn auth_lock_key(scope: &str, value: &str) -> String {
    auth_key(scope, value, AuthKeySuffix::Lock)
}

/// `pgauth:revoked:<jti>` (the durable `session_revocations` row is the fallback copy).
#[must_use]
pub fn revocation_key(jti: &str) -> String {
    format!("{REVOCATION_PREFIX}{jti}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_and_keys_match_the_typescript_strings() {
        assert_eq!(
            invalidation_channel("credential:abc"),
            Ok("payment-gateway:invalidation:credential:abc".to_owned())
        );
        assert_eq!(cache_key("route-health"), "pgcache:route-health");
        assert_eq!(
            velocity_key("rule-1", "merchant-7", 3600),
            "pgcache:vel:rule-1:merchant-7:3600"
        );
        assert_eq!(revocation_key("jti-1"), "pgauth:revoked:jti-1");
    }

    #[test]
    fn invalid_topics_are_rejected() {
        assert_eq!(invalidation_channel(""), Err(KeyError::InvalidTopic));
        assert_eq!(invalidation_channel("a\nb"), Err(KeyError::InvalidTopic));
        assert_eq!(invalidation_channel("a\rb"), Err(KeyError::InvalidTopic));
    }

    #[test]
    fn auth_keys_hash_the_lowercased_value() {
        // sha256("alice@example.com") and sha256("ALICE@EXAMPLE.COM") are the same digest.
        assert_eq!(
            auth_digest("Alice@Example.com"),
            auth_digest("alice@example.com")
        );
        let key = auth_count_key("login-id", "Alice@Example.com");
        assert_eq!(
            key,
            format!("pgauth:login-id:{}:count", auth_digest("alice@example.com"))
        );
        assert!(auth_lock_key("login-pair", "a|127.0.0.1").ends_with(":lock"));
    }

    #[test]
    fn known_digest_vector() {
        assert_eq!(
            auth_digest("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
