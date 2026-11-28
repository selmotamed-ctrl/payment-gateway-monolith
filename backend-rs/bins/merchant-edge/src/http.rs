//! Edge response model, security headers, CORS and request-id helpers.
//!
//! Port of `merchant-back/lib/security/index.ts` (headers + CORS allow-list),
//! `merchant-back/lib/requestLogger/index.ts` (`resolveRequestId`),
//! `merchant-back/lib/error/index.ts` (`notFoundHandler`) and the SSE header contract of
//! `merchant-back/lib/coreInternalClient.ts:983-987`.

#![forbid(unsafe_code)]

use std::net::IpAddr;

use futures_util::StreamExt as _;
use http::HeaderMap;
use ntex::http::StatusCode;
use ntex::util::Bytes;
use ntex::web::HttpResponse;
use pg_edge::{CorsAllowList, SSE_BUFFERING, SSE_CACHE_CONTROL, SSE_CONNECTION, SSE_CONTENT_TYPE};
use serde_json::Value;
use uuid::Uuid;

use crate::error::EdgeApiError;
use crate::upstream::CoreByteStream;

/// The body of an edge response.
pub enum ResponseBody {
    Bytes(Vec<u8>),
    Stream(CoreByteStream),
}

impl std::fmt::Debug for ResponseBody {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bytes(bytes) => formatter
                .debug_struct("Bytes")
                .field("len", &bytes.len())
                .finish(),
            Self::Stream(_) => formatter.write_str("Stream"),
        }
    }
}

/// A rendered edge response.
#[derive(Debug)]
pub struct EdgeResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: ResponseBody,
}

impl EdgeResponse {
    #[must_use]
    pub fn json(status: u16, body: &Value) -> Self {
        let bytes = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
        let mut response = Self {
            status,
            headers: Vec::new(),
            body: ResponseBody::Bytes(bytes),
        };
        response.set_header("content-type", "application/json; charset=utf-8");
        response
    }

    #[must_use]
    pub fn bytes(status: u16, bytes: Vec<u8>) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: ResponseBody::Bytes(bytes),
        }
    }

    #[must_use]
    pub fn stream(status: u16, stream: CoreByteStream) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: ResponseBody::Stream(stream),
        }
    }

    #[must_use]
    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: ResponseBody::Bytes(Vec::new()),
        }
    }

    #[must_use]
    pub fn from_error(error: &EdgeApiError) -> Self {
        Self::json(error.status, &error.to_json())
    }

    pub fn set_header(&mut self, name: &str, value: &str) {
        if let Some(entry) = self
            .headers
            .iter_mut()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
        {
            entry.1 = value.to_owned();
        } else {
            self.headers.push((name.to_owned(), value.to_owned()));
        }
    }

    #[must_use]
    pub fn has_header(&self, name: &str) -> bool {
        self.headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case(name))
    }

    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// The buffered body; a stream can only be consumed by [`Self::into_http`].
    #[must_use]
    pub fn body_bytes(&self) -> Option<&[u8]> {
        match &self.body {
            ResponseBody::Bytes(bytes) => Some(bytes),
            ResponseBody::Stream(_) => None,
        }
    }

    /// Apply the six edge security headers and the CORS answer of a simple request.
    pub fn finalize(&mut self, cors: &CorsAllowList, origin: Option<&str>) {
        for (name, value) in pg_http::security_headers() {
            if !self.has_header(name) {
                self.set_header(name, value);
            }
        }
        if cors.is_enabled() {
            if let Some(allowed) = cors.allow_origin(origin) {
                self.set_header("access-control-allow-origin", &allowed);
                if !self.has_header("vary") {
                    self.set_header("vary", "Origin");
                }
            }
        }
    }

    /// Add the SSE contract headers (`content-type`, `cache-control`, `connection`,
    /// `x-accel-buffering`) unless the route already set them.
    pub fn with_sse_headers(mut self) -> Self {
        if !self.has_header("content-type") {
            self.set_header("content-type", SSE_CONTENT_TYPE);
        }
        self.set_header("cache-control", SSE_CACHE_CONTROL);
        self.set_header("connection", SSE_CONNECTION);
        self.set_header("x-accel-buffering", SSE_BUFFERING);
        self
    }

    /// Convert into an ntex response.
    #[must_use]
    pub fn into_http(self) -> HttpResponse {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut builder = HttpResponse::builder(status);
        for (name, value) in &self.headers {
            builder.header(name.as_str(), value.as_str());
        }
        match self.body {
            ResponseBody::Bytes(bytes) => builder.body(Bytes::from(bytes)),
            ResponseBody::Stream(stream) => {
                let mapped = stream.map(|chunk| chunk.map(|bytes| Bytes::copy_from_slice(&bytes)));
                builder.streaming(mapped)
            }
        }
    }
}

/// `resolveRequestId`: a header matching `^[A-Za-z0-9._:-]{1,128}$`, else a fresh UUIDv4.
#[must_use]
pub fn resolve_request_id(headers: &HeaderMap) -> String {
    let incoming = headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or("");
    if !incoming.is_empty()
        && incoming.len() <= 128
        && incoming
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return incoming.to_owned();
    }
    Uuid::new_v4().to_string()
}

/// `encodeURIComponent`.
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            output.push(char::from(byte));
        } else {
            output.push('%');
            output.push(
                char::from_digit(u32::from(byte >> 4), 16)
                    .unwrap_or('0')
                    .to_ascii_uppercase(),
            );
            output.push(
                char::from_digit(u32::from(byte & 0x0f), 16)
                    .unwrap_or('0')
                    .to_ascii_uppercase(),
            );
        }
    }
    output
}

/// `decodeURIComponent` for one path segment.
#[must_use]
pub fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_value(*bytes.get(index + 1)?)?;
            let low = hex_value(*bytes.get(index + 2)?)?;
            output.push(high * 16 + low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Form-urlencoded decoding of a query string (`+` is a space).
#[must_use]
pub fn parse_query(raw: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for entry in raw.split('&') {
        if entry.is_empty() {
            continue;
        }
        let (key, value) = match entry.split_once('=') {
            Some((key, value)) => (key, value),
            None => (entry, ""),
        };
        let key = decode_form_component(key);
        let value = decode_form_component(value);
        pairs.push((key, value));
    }
    pairs
}

/// One query string decoded into a JSON object, repeated keys becoming arrays (Express `qs`).
#[must_use]
pub fn query_object(raw: &str) -> serde_json::Map<String, Value> {
    let mut object = serde_json::Map::new();
    for (key, value) in parse_query(raw) {
        match object.get_mut(&key) {
            Some(Value::Array(items)) => items.push(Value::String(value)),
            Some(existing) => {
                let first = existing.take();
                *existing = Value::Array(vec![first, Value::String(value)]);
            }
            None => {
                object.insert(key, Value::String(value));
            }
        }
    }
    object
}

fn decode_form_component(raw: &str) -> String {
    let replaced = raw.replace('+', " ");
    decode_uri_component(&replaced).unwrap_or(replaced)
}

/// Header lookup that joins repeated `cookie` headers the way Node does.
#[must_use]
pub fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    if name.eq_ignore_ascii_case("cookie") {
        let values: Vec<&str> = headers
            .get_all(name)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect();
        if values.is_empty() {
            return None;
        }
        return Some(values.join("; "));
    }
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// The client address resolved through `TRUSTED_PROXY_CIDRS`.
#[must_use]
pub fn resolve_client(headers: &HeaderMap, peer: IpAddr, trusted: &[ipnet::IpNet]) -> String {
    pg_edge::resolve_client_ip_from_headers(peer, trusted, headers).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                http::HeaderName::from_bytes(name.as_bytes()).expect("name"),
                http::HeaderValue::from_str(value).expect("value"),
            );
        }
        map
    }

    #[test]
    fn request_id_is_validated_or_generated() {
        let accepted = resolve_request_id(&headers(&[("x-request-id", "abc-DEF_1.2:3")]));
        assert_eq!(accepted, "abc-DEF_1.2:3");
        let generated = resolve_request_id(&headers(&[("x-request-id", "bad id")]));
        assert_eq!(generated.len(), 36);
        let long = resolve_request_id(&headers(&[("x-request-id", &"a".repeat(129))]));
        assert_eq!(long.len(), 36);
        let missing = resolve_request_id(&HeaderMap::new());
        assert_eq!(missing.len(), 36);
    }

    #[test]
    fn uri_component_encoding_matches_javascript() {
        assert_eq!(encode_uri_component("wal_1-2"), "wal_1-2");
        assert_eq!(encode_uri_component("a b/c?d"), "a%20b%2Fc%3Fd");
        assert_eq!(encode_uri_component("é"), "%C3%A9");
        assert_eq!(encode_uri_component("!*'()"), "!*'()");
        assert_eq!(decode_uri_component("a%20b%2Fc").as_deref(), Some("a b/c"));
        assert_eq!(decode_uri_component("%zz"), None);
    }

    #[test]
    fn query_parsing_decodes_and_keeps_repeats() {
        let object = query_object("page=2&q=a+b&tag=x&tag=y&empty");
        assert_eq!(object.get("page"), Some(&Value::String("2".to_owned())));
        assert_eq!(object.get("q"), Some(&Value::String("a b".to_owned())));
        assert_eq!(
            object.get("tag"),
            Some(&Value::Array(vec![
                Value::String("x".to_owned()),
                Value::String("y".to_owned())
            ]))
        );
        assert_eq!(object.get("empty"), Some(&Value::String(String::new())));
    }

    #[test]
    fn security_headers_are_added_once() {
        let mut response = EdgeResponse::json(200, &serde_json::json!({}));
        response.set_header("cache-control", "no-store");
        response.finalize(&CorsAllowList::default(), None);
        for (name, value) in pg_http::security_headers() {
            assert_eq!(response.header(name), Some(value), "{name}");
        }
        assert_eq!(
            response.header("content-type"),
            Some("application/json; charset=utf-8")
        );
    }

    #[test]
    fn cors_is_emitted_only_for_configured_origins() {
        let cors = CorsAllowList::from_csv(Some("https://portal.example"));
        let mut response = EdgeResponse::json(200, &serde_json::json!({}));
        response.finalize(&cors, Some("https://portal.example"));
        assert_eq!(
            response.header("access-control-allow-origin"),
            Some("https://portal.example")
        );
        assert_eq!(response.header("vary"), Some("Origin"));

        let mut other = EdgeResponse::json(200, &serde_json::json!({}));
        other.finalize(&cors, Some("https://evil.example"));
        assert!(other.header("access-control-allow-origin").is_none());
    }

    #[test]
    fn sse_headers_match_the_contract() {
        let response = EdgeResponse::empty(200).with_sse_headers();
        assert_eq!(response.header("content-type"), Some("text/event-stream"));
        assert_eq!(
            response.header("cache-control"),
            Some("no-cache, no-transform")
        );
        assert_eq!(response.header("connection"), Some("keep-alive"));
        assert_eq!(response.header("x-accel-buffering"), Some("no"));
    }

    #[test]
    fn cookie_headers_are_joined() {
        let mut map = HeaderMap::new();
        map.append("cookie", http::HeaderValue::from_static("a=1"));
        map.append("cookie", http::HeaderValue::from_static("b=2"));
        assert_eq!(header_value(&map, "cookie").as_deref(), Some("a=1; b=2"));
    }
}
