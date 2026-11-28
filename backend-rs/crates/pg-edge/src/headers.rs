//! Forwarding header safety and framing recomputation.
//!
//! Port of `{admin,merchant,checkout}-back/lib/coreInternalClient.ts`:
//! `FRAMING_HEADERS`, `stripFramingHeaders`, `HEADER_NAME_PATTERN`, `HEADER_VALUE_PATTERN`,
//! `assertHeaderSafe` and `sanitizeUserAgent`.
//!
//! The edge writes the body itself (re-serialised, decompressed or raw), so a caller's
//! `content-length`/`transfer-encoding`/`content-encoding` must never be forwarded: a length that
//! describes the original body would not match the bytes written on the pooled keep-alive
//! connection (request smuggling). Hop-by-hop and `proxy-*` headers are stripped as well, and the
//! real length is computed from the body.

#![forbid(unsafe_code)]

use http::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH, TRANSFER_ENCODING};

use crate::error::EdgeError;

/// Headers that belong to one connection only and must never cross the edge.
pub const HOP_BY_HOP_HEADERS: [&str; 6] = [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
];

/// Additional caller headers replaced (or dropped) by the edge.
pub const STRIPPED_FORWARD_HEADERS: [&str; 4] =
    ["content-length", "content-encoding", "host", "expect"];

/// Header set last on every core request.
pub const X_CLIENT_USER_AGENT: &str = "x-client-user-agent";
pub const USER_AGENT_MAX_CHARS: usize = 512;

/// `true` for the hop-by-hop list and everything prefixed `proxy-`.
#[must_use]
pub fn is_hop_by_hop(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    HOP_BY_HOP_HEADERS.contains(&lower.as_str()) || lower.starts_with("proxy-")
}

fn is_header_name_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase()
        || byte.is_ascii_digit()
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
}

/// `^[a-z0-9!#$%&'*+.^_`|~-]+$`.
#[must_use]
pub fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(is_header_name_byte)
}

/// `^[\t\x20-\x7e]*$`: tab and printable ASCII only.
#[must_use]
pub fn is_valid_header_value(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte == b'\t' || (0x20..=0x7e).contains(&byte))
}

/// One header pair check before dispatch (`CORE_HEADER_INVALID` on failure).
pub fn validate_header_pair(name: &str, value: &str) -> Result<(), EdgeError> {
    if is_valid_header_name(name) && is_valid_header_value(value) {
        Ok(())
    } else {
        Err(EdgeError::CoreHeaderInvalid)
    }
}

/// Validate every name/value of a header map.
pub fn assert_header_map_safe(headers: &HeaderMap) -> Result<(), EdgeError> {
    for (name, value) in headers {
        if !is_valid_header_name(name.as_str()) {
            return Err(EdgeError::CoreHeaderInvalid);
        }
        match value.to_str() {
            Ok(text) if is_valid_header_value(text) => {}
            _ => return Err(EdgeError::CoreHeaderInvalid),
        }
    }
    Ok(())
}

/// Remove hop-by-hop, caller framing and `proxy-*` headers.
pub fn strip_forward_headers(headers: &mut HeaderMap) {
    let remove: Vec<HeaderName> = headers
        .keys()
        .filter(|name| {
            let name = name.as_str();
            is_hop_by_hop(name) || STRIPPED_FORWARD_HEADERS.contains(&name)
        })
        .cloned()
        .collect();
    for name in remove {
        headers.remove(name);
    }
}

/// Set the exact body length and drop any transfer encoding. Returns `false` only if the header
/// value could not be built (impossible for a decimal length).
#[must_use]
pub fn set_content_length(headers: &mut HeaderMap, length: u64) -> bool {
    headers.remove(TRANSFER_ENCODING);
    match HeaderValue::from_str(&length.to_string()) {
        Ok(value) => {
            headers.insert(CONTENT_LENGTH, value);
            true
        }
        Err(_) => false,
    }
}

/// `sanitizeUserAgent`: printable ASCII only, capped at 512 characters.
#[must_use]
pub fn sanitize_user_agent(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .filter(|character| ('\u{20}'..='\u{7e}').contains(character))
        .take(USER_AGENT_MAX_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hop_by_hop_and_proxy_headers() {
        assert!(is_hop_by_hop("connection"));
        assert!(is_hop_by_hop("Keep-Alive"));
        assert!(is_hop_by_hop("proxy-authorization"));
        assert!(is_hop_by_hop("Proxy-Connection"));
        assert!(!is_hop_by_hop("content-length"));
        assert!(!is_hop_by_hop("x-request-id"));
    }

    #[test]
    fn stripping_removes_framing_and_keeps_application_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("connection", HeaderValue::from_static("keep-alive"));
        headers.insert("proxy-connection", HeaderValue::from_static("keep-alive"));
        headers.insert("content-length", HeaderValue::from_static("999"));
        headers.insert("content-encoding", HeaderValue::from_static("gzip"));
        headers.insert("host", HeaderValue::from_static("core.internal"));
        headers.insert("expect", HeaderValue::from_static("100-continue"));
        headers.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        headers.insert("authorization", HeaderValue::from_static("Bearer x"));

        strip_forward_headers(&mut headers);

        assert!(headers.get("connection").is_none());
        assert!(headers.get("proxy-connection").is_none());
        assert!(headers.get("content-length").is_none());
        assert!(headers.get("content-encoding").is_none());
        assert!(headers.get("host").is_none());
        assert!(headers.get("expect").is_none());
        assert!(headers.get("transfer-encoding").is_none());
        assert_eq!(
            headers.get("authorization").and_then(|v| v.to_str().ok()),
            Some("Bearer x")
        );
    }

    #[test]
    fn content_length_is_recomputed() {
        let mut headers = HeaderMap::new();
        headers.insert(TRANSFER_ENCODING, HeaderValue::from_static("chunked"));
        assert!(set_content_length(&mut headers, 123));
        assert_eq!(
            headers.get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()),
            Some("123")
        );
        assert!(headers.get(TRANSFER_ENCODING).is_none());
    }

    #[test]
    fn header_name_pattern() {
        assert!(is_valid_header_name("x-request-id"));
        assert!(is_valid_header_name("idempotency-key"));
        assert!(!is_valid_header_name(""));
        assert!(!is_valid_header_name("X-Request-Id")); // uppercase is not the TS pattern
        assert!(!is_valid_header_name("bad name"));
        assert!(!is_valid_header_name("bad:name"));
    }

    #[test]
    fn header_value_pattern() {
        assert!(is_valid_header_value(""));
        assert!(is_valid_header_value("text/plain; charset=utf-8"));
        assert!(is_valid_header_value("tab\there"));
        assert!(!is_valid_header_value("line\r\nbreak"));
        assert!(!is_valid_header_value("\u{7f}"));
        assert!(!is_valid_header_value("caf\u{e9}"));
    }

    #[test]
    fn validation_maps_to_core_header_invalid() {
        assert_eq!(validate_header_pair("x-ok", "value"), Ok(()));
        assert_eq!(
            validate_header_pair("x-bad", "line\r\nbreak"),
            Err(EdgeError::CoreHeaderInvalid)
        );

        let mut headers = HeaderMap::new();
        headers.insert("x-ok", HeaderValue::from_static("value"));
        assert_eq!(assert_header_map_safe(&headers), Ok(()));
    }

    #[test]
    fn user_agent_is_printable_and_capped() {
        assert_eq!(sanitize_user_agent(None), "");
        assert_eq!(sanitize_user_agent(Some("Mozilla/5.0")), "Mozilla/5.0");
        assert_eq!(sanitize_user_agent(Some("a\r\nb\u{7f}c")), "abc");
        let long = "x".repeat(600);
        assert_eq!(sanitize_user_agent(Some(long.as_str())).len(), 512);
    }
}
