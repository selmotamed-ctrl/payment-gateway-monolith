//! Port of `checkout-back/test/error-and-logger.test.ts`.

mod common;

use checkout_edge::error::{EdgeFailure, PublicInboundError};
use checkout_edge::logging::{redact_headers, redact_secrets, redact_url};
use ntex::http::StatusCode;
use serde_json::json;

#[test]
fn serializes_the_stable_platform_envelope() {
    let failure = EdgeFailure::validation(json!([
        { "path": ["railCode"], "message": "required" }
    ]));
    assert_eq!(failure.status, 400);
    assert_eq!(failure.code, "VALIDATION_FAILED");
    assert_eq!(
        serde_json::to_value(failure.envelope()).expect("json"),
        json!({
            "code": "VALIDATION_FAILED",
            "message": "Request payload failed validation",
            "details": [{ "path": ["railCode"], "message": "required" }],
        })
    );
}

#[test]
fn keeps_the_reference_and_details_when_core_supplies_them() {
    let failure = checkout_edge::error::map_core_http_error(
        409,
        &json!({
            "code": "SLOT_EXHAUSTED",
            "message": "no slot",
            "reference": "ref-1",
            "details": { "activeLockedCount": 5 },
        }),
    );
    assert_eq!(
        serde_json::to_value(failure.envelope()).expect("json"),
        json!({
            "code": "SLOT_EXHAUSTED",
            "message": "no slot",
            "reference": "ref-1",
            "details": { "activeLockedCount": 5 },
        })
    );
}

#[test]
fn validation_details_are_an_issue_list() {
    use checkout_edge::validation::parse_initiate;
    let failure = parse_initiate(Some(&json!({ "railCode": "" }))).expect_err("invalid");
    assert_eq!(failure.status, 400);
    assert_eq!(failure.code, "VALIDATION_FAILED");
    let details = failure.details.expect("details");
    assert!(details.is_array());
    assert!(details
        .as_array()
        .expect("array")
        .iter()
        .all(|issue| issue.get("code").is_some() && issue.get("path").is_some()));
}

#[test]
fn masks_secret_fields_at_any_depth() {
    let redacted = redact_secrets(&json!({
        "email": "merchant@example.com",
        "password": "super-secret",
        "nested": { "token": "pg_live_1", "authorization": "Bearer abc", "otp": "1234" },
        "list": [{ "apiKey": "key-1" }],
    }));
    assert_eq!(redacted["email"], "[REDACTED]");
    assert_eq!(redacted["password"], "[REDACTED]");
    assert_eq!(redacted["nested"]["token"], "[REDACTED]");
    assert_eq!(redacted["nested"]["authorization"], "[REDACTED]");
    assert_eq!(redacted["nested"]["otp"], "[REDACTED]");
    assert_eq!(redacted["list"][0]["apiKey"], "[REDACTED]");
}

#[test]
fn truncates_long_values() {
    let redacted = redact_secrets(&json!({ "note": "x".repeat(400) }));
    let note = redacted["note"].as_str().expect("string");
    assert!(note.len() < 400);
    assert!(note.contains("[truncated]"));
}

#[test]
fn headers_are_redacted_by_name() {
    let mut headers = ntex::http::HeaderMap::new();
    headers.insert(
        ntex::http::header::HeaderName::from_static("authorization"),
        ntex::http::header::HeaderValue::from_static("Bearer abc"),
    );
    headers.insert(
        ntex::http::header::HeaderName::from_static("user-agent"),
        ntex::http::header::HeaderValue::from_static("checkout-front/1.0"),
    );
    let redacted = redact_headers(&headers);
    assert!(redacted.contains(&("authorization".to_owned(), "[REDACTED]".to_owned())));
    assert!(redacted.contains(&("user-agent".to_owned(), "checkout-front/1.0".to_owned())));
}

#[test]
fn capability_urls_are_redacted_before_logging() {
    assert_eq!(
        redact_url("/api/v1/return/ATTEMPTTOKEN123?reference=R1&token=abc"),
        "/api/v1/return/[REDACTED]?reference=R1&token=[REDACTED]"
    );
}

#[test]
fn public_inbound_errors_are_two_field_envelopes() {
    let error = PublicInboundError {
        status: 503,
        code: "INBOUND_UNAVAILABLE",
        message: "The notification could not be processed right now",
    };
    let body = serde_json::to_value(error.to_failure().envelope()).expect("json");
    assert_eq!(body.as_object().expect("object").len(), 2);
    assert_eq!(error.to_failure().status, 503);
    assert_eq!(StatusCode::SERVICE_UNAVAILABLE.as_u16(), 503);
}
