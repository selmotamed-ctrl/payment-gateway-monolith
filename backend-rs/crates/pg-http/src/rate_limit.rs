//! Fixed-window rate limiting, shared across ntex workers in one process.
//!
//! The TS edges use `express-rate-limit` v8 fixed windows in memory. Keeping one map per process
//! (not per ntex worker) preserves the configured limits instead of multiplying them by the
//! worker count (chapter 2 §9).

#![forbid(unsafe_code)]

use std::time::{Duration, Instant};

use dashmap::DashMap;
use parking_lot::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateDecision {
    pub allowed: bool,
    pub limit: u64,
    pub remaining: u64,
    pub retry_after_seconds: u64,
    pub reset_epoch_seconds: u64,
}

#[derive(Debug, Clone, Copy)]
struct Window {
    count: u64,
    reset_at: Instant,
    reset_epoch_seconds: u64,
}

/// A fixed-window limiter with a bounded number of keys.
pub struct FixedWindowLimiter {
    window: Duration,
    max_keys: usize,
    entries: DashMap<String, Window>,
    last_sweep: Mutex<Instant>,
}

impl FixedWindowLimiter {
    #[must_use]
    pub fn new(window: Duration, max_keys: usize) -> Self {
        Self {
            window,
            max_keys,
            entries: DashMap::new(),
            last_sweep: Mutex::new(Instant::now()),
        }
    }

    /// Count one hit for `key` against `limit`.
    pub fn check(&self, key: &str, limit: u64) -> RateDecision {
        let now = Instant::now();
        self.sweep(now);
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        if self.entries.len() >= self.max_keys && !self.entries.contains_key(key) {
            // Bounded: refuse new keys rather than grow without limit. Existing keys keep their
            // windows; the sweep removes expired entries on the next call.
            return RateDecision {
                allowed: false,
                limit,
                remaining: 0,
                retry_after_seconds: self.window.as_secs().max(1),
                reset_epoch_seconds: epoch + self.window.as_secs(),
            };
        }
        let mut window = self.entries.entry(key.to_owned()).or_insert(Window {
            count: 0,
            reset_at: now + self.window,
            reset_epoch_seconds: epoch + self.window.as_secs(),
        });
        if now >= window.reset_at {
            window.count = 0;
            window.reset_at = now + self.window;
            window.reset_epoch_seconds = epoch + self.window.as_secs();
        }
        window.count = window.count.saturating_add(1);
        let allowed = window.count <= limit;
        let remaining = limit.saturating_sub(window.count);
        let retry_after_seconds = if allowed {
            0
        } else {
            window
                .reset_at
                .saturating_duration_since(now)
                .as_secs()
                .max(1)
        };
        RateDecision {
            allowed,
            limit,
            remaining,
            retry_after_seconds,
            reset_epoch_seconds: window.reset_epoch_seconds,
        }
    }

    fn sweep(&self, now: Instant) {
        let mut last = self.last_sweep.lock();
        if now.duration_since(*last) < self.window.min(Duration::from_secs(30)) {
            return;
        }
        *last = now;
        self.entries.retain(|_, window| window.reset_at > now);
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_the_limit() {
        let limiter = FixedWindowLimiter::new(Duration::from_secs(60), 100);
        assert!(limiter.check("a", 2).allowed);
        assert!(limiter.check("a", 2).allowed);
        let denied = limiter.check("a", 2);
        assert!(!denied.allowed);
        assert!(denied.retry_after_seconds >= 1);
        assert!(limiter.check("b", 2).allowed);
    }

    #[test]
    fn bounds_the_key_count() {
        let limiter = FixedWindowLimiter::new(Duration::from_secs(60), 1);
        assert!(limiter.check("a", 1).allowed);
        assert!(!limiter.check("b", 1).allowed);
    }
}
