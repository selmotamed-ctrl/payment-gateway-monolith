//! Upstream failures and the edge-facing `CORE_*` error codes.
//!
//! Port of `{admin,merchant,checkout}-back/lib/coreInternalClient.ts:104-258`: the
//! `STATUS_FALLBACKS` table, `TLS_ERROR_CODES`, `NODE_FAILURE_CODES`, `mapCoreTransportError`
//! and `coreUnavailable`.
//!
//! The classification matters for health: only failures that prove the *transport* to a node is
//! broken may eject it. A local pre-flight failure (invalid header characters, an oversized
//! response, a client abort) is mapped to an error but must never trip the circuit breaker.

#![forbid(unsafe_code)]

use std::fmt;

/// A failure that happened before an HTTP response arrived.
///
/// Port of `coreInternalClient.ts:123-258` (`TLS_ERROR_CODES`, `NODE_FAILURE_CODES`,
/// `mapCoreTransportError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportFailure {
    /// `ETIMEDOUT` / `ESOCKETTIMEDOUT`.
    Timeout,
    /// `ECONNREFUSED`.
    ConnectionRefused,
    /// `ECONNRESET` / `EPIPE`.
    ConnectionReset,
    /// `EHOSTUNREACH` / `ENETUNREACH`, and an unclassified connect error.
    Unreachable,
    /// `ENOTFOUND` / `EAI_AGAIN`.
    Dns,
    /// A member of `TLS_ERROR_CODES` (handshake, certificate, protocol version).
    Tls,
    /// Anything else (a local error, an abort, a decoding failure).
    Other,
}

impl TransportFailure {
    /// Whether this failure says something about the health of the node it happened on.
    ///
    /// Port of `coreInternalClient.ts:142-160`. `Other` never counts: TS only counts the explicit
    /// `NODE_FAILURE_CODES` set, and a local error carries no information about core.
    #[must_use]
    pub fn counts_against_node(self) -> bool {
        !matches!(self, Self::Other)
    }

    /// Classify a message or an error-chain text.
    ///
    /// TS switches on Node's stable `error.code`; Rust's `reqwest`/`hyper` chain does not expose
    /// the underlying OS error as a typed value, so the only portable signal is the chain text.
    /// TLS and DNS are checked before the generic timeout/connect words because a
    /// `TLS handshake timeout` is a TLS failure and not a plain timeout in the TS table.
    #[must_use]
    pub fn from_message(message: &str) -> Self {
        let lower = message.to_ascii_lowercase();
        if lower.contains("tls")
            || lower.contains("ssl")
            || lower.contains("certificate")
            || lower.contains("handshake")
            || lower.contains("invalid peer certificate")
            || lower.contains("unknown issuer")
        {
            return Self::Tls;
        }
        if lower.contains("dns")
            || lower.contains("name or service not known")
            || lower.contains("nodename nor servname")
            || lower.contains("failed to lookup address")
            || lower.contains("no such host")
            || lower.contains("servfail")
        {
            return Self::Dns;
        }
        if lower.contains("timed out") || lower.contains("timeout") {
            return Self::Timeout;
        }
        if lower.contains("connection refused") || lower.contains("econnrefused") {
            return Self::ConnectionRefused;
        }
        if lower.contains("connection reset")
            || lower.contains("connection aborted")
            || lower.contains("broken pipe")
            || lower.contains("econnreset")
            || lower.contains("epipe")
        {
            return Self::ConnectionReset;
        }
        if lower.contains("network is unreachable")
            || lower.contains("host is unreachable")
            || lower.contains("no route to host")
            || lower.contains("unreachable")
        {
            return Self::Unreachable;
        }
        Self::Other
    }

    /// Classify a `reqwest` error, walking its source chain for the cause text.
    ///
    /// Port of `coreInternalClient.ts:232-258`. `reqwest` collapses DNS, refused, reset and TLS
    /// handshake failures into one `is_connect()` flag, so the chain is inspected. A connect
    /// error whose cause cannot be identified is `Unreachable` (`CORE_UNREACHABLE`), which is the
    /// TS answer for `EHOSTUNREACH` and the closest transport-level statement available.
    #[must_use]
    pub fn from_reqwest(error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            return Self::Timeout;
        }
        if error.is_connect() {
            return match Self::from_message(&error_chain_text(error)) {
                Self::Other => Self::Unreachable,
                other => other,
            };
        }
        Self::from_message(&error.to_string())
    }
}

fn error_chain_text(error: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(current) = source {
        text.push_str(": ");
        text.push_str(&current.to_string());
        source = current.source();
    }
    text
}

/// The `{status, code, message}` an edge returns when it could not reach core.
///
/// Port of `coreInternalClient.ts:232-258` and the `coreUnavailable` helper (`:453`). The message
/// strings are the TS ones so clients that match them keep working.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolError {
    status: u16,
    code: &'static str,
    message: String,
}

impl PoolError {
    #[must_use]
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    /// `504 CORE_TIMEOUT` — `ETIMEDOUT`/`ESOCKETTIMEDOUT`.
    #[must_use]
    pub fn timeout() -> Self {
        Self::new(
            504,
            "CORE_TIMEOUT",
            "Core service did not respond before the deadline",
        )
    }

    /// `502 CORE_UNREACHABLE` — refused, reset, pipe or host unreachable.
    #[must_use]
    pub fn unreachable() -> Self {
        Self::new(502, "CORE_UNREACHABLE", "Core service is unreachable")
    }

    /// `502 CORE_DNS_FAILURE` — `ENOTFOUND`/`EAI_AGAIN`.
    #[must_use]
    pub fn dns_failure() -> Self {
        Self::new(
            502,
            "CORE_DNS_FAILURE",
            "Core service hostname could not be resolved",
        )
    }

    /// `502 CORE_TLS_ERROR` — a mTLS handshake failure.
    #[must_use]
    pub fn tls_error() -> Self {
        Self::new(
            502,
            "CORE_TLS_ERROR",
            "Mutual TLS handshake with core service failed",
        )
    }

    /// `502 CORE_CONNECTION_ERROR` — anything else.
    #[must_use]
    pub fn connection_error() -> Self {
        Self::new(502, "CORE_CONNECTION_ERROR", "Failed to reach core service")
    }

    /// `502 CORE_RESPONSE_TOO_LARGE` — the buffered response exceeded `CORE_MAX_RESPONSE_BYTES`.
    #[must_use]
    pub fn response_too_large(limit: u64) -> Self {
        Self::new(
            502,
            "CORE_RESPONSE_TOO_LARGE",
            format!("Core response exceeded the edge size limit of {limit} bytes"),
        )
    }

    /// `502 CORE_BAD_GATEWAY` — core (or its proxy) answered 502 without an envelope.
    #[must_use]
    pub fn bad_gateway() -> Self {
        Self::new(
            502,
            "CORE_BAD_GATEWAY",
            "Core service returned an invalid response",
        )
    }

    /// `504 CORE_GATEWAY_TIMEOUT` — core (or its proxy) answered 504 without an envelope.
    #[must_use]
    pub fn gateway_timeout() -> Self {
        Self::new(
            504,
            "CORE_GATEWAY_TIMEOUT",
            "Core service did not respond in time",
        )
    }

    /// `503 CORE_UNAVAILABLE` — no node is eligible (all ejected, or none configured).
    #[must_use]
    pub fn unavailable() -> Self {
        Self::new(
            503,
            "CORE_UNAVAILABLE",
            "Core service is temporarily unavailable",
        )
    }

    /// `503 SANDBOX_NODE_UNAVAILABLE` — the Sandbox pool is not configured.
    ///
    /// Port of `{admin,merchant,checkout}-back/lib/corePools.ts`. The Sandbox plane never falls
    /// back to the Live pool.
    #[must_use]
    pub fn sandbox_unavailable() -> Self {
        Self::new(
            503,
            "SANDBOX_NODE_UNAVAILABLE",
            "The Sandbox environment is not configured on this gateway",
        )
    }

    /// `500 CORE_PATH_INVALID` — a caller passed a path that is not a rooted core path.
    #[must_use]
    pub fn path_invalid(message: impl Into<String>) -> Self {
        Self::new(500, "CORE_PATH_INVALID", message)
    }

    /// `403 CORE_CHANNEL_VIOLATION` — the path is outside the edge's channel prefixes.
    #[must_use]
    pub fn channel_violation(message: impl Into<String>) -> Self {
        Self::new(403, "CORE_CHANNEL_VIOLATION", message)
    }

    /// `400 CORE_HEADER_INVALID` — a forwarded header name or value is not printable ASCII.
    #[must_use]
    pub fn header_invalid() -> Self {
        Self::new(
            400,
            "CORE_HEADER_INVALID",
            "A forwarded header contains invalid characters",
        )
    }

    /// `400 INVALID_MIN_LSN` — the admin edge received a malformed `x-pg-min-lsn`.
    #[must_use]
    pub fn invalid_min_lsn() -> Self {
        Self::new(
            400,
            "INVALID_MIN_LSN",
            "x-pg-min-lsn must look like <hex>/<hex>",
        )
    }

    /// `500 CORE_CONFIG_INVALID` — the configured pool URL cannot be used.
    ///
    /// TS throws a `TypeError` from `new URL(baseUrl)` in that case, which surfaces as a 502
    /// `CORE_CONNECTION_ERROR`. Configuration is validated at boot here, so reaching this is a
    /// programming error; DEV note recorded in the crate report.
    #[must_use]
    pub fn config_invalid(message: impl Into<String>) -> Self {
        Self::new(500, "CORE_CONFIG_INVALID", message)
    }

    /// Map a transport failure to the TS status/code pair.
    #[must_use]
    pub fn from_transport(failure: TransportFailure) -> Self {
        match failure {
            TransportFailure::Timeout => Self::timeout(),
            TransportFailure::ConnectionRefused
            | TransportFailure::ConnectionReset
            | TransportFailure::Unreachable => Self::unreachable(),
            TransportFailure::Dns => Self::dns_failure(),
            TransportFailure::Tls => Self::tls_error(),
            TransportFailure::Other => Self::connection_error(),
        }
    }

    #[must_use]
    pub fn status(&self) -> u16 {
        self.status
    }

    #[must_use]
    pub fn code(&self) -> &'static str {
        self.code
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for PoolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for PoolError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_mapping_matches_the_ts_table() {
        assert_eq!(
            PoolError::from_transport(TransportFailure::Timeout).status(),
            504
        );
        assert_eq!(
            PoolError::from_transport(TransportFailure::Timeout).code(),
            "CORE_TIMEOUT"
        );
        assert_eq!(
            PoolError::from_transport(TransportFailure::ConnectionRefused).code(),
            "CORE_UNREACHABLE"
        );
        assert_eq!(
            PoolError::from_transport(TransportFailure::ConnectionReset).status(),
            502
        );
        assert_eq!(
            PoolError::from_transport(TransportFailure::Unreachable).code(),
            "CORE_UNREACHABLE"
        );
        assert_eq!(
            PoolError::from_transport(TransportFailure::Dns).code(),
            "CORE_DNS_FAILURE"
        );
        assert_eq!(
            PoolError::from_transport(TransportFailure::Tls).code(),
            "CORE_TLS_ERROR"
        );
        assert_eq!(
            PoolError::from_transport(TransportFailure::Other).code(),
            "CORE_CONNECTION_ERROR"
        );
    }

    #[test]
    fn only_transport_failures_count_against_a_node() {
        assert!(TransportFailure::Timeout.counts_against_node());
        assert!(TransportFailure::Tls.counts_against_node());
        assert!(TransportFailure::Dns.counts_against_node());
        assert!(!TransportFailure::Other.counts_against_node());
    }

    #[test]
    fn message_classification_matches_node_error_codes() {
        assert_eq!(
            TransportFailure::from_message("TLS handshake timeout"),
            TransportFailure::Tls
        );
        assert_eq!(
            TransportFailure::from_message("dns error: failed to lookup address information"),
            TransportFailure::Dns
        );
        assert_eq!(
            TransportFailure::from_message("operation timed out"),
            TransportFailure::Timeout
        );
        assert_eq!(
            TransportFailure::from_message("tcp connect error: Connection refused (os error 111)"),
            TransportFailure::ConnectionRefused
        );
        assert_eq!(
            TransportFailure::from_message("connection reset by peer"),
            TransportFailure::ConnectionReset
        );
        assert_eq!(
            TransportFailure::from_message("No route to host"),
            TransportFailure::Unreachable
        );
        assert_eq!(
            TransportFailure::from_message("invalid header value"),
            TransportFailure::Other
        );
    }

    #[test]
    fn edge_error_codes_and_statuses() {
        let unavailable = PoolError::unavailable();
        assert_eq!(unavailable.status(), 503);
        assert_eq!(unavailable.code(), "CORE_UNAVAILABLE");

        let sandbox = PoolError::sandbox_unavailable();
        assert_eq!(sandbox.status(), 503);
        assert_eq!(sandbox.code(), "SANDBOX_NODE_UNAVAILABLE");

        assert_eq!(PoolError::response_too_large(64).status(), 502);
        assert_eq!(PoolError::bad_gateway().status(), 502);
        assert_eq!(PoolError::gateway_timeout().status(), 504);
        assert_eq!(PoolError::header_invalid().status(), 400);
        assert_eq!(PoolError::invalid_min_lsn().code(), "INVALID_MIN_LSN");
        assert_eq!(PoolError::channel_violation("no").status(), 403);
        assert_eq!(PoolError::path_invalid("no").code(), "CORE_PATH_INVALID");
    }

    #[test]
    fn display_contains_status_code_and_message() {
        let rendered = PoolError::timeout().to_string();
        assert!(rendered.starts_with("504 CORE_TIMEOUT: "));
    }
}
