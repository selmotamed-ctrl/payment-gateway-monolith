//! Login and MFA failure throttles.
//!
//! Port of `core-back/lib/auth/throttle.ts` and the key prefix of
//! `core-back/lib/auth/sharedState.ts:120-124`.
//!
//! The counters live in the shared auth state store (Redis when `REDIS_URL` is set, per-process
//! memory otherwise). This module owns the **keys**, the **policies** and the **decision**; the
//! store itself is a port (`incr_window`, `set_flag`, `flag_remaining_ms`, `del`) implemented by
//! `pg-redis`.
//!
//! Keys are hashed so an identifier (phone or e-mail) is never kept in clear. The TS store adds the
//! `pgauth:` prefix to whatever key it is given; the effective Redis key is therefore
//! `pgauth:<scope>:<sha256hex(lower(value))>:count|:lock`, which is what [`ThrottleKey`] builds
//! directly (chapter 2 §5).
//!
//! GAP-053 semantics: the tight login lock is keyed on the identifier **and** the client address, so
//! five wrong passwords from one address lock that identifier for that address only; a much higher
//! identifier-only ceiling still stops guessing spread over many addresses.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use crate::error::AuthError;

/// The store prefix every auth key carries.
pub const KEY_PREFIX: &str = "pgauth:";

/// The 15-minute window shared by every policy.
pub const THROTTLE_WINDOW_MS: i64 = 15 * 60_000;

/// One throttle policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThrottlePolicy {
    pub max_failures: u32,
    pub window_ms: i64,
    pub lock_ms: i64,
}

impl ThrottlePolicy {
    const fn new(max_failures: u32) -> Self {
        Self {
            max_failures,
            window_ms: THROTTLE_WINDOW_MS,
            lock_ms: THROTTLE_WINDOW_MS,
        }
    }
}

/// `LOGIN_PAIR_POLICY`: identifier + address, 5 failures.
pub const LOGIN_PAIR_POLICY: ThrottlePolicy = ThrottlePolicy::new(5);
/// `LOGIN_IDENTIFIER_POLICY`: identifier only, 50 failures.
pub const LOGIN_IDENTIFIER_POLICY: ThrottlePolicy = ThrottlePolicy::new(50);
/// `LOGIN_IP_POLICY`: address only, 30 failures.
pub const LOGIN_IP_POLICY: ThrottlePolicy = ThrottlePolicy::new(30);
/// `MFA_IP_POLICY`: address only, 20 failures.
pub const MFA_IP_POLICY: ThrottlePolicy = ThrottlePolicy::new(20);

/// The four throttle scopes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ThrottleScope {
    /// `login-id`: the identifier-only ceiling.
    LoginId,
    /// `login-pair`: identifier + address (the tight lock).
    LoginPair,
    /// `login-ip`: the address.
    LoginIp,
    /// `mfa-ip`: the address for MFA codes.
    MfaIp,
}

impl ThrottleScope {
    /// The scope segment of the key.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LoginId => "login-id",
            Self::LoginPair => "login-pair",
            Self::LoginIp => "login-ip",
            Self::MfaIp => "mfa-ip",
        }
    }

    /// The policy applied by `recordFailure`.
    #[must_use]
    pub fn policy(self) -> ThrottlePolicy {
        match self {
            Self::LoginId => LOGIN_IDENTIFIER_POLICY,
            Self::LoginPair => LOGIN_PAIR_POLICY,
            Self::LoginIp => LOGIN_IP_POLICY,
            Self::MfaIp => MFA_IP_POLICY,
        }
    }
}

/// A fully built throttle key: the hashed scope value, plus the `:count`/`:lock` suffixes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThrottleKey {
    scope: ThrottleScope,
    /// `sha256hex(lower(value))`.
    digest: String,
}

impl ThrottleKey {
    /// Build a key from a raw value. The value is lower-cased before hashing, exactly like
    /// `keyOf(scope, value)`: `sha256(lower(value))`.
    #[must_use]
    pub fn new(scope: ThrottleScope, value: &str) -> Self {
        Self {
            scope,
            digest: pg_crypto::sha256_hex(value.to_lowercase().as_bytes()),
        }
    }

    /// The identifier + address key (`pairValue`): `lower(identifier)|ip-or-unknown`, hashed.
    ///
    /// An unresolvable address shares one bucket (`unknown`) instead of bypassing the lock.
    #[must_use]
    pub fn pair(identifier: &str, ip: Option<&str>) -> Self {
        let value = format!("{}|{}", identifier.to_lowercase(), ip.unwrap_or("unknown"));
        Self::new(ThrottleScope::LoginPair, &value)
    }

    /// The scope this key belongs to.
    #[must_use]
    pub fn scope(&self) -> ThrottleScope {
        self.scope
    }

    /// The hashed value segment.
    #[must_use]
    pub fn digest(&self) -> &str {
        &self.digest
    }

    /// `pgauth:<scope>:<digest>:count`.
    #[must_use]
    pub fn count_key(&self) -> String {
        format!("{KEY_PREFIX}{}:{}:count", self.scope.as_str(), self.digest)
    }

    /// `pgauth:<scope>:<digest>:lock`.
    #[must_use]
    pub fn lock_key(&self) -> String {
        format!("{KEY_PREFIX}{}:{}:lock", self.scope.as_str(), self.digest)
    }

    /// Both keys (for `del` on a successful login).
    #[must_use]
    pub fn keys(&self) -> [String; 2] {
        [self.count_key(), self.lock_key()]
    }
}

/// The outcome of recording a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThrottleDecision {
    /// Failures counted in the active window after this one.
    pub failures: u32,
    /// The policy limit.
    pub limit: u32,
    /// True when the lock must be set (`failures >= limit`).
    pub lock: bool,
    /// Failures left before the lock.
    pub remaining: u32,
}

/// `recordFailure`'s decision: lock when `count >= limit`.
#[must_use]
pub fn decision(count: u32, limit: u32) -> ThrottleDecision {
    ThrottleDecision {
        failures: count,
        limit,
        lock: count >= limit,
        remaining: limit.saturating_sub(count),
    }
}

/// `Math.ceil(remaining / 1000)` for `details.retryAfterSeconds`.
///
/// Signed `div_ceil` is still unstable on the pinned toolchain, so the ceiling is written out.
#[must_use]
pub fn retry_after_seconds(remaining_ms: i64) -> i64 {
    if remaining_ms <= 0 {
        0
    } else {
        remaining_ms.saturating_add(999) / 1000
    }
}

/// `assertNotThrottled`: `429 AUTH_THROTTLED` while the lock flag is still alive.
pub fn assert_not_throttled(lock_remaining_ms: i64) -> Result<(), AuthError> {
    if lock_remaining_ms > 0 {
        Err(AuthError::throttled(lock_remaining_ms))
    } else {
        Ok(())
    }
}

/// The keys `assertLoginAllowed` checks before the password, in TS order: identifier ceiling,
/// identifier + address lock, address throttle.
#[must_use]
pub fn login_check_keys(identifier: &str, ip: Option<&str>) -> Vec<ThrottleKey> {
    let mut keys = vec![
        ThrottleKey::new(ThrottleScope::LoginId, identifier),
        ThrottleKey::pair(identifier, ip),
    ];
    if let Some(ip) = ip {
        keys.push(ThrottleKey::new(ThrottleScope::LoginIp, ip));
    }
    keys
}

/// The counters `recordLoginFailure` increments (same set as [`login_check_keys`], and the same
/// policy is available from each key's scope).
#[must_use]
pub fn login_failure_keys(identifier: &str, ip: Option<&str>) -> Vec<ThrottleKey> {
    login_check_keys(identifier, ip)
}

/// The keys `recordLoginSuccess` clears: the identifier ceiling and the identifier + address pair
/// (the address counter is deliberately left alone, it protects the address, not the account).
#[must_use]
pub fn login_success_keys(identifier: &str, ip: Option<&str>) -> Vec<ThrottleKey> {
    vec![
        ThrottleKey::new(ThrottleScope::LoginId, identifier),
        ThrottleKey::pair(identifier, ip),
    ]
}

/// `assertMfaAllowed` / `recordMfaFailure`: no address means no key and no check.
#[must_use]
pub fn mfa_key(ip: Option<&str>) -> Option<ThrottleKey> {
    ip.map(|ip| ThrottleKey::new(ThrottleScope::MfaIp, ip))
}

/// The union of every count/lock key a login success clears, de-duplicated.
#[must_use]
pub fn distinct_keys(keys: &[ThrottleKey]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for key in keys {
        for candidate in key.keys() {
            if seen.insert(candidate.clone()) {
                out.push(candidate);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policies_match_the_ts_limits_and_window() {
        assert_eq!(LOGIN_PAIR_POLICY.max_failures, 5);
        assert_eq!(LOGIN_IDENTIFIER_POLICY.max_failures, 50);
        assert_eq!(LOGIN_IP_POLICY.max_failures, 30);
        assert_eq!(MFA_IP_POLICY.max_failures, 20);
        for policy in [
            LOGIN_PAIR_POLICY,
            LOGIN_IDENTIFIER_POLICY,
            LOGIN_IP_POLICY,
            MFA_IP_POLICY,
        ] {
            assert_eq!(policy.window_ms, 900_000);
            assert_eq!(policy.lock_ms, 900_000);
        }
        assert_eq!(ThrottleScope::LoginPair.policy(), LOGIN_PAIR_POLICY);
        assert_eq!(ThrottleScope::MfaIp.policy(), MFA_IP_POLICY);
    }

    #[test]
    fn key_format_is_prefix_scope_hash_suffix() {
        // sha256("user@example.com") from an independent implementation.
        let key = ThrottleKey::new(ThrottleScope::LoginId, "User@Example.com");
        assert_eq!(
            key.digest(),
            "b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514"
        );
        assert_eq!(
            key.count_key(),
            "pgauth:login-id:b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514:count"
        );
        assert_eq!(
            key.lock_key(),
            "pgauth:login-id:b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514:lock"
        );
        // Case-insensitive: the value is lower-cased before hashing.
        assert_eq!(
            key,
            ThrottleKey::new(ThrottleScope::LoginId, "USER@EXAMPLE.COM")
        );
        assert_ne!(
            key,
            ThrottleKey::new(ThrottleScope::LoginIp, "user@example.com")
        );
    }

    #[test]
    fn pair_key_uses_pipe_and_unknown_address_bucket() {
        // sha256("user@example.com|203.0.113.9") from an independent implementation.
        let key = ThrottleKey::pair("User@Example.com", Some("203.0.113.9"));
        assert_eq!(key.scope(), ThrottleScope::LoginPair);
        assert_eq!(
            key.digest(),
            "3819e6a221dd5e313997ab36a4f815499c30638a21f9ef844887dceb9893066c"
        );
        let unknown = ThrottleKey::pair("user@example.com", None);
        assert_eq!(
            unknown.digest(),
            pg_crypto::sha256_hex(b"user@example.com|unknown")
        );
        assert_ne!(unknown, key);
    }

    #[test]
    fn decision_locks_at_the_limit() {
        let first = decision(1, 5);
        assert!(!first.lock);
        assert_eq!(first.remaining, 4);
        assert!(!decision(4, 5).lock);
        let fifth = decision(5, 5);
        assert!(fifth.lock);
        assert_eq!(fifth.remaining, 0);
        // Above the limit stays locked and never underflows.
        let sixth = decision(6, 5);
        assert!(sixth.lock);
        assert_eq!(sixth.remaining, 0);
    }

    #[test]
    fn retry_after_rounds_up_to_whole_seconds() {
        assert_eq!(retry_after_seconds(0), 0);
        assert_eq!(retry_after_seconds(-5), 0);
        assert_eq!(retry_after_seconds(1), 1);
        assert_eq!(retry_after_seconds(1_000), 1);
        assert_eq!(retry_after_seconds(1_001), 2);
        assert_eq!(retry_after_seconds(899_999), 900);
    }

    #[test]
    fn throttled_error_carries_the_retry_after_detail() {
        assert!(assert_not_throttled(0).is_ok());
        let error = assert_not_throttled(2_500).expect_err("locked");
        assert_eq!(error.status, 429);
        assert_eq!(error.code, "AUTH_THROTTLED");
        assert_eq!(error.details.unwrap_or_default()["retryAfterSeconds"], 3);
    }

    #[test]
    fn login_checks_the_three_keys_in_order() {
        let keys = login_check_keys("user@example.com", Some("203.0.113.9"));
        assert_eq!(keys.len(), 3);
        assert_eq!(keys[0].scope(), ThrottleScope::LoginId);
        assert_eq!(keys[1].scope(), ThrottleScope::LoginPair);
        assert_eq!(keys[2].scope(), ThrottleScope::LoginIp);
        // Without an address only the identifier keys are checked.
        let keys = login_check_keys("user@example.com", None);
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().all(|key| key.scope() != ThrottleScope::LoginIp));
    }

    #[test]
    fn login_success_clears_the_identifier_and_pair_only() {
        let keys = login_success_keys("user@example.com", Some("203.0.113.9"));
        assert_eq!(keys.len(), 2);
        let cleared = distinct_keys(&keys);
        // Two scopes × count/lock, de-duplicated.
        assert_eq!(cleared.len(), 4);
        assert!(cleared.iter().all(|key| !key.contains("login-ip")));
        assert_eq!(
            cleared
                .iter()
                .filter(|key| key.contains("login-pair"))
                .count(),
            2
        );
        assert_eq!(
            cleared.iter().filter(|key| key.ends_with(":lock")).count(),
            2
        );
        assert!(cleared.iter().all(|key| !key.contains("203.0.113.9")));
    }

    #[test]
    fn mfa_keys_need_an_address() {
        assert!(mfa_key(None).is_none());
        let key = mfa_key(Some("203.0.113.9")).expect("key");
        assert_eq!(key.scope(), ThrottleScope::MfaIp);
        assert!(key.count_key().starts_with("pgauth:mfa-ip:"));
        assert_eq!(key, ThrottleKey::new(ThrottleScope::MfaIp, "203.0.113.9"));
    }
}
