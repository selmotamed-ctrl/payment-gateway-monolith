//! Method and status classification for the two retry phases.
//!
//! Port of `{admin,merchant,checkout}-back/lib/coreInternalClient.ts:19-35` and `:461-494`:
//! `REPLAY_SAFE_METHODS`, `IDEMPOTENT_METHODS`, `isUnavailableStatus`, `mayReplayAfterSend`,
//! `retryAttemptsFor` and `normalizeMaxAttempts`.
//!
//! There are two independent decisions:
//!
//! * a **connect-phase** failure sent nothing, so `GET/HEAD/PUT/DELETE/OPTIONS` are always retried;
//! * a **replay after send** can duplicate an effect, so it is limited to read-only methods,
//!   a request carrying an `Idempotency-Key`, or an explicit caller opt-in. A `PUT`/`DELETE` is
//!   never replayed after send even though HTTP calls them idempotent: core's `PUT` routes create
//!   a new version per call.

#![forbid(unsafe_code)]

/// The methods the edge forwards to core.
///
/// Port of `CoreHttpMethod` (`coreInternalClient.ts:37`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CoreMethod {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
}

impl CoreMethod {
    #[must_use]
    pub const fn all() -> [Self; 7] {
        [
            Self::Get,
            Self::Head,
            Self::Post,
            Self::Put,
            Self::Patch,
            Self::Delete,
            Self::Options,
        ]
    }

    /// Parse an HTTP method case-insensitively; unknown methods are rejected.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            value if value.eq_ignore_ascii_case("GET") => Self::Get,
            value if value.eq_ignore_ascii_case("HEAD") => Self::Head,
            value if value.eq_ignore_ascii_case("POST") => Self::Post,
            value if value.eq_ignore_ascii_case("PUT") => Self::Put,
            value if value.eq_ignore_ascii_case("PATCH") => Self::Patch,
            value if value.eq_ignore_ascii_case("DELETE") => Self::Delete,
            value if value.eq_ignore_ascii_case("OPTIONS") => Self::Options,
            _ => return None,
        })
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Head => "HEAD",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Options => "OPTIONS",
        }
    }

    /// `REPLAY_SAFE_METHODS`: a response may be requested again from another node.
    #[must_use]
    pub const fn is_replay_safe(self) -> bool {
        matches!(self, Self::Get | Self::Head | Self::Options)
    }

    /// `IDEMPOTENT_METHODS`: a connect-phase failure may be retried on the next node.
    #[must_use]
    pub const fn is_connect_retryable(self) -> bool {
        matches!(
            self,
            Self::Get | Self::Head | Self::Put | Self::Delete | Self::Options
        )
    }
}

/// Per-call overrides accepted by `CoreCallOptions`.
///
/// Port of `retryIdempotent`, `retryIfUnavailable` and `maxAttempts`
/// (`coreInternalClient.ts:48-51`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RetryOptions {
    /// `None` keeps the method default (`IDEMPOTENT_METHODS`).
    pub retry_idempotent: Option<bool>,
    /// Explicit opt-in used by callers whose request is safe by construction.
    pub retry_if_unavailable: bool,
    /// `None` keeps `RetryPolicy::DEFAULT_MAX_ATTEMPTS`.
    pub max_attempts: Option<u32>,
}

/// `DEFAULT_MAX_ATTEMPTS` and the attempt-count rules.
///
/// Port of `retryAttemptsFor` (`coreInternalClient.ts:485-494`) and `normalizeMaxAttempts`
/// (`:456-459`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Attempts per logical call, at least one.
    pub max_attempts: u32,
}

impl RetryPolicy {
    /// TS `DEFAULT_MAX_ATTEMPTS`.
    pub const DEFAULT_MAX_ATTEMPTS: u32 = 2;

    #[must_use]
    pub fn new(max_attempts: u32) -> Self {
        Self {
            max_attempts: max_attempts.max(1),
        }
    }

    /// How many attempts one logical call may make.
    ///
    /// TS enables retries when `retryIdempotent ?? IDEMPOTENT_METHODS.has(method)`, or when
    /// `retryIfUnavailable` is set.
    #[must_use]
    pub fn attempts_for(self, method: CoreMethod, options: RetryOptions) -> u32 {
        let retry_enabled = options
            .retry_idempotent
            .unwrap_or_else(|| method.is_connect_retryable());
        if !retry_enabled && !options.retry_if_unavailable {
            return 1;
        }
        options.max_attempts.unwrap_or(self.max_attempts).max(1)
    }

    /// `mayReplayAfterSend`: a request that already reached the wire may be replayed.
    #[must_use]
    pub fn may_replay_after_send(
        method: CoreMethod,
        has_idempotency_key: bool,
        options: RetryOptions,
    ) -> bool {
        method.is_replay_safe()
            || has_idempotency_key
            || options.retry_idempotent == Some(true)
            || options.retry_if_unavailable
    }

    /// Attempt budget for a request that carries an `Idempotency-Key`.
    ///
    /// TS `retryAttemptsFor` only looks at the method and the caller's opt-in, so a `POST` with
    /// an `Idempotency-Key` still gets one attempt even though `mayReplayAfterSend` would allow
    /// the replay. That makes the header useless for a mutation. DEV: the Rust port treats a
    /// valid idempotency key as retry-enabled and uses the standard budget, unless the caller
    /// explicitly disabled retries. [`Self::attempts_for`] keeps the exact TS rule for callers
    /// that need to differ.
    #[must_use]
    pub fn attempts_for_request(
        self,
        method: CoreMethod,
        idempotency_key: Option<&str>,
        options: RetryOptions,
    ) -> u32 {
        if idempotency_key.is_some() && options.retry_idempotent != Some(false) {
            return options.max_attempts.unwrap_or(self.max_attempts).max(1);
        }
        self.attempts_for(method, options)
    }

    /// `isUnavailableStatus`: 502/503/504 are the only statuses worth trying on another node.
    ///
    /// Core's own 502/503/504 answers prove the node is reachable and must never eject it; they
    /// only justify a replay when the request is replay-safe.
    #[must_use]
    pub const fn retryable_status(status: u16) -> bool {
        matches!(status, 502..=504)
    }

    /// Classify a complete HTTP response for replay.
    ///
    /// Mirrors the `request()` loop: after any HTTP response the node is healthy; the response is
    /// retried only when it is 502/503/504 and the request may be replayed after send.
    #[must_use]
    pub fn retryable(
        method: CoreMethod,
        status: u16,
        idempotency_key: Option<&str>,
        options: RetryOptions,
    ) -> bool {
        Self::retryable_status(status)
            && Self::may_replay_after_send(method, idempotency_key.is_some(), options)
    }
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: Self::DEFAULT_MAX_ATTEMPTS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn methods_parse_case_insensitively_and_round_trip() {
        for method in CoreMethod::all() {
            assert_eq!(CoreMethod::parse(method.as_str()), Some(method));
            assert_eq!(
                CoreMethod::parse(&method.as_str().to_ascii_lowercase()),
                Some(method)
            );
        }
        assert_eq!(CoreMethod::parse("TRACE"), None);
        assert_eq!(CoreMethod::parse(""), None);
    }

    #[test]
    fn replay_and_connect_sets_match_the_ts_constants() {
        for method in CoreMethod::all() {
            let replay_safe = matches!(
                method,
                CoreMethod::Get | CoreMethod::Head | CoreMethod::Options
            );
            let connect_retryable = matches!(
                method,
                CoreMethod::Get
                    | CoreMethod::Head
                    | CoreMethod::Put
                    | CoreMethod::Delete
                    | CoreMethod::Options
            );
            assert_eq!(method.is_replay_safe(), replay_safe, "{method:?}");
            assert_eq!(
                method.is_connect_retryable(),
                connect_retryable,
                "{method:?}"
            );
        }
        assert!(!CoreMethod::Patch.is_connect_retryable());
        assert!(!CoreMethod::Post.is_connect_retryable());
    }

    #[test]
    fn attempt_counts_follow_retry_attempts_for() {
        let policy = RetryPolicy::default();
        let defaults = RetryOptions::default();

        assert_eq!(policy.attempts_for(CoreMethod::Get, defaults), 2);
        assert_eq!(policy.attempts_for(CoreMethod::Head, defaults), 2);
        assert_eq!(policy.attempts_for(CoreMethod::Put, defaults), 2);
        assert_eq!(policy.attempts_for(CoreMethod::Delete, defaults), 2);
        assert_eq!(policy.attempts_for(CoreMethod::Options, defaults), 2);
        assert_eq!(policy.attempts_for(CoreMethod::Post, defaults), 1);
        assert_eq!(policy.attempts_for(CoreMethod::Patch, defaults), 1);

        let opted_in = RetryOptions {
            retry_if_unavailable: true,
            ..RetryOptions::default()
        };
        assert_eq!(policy.attempts_for(CoreMethod::Post, opted_in), 2);

        let idempotent = RetryOptions {
            retry_idempotent: Some(true),
            max_attempts: Some(4),
            ..RetryOptions::default()
        };
        assert_eq!(policy.attempts_for(CoreMethod::Post, idempotent), 4);

        let disabled = RetryOptions {
            retry_idempotent: Some(false),
            ..RetryOptions::default()
        };
        assert_eq!(policy.attempts_for(CoreMethod::Get, disabled), 1);
        assert_eq!(RetryPolicy::new(0).max_attempts, 1);
    }

    #[test]
    fn replay_after_send_is_limited_to_safe_requests() {
        let defaults = RetryOptions::default();
        assert!(RetryPolicy::may_replay_after_send(
            CoreMethod::Get,
            false,
            defaults
        ));
        assert!(RetryPolicy::may_replay_after_send(
            CoreMethod::Options,
            false,
            defaults
        ));
        assert!(!RetryPolicy::may_replay_after_send(
            CoreMethod::Post,
            false,
            defaults
        ));
        assert!(!RetryPolicy::may_replay_after_send(
            CoreMethod::Put,
            false,
            defaults
        ));
        assert!(!RetryPolicy::may_replay_after_send(
            CoreMethod::Delete,
            false,
            defaults
        ));
        assert!(RetryPolicy::may_replay_after_send(
            CoreMethod::Post,
            true,
            defaults
        ));
        assert!(RetryPolicy::may_replay_after_send(
            CoreMethod::Put,
            true,
            defaults
        ));
        let opt_in = RetryOptions {
            retry_idempotent: Some(true),
            ..RetryOptions::default()
        };
        assert!(RetryPolicy::may_replay_after_send(
            CoreMethod::Patch,
            false,
            opt_in
        ));
    }

    #[test]
    fn only_502_503_504_are_retryable_statuses() {
        for status in [200, 400, 401, 404, 409, 422, 429, 500] {
            assert!(!RetryPolicy::retryable_status(status), "{status}");
        }
        for status in [502, 503, 504] {
            assert!(RetryPolicy::retryable_status(status), "{status}");
        }
    }

    #[test]
    fn retryable_combines_status_and_replay_rules() {
        let defaults = RetryOptions::default();
        assert!(RetryPolicy::retryable(CoreMethod::Get, 503, None, defaults));
        assert!(!RetryPolicy::retryable(
            CoreMethod::Get,
            500,
            None,
            defaults
        ));
        assert!(!RetryPolicy::retryable(
            CoreMethod::Post,
            503,
            None,
            defaults
        ));
        assert!(RetryPolicy::retryable(
            CoreMethod::Post,
            503,
            Some("order-123456"),
            defaults
        ));
        assert!(!RetryPolicy::retryable(
            CoreMethod::Post,
            200,
            Some("order-123456"),
            defaults
        ));
    }

    #[test]
    fn an_idempotency_key_enables_the_standard_attempt_budget() {
        let policy = RetryPolicy::default();
        let defaults = RetryOptions::default();
        // TS `retryAttemptsFor` (kept by `attempts_for`).
        assert_eq!(policy.attempts_for(CoreMethod::Post, defaults), 1);
        assert_eq!(
            policy.attempts_for_request(CoreMethod::Post, None, defaults),
            1
        );
        // DEV: the request-scoped budget treats a valid key as retry-enabled.
        assert_eq!(
            policy.attempts_for_request(CoreMethod::Post, Some("order-12345678"), defaults),
            2
        );
        assert_eq!(
            policy.attempts_for_request(
                CoreMethod::Post,
                Some("order-12345678"),
                RetryOptions {
                    max_attempts: Some(3),
                    ..RetryOptions::default()
                }
            ),
            3
        );
        let disabled = RetryOptions {
            retry_idempotent: Some(false),
            ..RetryOptions::default()
        };
        assert_eq!(
            policy.attempts_for_request(CoreMethod::Post, Some("order-12345678"), disabled),
            1
        );
    }
}
