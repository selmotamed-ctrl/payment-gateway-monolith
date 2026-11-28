//! Request and response header hygiene for edge → core calls.
//!
//! Port of `buildRequestHeaders`, `buildCoreHeaders`, `assertHeaderSafe`, `stripFramingHeaders`,
//! `sanitizeUserAgent`, `consistencyHeader` and the relay list in
//! `{admin,merchant,checkout}-back/lib/coreInternalClient.ts:155-193`, `:496-534`;
//! `admin-back/api/forward.ts:21-28` (idempotency key); and `checkout-back/api/sandboxProxy.ts`
//! (sandbox plane headers).
//!
//! The ordering is the security property: caller headers go in first, then every edge-owned
//! header is applied, so a page can never spoof `x-edge-service`, the resolved client IP, the
//! credential or the plane. Message-framing headers are removed and `content-length` is recomputed
//! from the bytes the edge actually writes, which closes the request-smuggling gap where a
//! forwarded length describes the original body.

#![forbid(unsafe_code)]

use crate::config::Plane;
use crate::error::PoolError;
use crate::path::EdgeChannel;

/// Framing and hop-by-hop headers that are never taken from a caller.
///
/// Port of `FRAMING_HEADERS` (`coreInternalClient.ts:174`).
pub const HOP_BY_HOP_HEADERS: [&str; 10] = [
    "content-length",
    "transfer-encoding",
    "content-encoding",
    "connection",
    "keep-alive",
    "upgrade",
    "te",
    "trailer",
    "host",
    "expect",
];

/// Response headers the edge relays to its client.
///
/// Port of the relay loops (`admin-back/api/forward.ts:103`, `:150`;
/// `merchant-back/api/sandboxProxy.ts:148`).
pub const RELAYED_RESPONSE_HEADERS: [&str; 2] = ["x-pg-served-by", "x-pg-min-lsn"];

/// An ordered, case-insensitive header list that keeps the wire order stable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HeaderSet {
    entries: Vec<(String, String)>,
}

impl HeaderSet {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Build from caller pairs; later entries win and names are lowercased.
    #[must_use]
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        let mut headers = Self::new();
        for (name, value) in pairs {
            headers.set(name, value);
        }
        headers
    }

    /// Set a header, replacing an earlier value with the same lowercased name.
    pub fn set(&mut self, name: &str, value: &str) {
        let name = name.to_ascii_lowercase();
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.0 == name) {
            entry.1 = value.to_owned();
        } else {
            self.entries.push((name, value.to_owned()));
        }
    }

    pub fn remove(&mut self, name: &str) {
        let name = name.to_ascii_lowercase();
        self.entries.retain(|entry| entry.0 != name);
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|entry| entry.0.eq_ignore_ascii_case(name))
            .map(|entry| entry.1.as_str())
    }

    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    #[must_use]
    pub fn entries(&self) -> &[(String, String)] {
        &self.entries
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Remove every framing/hop-by-hop header.
    ///
    /// Port of `stripFramingHeaders` (`coreInternalClient.ts:176-178`).
    pub fn strip_framing(&mut self) {
        self.entries
            .retain(|entry| !HOP_BY_HOP_HEADERS.contains(&entry.0.as_str()));
    }

    /// Strip framing, then compute the real `content-length` from the bytes written.
    ///
    /// Port of `buildRequestHeaders` (`coreInternalClient.ts:496-507`).
    pub fn with_content_length(mut self, body_len: Option<usize>) -> Result<Self, PoolError> {
        self.strip_framing();
        if let Some(length) = body_len {
            self.set("content-length", &length.to_string());
        }
        self.validate()?;
        Ok(self)
    }

    /// Reject non-printable-ASCII names or values before anything is dispatched.
    ///
    /// Port of `assertHeaderSafe` (`coreInternalClient.ts:183-190`).
    pub fn validate(&self) -> Result<(), PoolError> {
        for (name, value) in &self.entries {
            if !valid_header_name(name) || !valid_header_value(value) {
                return Err(PoolError::header_invalid());
            }
        }
        Ok(())
    }
}

/// A valid HTTP field name (RFC 9110 token). [`HeaderSet`] stores lowercased names.
#[must_use]
pub fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                        | b'-'
                )
        })
}

/// A valid field value: horizontal tab or printable ASCII (`^[\t\x20-\x7e]*$` in TS).
#[must_use]
pub fn valid_header_value(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte == b'\t' || (0x20..=0x7e).contains(&byte))
}

/// `^[A-Za-z0-9._:-]{8,128}$`, the shape admin-back forwards as `idempotency-key`.
///
/// Port of `IDEMPOTENCY_KEY_PATTERN` (`admin-back/api/forward.ts:21`).
#[must_use]
pub fn valid_idempotency_key(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// Keep printable ASCII and cap the value at 512 characters.
///
/// Port of `sanitizeUserAgent` (`coreInternalClient.ts:192-193`).
#[must_use]
pub fn sanitize_user_agent(value: Option<&str>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    value
        .chars()
        .filter(|character| ('\u{20}'..='\u{7e}').contains(character))
        .take(512)
        .collect()
}

/// Everything the edge owns for one core call.
#[derive(Debug, Clone, Copy)]
pub struct CoreRequestMeta<'a> {
    pub channel: EdgeChannel,
    pub plane: Plane,
    pub request_id: &'a str,
    pub client_ip: &'a str,
    pub user_agent: Option<&'a str>,
    pub authorization: Option<&'a str>,
    /// `true` when a JSON or raw body is written; drives the default `content-type`.
    pub body_present: bool,
    /// Overrides `content-type` for a raw body (for example `application/octet-stream`).
    pub raw_content_type: Option<&'a str>,
    /// `x-pg-min-lsn`, already validated by the admin edge.
    pub min_lsn: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
}

/// Build the headers of one edge → core call.
///
/// Port of `buildCoreHeaders` (`coreInternalClient.ts:512-534`), plus the sandbox plane headers
/// from `checkout-back/api/sandboxProxy.ts`/`merchant-back/api/sandboxProxy.ts`.
pub fn build_core_headers(
    caller: &[(&str, &str)],
    meta: &CoreRequestMeta<'_>,
) -> Result<HeaderSet, PoolError> {
    let mut headers = HeaderSet::from_pairs(caller);
    headers.strip_framing();

    headers.set("accept", "application/json");
    headers.set("x-request-id", meta.request_id);
    headers.set("x-real-client-ip", meta.client_ip);
    headers.set("x-client-user-agent", &sanitize_user_agent(meta.user_agent));
    headers.set("x-edge-service", meta.channel.service_name());

    match meta.authorization {
        Some(value) => headers.set("authorization", value),
        None => headers.remove("authorization"),
    }

    match meta.raw_content_type {
        Some(value) => headers.set("content-type", value),
        None if meta.body_present => headers.set("content-type", "application/json"),
        None => headers.remove("content-type"),
    }

    match meta
        .min_lsn
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(lsn) => headers.set("x-pg-min-lsn", lsn),
        None => headers.remove("x-pg-min-lsn"),
    }

    if let Some(key) = meta
        .idempotency_key
        .filter(|key| valid_idempotency_key(key))
    {
        headers.set("idempotency-key", key);
    }

    if meta.plane == Plane::Sandbox {
        for (name, value) in crate::config::sandbox_headers(meta.channel) {
            headers.set(name, value);
        }
    }

    headers.validate()?;
    Ok(headers)
}

/// Build headers for a low-level call whose body is already serialised.
///
/// Port of `buildRequestHeaders` (`coreInternalClient.ts:496-507`).
pub fn prepare_request_headers(
    caller: &[(&str, &str)],
    body_len: Option<usize>,
) -> Result<HeaderSet, PoolError> {
    HeaderSet::from_pairs(caller).with_content_length(body_len)
}

/// Select the two response headers an edge relays to its client.
#[must_use]
pub fn relay_headers(response: &HeaderSet) -> Vec<(String, String)> {
    RELAYED_RESPONSE_HEADERS
        .iter()
        .filter_map(|name| {
            response
                .get(name)
                .map(|value| ((*name).to_owned(), value.to_owned()))
        })
        .collect()
}

/// Select the relayed headers from an `http::HeaderMap` (the executor's response type).
#[must_use]
pub fn relay_from_header_map(headers: &http::HeaderMap) -> Vec<(String, String)> {
    RELAYED_RESPONSE_HEADERS
        .iter()
        .filter_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .map(|value| ((*name).to_owned(), value.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta<'a>(channel: EdgeChannel) -> CoreRequestMeta<'a> {
        CoreRequestMeta {
            channel,
            plane: Plane::Live,
            request_id: "req-1",
            client_ip: "203.0.113.7",
            user_agent: Some("Mozilla/5.0 (X11)"),
            authorization: Some("Bearer token"),
            body_present: true,
            raw_content_type: None,
            min_lsn: None,
            idempotency_key: None,
        }
    }

    #[test]
    fn names_are_lowercased_and_later_values_win() {
        let mut headers = HeaderSet::from_pairs(&[("X-Test", "1"), ("x-test", "2")]);
        assert_eq!(headers.get("X-TEST"), Some("2"));
        assert_eq!(headers.len(), 1);
        headers.set("x-other", "3");
        assert_eq!(headers.get("x-other"), Some("3"));
        headers.remove("X-OTHER");
        assert!(!headers.contains("x-other"));
    }

    #[test]
    fn header_name_and_value_validation_is_printable_ascii() {
        assert!(valid_header_name("x-pg-min-lsn"));
        assert!(valid_header_name("x-api-key"));
        assert!(!valid_header_name(""));
        assert!(!valid_header_name("x header"));
        assert!(!valid_header_name("x-header\r\n"));

        assert!(valid_header_value(""));
        assert!(valid_header_value("plain \tvalue"));
        assert!(!valid_header_value("bad\nvalue"));
        assert!(!valid_header_value("caf\u{e9}"));

        let mut headers = HeaderSet::new();
        headers.set("x-bad", "line\nbreak");
        assert_eq!(
            headers.validate().expect_err("invalid").code(),
            "CORE_HEADER_INVALID"
        );
    }

    #[test]
    fn framing_headers_are_stripped_and_length_is_recomputed() {
        let headers = HeaderSet::from_pairs(&[
            ("content-length", "999"),
            ("transfer-encoding", "chunked"),
            ("connection", "keep-alive"),
            ("host", "evil"),
            ("x-keep", "1"),
        ])
        .with_content_length(Some(12))
        .expect("headers");

        assert_eq!(headers.get("content-length"), Some("12"));
        assert!(!headers.contains("transfer-encoding"));
        assert!(!headers.contains("connection"));
        assert!(!headers.contains("host"));
        assert_eq!(headers.get("x-keep"), Some("1"));

        let empty = prepare_request_headers(&[("x-keep", "1")], None).expect("headers");
        assert!(!empty.contains("content-length"));
    }

    #[test]
    fn edge_owned_headers_cannot_be_overridden_by_the_caller() {
        let headers = build_core_headers(
            &[
                ("accept", "text/html"),
                ("x-edge-service", "checkout-back"),
                ("x-request-id", "spoofed"),
                ("x-real-client-ip", "1.2.3.4"),
                ("x-client-user-agent", "spoofed"),
                ("Authorization", "Basic attacker"),
            ],
            &meta(EdgeChannel::Admin),
        )
        .expect("headers");

        assert_eq!(headers.get("accept"), Some("application/json"));
        assert_eq!(headers.get("x-edge-service"), Some("admin-back"));
        assert_eq!(headers.get("x-request-id"), Some("req-1"));
        assert_eq!(headers.get("x-real-client-ip"), Some("203.0.113.7"));
        assert_eq!(
            headers.get("x-client-user-agent"),
            Some("Mozilla/5.0 (X11)")
        );
        assert_eq!(headers.get("authorization"), Some("Bearer token"));
        assert_eq!(headers.get("content-type"), Some("application/json"));
    }

    #[test]
    fn authorization_and_content_type_are_removed_when_absent() {
        let mut request = meta(EdgeChannel::Merchant);
        request.authorization = None;
        request.body_present = false;
        request.user_agent = None;
        let headers = build_core_headers(
            &[
                ("authorization", "Basic attacker"),
                ("content-type", "text/plain"),
            ],
            &request,
        )
        .expect("headers");
        assert!(!headers.contains("authorization"));
        assert!(!headers.contains("content-type"));
        assert_eq!(headers.get("x-client-user-agent"), Some(""));
    }

    #[test]
    fn raw_content_type_overrides_json_and_user_agent_is_sanitized() {
        let mut request = meta(EdgeChannel::Merchant);
        request.raw_content_type = Some("application/octet-stream");
        request.user_agent = Some("Agent\r\nInjected \u{1f600}");
        let headers = build_core_headers(&[], &request).expect("headers");
        assert_eq!(
            headers.get("content-type"),
            Some("application/octet-stream")
        );
        assert_eq!(headers.get("x-client-user-agent"), Some("AgentInjected "));

        let long = "a".repeat(600);
        assert_eq!(sanitize_user_agent(Some(&long)).len(), 512);
    }

    #[test]
    fn min_lsn_and_idempotency_key_are_only_forwarded_when_usable() {
        let mut request = meta(EdgeChannel::Admin);
        request.min_lsn = Some("  0/16B6C50  ");
        request.idempotency_key = Some("order-12345678");
        let headers = build_core_headers(&[], &request).expect("headers");
        assert_eq!(headers.get("x-pg-min-lsn"), Some("0/16B6C50"));
        assert_eq!(headers.get("idempotency-key"), Some("order-12345678"));

        request.min_lsn = Some("   ");
        request.idempotency_key = Some("short");
        let headers = build_core_headers(&[], &request).expect("headers");
        assert!(!headers.contains("x-pg-min-lsn"));
        assert!(!headers.contains("idempotency-key"));

        assert!(valid_idempotency_key("abc:def_ghi-1.2"));
        assert!(!valid_idempotency_key("has space"));
        assert!(!valid_idempotency_key("short"));
        assert!(!valid_idempotency_key(&"a".repeat(129)));
    }

    #[test]
    fn sandbox_plane_sets_the_two_plane_headers() {
        let mut request = meta(EdgeChannel::Merchant);
        request.plane = Plane::Sandbox;
        let headers = build_core_headers(&[], &request).expect("headers");
        assert_eq!(headers.get("x-execution-plane"), Some("SANDBOX"));
        assert_eq!(headers.get("x-sandbox-proxy"), Some("merchant-back"));

        request.channel = EdgeChannel::Admin;
        let headers = build_core_headers(&[], &request).expect("headers");
        assert_eq!(headers.get("x-sandbox-proxy"), Some("admin-back"));
    }

    #[test]
    fn only_the_two_relay_headers_are_selected() {
        let response = HeaderSet::from_pairs(&[
            ("x-pg-served-by", "core-1"),
            ("x-pg-min-lsn", "0/16B6C50"),
            ("x-request-id", "req-1"),
            ("content-type", "application/json"),
        ]);
        assert_eq!(
            relay_headers(&response),
            vec![
                ("x-pg-served-by".to_owned(), "core-1".to_owned()),
                ("x-pg-min-lsn".to_owned(), "0/16B6C50".to_owned()),
            ]
        );

        let mut map = http::HeaderMap::new();
        map.insert(
            "x-pg-served-by",
            "core-2".parse::<http::HeaderValue>().expect("value"),
        );
        map.insert(
            "x-pg-min-lsn",
            "1/2".parse::<http::HeaderValue>().expect("value"),
        );
        map.insert(
            "x-request-id",
            "req-2".parse::<http::HeaderValue>().expect("value"),
        );
        assert_eq!(
            relay_from_header_map(&map),
            vec![
                ("x-pg-served-by".to_owned(), "core-2".to_owned()),
                ("x-pg-min-lsn".to_owned(), "1/2".to_owned()),
            ]
        );
    }
}
