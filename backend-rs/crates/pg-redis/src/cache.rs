//! Cache lifetimes.
//!
//! Port of `core-back/lib/storageEngine/redisCacheAndVelocityAdapter.ts` (`pgcache:` JSON values
//! with a 30 s L1 copy) and the 5 s local caches of `engine/routeHealth/policy.ts`,
//! `engine/reportStudio/merchantReportEngine.ts` and `lib/communication/settings.ts`.
//!
//! The 5 s settings caches are deliberately node-local in the TypeScript code: a settings write
//! invalidates only the writing node today (E-F01 fixes that later). The Rust value is therefore a
//! TTL constant, not a pub/sub key.

#![forbid(unsafe_code)]

use std::time::Duration;

/// L1 (in-process) lifetime of a cache value read from Redis.
pub const CACHE_L1_TTL_SECONDS: u64 = 30;

/// Local TTL shared by the route-health, merchant-report and communication settings caches.
pub const SETTINGS_CACHE_TTL_MS: u64 = 5_000;

/// [`SETTINGS_CACHE_TTL_MS`] as a `Duration`.
pub const SETTINGS_CACHE_TTL: Duration = Duration::from_millis(SETTINGS_CACHE_TTL_MS);

/// `Math.max(1, ttlSec)`: Redis refuses a zero expiry and TS never sends one.
#[must_use]
pub fn normalize_ttl_seconds(ttl_sec: u64) -> u64 {
    ttl_sec.max(1)
}

/// The L1 expiry in milliseconds for a cache write (TS stores `ttlSec * 1_000`).
#[must_use]
pub fn l1_ttl_ms(ttl_sec: u64) -> u64 {
    normalize_ttl_seconds(ttl_sec).saturating_mul(1_000)
}

/// `expiresAtMs > Date.now()`: an entry expiring exactly now is stale.
#[must_use]
pub fn is_fresh(expires_at_ms: i64, now_ms: i64) -> bool {
    expires_at_ms > now_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ttl_is_clamped_to_one_second() {
        assert_eq!(normalize_ttl_seconds(0), 1);
        assert_eq!(normalize_ttl_seconds(1), 1);
        assert_eq!(normalize_ttl_seconds(90), 90);
        assert_eq!(l1_ttl_ms(0), 1_000);
        assert_eq!(l1_ttl_ms(30), 30_000);
    }

    #[test]
    fn settings_and_l1_ttls_match_the_typescript_constants() {
        assert_eq!(CACHE_L1_TTL_SECONDS, 30);
        assert_eq!(SETTINGS_CACHE_TTL_MS, 5_000);
        assert_eq!(SETTINGS_CACHE_TTL, Duration::from_secs(5));
    }

    #[test]
    fn freshness_is_strict() {
        assert!(is_fresh(1_001, 1_000));
        assert!(!is_fresh(1_000, 1_000));
        assert!(!is_fresh(999, 1_000));
    }
}
