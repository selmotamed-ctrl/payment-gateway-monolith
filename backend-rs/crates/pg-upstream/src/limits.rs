//! Request deadlines and the response-size cap.
//!
//! Port of the `CORE_REQUEST_TIMEOUT_MS`, `CORE_TOTAL_DEADLINE_MS` and `CORE_MAX_RESPONSE_BYTES`
//! handling in `{admin,merchant,checkout}-back/lib/coreInternalClient.ts:598-599`, `:637-645` and
//! the env defaults (`admin-back/lib/env/index.ts:24-37`).

#![forbid(unsafe_code)]

use crate::error::PoolError;
use crate::path::EdgeChannel;

/// Per-call limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Idle timeout of one attempt (admin 60 s, merchant/checkout 30 s).
    pub request_timeout_ms: u64,
    /// Wall-clock budget of the whole buffered call.
    pub total_deadline_ms: u64,
    /// Maximum buffered response body.
    pub max_response_bytes: u64,
}

impl Limits {
    /// `CORE_TOTAL_DEADLINE_MS` default.
    pub const DEFAULT_TOTAL_DEADLINE_MS: u64 = 300_000;
    /// `CORE_MAX_RESPONSE_BYTES` default (64 MiB).
    pub const DEFAULT_MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
    /// `CORE_REQUEST_TIMEOUT_MS` default for `admin-back`.
    pub const ADMIN_REQUEST_TIMEOUT_MS: u64 = 60_000;
    /// `CORE_REQUEST_TIMEOUT_MS` default for `merchant-back` and `checkout-back`.
    pub const EDGE_REQUEST_TIMEOUT_MS: u64 = 30_000;

    #[must_use]
    pub fn for_channel(channel: EdgeChannel) -> Self {
        Self {
            request_timeout_ms: match channel {
                EdgeChannel::Admin => Self::ADMIN_REQUEST_TIMEOUT_MS,
                EdgeChannel::Merchant | EdgeChannel::Checkout => Self::EDGE_REQUEST_TIMEOUT_MS,
            },
            total_deadline_ms: Self::DEFAULT_TOTAL_DEADLINE_MS,
            max_response_bytes: Self::DEFAULT_MAX_RESPONSE_BYTES,
        }
    }

    /// The deadline TS arms: `max(CORE_TOTAL_DEADLINE_MS, timeoutMs)`
    /// (`coreInternalClient.ts:598`).
    #[must_use]
    pub fn effective_deadline_ms(&self, request_timeout_ms: Option<u64>) -> u64 {
        self.total_deadline_ms
            .max(request_timeout_ms.unwrap_or(self.request_timeout_ms))
    }

    /// Reject a declared `content-length` above the cap before reading the body.
    pub fn check_declared_length(&self, declared: Option<u64>) -> Result<(), PoolError> {
        match declared {
            Some(length) if length > self.max_response_bytes => {
                Err(PoolError::response_too_large(self.max_response_bytes))
            }
            _ => Ok(()),
        }
    }

    /// Reject a running total above the cap.
    ///
    /// Port of the `received > maxBytes` branch (`coreInternalClient.ts:637-645`); the executor
    /// must settle the call as an error before a trailing `end` can resolve it.
    pub fn check_received(&self, received: u64) -> Result<(), PoolError> {
        if received > self.max_response_bytes {
            Err(PoolError::response_too_large(self.max_response_bytes))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_defaults_match_the_deploy_environment() {
        let admin = Limits::for_channel(EdgeChannel::Admin);
        assert_eq!(admin.request_timeout_ms, 60_000);
        assert_eq!(admin.total_deadline_ms, 300_000);
        assert_eq!(admin.max_response_bytes, 67_108_864);

        assert_eq!(
            Limits::for_channel(EdgeChannel::Merchant).request_timeout_ms,
            30_000
        );
        assert_eq!(
            Limits::for_channel(EdgeChannel::Checkout).request_timeout_ms,
            30_000
        );
    }

    #[test]
    fn deadline_is_the_larger_of_the_total_and_the_call_timeout() {
        let limits = Limits::for_channel(EdgeChannel::Merchant);
        assert_eq!(limits.effective_deadline_ms(None), 300_000);
        assert_eq!(limits.effective_deadline_ms(Some(1_000)), 300_000);
        assert_eq!(limits.effective_deadline_ms(Some(900_000)), 900_000);
    }

    #[test]
    fn response_cap_is_enforced_declared_and_streamed() {
        let limits = Limits {
            request_timeout_ms: 30_000,
            total_deadline_ms: 300_000,
            max_response_bytes: 1_024,
        };
        assert!(limits.check_declared_length(None).is_ok());
        assert!(limits.check_declared_length(Some(1_024)).is_ok());
        let error = limits
            .check_declared_length(Some(1_025))
            .expect_err("declared");
        assert_eq!(error.code(), "CORE_RESPONSE_TOO_LARGE");
        assert_eq!(error.status(), 502);

        assert!(limits.check_received(1_024).is_ok());
        assert_eq!(
            limits.check_received(1_025).expect_err("received").code(),
            "CORE_RESPONSE_TOO_LARGE"
        );
    }
}
