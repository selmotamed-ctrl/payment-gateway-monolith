//! Body parsing and inflation for the checkout edge.
//!
//! Port of `checkout-back/index.ts` (`express.json`/`express.urlencoded` with
//! `MAX_JSON_BODY_BYTES`) and `checkout-back/api/public/inbound.ts` (`express.raw` with
//! `MAX_INBOUND_BODY_BYTES`).
//!
//! * A declared `Content-Length` above the limit is refused before reading (body-parser).
//! * gzip, deflate and zstd are inflated with ntex's decoder; brotli uses the `brotli` crate's
//!   capped `Read` adapter on the blocking pool. The limit applies to the inflated bytes, exactly
//!   like body-parser's raw-body budget.
//! * JSON is strict (a top-level object or array only) and malformed JSON is `400 BAD_REQUEST`.

#![forbid(unsafe_code)]

use std::sync::atomic::{AtomicU64, Ordering};

use ntex::http::encoding::Decoder;
use ntex::http::header::ContentEncoding;
use ntex::http::header::{CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE};
use ntex::http::HeaderMap;
use ntex::util::stream_recv;
use ntex::web;

use crate::error::EdgeFailure;

/// The parsed JSON/urlencoded body of a checkout request.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedBody {
    /// Express left `req.body === undefined` (no parser matched the content type).
    Missing,
    /// `express.json` or `express.urlencoded` produced a value.
    Value(serde_json::Value),
}

impl ParsedBody {
    /// `req.body` (undefined becomes `None`).
    #[must_use]
    pub fn as_value(&self) -> Option<&serde_json::Value> {
        match self {
            Self::Missing => None,
            Self::Value(value) => Some(value),
        }
    }

    /// `req.body ?? {}` for the resend/cancel routes.
    #[must_use]
    pub fn value_or_empty_object(&self) -> serde_json::Value {
        match self {
            Self::Missing => serde_json::json!({}),
            Self::Value(value) => value.clone(),
        }
    }
}

/// The parsed content type: lowercase media type and parameter map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentType {
    pub media_type: String,
    pub charset: Option<String>,
}

/// Parse `Content-Type` like the `type-is`/`content-type` pair Express uses.
#[must_use]
pub fn parse_content_type(headers: &HeaderMap) -> Option<ContentType> {
    let raw = headers.get(CONTENT_TYPE)?.to_str().ok()?;
    let mut parts = raw.split(';');
    let media_type = parts.next()?.trim().to_ascii_lowercase();
    if media_type.is_empty() {
        return None;
    }
    let mut charset = None;
    for parameter in parts {
        let Some((key, value)) = parameter.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("charset") {
            charset = Some(value.trim().trim_matches('"').to_ascii_lowercase());
        }
    }
    Some(ContentType {
        media_type,
        charset,
    })
}

/// `content-encoding`, normalised and validated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyEncoding {
    Identity,
    Gzip,
    Deflate,
    Zstd,
    Brotli,
}

/// An unsupported `content-encoding` (body-parser answers `415`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodingRejection {
    Unsupported,
}

impl EncodingRejection {
    /// body-parser rejects an unsupported encoding with `415`, and the edge's error handler keeps
    /// the parser status with the generic `BAD_REQUEST` code.
    #[must_use]
    pub fn to_failure(self) -> EdgeFailure {
        EdgeFailure::body_parser(415)
    }
}

/// Parse the encoding. Multiple codings are unsupported, like Node's `createDecompressionStream`.
pub fn parse_content_encoding(headers: &HeaderMap) -> Result<BodyEncoding, EncodingRejection> {
    let Some(raw) = headers.get(CONTENT_ENCODING) else {
        return Ok(BodyEncoding::Identity);
    };
    let raw = raw.to_str().unwrap_or_default().trim().to_ascii_lowercase();
    if raw.is_empty() {
        return Ok(BodyEncoding::Identity);
    }
    match raw.as_str() {
        "identity" => Ok(BodyEncoding::Identity),
        "gzip" => Ok(BodyEncoding::Gzip),
        "deflate" => Ok(BodyEncoding::Deflate),
        "zstd" => Ok(BodyEncoding::Zstd),
        "br" => Ok(BodyEncoding::Brotli),
        _ => Err(EncodingRejection::Unsupported),
    }
}

/// Declared length, when a meaningful one is present.
#[must_use]
pub fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

/// Test-visible count of body reads, used to prove that a limiter runs before the body.
#[derive(Debug, Default)]
pub struct BodyReadCounter(AtomicU64);

impl BodyReadCounter {
    #[must_use]
    pub fn get(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }

    pub fn note(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

/// Read the payload, inflating it when a supported encoding is present, and enforce `limit` on the
/// decoded size. The payload is consumed.
pub async fn read_decoded(
    payload: web::types::Payload,
    headers: &HeaderMap,
    limit: u64,
    counter: Option<&BodyReadCounter>,
) -> Result<Vec<u8>, EdgeFailure> {
    let encoding = parse_content_encoding(headers).map_err(EncodingRejection::to_failure)?;
    if encoding == BodyEncoding::Identity {
        if let Some(length) = declared_length(headers) {
            if length > limit {
                return Err(EdgeFailure::payload_too_large());
            }
        }
    }
    if let Some(counter) = counter {
        counter.note();
    }
    let mut output: Vec<u8> = Vec::new();
    match encoding {
        BodyEncoding::Identity => {
            let mut payload = payload;
            while let Some(chunk) = payload.recv().await {
                let chunk = chunk.map_err(|_| EdgeFailure::body_parser(400))?;
                if output.len() as u64 + chunk.len() as u64 > limit {
                    return Err(EdgeFailure::payload_too_large());
                }
                output.extend_from_slice(&chunk);
            }
        }
        BodyEncoding::Brotli => {
            // The brotli decoder is a `Read` adapter, so collect the compressed body (bounded)
            // and decompress on the blocking pool with a capped output reader.
            let compressed_limit = limit.saturating_add(64 * 1024);
            let compressed = read_compressed(payload, compressed_limit).await?;
            let output_limit = limit;
            output =
                tokio::task::spawn_blocking(move || decompress_brotli(&compressed, output_limit))
                    .await
                    .map_err(|_| EdgeFailure::server_error())??;
        }
        other => {
            let encoding = match other {
                BodyEncoding::Gzip => ContentEncoding::Gzip,
                BodyEncoding::Deflate => ContentEncoding::Deflate,
                BodyEncoding::Zstd => ContentEncoding::Zstd,
                BodyEncoding::Brotli | BodyEncoding::Identity => {
                    return Err(EdgeFailure::server_error())
                }
            };
            let mut decoder = Decoder::new(payload.into_inner(), encoding);
            while let Some(chunk) = stream_recv(&mut decoder).await {
                let chunk = chunk.map_err(|_| EdgeFailure::body_parser(400))?;
                if output.len() as u64 + chunk.len() as u64 > limit {
                    return Err(EdgeFailure::payload_too_large());
                }
                output.extend_from_slice(&chunk);
            }
        }
    }
    Ok(output)
}

/// Read an encoded body with a hard compressed-size cap.
async fn read_compressed(
    mut payload: web::types::Payload,
    cap: u64,
) -> Result<Vec<u8>, EdgeFailure> {
    let mut compressed = Vec::new();
    while let Some(chunk) = payload.recv().await {
        let chunk = chunk.map_err(|_| EdgeFailure::body_parser(400))?;
        if compressed.len() as u64 + chunk.len() as u64 > cap {
            return Err(EdgeFailure::payload_too_large());
        }
        compressed.extend_from_slice(&chunk);
    }
    Ok(compressed)
}

/// Decompress a brotli body with the same output budget as every other encoding.
fn decompress_brotli(compressed: &[u8], limit: u64) -> Result<Vec<u8>, EdgeFailure> {
    use std::io::Read as _;
    let mut reader = brotli::Decompressor::new(compressed, 4096).take(limit.saturating_add(1));
    let mut output = Vec::new();
    reader
        .read_to_end(&mut output)
        .map_err(|_| EdgeFailure::body_parser(400))?;
    if output.len() as u64 > limit {
        return Err(EdgeFailure::payload_too_large());
    }
    Ok(output)
}

/// Read and parse the global JSON/urlencoded body.
///
/// Returns [`ParsedBody::Missing`] without touching the payload when the content type is not one
/// of the two parsers Express mounts.
pub async fn read_request_body(
    payload: web::types::Payload,
    headers: &HeaderMap,
    limit: u64,
    counter: Option<&BodyReadCounter>,
) -> Result<ParsedBody, EdgeFailure> {
    let Some(content_type) = parse_content_type(headers) else {
        return Ok(ParsedBody::Missing);
    };
    let is_json = content_type.media_type == "application/json";
    let is_form = content_type.media_type == "application/x-www-form-urlencoded";
    if !is_json && !is_form {
        return Ok(ParsedBody::Missing);
    }
    if is_json {
        if let Some(charset) = &content_type.charset {
            if !matches!(charset.as_str(), "utf-8" | "utf8" | "us-ascii" | "ascii") {
                return Err(EdgeFailure::body_parser(415));
            }
        }
    }
    let bytes = read_decoded(payload, headers, limit, counter).await?;
    if is_form {
        return Ok(ParsedBody::Value(parse_urlencoded(&bytes)));
    }
    if bytes.is_empty() {
        // body-parser returns `{}` for a zero-length JSON body; whitespace is not empty and
        // goes through the parser (and fails), exactly like JSON.parse.
        return Ok(ParsedBody::Value(serde_json::json!({})));
    }
    let text = String::from_utf8_lossy(&bytes);
    let trimmed = text.trim();
    let first = trimmed.as_bytes().first().copied().unwrap_or_default();
    if first != b'{' && first != b'[' {
        return Err(EdgeFailure::body_parser(400));
    }
    serde_json::from_str(trimmed)
        .map(ParsedBody::Value)
        .map_err(|_| EdgeFailure::body_parser(400))
}

/// `express.urlencoded({ extended: false })` (Node's `querystring.parse`).
///
/// Repeated keys become arrays of strings; there is no bracket/nesting expansion.
#[must_use]
pub fn parse_urlencoded(bytes: &[u8]) -> serde_json::Value {
    let mut output = serde_json::Map::new();
    for (key, value) in url::form_urlencoded::parse(bytes) {
        let key = key.into_owned();
        let value = serde_json::Value::String(value.into_owned());
        match output.get_mut(&key) {
            None => {
                output.insert(key, value);
            }
            Some(serde_json::Value::Array(entries)) => entries.push(value),
            Some(existing) => {
                let previous = existing.take();
                *existing = serde_json::Value::Array(vec![previous, value]);
            }
        }
    }
    serde_json::Value::Object(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ntex::http::header::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                ntex::http::header::HeaderName::from_bytes(name.as_bytes()).expect("name"),
                HeaderValue::from_str(value).expect("value"),
            );
        }
        map
    }

    #[test]
    fn content_type_parameters_are_parsed() {
        let parsed = parse_content_type(&headers(&[(
            "content-type",
            "Application/JSON; charset=UTF-8",
        )]))
        .expect("type");
        assert_eq!(parsed.media_type, "application/json");
        assert_eq!(parsed.charset.as_deref(), Some("utf-8"));
        assert!(parse_content_type(&headers(&[])).is_none());
    }

    #[test]
    fn encodings_match_body_parser() {
        assert_eq!(
            parse_content_encoding(&headers(&[("content-encoding", "gzip")])).expect("gzip"),
            BodyEncoding::Gzip
        );
        assert_eq!(
            parse_content_encoding(&headers(&[("content-encoding", "deflate")])).expect("deflate"),
            BodyEncoding::Deflate
        );
        assert_eq!(
            parse_content_encoding(&headers(&[("content-encoding", "zstd")])).expect("zstd"),
            BodyEncoding::Zstd
        );
        assert_eq!(
            parse_content_encoding(&headers(&[])).expect("identity"),
            BodyEncoding::Identity
        );
        assert_eq!(
            parse_content_encoding(&headers(&[("content-encoding", "br")])).expect("brotli"),
            BodyEncoding::Brotli
        );
        assert_eq!(
            parse_content_encoding(&headers(&[("content-encoding", "gzip, br")]))
                .expect_err("multi"),
            EncodingRejection::Unsupported
        );
        assert_eq!(EncodingRejection::Unsupported.to_failure().status, 415);
    }

    #[test]
    fn urlencoded_matches_querystring() {
        let parsed = parse_urlencoded(b"railCode=MOAMALAT&phone=0912345678&phone=0912345679");
        assert_eq!(parsed["railCode"], "MOAMALAT");
        assert_eq!(
            parsed["phone"],
            serde_json::json!(["0912345678", "0912345679"])
        );
        let decoded = parse_urlencoded(b"note=hello+world");
        assert_eq!(decoded["note"], "hello world");
    }

    #[test]
    fn declared_length_is_read_from_the_header() {
        assert_eq!(
            declared_length(&headers(&[("content-length", " 12 ")])),
            Some(12)
        );
        assert_eq!(
            declared_length(&headers(&[("content-length", "nope")])),
            None
        );
    }
}
