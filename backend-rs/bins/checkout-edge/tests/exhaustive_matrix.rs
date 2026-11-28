//! Port of `checkout-back/test/exhaustive/05-api-matrix/checkout-zero-trust-matrix.test.ts`.
//!
//! The real `zReady` schemas, the monetary-field scanner and the inbound environment/header
//! translation, exercised without an HTTP server.

use checkout_edge::error::EdgeFailure;
use checkout_edge::inbound::{
    inbound_channel_key, pick_forwardable_pairs, translate_inbound_environment,
    CoreInboundEnvironment,
};
use checkout_edge::monetary::{
    assert_no_monetary_fields, find_forbidden_monetary_field, is_forbidden_monetary_field,
    FORBIDDEN_MONETARY_NAMES,
};
use checkout_edge::validation::{
    parse_client_event, parse_confirm, parse_inbound_params, parse_initiate, parse_resend,
    translate_client_event, validate_attempt_id, validate_attempt_token, validate_link_key,
    validate_public_id, CLIENT_EVENTS, INBOUND_ENVIRONMENTS,
};
use serde_json::json;

const SAFE_FIELDS: [&str; 10] = [
    "phone",
    "otp",
    "reference",
    "customerName",
    "birthYear",
    "walletId",
    "cardLast4",
    "sessionId",
    "note",
    "language",
];

#[test]
fn every_forbidden_name_is_refused_in_every_case_variant() {
    for name in FORBIDDEN_MONETARY_NAMES {
        let variants = [
            name.to_owned(),
            name.to_uppercase(),
            name.chars()
                .enumerate()
                .flat_map(|(index, character)| {
                    if index > 0 && character.is_ascii_uppercase() {
                        format!("_{character}")
                            .to_lowercase()
                            .chars()
                            .collect::<Vec<_>>()
                    } else {
                        vec![character]
                    }
                })
                .collect::<String>(),
        ];
        for variant in variants {
            assert!(
                is_forbidden_monetary_field(&variant),
                "{variant} must be refused"
            );
            let failure = assert_no_monetary_fields(Some(&json!({ variant.clone(): "1.0000" })))
                .expect_err("refused");
            assert_eq!(failure.code, "AMOUNT_NOT_ACCEPTED");
        }
        assert!(assert_no_monetary_fields(Some(&json!({
            "formData": { "profile": { name: 1 } }
        })))
        .is_err());
        assert!(assert_no_monetary_fields(Some(&json!({
            "items": [{ "ok": true }, { name: 1 }]
        })))
        .is_err());
    }
}

#[test]
fn safe_fields_are_accepted_and_paths_are_dotted() {
    for name in SAFE_FIELDS {
        assert!(!is_forbidden_monetary_field(name), "{name}");
        assert!(assert_no_monetary_fields(Some(&json!({ name: "value" }))).is_ok());
    }
    assert_eq!(
        find_forbidden_monetary_field(&json!({ "formData": { "amount": "10" } })).as_deref(),
        Some("formData.amount")
    );
    assert_eq!(
        find_forbidden_monetary_field(&json!({ "formData": { "phone": "0912345678" } })),
        None
    );
}

#[test]
fn the_scanner_stops_at_the_depth_budget() {
    let mut payload = json!({ "amount": "1" });
    for _ in 0..20 {
        payload = json!({ "child": payload });
    }
    assert_eq!(find_forbidden_monetary_field(&payload), None);
}

#[test]
fn checkout_schema_boundaries_match_zod() {
    for value in ["LNK_123", "abcdef", &"A".repeat(64)] {
        assert!(validate_link_key(value).is_ok(), "{value}");
    }
    for value in ["", "abc", &"A".repeat(65), "has space", "has/slash"] {
        assert!(validate_link_key(value).is_err(), "{value}");
    }
    for value in ["ATT_123", "abcdef"] {
        assert!(validate_attempt_id(value).is_ok());
    }
    for value in ["", "abc", "has space", "has/slash"] {
        assert!(validate_attempt_id(value).is_err());
    }
    assert!(validate_attempt_token("attempttoken123").is_ok());
    assert!(validate_attempt_token("short").is_err());
    assert!(validate_attempt_token(&"A".repeat(257)).is_err());
    assert!(validate_public_id("opaquePublicId0123456789abcdef").is_ok());
    assert!(validate_public_id("short").is_err());
    assert!(validate_public_id(&"a".repeat(65)).is_err());
}

#[test]
fn initiate_and_confirm_bodies_follow_the_zod_contract() {
    for rail in ["MOAMALAT", "sadad", "numo_pay"] {
        assert!(
            parse_initiate(Some(&json!({
                "railCode": rail,
                "formData": {},
                "idempotencyKey": "idem-00000001",
            })))
            .is_ok(),
            "{rail}"
        );
    }
    for rail in ["", "bad rail", "bad/rail", &"x".repeat(65)] {
        assert!(
            parse_initiate(Some(&json!({
                "railCode": rail,
                "formData": {},
                "idempotencyKey": "idem-00000001",
            })))
            .is_err(),
            "{rail}"
        );
    }
    for otp in ["1234", "123456", "12345678"] {
        assert!(parse_confirm(Some(&json!({
            "otp": otp,
            "idempotencyKey": "idem-00000001",
        })))
        .is_ok());
    }
    for otp in ["", "123", "123456789", "abcd"] {
        assert!(parse_confirm(Some(&json!({
            "otp": otp,
            "idempotencyKey": "idem-00000001",
        })))
        .is_err());
    }
    for key in ["idem-00000001", "A_b.c:d-12345678"] {
        assert!(parse_resend(Some(&json!({ "idempotencyKey": key }))).is_ok());
    }
    for key in ["short", "has space", "has/slash", &"x".repeat(129)] {
        assert!(parse_resend(Some(&json!({ "idempotencyKey": key }))).is_err());
    }
}

#[test]
fn client_events_accept_the_legacy_aliases() {
    let aliases = [
        ("completeCallback", Some("completeCallback")),
        ("COMPLETE_CALLBACK", Some("completeCallback")),
        ("complete-callback", Some("completeCallback")),
        ("complete_callback", Some("completeCallback")),
        ("errorCallback", Some("errorCallback")),
        ("ERROR_CALLBACK", Some("errorCallback")),
        ("CANCEL_CALLBACK", Some("errorCallback")),
        ("widgetEvent", Some("widgetEvent")),
        ("WIDGET_READY", Some("widgetEvent")),
        ("WIDGET_CLOSED", Some("widgetEvent")),
        ("returnHint", Some("returnHint")),
        ("RETURN_HINT", Some("returnHint")),
        ("NOT_AN_EVENT", None),
    ];
    for (input, expected) in aliases {
        assert_eq!(translate_client_event(input), expected, "{input}");
    }
    for event in CLIENT_EVENTS {
        assert!(parse_client_event(Some(&json!({ "event": event }))).is_ok());
    }
    assert!(parse_client_event(Some(&json!({ "event": "drop_tables" }))).is_err());
    let failure =
        parse_client_event(Some(&json!({ "event": "drop_tables" }))).expect_err("unknown");
    assert_eq!(failure.code, "VALIDATION_FAILED");
}

#[test]
fn inbound_environments_map_onto_the_canonical_pair() {
    for env in INBOUND_ENVIRONMENTS {
        let canonical = translate_inbound_environment(env).expect("valid");
        let expected = match env {
            "sandbox" | "test" | "uat" => CoreInboundEnvironment::Sandbox,
            _ => CoreInboundEnvironment::Live,
        };
        assert_eq!(canonical, expected);
        assert_eq!(
            translate_inbound_environment(&env.to_uppercase()).expect("uppercase"),
            expected
        );
        assert_eq!(
            translate_inbound_environment(&format!(" {env} ")).expect("trim"),
            expected
        );
        assert!(parse_inbound_params("moamalat", env, "abc123token").is_ok());
    }
    assert_eq!(
        translate_inbound_environment("staging")
            .expect_err("invalid")
            .code,
        "INBOUND_ENVIRONMENT_INVALID"
    );
    assert_eq!(INBOUND_ENVIRONMENTS.len(), 5);
    let failure = parse_inbound_params("moamalat", "staging", "abc123token")
        .expect_err("unknown environment");
    assert_eq!(failure.status, 400);
    assert_eq!(failure.code, "VALIDATION_FAILED");
}

#[test]
fn inbound_header_allow_list_keeps_only_the_signature_headers() {
    let pairs = vec![
        ("content-type".to_owned(), "application/json".to_owned()),
        ("x-signature".to_owned(), "sig".to_owned()),
        ("x-gateway-signature".to_owned(), "sig2".to_owned()),
        ("x-hub-signature-256".to_owned(), "sig3".to_owned()),
        ("x-timestamp".to_owned(), "1".to_owned()),
        ("x-nonce".to_owned(), "n".to_owned()),
        ("authorization".to_owned(), "Bearer secret".to_owned()),
        ("cookie".to_owned(), "session=secret".to_owned()),
        ("x-internal-token".to_owned(), "leak".to_owned()),
    ];
    let forwarded = pick_forwardable_pairs(&pairs);
    let names: Vec<&str> = forwarded.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "content-type",
            "x-signature",
            "x-gateway-signature",
            "x-hub-signature-256",
            "x-timestamp",
            "x-nonce",
        ]
    );
    assert!(!names.contains(&"authorization"));
    assert!(!names.contains(&"cookie"));
    assert!(!names.contains(&"x-internal-token"));

    let repeated = vec![
        ("x-signature".to_owned(), "a".to_owned()),
        ("x-signature".to_owned(), "b".to_owned()),
    ];
    assert_eq!(
        pick_forwardable_pairs(&repeated),
        vec![("x-signature".to_owned(), "a, b".to_owned())]
    );
}

#[test]
fn channel_keys_are_short_stable_digests() {
    let key = inbound_channel_key(&["moamalat", "live", "abc123token"]);
    assert_eq!(key.len(), 32);
    assert_eq!(
        key,
        inbound_channel_key(&["MOAMALAT", "LIVE", "abc123token"])
    );
    assert_ne!(key, inbound_channel_key(&["moamalat", "live", "different"]));
}

#[test]
fn edge_failures_always_carry_status_and_code() {
    let failures = [
        EdgeFailure::server_error(),
        EdgeFailure::payload_too_large(),
        EdgeFailure::sandbox_unavailable(),
        EdgeFailure::sandbox_inspector_forbidden(),
        EdgeFailure::body_parser(400),
        EdgeFailure::body_parser(415),
    ];
    for failure in failures {
        assert!(failure.status >= 400);
        assert!(!failure.code.is_empty());
        assert!(!failure.message.is_empty());
    }
}
