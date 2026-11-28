//! Merchant webhook retry schedule, event filter and endpoint limit.
//!
//! Port of `core-back/engine/webhooks/events.ts`,
//! `core-back/engine/workers/MerchantWebhookWorker.ts:149-283` and
//! `core-back/engine/webhooks/WebhookEndpointService.ts:140-160`.
//!
//! Retry delays after the 1st..7th failed attempt (the first attempt is immediate) are
//! `5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h`, i.e. eight attempts in total. A retry delay gets
//! `±20%` jitter. After the 8th failure the delivery is parked; an endpoint that has failed
//! continuously for five days is disabled.

#![forbid(unsafe_code)]

/// `WEBHOOK_RETRY_DELAYS_MS` (`engine/webhooks/events.ts:78`).
pub const WEBHOOK_RETRY_DELAYS_MS: [u64; 7] = [
    5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000,
];
/// `WEBHOOK_MAX_ATTEMPTS` = delays + the immediate first attempt.
pub const WEBHOOK_MAX_ATTEMPTS: u32 = 8;
/// `MERCHANT_WEBHOOK_DISABLE_AFTER_DAYS` default.
pub const WEBHOOK_DISABLE_AFTER_DAYS: u64 = 5;
/// `WEBHOOK_DISABLE_AFTER_DAYS` in milliseconds.
pub const WEBHOOK_DISABLE_AFTER_MS: u64 = WEBHOOK_DISABLE_AFTER_DAYS * 86_400_000;
/// Endpoints one application may have (`WebhookEndpointService.ts:150`).
pub const WEBHOOK_ENDPOINTS_PER_APPLICATION: usize = 5;
/// `±20%` jitter (`MerchantWebhookWorker.ts:152`).
pub const WEBHOOK_JITTER_PERCENT: u64 = 20;
/// The non-subscribable test event (`engine/webhooks/events.ts:19`).
pub const WEBHOOK_TEST_EVENT: &str = "webhook.test";

/// The jitter and limits of one deployment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebhookRetryPolicy {
    pub jitter_percent: u64,
    pub max_attempts: u32,
    pub disable_after_ms: u64,
}

impl WebhookRetryPolicy {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The delay after the given 1-based attempt number.
    ///
    /// `jitter_sample` is a deterministic sample in `0..=10_000` (`5_000` is the exact base
    /// delay). TS uses `Math.random()`; a caller draws the sample from its injected RNG.
    #[must_use]
    pub fn delay_after_attempt(&self, attempt: u32, jitter_sample: u32) -> u64 {
        let index = usize::try_from(attempt.saturating_sub(1))
            .unwrap_or(0)
            .min(WEBHOOK_RETRY_DELAYS_MS.len().saturating_sub(1));
        let base = WEBHOOK_RETRY_DELAYS_MS
            .get(index)
            .copied()
            .unwrap_or(WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.len() - 1]);
        self.apply_jitter(base, jitter_sample)
    }

    /// When the next attempt is due, or `None` when the delivery must be parked.
    #[must_use]
    pub fn next_attempt_at(&self, now_ms: u64, attempt: u32, jitter_sample: u32) -> Option<u64> {
        if self.is_exhausted(attempt) {
            return None;
        }
        Some(now_ms.saturating_add(self.delay_after_attempt(attempt, jitter_sample)))
    }

    /// `attempts >= WEBHOOK_MAX_ATTEMPTS` (`MerchantWebhookWorker.ts:194`).
    #[must_use]
    pub fn is_exhausted(&self, attempt: u32) -> bool {
        attempt >= self.max_attempts
    }

    /// Whether an endpoint failing since `failing_since_ms` must be disabled now.
    #[must_use]
    pub fn should_disable(&self, failing_since_ms: Option<u64>, now_ms: u64) -> bool {
        failing_since_ms.is_some_and(|since| {
            now_ms >= since && now_ms.saturating_sub(since) >= self.disable_after_ms
        })
    }

    fn apply_jitter(&self, base: u64, jitter_sample: u32) -> u64 {
        let percent = self.jitter_percent.min(100);
        if percent == 0 {
            return base;
        }
        let clamped = u64::from(jitter_sample.min(10_000));
        let spread = base.saturating_mul(percent) / 100;
        let doubled = spread.saturating_mul(2);
        let offset = clamped.saturating_mul(doubled) / 10_000;
        base.saturating_sub(spread).saturating_add(offset)
    }
}

impl Default for WebhookRetryPolicy {
    fn default() -> Self {
        Self {
            jitter_percent: WEBHOOK_JITTER_PERCENT,
            max_attempts: WEBHOOK_MAX_ATTEMPTS,
            disable_after_ms: WEBHOOK_DISABLE_AFTER_MS,
        }
    }
}

/// The merchant-facing webhook event types plus the test event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WebhookEventType {
    PaymentSucceeded,
    PaymentFailed,
    PaymentExpired,
    PaymentRefunded,
    DisputeOpened,
    DisputeClosed,
    CashoutPaid,
    CashoutFailed,
    LinkExpired,
    /// `webhook.test`: always delivered to the endpoint it was requested for.
    WebhookTest,
}

impl WebhookEventType {
    /// Every event, including the test event.
    #[must_use]
    pub const fn all() -> [Self; 10] {
        [
            Self::PaymentSucceeded,
            Self::PaymentFailed,
            Self::PaymentExpired,
            Self::PaymentRefunded,
            Self::DisputeOpened,
            Self::DisputeClosed,
            Self::CashoutPaid,
            Self::CashoutFailed,
            Self::LinkExpired,
            Self::WebhookTest,
        ]
    }

    /// The nine types a merchant may subscribe to (`WEBHOOK_EVENT_TYPES`).
    #[must_use]
    pub const fn subscribable() -> [Self; 9] {
        [
            Self::PaymentSucceeded,
            Self::PaymentFailed,
            Self::PaymentExpired,
            Self::PaymentRefunded,
            Self::DisputeOpened,
            Self::DisputeClosed,
            Self::CashoutPaid,
            Self::CashoutFailed,
            Self::LinkExpired,
        ]
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "payment.succeeded" => Self::PaymentSucceeded,
            "payment.failed" => Self::PaymentFailed,
            "payment.expired" => Self::PaymentExpired,
            "payment.refunded" => Self::PaymentRefunded,
            "dispute.opened" => Self::DisputeOpened,
            "dispute.closed" => Self::DisputeClosed,
            "cashout.paid" => Self::CashoutPaid,
            "cashout.failed" => Self::CashoutFailed,
            "link.expired" => Self::LinkExpired,
            WEBHOOK_TEST_EVENT => Self::WebhookTest,
            _ => return None,
        })
    }

    /// Parse a subscribable type; `webhook.test` is rejected for an endpoint filter.
    #[must_use]
    pub fn parse_subscription(raw: &str) -> Option<Self> {
        Self::parse(raw).filter(|event| !event.is_test())
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PaymentSucceeded => "payment.succeeded",
            Self::PaymentFailed => "payment.failed",
            Self::PaymentExpired => "payment.expired",
            Self::PaymentRefunded => "payment.refunded",
            Self::DisputeOpened => "dispute.opened",
            Self::DisputeClosed => "dispute.closed",
            Self::CashoutPaid => "cashout.paid",
            Self::CashoutFailed => "cashout.failed",
            Self::LinkExpired => "link.expired",
            Self::WebhookTest => WEBHOOK_TEST_EVENT,
        }
    }

    #[must_use]
    pub const fn is_test(self) -> bool {
        matches!(self, Self::WebhookTest)
    }
}

/// One unknown entry in an endpoint filter.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WebhookConfigError {
    #[error("Unknown event type(s): {0}")]
    UnknownEventType(String),
}

impl WebhookConfigError {
    /// The admin-facing TS code (`WEBHOOK_EVENT_TYPE_UNKNOWN`, HTTP 422).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownEventType(_) => "WEBHOOK_EVENT_TYPE_UNKNOWN",
        }
    }
}

/// The endpoint cap was reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum WebhookLimitError {
    #[error("An application can have at most {limit} webhook endpoints")]
    EndpointLimit { limit: usize },
}

/// Validate and de-duplicate an endpoint's `eventTypes`.
///
/// Port of `checkEventTypes` (`WebhookEndpointService.ts:83-90`): order is preserved, unknown
/// types are rejected together, and an empty filter means "all events".
pub fn parse_event_filter(types: &[&str]) -> Result<Vec<WebhookEventType>, WebhookConfigError> {
    let mut parsed: Vec<WebhookEventType> = Vec::new();
    let mut unknown: Vec<&str> = Vec::new();
    for raw in types {
        match WebhookEventType::parse_subscription(raw) {
            Some(event) => {
                if !parsed.contains(&event) {
                    parsed.push(event);
                }
            }
            None => {
                if !unknown.contains(raw) {
                    unknown.push(raw);
                }
            }
        }
    }
    if !unknown.is_empty() {
        return Err(WebhookConfigError::UnknownEventType(unknown.join(", ")));
    }
    Ok(parsed)
}

/// Whether an endpoint's filter accepts an event.
///
/// Port of the fan-out filter (`engine/webhooks/fanout.ts:108-109`): an empty filter accepts
/// everything and the test event ignores the filter because it targets one endpoint.
#[must_use]
pub fn endpoint_accepts_event(filter: &[WebhookEventType], event: WebhookEventType) -> bool {
    if event.is_test() {
        return true;
    }
    filter.is_empty() || filter.contains(&event)
}

/// Enforce the per-application endpoint limit.
///
/// Port of `existing >= limit` (`WebhookEndpointService.ts:149-151`); a zero limit therefore
/// rejects every endpoint, as it does in TS.
pub fn ensure_endpoint_capacity(existing: usize, limit: usize) -> Result<(), WebhookLimitError> {
    if existing >= limit {
        Err(WebhookLimitError::EndpointLimit { limit })
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_retry_schedule_is_the_ts_schedule() {
        let policy = WebhookRetryPolicy::default();
        assert_eq!(policy.max_attempts, 8);
        assert_eq!(policy.jitter_percent, 20);
        assert_eq!(policy.disable_after_ms, 432_000_000);

        // Sample 5_000 is the exact base delay (no jitter).
        let expected = [
            5_000_u64, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000,
        ];
        for (index, base) in expected.iter().enumerate() {
            let attempt = u32::try_from(index + 1).expect("attempt");
            assert_eq!(policy.delay_after_attempt(attempt, 5_000), *base);
        }
        // Attempt 0 is defensive and behaves like attempt 1.
        assert_eq!(policy.delay_after_attempt(0, 5_000), 5_000);
        // Attempt 8 is exhausted and has no next instant.
        assert!(policy.is_exhausted(8));
        assert_eq!(policy.next_attempt_at(1_000, 8, 5_000), None);
        assert_eq!(policy.next_attempt_at(1_000, 1, 5_000), Some(1_000 + 5_000));
        assert_eq!(policy.next_attempt_at(0, 7, 5_000), Some(36_000_000));
    }

    #[test]
    fn jitter_stays_within_twenty_percent() {
        let policy = WebhookRetryPolicy::default();
        let base = 300_000_u64;
        assert_eq!(policy.delay_after_attempt(2, 0), base - base / 5);
        assert_eq!(policy.delay_after_attempt(2, 10_000), base + base / 5);
        assert_eq!(policy.delay_after_attempt(2, 2_500), base - base / 10);
        assert_eq!(policy.delay_after_attempt(2, 7_500), base + base / 10);
        assert_eq!(policy.delay_after_attempt(2, 5_000), base);
        // Out-of-range samples clamp.
        assert_eq!(policy.delay_after_attempt(2, 50_000), base + base / 5);

        let no_jitter = WebhookRetryPolicy {
            jitter_percent: 0,
            ..WebhookRetryPolicy::default()
        };
        assert_eq!(no_jitter.delay_after_attempt(2, 0), base);
        assert_eq!(no_jitter.delay_after_attempt(2, 10_000), base);
    }

    #[test]
    fn an_endpoint_failing_for_five_days_is_disabled() {
        let policy = WebhookRetryPolicy::default();
        assert!(!policy.should_disable(None, 1_000_000_000));
        assert!(!policy.should_disable(Some(0), WEBHOOK_DISABLE_AFTER_MS - 1));
        assert!(policy.should_disable(Some(0), WEBHOOK_DISABLE_AFTER_MS));
        assert!(policy.should_disable(Some(0), WEBHOOK_DISABLE_AFTER_MS + 1));
        // A future `failing_since` (clock skew) is not a five-day failure.
        assert!(!policy.should_disable(Some(2_000), 1_000));
    }

    #[test]
    fn event_types_round_trip_and_the_test_event_is_not_subscribable() {
        assert_eq!(WebhookEventType::all().len(), 10);
        assert_eq!(WebhookEventType::subscribable().len(), 9);
        for event in WebhookEventType::all() {
            assert_eq!(WebhookEventType::parse(event.as_str()), Some(event));
        }
        assert_eq!(
            WebhookEventType::parse("payment.succeeded"),
            Some(WebhookEventType::PaymentSucceeded)
        );
        assert_eq!(
            WebhookEventType::parse("webhook.test"),
            Some(WebhookEventType::WebhookTest)
        );
        assert_eq!(WebhookEventType::parse_subscription("webhook.test"), None);
        assert_eq!(
            WebhookEventType::parse_subscription("payment.refunded"),
            Some(WebhookEventType::PaymentRefunded)
        );
        assert_eq!(WebhookEventType::parse("refund.created"), None);
        assert!(WebhookEventType::WebhookTest.is_test());
    }

    #[test]
    fn event_filters_deduplicate_and_reject_unknown_types() {
        let filter =
            parse_event_filter(&["payment.succeeded", "payment.failed", "payment.succeeded"])
                .expect("filter");
        assert_eq!(
            filter,
            vec![
                WebhookEventType::PaymentSucceeded,
                WebhookEventType::PaymentFailed
            ]
        );

        let error =
            parse_event_filter(&["payment.succeeded", "nope", "also-nope"]).expect_err("unknown");
        assert_eq!(error.code(), "WEBHOOK_EVENT_TYPE_UNKNOWN");
        assert_eq!(
            error,
            WebhookConfigError::UnknownEventType("nope, also-nope".to_owned())
        );
        assert!(error.to_string().contains("nope, also-nope"));

        assert_eq!(
            parse_event_filter(&["webhook.test"]).expect_err("test event"),
            WebhookConfigError::UnknownEventType("webhook.test".to_owned())
        );
        assert!(parse_event_filter(&[]).expect("empty").is_empty());
    }

    #[test]
    fn an_empty_filter_accepts_everything_and_the_test_event_ignores_the_filter() {
        let filter = [WebhookEventType::PaymentSucceeded];
        assert!(endpoint_accepts_event(&[], WebhookEventType::PaymentFailed));
        assert!(endpoint_accepts_event(
            &filter,
            WebhookEventType::PaymentSucceeded
        ));
        assert!(!endpoint_accepts_event(
            &filter,
            WebhookEventType::PaymentFailed
        ));
        assert!(endpoint_accepts_event(&[], WebhookEventType::WebhookTest));
        assert!(endpoint_accepts_event(
            &filter,
            WebhookEventType::WebhookTest
        ));
    }

    #[test]
    fn the_endpoint_limit_is_five_per_application() {
        assert_eq!(WEBHOOK_ENDPOINTS_PER_APPLICATION, 5);
        for existing in 0..5 {
            assert!(
                ensure_endpoint_capacity(existing, WEBHOOK_ENDPOINTS_PER_APPLICATION).is_ok(),
                "{existing}"
            );
        }
        assert_eq!(
            ensure_endpoint_capacity(5, WEBHOOK_ENDPOINTS_PER_APPLICATION)
                .expect_err("limit")
                .to_string(),
            "An application can have at most 5 webhook endpoints"
        );
        assert!(ensure_endpoint_capacity(0, 0).is_err());
    }
}
