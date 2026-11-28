//! Inbound webhook translation and the forwardable header allow-list.
//!
//! Port of `checkout-back/api/public/inbound.ts`:
//! * `FORWARDABLE_HEADER_ALLOWLIST` and `pickForwardableHeaders`;
//! * `INBOUND_ENVIRONMENTS`, `CoreInboundEnvironment` and `translateInboundEnvironment`;
//! * `channelOf`, `digestKeyPart` and the two rate-limit key shapes.
//!
//! The inbound route never forwards credentials, cookies or identity headers to core, and the
//! public error vocabulary never leaks core's envelope.

#![forbid(unsafe_code)]

use ntex::http::HeaderMap;
use pg_edge::digest_key_part;

use crate::error::EdgeFailure;

/// `FORWARDABLE_HEADER_ALLOWLIST`, copied verbatim. `content-length` is deliberately absent: the
/// body is forwarded after inflation, so the original length would no longer describe it.
pub const FORWARDABLE_HEADERS: [&str; 8] = [
    "content-type",
    "user-agent",
    "x-signature",
    "x-gateway-signature",
    "x-hub-signature-256",
    "x-moomalat-signature",
    "x-timestamp",
    "x-nonce",
];

/// The canonical core plane an inbound environment maps to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreInboundEnvironment {
    Sandbox,
    Live,
}

impl CoreInboundEnvironment {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sandbox => "SANDBOX",
            Self::Live => "LIVE",
        }
    }
}

/// Port of `translateInboundEnvironment`: `sandbox|test|uat` → `SANDBOX`, `live|production` →
/// `LIVE`, anything else is `400 INBOUND_ENVIRONMENT_INVALID`.
pub fn translate_inbound_environment(value: &str) -> Result<CoreInboundEnvironment, EdgeFailure> {
    match value.trim().to_lowercase().as_str() {
        "sandbox" | "test" | "uat" => Ok(CoreInboundEnvironment::Sandbox),
        "live" | "production" => Ok(CoreInboundEnvironment::Live),
        _ => Err(EdgeFailure::new(
            400,
            "INBOUND_ENVIRONMENT_INVALID",
            "The inbound environment is invalid",
        )),
    }
}

/// One allowlisted header value. Repeated values are joined with `", "` exactly like
/// `pickForwardableHeaders` (Node folds repeated headers this way for the router).
#[must_use]
pub fn pick_forwardable_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    let mut forwarded = Vec::new();
    for name in FORWARDABLE_HEADERS {
        let values: Vec<&str> = headers
            .get_all(name)
            .filter_map(|value| value.to_str().ok())
            .collect();
        if values.is_empty() {
            continue;
        }
        forwarded.push((name.to_owned(), values.join(", ")));
    }
    forwarded
}

/// A test-friendly form of `pickForwardableHeaders` over raw name/value pairs.
#[must_use]
pub fn pick_forwardable_pairs(pairs: &[(String, String)]) -> Vec<(String, String)> {
    let mut forwarded = Vec::new();
    for name in FORWARDABLE_HEADERS {
        let values: Vec<&str> = pairs
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .collect();
        if !values.is_empty() {
            forwarded.push((name.to_owned(), values.join(", ")));
        }
    }
    forwarded
}

/// `channelOf`: the gateway, environment and path token of the request, lowercased and digested.
///
/// `segments` are the path segments below `/api/v1/inbound` in wire order.
#[must_use]
pub fn inbound_channel_key(segments: &[&str]) -> String {
    let gateway = segments.first().copied().unwrap_or_default();
    let environment = segments.get(1).copied().unwrap_or_default();
    let token = segments.get(2).copied().unwrap_or_default();
    digest_key_part(&format!(
        "{}/{}/{}",
        gateway.to_lowercase(),
        environment.to_lowercase(),
        token
    ))
}

/// The limiter keys used by the inbound route.
///
/// * `client` — the coarse per-address ceiling (`INBOUND_RATE_LIMIT_MAX * 5`);
/// * `channel` — `client|channel-digest`, so one noisy channel cannot burn another's budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundLimiterKeys {
    pub client: String,
    pub channel: String,
}

#[must_use]
pub fn inbound_limiter_keys(client_ip: &str, segments: &[&str]) -> InboundLimiterKeys {
    let client = if client_ip.is_empty() {
        "unknown".to_owned()
    } else {
        client_ip.to_owned()
    };
    let channel = format!("{client}|{}", inbound_channel_key(segments));
    InboundLimiterKeys { client, channel }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ntex::http::header::HeaderValue;

    fn header_map() -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("content-type", "application/json"),
            ("user-agent", "gateway-agent/1.0"),
            ("content-length", "12"),
            ("x-signature", "sig-1"),
            ("x-gateway-signature", "sig-2"),
            ("x-hub-signature-256", "sha256=sig-3"),
            ("x-moomalat-signature", "sig-4"),
            ("x-timestamp", "1700000000"),
            ("x-nonce", "nonce-1"),
            ("authorization", "Bearer super-secret"),
            ("cookie", "session=super-secret"),
            ("x-user-id", "user-42"),
            ("x-authorities", "MERCHANT_ADMIN"),
            ("x-roles", "MERCHANT_ADMIN"),
            ("x-forwarded-for", "203.0.113.9"),
            ("x-request-id", "spoofed-request-id"),
            ("x-real-client-ip", "203.0.113.9"),
            ("host", "pay.example.com"),
            ("connection", "keep-alive"),
            ("transfer-encoding", "chunked"),
        ] {
            headers.insert(
                ntex::http::header::HeaderName::from_bytes(name.as_bytes()).expect("name"),
                HeaderValue::from_str(value).expect("value"),
            );
        }
        headers
    }

    #[test]
    fn only_the_allowlisted_headers_are_forwarded() {
        let forwarded = pick_forwardable_headers(&header_map());
        let names: Vec<&str> = forwarded.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "content-type",
                "user-agent",
                "x-signature",
                "x-gateway-signature",
                "x-hub-signature-256",
                "x-moomalat-signature",
                "x-timestamp",
                "x-nonce",
            ]
        );
        assert!(!names.contains(&"content-length"));
        assert!(!names.contains(&"authorization"));
        assert!(!names.contains(&"cookie"));
        assert!(!names.contains(&"x-user-id"));
        assert!(!names.contains(&"x-authorities"));
        assert!(!names.contains(&"x-roles"));
    }

    #[test]
    fn repeated_values_are_joined() {
        let pairs = vec![
            ("x-signature".to_owned(), "a".to_owned()),
            ("x-signature".to_owned(), "b".to_owned()),
        ];
        assert_eq!(
            pick_forwardable_pairs(&pairs),
            vec![("x-signature".to_owned(), "a, b".to_owned())]
        );

        let mut headers = HeaderMap::new();
        headers.append(
            ntex::http::header::HeaderName::from_static("x-signature"),
            HeaderValue::from_static("a"),
        );
        headers.append(
            ntex::http::header::HeaderName::from_static("x-signature"),
            HeaderValue::from_static("b"),
        );
        assert_eq!(
            pick_forwardable_headers(&headers),
            vec![("x-signature".to_owned(), "a, b".to_owned())]
        );
    }

    #[test]
    fn environments_map_onto_the_canonical_pair() {
        for value in ["sandbox", "test", "uat"] {
            assert_eq!(
                translate_inbound_environment(value).expect("sandbox"),
                CoreInboundEnvironment::Sandbox
            );
            assert_eq!(
                translate_inbound_environment(&value.to_uppercase()).expect("uppercase"),
                CoreInboundEnvironment::Sandbox
            );
            assert_eq!(
                translate_inbound_environment(&format!(" {value} ")).expect("trim"),
                CoreInboundEnvironment::Sandbox
            );
        }
        for value in ["live", "production"] {
            assert_eq!(
                translate_inbound_environment(value).expect("live"),
                CoreInboundEnvironment::Live
            );
        }
        let failure = translate_inbound_environment("staging").expect_err("invalid");
        assert_eq!(failure.status, 400);
        assert_eq!(failure.code, "INBOUND_ENVIRONMENT_INVALID");
    }

    #[test]
    fn channel_keys_are_stable_and_lowercased() {
        let lower = inbound_channel_key(&["moamalat", "live", "abc123token"]);
        let mixed = inbound_channel_key(&["Moamalat", "LIVE", "abc123token"]);
        assert_eq!(lower, mixed);
        assert_eq!(lower.len(), 32);
        assert_ne!(
            lower,
            inbound_channel_key(&["moamalat", "live", "abc123token2"])
        );
    }

    #[test]
    fn limiter_keys_separate_clients_and_channels() {
        let keys = inbound_limiter_keys("203.0.113.7", &["gw", "live", "token1"]);
        assert_eq!(keys.client, "203.0.113.7");
        assert!(keys.channel.starts_with("203.0.113.7|"));
        let other = inbound_limiter_keys("203.0.113.7", &["gw", "live", "token2"]);
        assert_ne!(keys.channel, other.channel);
        assert_eq!(keys.client, other.client);
        assert_eq!(inbound_limiter_keys("", &[]).client, "unknown");
    }
}
