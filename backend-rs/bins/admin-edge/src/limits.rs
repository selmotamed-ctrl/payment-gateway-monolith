//! Process-wide fixed-window and sliding-window limiters.
//!
//! Port of the `express-rate-limit` instances and the hand-written buckets in
//! `admin-back/api/protected/{index,search,academy}.ts`, `admin-back/api/public/auth.ts`,
//! `admin-back/api/upload.ts`, `admin-back/api/protected/backups.ts` and
//! `admin-back/lib/authLimiters.ts`.
//!
//! One map per process (not per ntex worker) so limits do not multiply by worker count, as
//! chapter 2 §9 requires. Account failure limiters count failures only, like
//! `skipSuccessfulRequests: true`.

#![forbid(unsafe_code)]

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use parking_lot::Mutex;
use pg_http::rate_limit::FixedWindowLimiter;

/// A limiter decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub allowed: bool,
    pub limit: u64,
    pub remaining: u64,
    pub retry_after_seconds: u64,
}

impl Decision {
    fn allowed(limit: u64, remaining: u64) -> Self {
        Self {
            allowed: true,
            limit,
            remaining,
            retry_after_seconds: 0,
        }
    }

    fn denied(limit: u64, retry_after_seconds: u64) -> Self {
        Self {
            allowed: false,
            limit,
            remaining: 0,
            retry_after_seconds: retry_after_seconds.max(1),
        }
    }
}

/// Fixed-window limiter keyed on an arbitrary string.
pub struct Fixed {
    inner: FixedWindowLimiter,
    limit: u64,
}

impl Fixed {
    #[must_use]
    pub fn new(limit: u64, window: Duration) -> Self {
        Self {
            inner: FixedWindowLimiter::new(window, 20_000),
            limit,
        }
    }

    pub fn check(&self, key: &str) -> Decision {
        let decision = self.inner.check(key, self.limit);
        Decision {
            allowed: decision.allowed,
            limit: decision.limit,
            remaining: decision.remaining,
            retry_after_seconds: decision.retry_after_seconds.max(1),
        }
    }
}

/// Sliding-window limiter (search 120/min, academy 60/min).
pub struct Sliding {
    window: Duration,
    limit: u64,
    max_keys: usize,
    entries: DashMap<String, Mutex<VecDeque<Instant>>>,
}

impl Sliding {
    #[must_use]
    pub fn new(limit: u64, window: Duration) -> Self {
        Self {
            window,
            limit,
            max_keys: 2_000,
            entries: DashMap::new(),
        }
    }

    pub fn check(&self, key: &str) -> Decision {
        let now = Instant::now();
        if self.entries.len() >= self.max_keys && !self.entries.contains_key(key) {
            // Bound the map like the TS cleanup loop: refuse new keys rather than grow forever.
            self.sweep(now);
            if self.entries.len() >= self.max_keys {
                return Decision::denied(self.limit, self.window.as_secs());
            }
        }
        let entry = self
            .entries
            .entry(key.to_owned())
            .or_insert_with(|| Mutex::new(VecDeque::new()));
        let mut stamps = entry.lock();
        while stamps
            .front()
            .is_some_and(|stamp| *stamp + self.window <= now)
        {
            stamps.pop_front();
        }
        if stamps.len() as u64 >= self.limit {
            let oldest = stamps.front().copied().unwrap_or(now);
            let wait = (oldest + self.window).saturating_duration_since(now);
            return Decision::denied(
                self.limit,
                wait.as_secs().max(u64::from(wait.subsec_nanos() > 0)),
            );
        }
        stamps.push_back(now);
        Decision::allowed(self.limit, self.limit - stamps.len() as u64)
    }

    fn sweep(&self, now: Instant) {
        self.entries.retain(|_, stamps| {
            let mut stamps = stamps.lock();
            while stamps
                .front()
                .is_some_and(|stamp| *stamp + self.window <= now)
            {
                stamps.pop_front();
            }
            !stamps.is_empty()
        });
    }
}

/// Failure-only fixed window, the `skipSuccessfulRequests` behaviour of `lib/authLimiters.ts`.
pub struct Failures {
    window: Duration,
    max_keys: usize,
    entries: DashMap<String, Mutex<FailureWindow>>,
}

struct FailureWindow {
    count: u64,
    reset_at: Instant,
}

impl Failures {
    #[must_use]
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            max_keys: 20_000,
            entries: DashMap::new(),
        }
    }

    /// Look at the current budget without consuming it.
    pub fn peek(&self, key: &str, limit: u64) -> Decision {
        let now = Instant::now();
        let Some(entry) = self.entries.get(key) else {
            return Decision::allowed(limit, limit);
        };
        let window = entry.lock();
        if now >= window.reset_at {
            return Decision::allowed(limit, limit);
        }
        if window.count >= limit {
            let wait = window.reset_at.saturating_duration_since(now);
            return Decision::denied(limit, wait.as_secs() + u64::from(wait.subsec_nanos() > 0));
        }
        Decision::allowed(limit, limit.saturating_sub(window.count))
    }

    /// Count one failure. Called after the response status is known.
    pub fn record_failure(&self, key: &str) {
        let now = Instant::now();
        if self.entries.len() >= self.max_keys && !self.entries.contains_key(key) {
            self.entries
                .retain(|_, window| window.lock().reset_at > now);
            if self.entries.len() >= self.max_keys {
                return;
            }
        }
        let entry = self.entries.entry(key.to_owned()).or_insert_with(|| {
            Mutex::new(FailureWindow {
                count: 0,
                reset_at: now + self.window,
            })
        });
        let mut window = entry.lock();
        if now >= window.reset_at {
            window.count = 0;
            window.reset_at = now + self.window;
        }
        window.count = window.count.saturating_add(1);
    }
}

/// Every limiter the admin edge owns.
pub struct Limiters {
    /// 600 per `ADMIN_RATE_LIMIT_WINDOW_MS` per client address.
    pub admin: Fixed,
    /// 10 per `AUTH_RATE_LIMIT_WINDOW_MS` per client address.
    pub auth: Fixed,
    /// 20 uploads per `ADMIN_RATE_LIMIT_WINDOW_MS`.
    pub upload: Fixed,
    /// 6 backup jobs per 10 minutes.
    pub backup: Fixed,
    /// 120 searches per minute per (ip, subject).
    pub search: Sliding,
    /// 60 academy requests per minute per user.
    pub academy: Sliding,
    /// `AUTH_RATE_LIMIT_MAX` failures per (account, address) per window.
    pub account_per_address: Failures,
    /// `AUTH_RATE_LIMIT_MAX * 5` failures per account per window.
    pub account_ceiling: Failures,
}

impl Limiters {
    #[must_use]
    pub fn new(
        admin_limit: u64,
        admin_window_ms: u64,
        auth_limit: u64,
        auth_window_ms: u64,
        upload_limit: u64,
        upload_window_ms: u64,
        backup_limit: u64,
    ) -> Self {
        let auth_window = Duration::from_millis(auth_window_ms);
        Self {
            admin: Fixed::new(admin_limit, Duration::from_millis(admin_window_ms)),
            auth: Fixed::new(auth_limit, auth_window),
            upload: Fixed::new(upload_limit, Duration::from_millis(upload_window_ms)),
            backup: Fixed::new(backup_limit, Duration::from_secs(600)),
            search: Sliding::new(120, Duration::from_secs(60)),
            academy: Sliding::new(60, Duration::from_secs(60)),
            account_per_address: Failures::new(auth_window),
            account_ceiling: Failures::new(auth_window),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_window_enforces_and_resets() {
        let limiter = Fixed::new(2, Duration::from_millis(20));
        assert!(limiter.check("a").allowed);
        assert!(limiter.check("a").allowed);
        assert!(!limiter.check("a").allowed);
        std::thread::sleep(Duration::from_millis(30));
        assert!(limiter.check("a").allowed);
    }

    #[test]
    fn sliding_window_counts_a_trailing_minute() {
        let limiter = Sliding::new(2, Duration::from_millis(30));
        assert!(limiter.check("u").allowed);
        assert!(limiter.check("u").allowed);
        let denied = limiter.check("u");
        assert!(!denied.allowed);
        assert!(denied.retry_after_seconds >= 1);
        std::thread::sleep(Duration::from_millis(40));
        assert!(limiter.check("u").allowed);
    }

    #[test]
    fn failure_limiter_only_counts_failures() {
        let limiter = Failures::new(Duration::from_secs(60));
        for _ in 0..5 {
            assert!(limiter.peek("acct", 3).allowed);
        }
        limiter.record_failure("acct");
        limiter.record_failure("acct");
        assert!(limiter.peek("acct", 3).allowed);
        limiter.record_failure("acct");
        assert!(!limiter.peek("acct", 3).allowed);
    }
}
