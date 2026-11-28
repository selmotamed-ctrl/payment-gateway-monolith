//! Egress policy failures.
//!
//! Port of `WebhookEgressError` (`core-back/lib/webhooks/egress.ts:14-19`) and the URL errors of
//! `compileUrl.ts` (`urlError`, `validateFinalUrl`). Every variant carries the TS code string and
//! whether a delivery may be retried for it. Codes match the TS ones where they exist, because the
//! merchant portal renders `WEBHOOK_<code>`.
//!
//! [`GatewayError`] is the error of the gateway HTTP executor ([`crate::executor`]). The TS
//! `ApiConsumerError` has no `code` field, so the executor uses a stable `API_*` family for
//! transport/config failures and keeps the `EgressError` codes (the `compileUrl`/SSRF ones) for a
//! refused destination.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::body::BodyError;
use crate::credentials::AuthError;

/// A refused or failed outbound request.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EgressError {
    #[error("The URL is empty or too long")]
    InvalidUrl,
    #[error("The URL contains whitespace, control characters or an encoded path separator")]
    InvalidUrlCharacters,
    #[error("URL path contains a traversal segment")]
    InvalidUrlPath,
    #[error("The URL is not valid")]
    MalformedUrl,
    #[error("Only HTTPS endpoints are allowed")]
    InsecureScheme,
    #[error("URL credentials are not allowed")]
    UrlUserinfo,
    #[error("URL fragments are not allowed")]
    UrlFragment,
    #[error("No outbound host allowlist is configured; refusing the request")]
    HostAllowlistEmpty,
    #[error("URL host '{0}' is not allowed")]
    HostNotAllowed(String),
    #[error("Port {0} is not allowed")]
    PortNotAllowed(u16),
    #[error("Private, loopback and link-local addresses are not allowed")]
    PrivateHost,
    #[error("The host '{0}' did not resolve")]
    DnsFailure(String),
    #[error("Gateway response exceeds {limit} bytes")]
    ResponseTooLarge { limit: u64 },
    #[error("Gateway redirects are forbidden")]
    RedirectForbidden,
    #[error("The endpoint did not answer in time")]
    Timeout,
    #[error("Connection failed: {0}")]
    Network(String),
}

impl EgressError {
    /// The TS error code (`WebhookEgressError.code` / `compileUrl` codes).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidUrl | Self::MalformedUrl => "INVALID_URL",
            Self::InvalidUrlCharacters => "INVALID_URL",
            Self::InvalidUrlPath => "INVALID_URL_PATH",
            Self::InsecureScheme => "INSECURE_URL",
            Self::UrlUserinfo => "URL_USERINFO",
            Self::UrlFragment => "URL_FRAGMENT",
            Self::HostAllowlistEmpty => "HOST_ALLOWLIST_EMPTY",
            Self::HostNotAllowed(_) => "HOST_NOT_ALLOWED",
            Self::PortNotAllowed(_) => "PORT_NOT_ALLOWED",
            Self::PrivateHost => "PRIVATE_HOST",
            Self::DnsFailure(_) => "DNS_FAILURE",
            Self::ResponseTooLarge { .. } => "RESPONSE_TOO_LARGE",
            Self::RedirectForbidden => "REDIRECT_FORBIDDEN",
            Self::Timeout => "TIMEOUT",
            Self::Network(_) => "NETWORK",
        }
    }

    /// Whether the same request may be sent again later.
    ///
    /// Port of the `retryable` flags in `webhooks/egress.ts` and `ApiConsumer.ts`: only a DNS
    /// failure, a timeout and a network error are transient; every policy refusal is permanent.
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(self, Self::DnsFailure(_) | Self::Timeout | Self::Network(_))
    }

    /// Truncate a transport message to the 300 characters TS keeps
    /// (`webhooks/egress.ts:169`).
    #[must_use]
    pub fn network(message: impl Into<String>) -> Self {
        let message = message.into();
        Self::Network(message.chars().take(300).collect())
    }

    #[must_use]
    pub fn dns_failure(host: impl Into<String>) -> Self {
        Self::DnsFailure(host.into())
    }
}

/// A failed gateway call.
///
/// Port of `ApiConsumerError` (`core-back/engine/apiConsumer/ApiConsumer.ts:134-159`) plus the
/// policy errors of [`EgressError`]. `money_uncertain` marks a transport failure of a money-moving
/// step: the gateway may have processed the request, so the attempt must not be retried blindly.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum GatewayError {
    #[error("{0}")]
    Egress(#[from] EgressError),
    #[error("{0}")]
    Auth(#[from] AuthError),
    #[error("{0}")]
    Body(#[from] BodyError),
    #[error("Gateway returned HTTP {status}")]
    Http {
        status: u16,
        raw_text: String,
        data: Value,
    },
    #[error("{message}")]
    Transport {
        message: String,
        timeout: bool,
        money_uncertain: bool,
    },
    #[error("Gateway response exceeds {limit} bytes")]
    TooLarge { limit: u64, status: Option<u16> },
    #[error("Gateway redirects are forbidden")]
    Redirect { status: u16 },
    #[error("Gateway JSON response exceeds depth {limit}")]
    JsonDepth {
        limit: usize,
        status: u16,
        raw_text: String,
    },
    #[error("XML DTD and external entities are forbidden")]
    XmlDtd { status: u16, raw_text: String },
    #[error("{message}")]
    InvalidJson {
        message: String,
        status: u16,
        raw_text: String,
    },
    #[error("CR, LF, or NUL is forbidden in {label}")]
    HeaderInjection { label: &'static str },
    #[error("{0}")]
    InvalidRequest(String),
}

impl GatewayError {
    /// The error code surfaced to callers.
    ///
    /// The `compileUrl`/SSRF codes keep their TS spelling so the admin UI can explain a refused
    /// destination; transport and response failures use the `API_*` family because TS throws an
    /// `ApiConsumerError` without a code for those.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Egress(error) => error.code(),
            Self::Auth(error) => error.code(),
            Self::Body(error) => error.code(),
            Self::Http { .. } => "API_HTTP_ERROR",
            Self::Transport { timeout: true, .. } => "API_TIMEOUT",
            Self::Transport { timeout: false, .. } => "API_NETWORK_ERROR",
            Self::TooLarge { .. } => "API_RESPONSE_TOO_LARGE",
            Self::Redirect { .. } => "API_REDIRECT_FORBIDDEN",
            Self::JsonDepth { .. } => "API_JSON_DEPTH_EXCEEDED",
            Self::XmlDtd { .. } => "API_XML_DTD_FORBIDDEN",
            Self::InvalidJson { .. } => "API_INVALID_JSON",
            Self::HeaderInjection { .. } => "HEADER_INJECTION_BLOCKED",
            Self::InvalidRequest(_) => "API_REQUEST_INVALID",
        }
    }

    /// Whether the same request may be sent again (`retryable` in `ApiConsumerError`).
    #[must_use]
    pub fn retryable(&self) -> bool {
        match self {
            Self::Egress(error) => error.retryable(),
            Self::Http { status, .. } => *status >= 500,
            Self::Transport { .. } => true,
            _ => false,
        }
    }

    /// The money may have moved even though the call failed (`moneyUncertain` in TS).
    #[must_use]
    pub fn money_uncertain(&self) -> bool {
        match self {
            Self::Transport {
                money_uncertain, ..
            } => *money_uncertain,
            _ => false,
        }
    }

    /// The HTTP status, when the gateway answered.
    #[must_use]
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Http { status, .. }
            | Self::JsonDepth { status, .. }
            | Self::XmlDtd { status, .. }
            | Self::InvalidJson { status, .. }
            | Self::Redirect { status } => Some(*status),
            Self::TooLarge { status, .. } => *status,
            _ => None,
        }
    }

    /// The exact answer the gateway sent (TS `rawText`).
    #[must_use]
    pub fn raw_text(&self) -> Option<&str> {
        match self {
            Self::Http { raw_text, .. }
            | Self::JsonDepth { raw_text, .. }
            | Self::XmlDtd { raw_text, .. }
            | Self::InvalidJson { raw_text, .. } => Some(raw_text),
            _ => None,
        }
    }

    /// The parsed answer body (TS `data`).
    #[must_use]
    pub fn data(&self) -> Option<&Value> {
        match self {
            Self::Http { data, .. } => Some(data),
            _ => None,
        }
    }

    /// Whether the failure is an authentication rejection (`isAuthenticationError` in TS).
    ///
    /// Only a 401/403 answer counts; a configuration error (`GatewayError::Auth`) is a different
    /// condition and must not trigger a token refresh.
    #[must_use]
    pub fn is_authentication_error(&self) -> bool {
        matches!(self.status(), Some(401 | 403))
    }
}

impl From<GatewayError> for EgressError {
    fn from(error: GatewayError) -> Self {
        match error {
            GatewayError::Egress(inner) => inner,
            other => EgressError::Network(other.to_string().chars().take(300).collect()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_match_the_merchant_portal_contract() {
        assert_eq!(EgressError::InvalidUrl.code(), "INVALID_URL");
        assert_eq!(EgressError::InvalidUrlPath.code(), "INVALID_URL_PATH");
        assert_eq!(EgressError::InsecureScheme.code(), "INSECURE_URL");
        assert_eq!(EgressError::UrlUserinfo.code(), "URL_USERINFO");
        assert_eq!(EgressError::UrlFragment.code(), "URL_FRAGMENT");
        assert_eq!(EgressError::PrivateHost.code(), "PRIVATE_HOST");
        assert_eq!(
            EgressError::dns_failure("example.test").code(),
            "DNS_FAILURE"
        );
        assert_eq!(EgressError::Timeout.code(), "TIMEOUT");
        assert_eq!(EgressError::network("broken").code(), "NETWORK");
    }

    #[test]
    fn only_transient_failures_are_retryable() {
        for error in [
            EgressError::InvalidUrl,
            EgressError::InsecureScheme,
            EgressError::UrlUserinfo,
            EgressError::UrlFragment,
            EgressError::HostAllowlistEmpty,
            EgressError::HostNotAllowed("x".to_owned()),
            EgressError::PortNotAllowed(8443),
            EgressError::PrivateHost,
            EgressError::ResponseTooLarge { limit: 4 },
            EgressError::RedirectForbidden,
        ] {
            assert!(!error.retryable(), "{error}");
        }
        assert!(EgressError::dns_failure("x").retryable());
        assert!(EgressError::Timeout.retryable());
        assert!(EgressError::network("reset").retryable());
    }

    #[test]
    fn network_messages_are_capped() {
        let long = "x".repeat(500);
        match EgressError::network(long) {
            EgressError::Network(message) => assert_eq!(message.len(), 300),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn gateway_error_codes_cover_policy_auth_transport_and_http() {
        let policy = GatewayError::from(EgressError::PrivateHost);
        assert_eq!(policy.code(), "PRIVATE_HOST");
        assert!(!policy.retryable());
        assert_eq!(policy.status(), None);

        let auth = GatewayError::from(AuthError::ApiKeyMissing);
        assert_eq!(auth.code(), "API_KEY_CREDENTIAL_MISSING");
        assert!(!auth.retryable());
        assert!(!auth.is_authentication_error());

        let timeout = GatewayError::Transport {
            message: "Gateway request timed out".to_owned(),
            timeout: true,
            money_uncertain: true,
        };
        assert_eq!(timeout.code(), "API_TIMEOUT");
        assert!(timeout.retryable());
        assert!(timeout.money_uncertain());

        let network = GatewayError::Transport {
            message: "connection refused".to_owned(),
            timeout: false,
            money_uncertain: false,
        };
        assert_eq!(network.code(), "API_NETWORK_ERROR");
        assert!(network.retryable());

        let http = GatewayError::Http {
            status: 503,
            raw_text: "busy".to_owned(),
            data: serde_json::json!({ "code": "busy" }),
        };
        assert_eq!(http.code(), "API_HTTP_ERROR");
        assert!(http.retryable());
        assert_eq!(http.status(), Some(503));
        assert_eq!(http.raw_text(), Some("busy"));
        assert_eq!(http.data(), Some(&serde_json::json!({ "code": "busy" })));

        let refused = GatewayError::Http {
            status: 401,
            raw_text: String::new(),
            data: Value::Null,
        };
        assert!(!refused.retryable());
        assert!(refused.is_authentication_error());

        assert_eq!(
            GatewayError::TooLarge {
                limit: 10,
                status: Some(200)
            }
            .code(),
            "API_RESPONSE_TOO_LARGE"
        );
        assert_eq!(
            GatewayError::Redirect { status: 302 }.code(),
            "API_REDIRECT_FORBIDDEN"
        );
        assert_eq!(
            GatewayError::JsonDepth {
                limit: 64,
                status: 200,
                raw_text: "{}".to_owned()
            }
            .code(),
            "API_JSON_DEPTH_EXCEEDED"
        );
        assert_eq!(
            GatewayError::XmlDtd {
                status: 200,
                raw_text: "<!DOCTYPE x>".to_owned()
            }
            .code(),
            "API_XML_DTD_FORBIDDEN"
        );
        assert_eq!(
            GatewayError::HeaderInjection { label: "header" }.code(),
            "HEADER_INJECTION_BLOCKED"
        );
        assert_eq!(
            GatewayError::InvalidRequest("x".to_owned()).code(),
            "API_REQUEST_INVALID"
        );
        assert_eq!(
            GatewayError::InvalidJson {
                message: "expected value".to_owned(),
                status: 200,
                raw_text: "{".to_owned()
            }
            .code(),
            "API_INVALID_JSON"
        );
    }

    #[test]
    fn a_gateway_error_downgrades_to_an_egress_error_without_losing_the_message() {
        let error: EgressError = GatewayError::Redirect { status: 302 }.into();
        assert_eq!(error.code(), "NETWORK");
        assert!(error.retryable());
        let original = EgressError::HostNotAllowed("x".to_owned());
        let round_trip: EgressError = GatewayError::from(original.clone()).into();
        assert_eq!(round_trip, original);
    }
}
