//! Login/MFA throttle policy, the atomic increment-with-window Lua and the bounded memory
//! fallback store.
//!
//! Port of `core-back/lib/auth/sharedState.ts` and `core-back/lib/auth/throttle.ts`.
//!
//! Policy (GAP-027 in the TypeScript tree): counters live in Redis when `REDIS_URL` is set and are
//! shared by every core instance; any Redis failure degrades to a per-process store so login keeps
//! working during an outage. Identifiers are hashed before they become keys (see
//! [`crate::keys::auth_digest`]) so a phone number or e-mail is never stored in clear.
//!
//! `INCR_WINDOW_LUA` is copied byte-for-byte from the TS source: `INCR` and `PEXPIRE` are one
//! atomic step, and a key found without an expiry gets one re-applied.

#![forbid(unsafe_code)]

use std::collections::{HashMap, VecDeque};

/// Maximum entries of the per-process fallback before it drops the oldest half.
pub const MEMORY_MAX_ENTRIES: usize = 20_000;

pub const SCOPE_LOGIN_ID: &str = "login-id";
pub const SCOPE_LOGIN_PAIR: &str = "login-pair";
pub const SCOPE_LOGIN_IP: &str = "login-ip";
pub const SCOPE_MFA_IP: &str = "mfa-ip";

/// Byte-for-byte copy of `INCR_WINDOW_LUA` (156 bytes including the template newlines).
pub const INCR_WINDOW_LUA: &str = r"
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThrottlePolicy {
    pub max_failures: u64,
    pub window_ms: u64,
    pub lock_ms: u64,
}

impl ThrottlePolicy {
    #[must_use]
    pub const fn new(max_failures: u64, window_ms: u64, lock_ms: u64) -> Self {
        Self {
            max_failures,
            window_ms,
            lock_ms,
        }
    }

    /// `recordFailure` sets the lock once the counter reaches the maximum.
    #[must_use]
    pub fn should_lock(self, failures: u64) -> bool {
        failures >= self.max_failures
    }
}

/// Every throttle window and lock is 15 minutes.
pub const THROTTLE_WINDOW_MS: u64 = 15 * 60_000;

/// Tight lock on identifier + client address (5 failures).
pub const LOGIN_PAIR_POLICY: ThrottlePolicy =
    ThrottlePolicy::new(5, THROTTLE_WINDOW_MS, THROTTLE_WINDOW_MS);

/// Identifier-only ceiling against guessing spread over many addresses (50 failures).
pub const LOGIN_IDENTIFIER_POLICY: ThrottlePolicy =
    ThrottlePolicy::new(50, THROTTLE_WINDOW_MS, THROTTLE_WINDOW_MS);

/// Per-address login throttle (30 failures).
pub const LOGIN_IP_POLICY: ThrottlePolicy =
    ThrottlePolicy::new(30, THROTTLE_WINDOW_MS, THROTTLE_WINDOW_MS);

/// Per-address MFA throttle (20 failures).
pub const MFA_IP_POLICY: ThrottlePolicy =
    ThrottlePolicy::new(20, THROTTLE_WINDOW_MS, THROTTLE_WINDOW_MS);

/// `identifier.toLowerCase()|ip`, with one shared bucket when the address is unknown.
#[must_use]
pub fn pair_value(identifier: &str, ip: Option<&str>) -> String {
    format!("{}|{}", identifier.to_lowercase(), ip.unwrap_or("unknown"))
}

/// `details.retryAfterSeconds` = `Math.ceil(remaining / 1000)`.
#[must_use]
pub fn retry_after_seconds(remaining_ms: u64) -> u64 {
    remaining_ms.div_ceil(1_000)
}

#[derive(Debug, Clone, Copy)]
struct Counter {
    count: u64,
    expires_at_ms: i64,
    generation: u64,
}

#[derive(Debug, Clone, Copy)]
struct Flag {
    expires_at_ms: i64,
    generation: u64,
}

/// One live map entry in insertion order. A stale entry (removed by `del`, expiry or eviction)
/// is skipped lazily when it reaches the front; the `generation` prevents a stale entry from
/// evicting a key that was re-inserted after the original was deleted.
#[derive(Debug, Clone)]
enum OrderEntry {
    Counter { key: String, generation: u64 },
    Flag { key: String, generation: u64 },
}

/// The in-process fallback (`MemoryAuthStateStore`).
///
/// Capacity is the hard cap on **counters + flags together** (20,000 in production, not per map).
/// A write that finds the store at the cap first drops expired entries, then evicts the oldest
/// inserted live entries until at most half the capacity remains, so a key flood cannot thrash the
/// store one eviction per write. This mirrors the TS `prune()` guard (which drops the oldest half
/// of each map); the TypeScript remembers insertion order, so the Rust order queue does too.
/// A key re-written after it was deleted gets a fresh generation, so a stale order entry never
/// evicts its replacement.
#[derive(Debug, Clone)]
pub struct MemoryAuthState {
    capacity: usize,
    counters: HashMap<String, Counter>,
    flags: HashMap<String, Flag>,
    order: VecDeque<OrderEntry>,
    generation_counter: u64,
}

impl Default for MemoryAuthState {
    fn default() -> Self {
        Self::new(MEMORY_MAX_ENTRIES)
    }
}

impl MemoryAuthState {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            counters: HashMap::new(),
            flags: HashMap::new(),
            order: VecDeque::new(),
            generation_counter: 0,
        }
    }

    #[must_use]
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.counters.len() + self.flags.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Test/observability hook: is this counter key present (expiry is applied lazily on read or
    /// when the store next reaches its capacity)?
    #[must_use]
    pub fn contains_counter(&self, key: &str) -> bool {
        self.counters.contains_key(key)
    }

    /// Test/observability hook: is this flag key present (expiry is applied lazily on read or when
    /// the store next reaches its capacity)?
    #[must_use]
    pub fn contains_flag(&self, key: &str) -> bool {
        self.flags.contains_key(key)
    }

    /// Port of `incrWindow`: start a fresh window when none is active, then increment.
    pub fn incr_window(&mut self, key: &str, window_ms: u64, now_ms: i64) -> u64 {
        self.reserve_slot(now_ms);
        let window_ms = i64::try_from(window_ms).unwrap_or(i64::MAX);
        if let Some(entry) = self.counters.get_mut(key) {
            if entry.expires_at_ms <= now_ms {
                entry.count = 0;
                entry.expires_at_ms = now_ms.saturating_add(window_ms);
            }
            entry.count = entry.count.saturating_add(1);
            return entry.count;
        }
        let generation = self.next_generation();
        self.counters.insert(
            key.to_owned(),
            Counter {
                count: 1,
                expires_at_ms: now_ms.saturating_add(window_ms),
                generation,
            },
        );
        self.order.push_back(OrderEntry::Counter {
            key: key.to_owned(),
            generation,
        });
        1
    }

    /// Port of `setFlag`: `SET key 1 PX ttl`, stored here as an absolute expiry.
    pub fn set_flag(&mut self, key: &str, ttl_ms: u64, now_ms: i64) {
        self.reserve_slot(now_ms);
        let ttl_ms = i64::try_from(ttl_ms.max(1)).unwrap_or(i64::MAX);
        let expires_at_ms = now_ms.saturating_add(ttl_ms);
        if let Some(flag) = self.flags.get_mut(key) {
            // `SET ... PX` replaces the expiry in place; insertion order is unchanged.
            flag.expires_at_ms = expires_at_ms;
            return;
        }
        let generation = self.next_generation();
        self.flags.insert(
            key.to_owned(),
            Flag {
                expires_at_ms,
                generation,
            },
        );
        self.order.push_back(OrderEntry::Flag {
            key: key.to_owned(),
            generation,
        });
    }

    /// Port of `flagRemainingMs`: `0` when absent or already expired.
    pub fn flag_remaining_ms(&mut self, key: &str, now_ms: i64) -> u64 {
        match self.flags.get(key).copied() {
            None => 0,
            Some(flag) if flag.expires_at_ms <= now_ms => {
                self.flags.remove(key);
                0
            }
            Some(flag) => u64::try_from(flag.expires_at_ms - now_ms).unwrap_or(0),
        }
    }

    /// Port of `del`: removes both the counter and the flag of each key.
    pub fn del(&mut self, keys: &[String]) {
        for key in keys {
            self.counters.remove(key);
            self.flags.remove(key);
        }
    }

    /// Port of `clear` (tests and the explicit reset hook only).
    pub fn clear(&mut self) {
        self.counters.clear();
        self.flags.clear();
        self.order.clear();
    }

    fn next_generation(&mut self) -> u64 {
        let generation = self.generation_counter;
        self.generation_counter = self.generation_counter.wrapping_add(1);
        generation
    }

    /// Make room for one write. Below the cap this is a no-op (no full scan on every login
    /// failure); at the cap, expired entries go first and the oldest live half is evicted.
    fn reserve_slot(&mut self, now_ms: i64) {
        if self.len() < self.capacity {
            return;
        }
        self.counters
            .retain(|_, entry| entry.expires_at_ms > now_ms);
        self.flags.retain(|_, entry| entry.expires_at_ms > now_ms);
        if self.len() < self.capacity {
            return;
        }
        let target = self.capacity / 2;
        while self.len() > target {
            if !self.evict_oldest() {
                break;
            }
        }
    }

    /// Remove the oldest live entry. Stale order entries (already deleted or expired) are skipped.
    fn evict_oldest(&mut self) -> bool {
        while let Some(entry) = self.order.pop_front() {
            match entry {
                OrderEntry::Counter { key, generation } => {
                    if self
                        .counters
                        .get(&key)
                        .is_some_and(|counter| counter.generation == generation)
                    {
                        self.counters.remove(&key);
                        return true;
                    }
                }
                OrderEntry::Flag { key, generation } => {
                    if self
                        .flags
                        .get(&key)
                        .is_some_and(|flag| flag.generation == generation)
                    {
                        self.flags.remove(&key);
                        return true;
                    }
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sha256::sha256_hex;

    #[test]
    fn incr_window_lua_is_byte_identical_to_the_typescript_source() {
        assert_eq!(
            sha256_hex(INCR_WINDOW_LUA.as_bytes()),
            "a934395199d90fca943b898d5bb141fb5c8cb7ce4246fd0119287a8025bb84fd"
        );
        assert_eq!(INCR_WINDOW_LUA.len(), 156);
        assert!(INCR_WINDOW_LUA.starts_with('\n'));
        assert!(INCR_WINDOW_LUA.ends_with('\n'));
    }

    #[test]
    fn policies_match_the_typescript_limits() {
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
            assert_eq!(policy.window_ms, 15 * 60_000);
            assert_eq!(policy.lock_ms, 15 * 60_000);
        }
        assert!(!LOGIN_PAIR_POLICY.should_lock(4));
        assert!(LOGIN_PAIR_POLICY.should_lock(5));
    }

    #[test]
    fn pair_value_and_retry_after() {
        assert_eq!(
            pair_value("Alice@Example.com", Some("1.2.3.4")),
            "alice@example.com|1.2.3.4"
        );
        assert_eq!(pair_value("Alice", None), "alice|unknown");
        assert_eq!(retry_after_seconds(1), 1);
        assert_eq!(retry_after_seconds(1_001), 2);
        assert_eq!(retry_after_seconds(900_000), 900);
    }

    #[test]
    fn counters_start_and_reset_a_window() {
        let mut store = MemoryAuthState::new(10);
        assert_eq!(store.incr_window("k", 1_000, 0), 1);
        assert_eq!(store.incr_window("k", 1_000, 500), 2);
        assert_eq!(store.incr_window("k", 1_000, 1_000), 1); // window expired
        assert_eq!(store.incr_window("k", 1_000, 1_001), 2);
    }

    #[test]
    fn flags_expire() {
        let mut store = MemoryAuthState::new(10);
        assert_eq!(store.flag_remaining_ms("flag", 0), 0);
        store.set_flag("flag", 5_000, 1_000);
        assert_eq!(store.flag_remaining_ms("flag", 1_000), 5_000);
        assert_eq!(store.flag_remaining_ms("flag", 5_999), 1);
        assert_eq!(store.flag_remaining_ms("flag", 6_000), 0);
        assert_eq!(store.flag_remaining_ms("flag", 6_001), 0);
    }

    #[test]
    fn del_removes_counters_and_flags() {
        let mut store = MemoryAuthState::new(10);
        store.incr_window("k", 1_000, 0);
        store.set_flag("k", 1_000, 0);
        store.incr_window("other", 1_000, 0);
        assert_eq!(store.len(), 3);
        store.del(&["k".to_owned()]);
        assert_eq!(store.len(), 1);
        store.clear();
        assert!(store.is_empty());
    }

    #[test]
    fn store_is_bounded() {
        let mut store = MemoryAuthState::new(50);
        for index in 0..500 {
            store.incr_window(&format!("key-{index}"), 60_000, index);
        }
        // Hard cap: counters + flags never exceed `capacity`, and the oldest entries are gone.
        assert!(store.len() <= store.capacity(), "len={}", store.len());
        assert!(!store.is_empty());
        assert!(store.contains_counter("key-499"));
        assert!(!store.contains_counter("key-0"));
    }

    #[test]
    fn flags_are_bounded_and_evict_oldest() {
        let mut store = MemoryAuthState::new(50);
        for index in 0..500 {
            store.set_flag(&format!("flag-{index}"), 60_000, index);
        }
        assert!(store.len() <= store.capacity(), "len={}", store.len());
        assert!(store.contains_flag("flag-499"));
        assert!(!store.contains_flag("flag-0"));
    }

    #[test]
    fn a_cleared_store_can_be_reused() {
        let mut store = MemoryAuthState::new(2);
        store.incr_window("a", 1_000, 0);
        store.set_flag("b", 1_000, 0);
        store.clear();
        assert!(store.is_empty());
        assert_eq!(store.incr_window("a", 1_000, 0), 1);
        assert!(store.contains_counter("a"));
    }

    #[test]
    fn ttl_of_zero_is_at_least_one_millisecond() {
        let mut store = MemoryAuthState::new(10);
        store.set_flag("flag", 0, 0);
        assert!(store.flag_remaining_ms("flag", 0) >= 1);
    }
}
