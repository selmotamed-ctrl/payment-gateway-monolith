//! Server-side session revoke list.
//!
//! Port of `core-back/lib/auth/revocation.ts` (GAP-019).
//!
//! A revoked `jti` is kept until the token would have expired anyway, so the list is bounded by
//! the 12 h session lifetime. Redis is the fast path; the `session_revocations` row is the durable
//! copy. On a Redis miss the row decides (and the flag is re-warmed); when the row cannot be read
//! the Redis answer stands (fail-open for availability). Roughly one revocation in 50 also prunes
//! rows whose tokens expired.

#![forbid(unsafe_code)]

use crate::keys::revocation_key;

/// One revocation in this many triggers the expired-row prune.
pub const PRUNE_ONE_IN: u32 = 50;

/// `ttlMs = Math.max(1000, expiresAtSeconds * 1000 - nowMs)`.
pub const MIN_REVOCATION_TTL_MS: u64 = 1_000;

/// A `session_revocations` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevocationEntry {
    pub jti: String,
    pub expires_at_ms: i64,
}

impl RevocationEntry {
    /// Build from the token's `exp` (seconds) with the TS TTL floor.
    #[must_use]
    pub fn from_expiry_seconds(
        jti: impl Into<String>,
        expires_at_seconds: i64,
        now_ms: i64,
    ) -> Self {
        let ttl_ms = ttl_ms_for(expires_at_seconds, now_ms);
        Self {
            jti: jti.into(),
            expires_at_ms: now_ms.saturating_add(i64::try_from(ttl_ms).unwrap_or(i64::MAX)),
        }
    }

    #[must_use]
    pub fn key(&self) -> String {
        revocation_key(&self.jti)
    }

    #[must_use]
    pub fn remaining_ms(&self, now_ms: i64) -> u64 {
        if self.expires_at_ms <= now_ms {
            return 0;
        }
        u64::try_from(self.expires_at_ms - now_ms).unwrap_or(0)
    }

    #[must_use]
    pub fn is_expired(&self, now_ms: i64) -> bool {
        self.expires_at_ms <= now_ms
    }
}

/// The Redis flag TTL for a token expiring at `expires_at_seconds`.
#[must_use]
pub fn ttl_ms_for(expires_at_seconds: i64, now_ms: i64) -> u64 {
    let raw = expires_at_seconds
        .saturating_mul(1_000)
        .saturating_sub(now_ms);
    if raw <= i64::try_from(MIN_REVOCATION_TTL_MS).unwrap_or(i64::MAX) {
        return MIN_REVOCATION_TTL_MS;
    }
    u64::try_from(raw).unwrap_or(MIN_REVOCATION_TTL_MS)
}

/// The outcome of `isSessionRevoked`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevocationDecision {
    pub revoked: bool,
    /// Set when the flag must be written back (`store.setFlag`) for the rest of the token's life.
    pub warm_ttl_ms: Option<u64>,
}

impl RevocationDecision {
    #[must_use]
    pub fn revoked() -> Self {
        Self {
            revoked: true,
            warm_ttl_ms: None,
        }
    }

    #[must_use]
    pub fn not_revoked() -> Self {
        Self {
            revoked: false,
            warm_ttl_ms: None,
        }
    }
}

/// Decide from the Redis fast path and, when it misses, the durable row.
///
/// Port of `isSessionRevoked`:
/// 1. `flagRemainingMs(key) > 0` → revoked.
/// 2. no row, or the row is expired → not revoked.
/// 3. row still valid → revoked and re-warm for `max(1000, row.expiresAt - now)`.
///
/// A row that cannot be read is represented by `None` here; the caller keeps the Redis answer,
/// which is "not revoked" after a miss (the TS `catch { return false }`).
#[must_use]
pub fn decide(
    redis_remaining_ms: u64,
    table_entry: Option<&RevocationEntry>,
    now_ms: i64,
) -> RevocationDecision {
    if redis_remaining_ms > 0 {
        return RevocationDecision::revoked();
    }
    let Some(entry) = table_entry else {
        return RevocationDecision::not_revoked();
    };
    if entry.is_expired(now_ms) {
        return RevocationDecision::not_revoked();
    }
    RevocationDecision {
        revoked: true,
        warm_ttl_ms: Some(entry.remaining_ms(now_ms).max(MIN_REVOCATION_TTL_MS)),
    }
}

/// Port of `Math.floor(Math.random() * PRUNE_ONE_IN) === 0`.
///
/// The caller draws `sample` uniformly from `0..PRUNE_ONE_IN`; only `0` prunes. The modulo form
/// keeps the helper total for values outside that range.
#[must_use]
pub fn should_prune(sample: u32) -> bool {
    sample.is_multiple_of(PRUNE_ONE_IN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ttl_is_floored_and_uses_the_token_expiry() {
        assert_eq!(ttl_ms_for(1_700, 1_000_000), 700_000);
        // Already expired (or exp in the past) still gets the 1 s floor.
        assert_eq!(ttl_ms_for(900, 1_000_000), 1_000);
        assert_eq!(ttl_ms_for(1_000, 1_000_000), 1_000);
    }

    #[test]
    fn entry_keeps_the_typescript_keys() {
        let entry = RevocationEntry::from_expiry_seconds("jti-1", 1_700, 1_000_000);
        assert_eq!(entry.key(), "pgauth:revoked:jti-1");
        assert_eq!(entry.expires_at_ms, 1_700_000);
        assert_eq!(entry.remaining_ms(1_000_000), 700_000);
        assert!(!entry.is_expired(1_000_000));
        assert!(entry.is_expired(1_700_000));
    }

    #[test]
    fn redis_hit_wins() {
        let table = RevocationEntry::from_expiry_seconds("jti-1", 1_700, 1_000_000);
        let decision = decide(5_000, Some(&table), 1_000_000);
        assert_eq!(decision, RevocationDecision::revoked());
        assert_eq!(decision.warm_ttl_ms, None);
    }

    #[test]
    fn table_fallback_revokes_and_rewarms() {
        let table = RevocationEntry::from_expiry_seconds("jti-1", 1_700, 1_000_000);
        let decision = decide(0, Some(&table), 1_000_000);
        assert!(decision.revoked);
        assert_eq!(decision.warm_ttl_ms, Some(700_000));
    }

    #[test]
    fn missing_or_expired_row_is_not_revoked() {
        assert_eq!(
            decide(0, None, 1_000_000),
            RevocationDecision::not_revoked()
        );
        let expired = RevocationEntry {
            jti: "jti-1".to_owned(),
            expires_at_ms: 999_999,
        };
        assert_eq!(
            decide(0, Some(&expired), 1_000_000),
            RevocationDecision::not_revoked()
        );
    }

    #[test]
    fn re_warm_never_goes_below_one_second() {
        let almost_expired = RevocationEntry {
            jti: "jti-1".to_owned(),
            expires_at_ms: 1_000_001,
        };
        let decision = decide(0, Some(&almost_expired), 1_000_000);
        assert_eq!(decision.warm_ttl_ms, Some(1_000));
    }

    #[test]
    fn prune_decision_is_one_in_fifty() {
        assert_eq!(PRUNE_ONE_IN, 50);
        assert!(should_prune(0));
        assert!(should_prune(50));
        assert!(!should_prune(1));
        assert!(!should_prune(49));
    }
}
