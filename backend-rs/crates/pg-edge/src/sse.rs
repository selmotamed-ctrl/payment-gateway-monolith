//! Server-sent-event headers and framing.
//!
//! Port of the SSE relay in `{admin,merchant,checkout}-back/lib/coreInternalClient.ts:878-1000`
//! and the two stream routes documented in chapter 2 §23
//! (`core-back/api/internal/checkout.ts` status stream, `merchant.ts` POS stream).
//!
//! Abort behaviour (unchanged from TS):
//! - the edge streams the core response through; when the client disconnects the upstream request
//!   is aborted and the per-IP stream slot is released;
//! - a retry is only attempted **before** the stream is established (once headers/bytes were
//!   relayed, a retry could duplicate events);
//! - every stream has a hard deadline (checkout status 10 min, POS 15 min) and closes early on a
//!   terminal attempt status; the core side also polls the database as a fallback when the Redis
//!   realtime subscription misses an event.
//!
//! nginx must not buffer the stream, hence `x-accel-buffering: no` and `no-transform`.

#![forbid(unsafe_code)]

use http::header::HeaderMap;
use http::{HeaderName, HeaderValue};

pub const SSE_CONTENT_TYPE: &str = "text/event-stream";
pub const SSE_CACHE_CONTROL: &str = "no-cache, no-transform";
pub const SSE_CONNECTION: &str = "keep-alive";
pub const SSE_BUFFERING: &str = "no";

/// Checkout `GET /internal/checkout/pay/:linkKey/logs/:attemptId/status` deadline.
pub const CHECKOUT_STATUS_STREAM_TIMEOUT_MS: u64 = 10 * 60 * 1_000;
/// Merchant POS screen stream deadline.
pub const POS_STREAM_TIMEOUT_MS: u64 = 15 * 60 * 1_000;

/// The four headers every SSE response carries, in the TS insertion order.
pub const SSE_HEADERS: [(&str, &str); 4] = [
    ("content-type", SSE_CONTENT_TYPE),
    ("cache-control", SSE_CACHE_CONTROL),
    ("connection", SSE_CONNECTION),
    ("x-accel-buffering", SSE_BUFFERING),
];

#[must_use]
pub fn sse_headers() -> [(&'static str, &'static str); 4] {
    SSE_HEADERS
}

/// Apply the contract to a response header map, overwriting whatever the handler set.
pub fn apply_sse_headers(headers: &mut HeaderMap) {
    for (name, value) in SSE_HEADERS {
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(name, value);
        }
    }
}

/// One SSE frame. A multi-line payload becomes one `data:` line per line (the SSE grammar), and
/// a newline in the event name is flattened so it cannot inject a second field.
#[must_use]
pub fn event_frame(event: &str, data: &str) -> String {
    let event = event.replace(['\r', '\n'], " ");
    let mut frame = format!("event: {event}\n");
    for line in data.split('\n') {
        frame.push_str("data: ");
        frame.push_str(line.strip_suffix('\r').unwrap_or(line));
        frame.push('\n');
    }
    frame.push('\n');
    frame
}

/// The `status` event of the checkout stream: `{attemptId, reference, status, substatus}`.
#[must_use]
pub fn status_event_frame(
    attempt_id: &str,
    reference: &str,
    status: &str,
    substatus: Option<&str>,
) -> String {
    let payload = serde_json::json!({
        "attemptId": attempt_id,
        "reference": reference,
        "status": status,
        "substatus": substatus,
    });
    event_frame("status", &payload.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_contract() {
        assert_eq!(SSE_HEADERS.len(), 4);
        assert_eq!(SSE_HEADERS[0], ("content-type", "text/event-stream"));
        assert_eq!(SSE_HEADERS[1], ("cache-control", "no-cache, no-transform"));
        assert_eq!(SSE_HEADERS[2], ("connection", "keep-alive"));
        assert_eq!(SSE_HEADERS[3], ("x-accel-buffering", "no"));

        let mut headers = HeaderMap::new();
        apply_sse_headers(&mut headers);
        assert_eq!(
            headers.get("content-type").and_then(|v| v.to_str().ok()),
            Some("text/event-stream")
        );
        assert_eq!(
            headers
                .get("x-accel-buffering")
                .and_then(|v| v.to_str().ok()),
            Some("no")
        );
    }

    #[test]
    fn frames_follow_the_sse_grammar() {
        assert_eq!(
            event_frame("status", "{\"a\":1}"),
            "event: status\ndata: {\"a\":1}\n\n"
        );
        assert_eq!(
            event_frame("attempts", "line1\nline2"),
            "event: attempts\ndata: line1\ndata: line2\n\n"
        );
        assert_eq!(
            event_frame("bad\nevent", "x"),
            "event: bad event\ndata: x\n\n"
        );
    }

    #[test]
    fn status_event_shape() {
        let frame = status_event_frame("attempt-1", "REF-1", "SUCCEEDED", None);
        assert!(frame.starts_with("event: status\ndata: "));
        assert!(frame.contains("\"attemptId\":\"attempt-1\""));
        assert!(frame.contains("\"reference\":\"REF-1\""));
        assert!(frame.contains("\"substatus\":null"));
        assert!(frame.ends_with("\n\n"));
    }

    #[test]
    fn deadlines_match_the_routes() {
        assert_eq!(CHECKOUT_STATUS_STREAM_TIMEOUT_MS, 600_000);
        assert_eq!(POS_STREAM_TIMEOUT_MS, 900_000);
    }
}
