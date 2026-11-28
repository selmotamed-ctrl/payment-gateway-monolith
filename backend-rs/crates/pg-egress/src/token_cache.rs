//! Bounded, synchronous token cache with a refresh margin and deterministic jitter.
//!
//! Port of the token caching in `core-back/engine/apiConsumer/ApiConsumer.ts:729-921`
//! (`ConsumerAuthState`, `performRefresh`, `scheduleRefresh`) and chapter 2 §28.
//!
//! TS keeps one token per `ApiConsumer` instance and arms a refresh timer at
//! `expires_in * 1000 - 30_000` with ±10% jitter (`:877`, `:902`). The Rust cache is a pure struct
//! so a worker can share it across credential sets and test it with a fixed clock:
//!
//! * a token is only `get`-able strictly before `expires_at - margin - jitter`;
//! * the default margin is 60 s (the task instruction); [`TokenCache::TS_MARGIN_MS`] reproduces the
//!   30 s the TS API consumer uses;
//! * jitter is deterministic (FNV-1a over the token) instead of `Math.random`, so a restart does
//!   not move a refresh point and tests are stable;
//! * capacity is bounded and the entry closest to expiry is evicted first.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::fmt;

use parking_lot::Mutex;

/// The cache key: one token per gateway, credential set and environment.
///
/// Port of the `gatewayId` + `credentialSetId` + `env` identity passed to
/// `rotatingRefreshTokenPersistence` (`ApiConsumer.ts:59-65`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TokenKey {
    pub gateway_id: String,
    pub credential_set_id: String,
    pub environment: String,
}

impl TokenKey {
    #[must_use]
    pub fn new(
        gateway_id: impl Into<String>,
        credential_set_id: impl Into<String>,
        environment: impl Into<String>,
    ) -> Self {
        Self {
            gateway_id: gateway_id.into(),
            credential_set_id: credential_set_id.into(),
            environment: environment.into(),
        }
    }
}

/// One cached token.
///
/// The `Debug` implementation redacts both tokens: a token is a credential and must never appear
/// in a log line, a panic message or an error chain.
#[derive(Clone, PartialEq, Eq)]
pub struct TokenValue {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Absolute expiry in Unix milliseconds (`expires_in` seconds after the answer).
    pub expires_at_ms: Option<u64>,
    /// A refresh cadence declared by the credential set (`refresh_period_ms`), independent of the
    /// token's own expiry. TS arms the timer at this value ±10% (`ApiConsumer.ts:876-877`).
    pub refresh_period_ms: Option<u64>,
    pub scope: Option<String>,
}

impl TokenValue {
    #[must_use]
    pub fn new(access_token: impl Into<String>) -> Self {
        Self {
            access_token: access_token.into(),
            refresh_token: None,
            expires_at_ms: None,
            refresh_period_ms: None,
            scope: None,
        }
    }

    #[must_use]
    pub fn with_refresh_token(mut self, refresh_token: impl Into<String>) -> Self {
        self.refresh_token = Some(refresh_token.into());
        self
    }

    #[must_use]
    pub fn with_expires_at(mut self, expires_at_ms: u64) -> Self {
        self.expires_at_ms = Some(expires_at_ms);
        self
    }

    #[must_use]
    pub fn with_refresh_period(mut self, refresh_period_ms: u64) -> Self {
        self.refresh_period_ms = Some(refresh_period_ms);
        self
    }

    #[must_use]
    pub fn with_scope(mut self, scope: impl Into<String>) -> Self {
        self.scope = Some(scope.into());
        self
    }
}

impl fmt::Debug for TokenValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TokenValue")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at_ms", &self.expires_at_ms)
            .field("refresh_period_ms", &self.refresh_period_ms)
            .field("scope", &self.scope)
            .finish()
    }
}

#[derive(Debug, Clone)]
struct CacheEntry {
    value: TokenValue,
    refresh_at_ms: Option<u64>,
    inserted_ms: u64,
}

impl CacheEntry {
    fn is_stale(&self, now_ms: u64) -> bool {
        self.refresh_at_ms.is_some_and(|at| now_ms >= at)
    }
}

#[derive(Debug, Default)]
struct CacheInner {
    entries: HashMap<TokenKey, CacheEntry>,
}

impl CacheInner {
    fn eviction_candidate(&self) -> Option<TokenKey> {
        self.entries
            .iter()
            .min_by(|left, right| eviction_key(left.1).cmp(&eviction_key(right.1)))
            .map(|(key, _)| key.clone())
    }
}

fn eviction_key(entry: &CacheEntry) -> (u8, u64, u64) {
    match entry.refresh_at_ms {
        Some(at) => (0, at, entry.inserted_ms),
        None => (1, u64::MAX, entry.inserted_ms),
    }
}

/// A bounded token cache. All methods take `&self`; the lock is only held for the map operation.
pub struct TokenCache {
    inner: Mutex<CacheInner>,
    capacity: usize,
    margin_ms: u64,
    jitter_percent: u8,
}

impl TokenCache {
    pub const DEFAULT_CAPACITY: usize = 256;
    /// The task instruction's refresh margin.
    pub const DEFAULT_MARGIN_MS: u64 = 60_000;
    /// The TS API consumer's margin (`expires_in * 1000 - 30_000`).
    pub const TS_MARGIN_MS: u64 = 30_000;
    /// `±10%` around the refresh point (`ApiConsumer.ts:902`).
    pub const DEFAULT_JITTER_PERCENT: u8 = 10;

    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self::with_margin(capacity, Self::DEFAULT_MARGIN_MS)
    }

    #[must_use]
    pub fn with_margin(capacity: usize, margin_ms: u64) -> Self {
        Self {
            inner: Mutex::new(CacheInner::default()),
            capacity: capacity.max(1),
            margin_ms,
            jitter_percent: Self::DEFAULT_JITTER_PERCENT,
        }
    }

    /// Override the jitter percentage (0 disables it, values above 100 are clamped).
    #[must_use]
    pub fn with_jitter(mut self, jitter_percent: u8) -> Self {
        self.jitter_percent = jitter_percent.min(100);
        self
    }

    #[must_use]
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    #[must_use]
    pub fn margin_ms(&self) -> u64 {
        self.margin_ms
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.inner.lock().entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Return a fresh token. A stale entry is removed on access.
    #[must_use]
    pub fn get(&self, key: &TokenKey, now_ms: u64) -> Option<TokenValue> {
        let mut inner = self.inner.lock();
        let stale = inner.entries.get(key).map(|entry| entry.is_stale(now_ms));
        match stale {
            Some(true) => {
                inner.entries.remove(key);
                None
            }
            Some(false) => inner.entries.get(key).map(|entry| entry.value.clone()),
            None => None,
        }
    }

    /// Return the stored entry regardless of its freshness, without removing it.
    ///
    /// Used to keep a rotated refresh token across an expired access token: the provider issues a
    /// refresh token once, so it must not be discarded with the access token it accompanied.
    #[must_use]
    pub fn peek(&self, key: &TokenKey) -> Option<TokenValue> {
        self.inner
            .lock()
            .entries
            .get(key)
            .map(|entry| entry.value.clone())
    }

    /// Insert or replace a token, evicting the entry closest to expiry when the cache is full.
    ///
    /// Returns the evicted value, if any.
    pub fn put(&self, key: TokenKey, value: TokenValue, now_ms: u64) -> Option<TokenValue> {
        let refresh_at_ms = self.refresh_at_ms(&key, &value, now_ms);
        let entry = CacheEntry {
            value,
            refresh_at_ms,
            inserted_ms: now_ms,
        };
        let mut inner = self.inner.lock();
        let is_new = !inner.entries.contains_key(&key);
        let victim = if is_new && inner.entries.len() >= self.capacity {
            inner.eviction_candidate()
        } else {
            None
        };
        let evicted = victim
            .and_then(|victim| inner.entries.remove(&victim))
            .map(|entry| entry.value);
        inner.entries.insert(key, entry);
        evicted
    }

    /// Drop one token (a rotation, a revoked credential set, a `credential:<id>` bus event).
    pub fn invalidate(&self, key: &TokenKey) -> Option<TokenValue> {
        self.inner
            .lock()
            .entries
            .remove(key)
            .map(|entry| entry.value)
    }

    pub fn clear(&self) {
        self.inner.lock().entries.clear();
    }

    /// The absolute instant the caller should arm a refresh timer for.
    ///
    /// `None` when the token has no expiry (it stays valid until it is rejected).
    #[must_use]
    pub fn next_refresh_at(&self, key: &TokenKey) -> Option<u64> {
        self.inner
            .lock()
            .entries
            .get(key)
            .and_then(|entry| entry.refresh_at_ms)
    }

    fn refresh_at_ms(&self, key: &TokenKey, value: &TokenValue, now_ms: u64) -> Option<u64> {
        // A declared refresh cadence wins over the token lifetime, bounded by the expiry: TS arms
        // `refresh_period_ms` (or `expires_in * 1000 - 30_000`) and re-arms every 30 s afterwards.
        if let Some(period) = value.refresh_period_ms {
            let base = now_ms.saturating_add(period);
            let bounded = match value.expires_at_ms {
                Some(expires_at) => base.min(expires_at),
                None => base,
            };
            let spread = period.saturating_mul(u64::from(self.jitter_percent)) / 100;
            return Some(self.jittered(key, value, bounded, spread));
        }
        let expires_at = value.expires_at_ms?;
        if expires_at <= now_ms {
            return Some(now_ms);
        }
        let lifetime = expires_at.saturating_sub(now_ms);
        let margin = self.margin_ms.min(lifetime);
        let base = expires_at.saturating_sub(margin);
        let spread = margin.saturating_mul(u64::from(self.jitter_percent)) / 100;
        Some(self.jittered(key, value, base, spread))
    }

    fn jittered(&self, key: &TokenKey, value: &TokenValue, base: u64, spread: u64) -> u64 {
        if spread == 0 {
            return base;
        }
        let span = spread.saturating_mul(2).saturating_add(1);
        let offset = i64::try_from(token_seed(key, value) % span).unwrap_or(i64::MAX)
            - i64::try_from(spread).unwrap_or(i64::MAX);
        let jittered = i64::try_from(base)
            .unwrap_or(i64::MAX)
            .saturating_add(offset);
        u64::try_from(jittered.max(0)).unwrap_or(0)
    }
}

impl fmt::Debug for TokenCache {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TokenCache")
            .field("len", &self.len())
            .field("capacity", &self.capacity)
            .field("margin_ms", &self.margin_ms)
            .field("jitter_percent", &self.jitter_percent)
            .finish()
    }
}

fn token_seed(key: &TokenKey, value: &TokenValue) -> u64 {
    let seed = format!(
        "{}:{}:{}:{}",
        key.gateway_id, key.credential_set_id, key.environment, value.access_token
    );
    u64::from(pg_crypto::fnv1a32_utf16(&seed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(name: &str) -> TokenKey {
        TokenKey::new("gw-1", name, "LIVE")
    }

    #[test]
    fn a_fresh_token_is_returned_and_a_stale_one_is_dropped() {
        let cache = TokenCache::new(4);
        let entry = key("cs-1");
        assert!(cache.get(&entry, 0).is_none());

        let refresh_at = {
            cache.put(
                entry.clone(),
                TokenValue::new("token-a").with_expires_at(1_000_000),
                0,
            );
            cache.next_refresh_at(&entry).expect("expiry")
        };
        assert_eq!(cache.len(), 1);
        assert_eq!(
            cache
                .get(&entry, refresh_at - 1)
                .expect("fresh")
                .access_token,
            "token-a"
        );
        assert!(cache.get(&entry, refresh_at).is_none());
        assert!(cache.is_empty());
    }

    #[test]
    fn the_margin_is_subtracted_and_bounded_by_the_lifetime() {
        let cache = TokenCache::with_margin(4, 60_000).with_jitter(0);
        let entry = key("cs-1");
        cache.put(
            entry.clone(),
            TokenValue::new("token").with_expires_at(1_000_000),
            0,
        );
        assert_eq!(cache.next_refresh_at(&entry), Some(940_000));

        let short = key("cs-2");
        cache.put(
            short.clone(),
            TokenValue::new("short").with_expires_at(5_000),
            0,
        );
        // The margin never exceeds the lifetime, so a 5 s token refreshes at its expiry.
        assert_eq!(cache.next_refresh_at(&short), Some(0));

        let expired = key("cs-3");
        cache.put(
            expired.clone(),
            TokenValue::new("expired").with_expires_at(10),
            20,
        );
        assert_eq!(cache.next_refresh_at(&expired), Some(20));
        assert!(cache.get(&expired, 20).is_none());
    }

    #[test]
    fn jitter_is_deterministic_and_within_ten_percent_of_the_margin() {
        let cache = TokenCache::with_margin(4, 60_000).with_jitter(10);
        let entry = key("cs-jitter");
        cache.put(
            entry.clone(),
            TokenValue::new("token-jitter").with_expires_at(1_000_000),
            0,
        );
        let refresh_at = cache.next_refresh_at(&entry).expect("expiry");
        assert!(
            (934_000..=946_000).contains(&refresh_at),
            "refresh_at {refresh_at} outside the ±10% margin window"
        );

        let second = TokenCache::with_margin(4, 60_000).with_jitter(10);
        second.put(
            entry.clone(),
            TokenValue::new("token-jitter").with_expires_at(1_000_000),
            0,
        );
        assert_eq!(second.next_refresh_at(&entry), Some(refresh_at));

        // A different token gets a different (still bounded) point.
        let other = key("cs-other");
        second.put(
            other.clone(),
            TokenValue::new("another-token").with_expires_at(1_000_000),
            0,
        );
        let other_at = second.next_refresh_at(&other).expect("expiry");
        assert!((934_000..=946_000).contains(&other_at));
    }

    #[test]
    fn peek_sees_a_stale_entry_without_removing_it() {
        let cache = TokenCache::with_margin(4, 60_000).with_jitter(0);
        let entry = key("cs-peek");
        cache.put(
            entry.clone(),
            TokenValue::new("token")
                .with_refresh_token("refresh")
                .with_expires_at(100_000),
            0,
        );
        assert!(cache.get(&entry, 100_000).is_none(), "stale get");
        // `get` removed the entry, so peek now sees nothing; a fresh entry is visible to both.
        cache.put(
            entry.clone(),
            TokenValue::new("token-2")
                .with_refresh_token("refresh-2")
                .with_expires_at(200_000),
            0,
        );
        assert_eq!(
            cache.peek(&entry).and_then(|value| value.refresh_token),
            Some("refresh-2".to_owned())
        );
        assert_eq!(
            cache.get(&entry, 139_999).map(|value| value.access_token),
            Some("token-2".to_owned())
        );
        assert!(cache.peek(&key("missing")).is_none());
    }

    #[test]
    fn a_declared_refresh_period_wins_over_the_expiry_margin() {
        let cache = TokenCache::with_margin(4, 60_000).with_jitter(0);
        let entry = key("cs-period");
        // Expires in 1 h, but the credential set asks for a refresh every 5 min.
        cache.put(
            entry.clone(),
            TokenValue::new("token")
                .with_expires_at(3_600_000)
                .with_refresh_period(300_000),
            0,
        );
        assert_eq!(cache.next_refresh_at(&entry), Some(300_000));
        assert!(cache.get(&entry, 299_999).is_some());
        assert!(cache.get(&entry, 300_000).is_none());

        // A period beyond the expiry is bounded by the expiry so a dead token is never returned.
        let short = key("cs-short");
        cache.put(
            short.clone(),
            TokenValue::new("short")
                .with_expires_at(100_000)
                .with_refresh_period(300_000),
            0,
        );
        assert_eq!(cache.next_refresh_at(&short), Some(100_000));
        assert!(cache.get(&short, 100_000).is_none());

        // Jitter is applied to the period, still inside ±10%.
        let jittered = TokenCache::with_margin(4, 60_000).with_jitter(10);
        jittered.put(
            entry.clone(),
            TokenValue::new("token")
                .with_expires_at(3_600_000)
                .with_refresh_period(300_000),
            0,
        );
        let at = jittered.next_refresh_at(&entry).expect("period");
        assert!((270_000..=330_000).contains(&at), "{at}");
    }

    #[test]
    fn no_expiry_means_the_token_never_goes_stale() {
        let cache = TokenCache::new(2);
        let entry = key("cs-1");
        cache.put(entry.clone(), TokenValue::new("permanent"), 0);
        assert_eq!(cache.next_refresh_at(&entry), None);
        assert!(cache.get(&entry, u64::MAX / 2).is_some());
    }

    #[test]
    fn capacity_evicts_the_entry_closest_to_expiry() {
        let cache = TokenCache::with_margin(2, 60_000).with_jitter(0);
        let first = key("cs-first");
        let second = key("cs-second");
        let third = key("cs-third");
        cache.put(
            first.clone(),
            TokenValue::new("first").with_expires_at(1_000_000),
            0,
        );
        cache.put(
            second.clone(),
            TokenValue::new("second").with_expires_at(2_000_000),
            0,
        );
        assert_eq!(cache.len(), 2);

        let evicted = cache.put(
            third.clone(),
            TokenValue::new("third").with_expires_at(3_000_000),
            0,
        );
        assert_eq!(
            evicted.map(|value| value.access_token),
            Some("first".to_owned())
        );
        assert!(cache.get(&first, 0).is_none());
        assert!(cache.get(&second, 0).is_some());
        assert!(cache.get(&third, 0).is_some());

        // Replacing an existing entry does not evict anything.
        assert!(cache
            .put(
                second.clone(),
                TokenValue::new("second-v2").with_expires_at(9_000_000),
                0,
            )
            .is_none());
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn invalidate_and_clear_remove_tokens() {
        let cache = TokenCache::new(4);
        let entry = key("cs-1");
        cache.put(entry.clone(), TokenValue::new("token"), 0);
        assert_eq!(
            cache.invalidate(&entry).map(|value| value.access_token),
            Some("token".to_owned())
        );
        assert!(cache.invalidate(&entry).is_none());

        cache.put(entry.clone(), TokenValue::new("token"), 0);
        cache.put(key("cs-2"), TokenValue::new("token-2"), 0);
        assert_eq!(cache.len(), 2);
        cache.clear();
        assert!(cache.is_empty());
    }

    #[test]
    fn a_zero_capacity_cache_still_works() {
        let cache = TokenCache::new(0);
        assert_eq!(cache.capacity(), 1);
        let entry = key("cs-1");
        cache.put(entry.clone(), TokenValue::new("token"), 0);
        assert!(cache.get(&entry, 0).is_some());
    }

    #[test]
    fn debug_output_never_contains_a_token() {
        let value = TokenValue::new("super-secret-access")
            .with_refresh_token("super-secret-refresh")
            .with_expires_at(10)
            .with_scope("read");
        let rendered = format!("{value:?}");
        assert!(!rendered.contains("super-secret-access"));
        assert!(!rendered.contains("super-secret-refresh"));
        assert!(rendered.contains("<redacted>"));

        let cache = TokenCache::new(2);
        cache.put(key("cs-1"), value, 0);
        let rendered = format!("{cache:?}");
        assert!(!rendered.contains("super-secret"));
        assert!(rendered.contains("capacity"));
    }

    #[test]
    fn the_ts_margin_is_available_for_parity_profiles() {
        assert_eq!(TokenCache::DEFAULT_MARGIN_MS, 60_000);
        assert_eq!(TokenCache::TS_MARGIN_MS, 30_000);
        let cache = TokenCache::with_margin(2, TokenCache::TS_MARGIN_MS).with_jitter(0);
        let entry = key("cs-1");
        cache.put(
            entry.clone(),
            TokenValue::new("token").with_expires_at(100_000),
            0,
        );
        assert_eq!(cache.next_refresh_at(&entry), Some(70_000));
    }
}
