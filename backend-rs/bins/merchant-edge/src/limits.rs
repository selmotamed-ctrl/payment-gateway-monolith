//! In-process fixed-window limiters.
//!
//! Port of the `express-rate-limit` v8 configuration of `merchant-back`:
//!
//! * auth 20 / 15 min per verified client address (`AUTH_RATE_LIMIT_*`);
//! * account limiters count **failures only** (`skipSuccessfulRequests`), keyed per account+address
//!   with an account-wide ceiling of five times the budget (`lib/authLimiters.ts`);
//! * API 300 / 60 s per address, onboarding the same budget, uploads 10 / 60 s per address;
//! * external 120 / 60 s per token+address plus a coarse 5x per-address ceiling.
//!
//! One limiter map is shared by every ntex worker (chapter 2 §9), not one per worker.

#![forbid(unsafe_code)]

use std::net::IpAddr;
use std::time::{Duration, Instant};

use dashmap::DashMap;

pub use pg_edge::digest_key_part;

/// The answer of one limiter hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LimitHit {
    pub allowed: bool,
    pub limit: u64,
    pub remaining: u64,
    /// Seconds until the window resets (at least 1 when refused).
    pub retry_after_seconds: u64,
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    count: u64,
    reset_at: Instant,
}

/// A fixed-window counter with `undo` for `skipSuccessfulRequests`.
#[derive(Debug)]
pub struct WindowLimiter {
    window: Duration,
    limit: u64,
    max_keys: usize,
    entries: DashMap<String, Bucket>,
}

impl WindowLimiter {
    #[must_use]
    pub fn new(window_ms: u64, limit: u32, max_keys: usize) -> Self {
        Self {
            window: Duration::from_millis(window_ms.max(1)),
            limit: u64::from(limit.max(1)),
            max_keys,
            entries: DashMap::new(),
        }
    }

    /// Count one request.
    pub fn hit(&self, key: &str) -> LimitHit {
        self.hit_at(key, Instant::now())
    }

    fn hit_at(&self, key: &str, now: Instant) -> LimitHit {
        if self.entries.len() >= self.max_keys && !self.entries.contains_key(key) {
            return LimitHit {
                allowed: false,
                limit: self.limit,
                remaining: 0,
                retry_after_seconds: self.window.as_secs().max(1),
            };
        }
        let mut bucket = self.entries.entry(key.to_owned()).or_insert(Bucket {
            count: 0,
            reset_at: now + self.window,
        });
        if now >= bucket.reset_at {
            bucket.count = 0;
            bucket.reset_at = now + self.window;
        }
        bucket.count = bucket.count.saturating_add(1);
        let allowed = bucket.count <= self.limit;
        let remaining = self.limit.saturating_sub(bucket.count);
        let retry_after_seconds = if allowed {
            0
        } else {
            bucket
                .reset_at
                .saturating_duration_since(now)
                .as_secs()
                .max(1)
        };
        LimitHit {
            allowed,
            limit: self.limit,
            remaining,
            retry_after_seconds,
        }
    }

    /// `skipSuccessfulRequests`: remove the hit of a request that turned out successful.
    pub fn undo(&self, key: &str) {
        if let Some(mut bucket) = self.entries.get_mut(key) {
            bucket.count = bucket.count.saturating_sub(1);
        }
    }

    #[must_use]
    pub fn limit(&self) -> u64 {
        self.limit
    }

    /// Current count of a key (diagnostics and tests; 0 when absent).
    #[must_use]
    pub fn count(&self, key: &str) -> u64 {
        self.entries.get(key).map_or(0, |bucket| bucket.count)
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

/// `rateLimitKey`: the verified client address, IPv6 grouped by `/56` (`ipKeyGenerator`), plus
/// the optional non-empty key parts.
#[must_use]
pub fn rate_limit_key(client_ip: &str, extra: &[&str]) -> String {
    let ip = ip_key(client_ip);
    let parts: Vec<&str> = extra
        .iter()
        .copied()
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        ip
    } else {
        format!("{ip}|{}", parts.join("|"))
    }
}

/// The `ipKeyGenerator` normalisation.
#[must_use]
pub fn ip_key(client_ip: &str) -> String {
    match pg_edge::parse_ip(client_ip) {
        Some(IpAddr::V4(address)) => address.to_string(),
        Some(IpAddr::V6(address)) => {
            // /56: keep the first seven bytes and zero the rest.
            let mut bytes = address.octets();
            for byte in bytes.iter_mut().skip(7) {
                *byte = 0;
            }
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        None => client_ip.to_owned(),
    }
}

/// The `RateLimit-*` headers of a limited response (`standardHeaders: true`).
#[must_use]
pub fn rate_limit_headers(hit: LimitHit) -> Vec<(String, String)> {
    let mut headers = vec![
        ("ratelimit-limit".to_owned(), hit.limit.to_string()),
        ("ratelimit-remaining".to_owned(), hit.remaining.to_string()),
    ];
    if !hit.allowed {
        headers.push((
            "retry-after".to_owned(),
            hit.retry_after_seconds.to_string(),
        ));
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_allows_the_budget_then_refuses() {
        let limiter = WindowLimiter::new(60_000, 2, 100);
        assert!(limiter.hit("a").allowed);
        assert!(limiter.hit("a").allowed);
        let refused = limiter.hit("a");
        assert!(!refused.allowed);
        assert!(refused.retry_after_seconds >= 1);
        assert!(limiter.hit("b").allowed);
    }

    #[test]
    fn undo_releases_a_successful_request() {
        let limiter = WindowLimiter::new(60_000, 1, 100);
        assert!(limiter.hit("a").allowed);
        limiter.undo("a");
        assert!(limiter.hit("a").allowed);
        limiter.undo("missing");
    }

    #[test]
    fn the_key_count_is_bounded() {
        let limiter = WindowLimiter::new(60_000, 1, 1);
        assert!(limiter.hit("a").allowed);
        assert!(!limiter.hit("b").allowed);
    }

    #[test]
    fn ipv4_keys_are_plain_and_ipv6_keys_are_grouped_by_56() {
        assert_eq!(rate_limit_key("203.0.113.9", &[]), "203.0.113.9");
        assert_eq!(
            rate_limit_key("203.0.113.9", &["upload"]),
            "203.0.113.9|upload"
        );
        assert_eq!(
            ip_key("2001:db8:abcd:1234:5678:9abc:def0:1234"),
            "2001:db8:abcd:1200::"
        );
        // Two addresses of the same /56 share the budget.
        assert_eq!(
            ip_key("2001:db8:abcd:1201::1"),
            ip_key("2001:db8:abcd:12ff::9")
        );
        assert_eq!(ip_key("not-an-ip"), "not-an-ip");
    }

    #[test]
    fn limit_headers_include_retry_after_only_when_refused() {
        let allowed = rate_limit_headers(LimitHit {
            allowed: true,
            limit: 20,
            remaining: 19,
            retry_after_seconds: 0,
        });
        assert_eq!(allowed.len(), 2);
        let refused = rate_limit_headers(LimitHit {
            allowed: false,
            limit: 20,
            remaining: 0,
            retry_after_seconds: 42,
        });
        assert!(refused.contains(&("retry-after".to_owned(), "42".to_owned())));
    }
}
