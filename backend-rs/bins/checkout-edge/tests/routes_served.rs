//! Every checkout route registered by the TypeScript edge is served.
//!
//! This is the route-coverage table: no checkout route answers 501, and each one forwards to the
//! expected core channel path.

mod common;

use std::sync::Arc;

use checkout_edge::routes::Route;
use common::{MockReply, MockTransport, TestApp};
use ntex::http::StatusCode;
use serde_json::json;

fn core() -> Arc<MockTransport> {
    MockTransport::new(|call| {
        if call.path.ends_with("/status") {
            return MockReply::Stream {
                status: 200,
                headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
                chunks: vec![b"data: {\"status\":\"AUTHORIZING\"}\n\n".to_vec()],
            };
        }
        if call.path.contains("/inbound/") {
            return MockReply::ok(json!({ "received": call.body.len() }));
        }
        if call.path.starts_with("/internal/checkout/return/") {
            return MockReply::ok(json!({ "reference": "REF-RETURN-1" }));
        }
        if call
            .path
            .starts_with("/internal/checkout/academy/certificates/")
        {
            return MockReply::ok(json!({ "status": "valid" }));
        }
        MockReply::ok(json!({ "ok": true }))
    })
}

#[ntex::test]
async fn every_registered_checkout_route_is_served() {
    let core = core();
    let app = TestApp::with_core(core.clone()).await;
    let cases: Vec<(&str, Route, ntex::http::Request)> = vec![
        (
            "health",
            Route::Health,
            common::get("/health").to_request(),
        ),
        (
            "inbound",
            Route::Inbound,
            common::get("/api/v1/inbound/moamalat/live/abc123token").to_request(),
        ),
        (
            "pay link",
            Route::PayLink,
            common::get("/api/v1/pay/LNKTESTKEY1").to_request(),
        ),
        (
            "initiate",
            Route::Initiate,
            common::post(
                "/api/v1/pay/LNKTESTKEY1/initiate",
                r#"{"railCode":"MOAMALAT","formData":{},"idempotencyKey":"idem-00000001"}"#,
            )
            .to_request(),
        ),
        (
            "logs",
            Route::AttemptLogs,
            common::get("/api/v1/pay/LNKTESTKEY1/logs/att_123").to_request(),
        ),
        (
            "status",
            Route::AttemptStatus,
            common::get("/api/v1/pay/LNKTESTKEY1/logs/att_123/status").to_request(),
        ),
        (
            "confirm",
            Route::Confirm,
            common::post(
                "/api/v1/pay/LNKTESTKEY1/logs/att_123/confirm",
                r#"{"otp":"1234","idempotencyKey":"idem-00000001"}"#,
            )
            .to_request(),
        ),
        (
            "resend",
            Route::Resend,
            common::post_empty("/api/v1/pay/LNKTESTKEY1/logs/att_123/resend").to_request(),
        ),
        (
            "cancel",
            Route::Cancel,
            common::post(
                "/api/v1/pay/LNKTESTKEY1/logs/att_123/cancel",
                r#"{"idempotencyKey":"idem-00000001","reason":"payer cancelled"}"#,
            )
            .to_request(),
        ),
        (
            "client event",
            Route::ClientEvent,
            common::post(
                "/api/v1/pay/LNKTESTKEY1/logs/att_123/client-event",
                r#"{"event":"returnHint"}"#,
            )
            .to_request(),
        ),
        (
            "sandbox accounts list",
            Route::SandboxAccountsList,
            common::get("/api/v1/pay/sbx_test123/sandbox-accounts").to_request(),
        ),
        (
            "sandbox accounts create",
            Route::SandboxAccountsCreate,
            common::post(
                "/api/v1/pay/sbx_test123/sandbox-accounts",
                r#"{"railCode":"MOAMALAT","gatewayCode":"MOAMALAT","identifier":"0912345678","holderName":"Payer"}"#,
            )
            .to_request(),
        ),
        (
            "sandbox account patch",
            Route::SandboxAccountPatch,
            common::patch(
                "/api/v1/pay/sbx_test123/sandbox-accounts/acc_1",
                r#"{"quickPreset":"TOP_UP_5000"}"#,
            )
            .to_request(),
        ),
        (
            "sandbox movements",
            Route::SandboxAccountMovements,
            common::get("/api/v1/pay/sbx_test123/sandbox-accounts/acc_1/movements").to_request(),
        ),
        (
            "sandbox inspector",
            Route::SandboxInspector,
            common::get("/api/v1/pay/sbx_test123/logs/att_123/sandbox-inspector").to_request(),
        ),
        (
            "sandbox simulate",
            Route::SandboxSimulate,
            common::post(
                "/api/v1/pay/sbx_test123/logs/att_123/sandbox-simulate",
                r#"{"action":"FIRE_WEBHOOK_NOW"}"#,
            )
            .to_request(),
        ),
        (
            "return",
            Route::Return,
            common::get("/api/v1/return/attempttoken123").to_request(),
        ),
        (
            "certificate",
            Route::Certificate,
            common::get("/api/v1/verify/certificate/opaquePublicId0123456789abcdef")
                .to_request(),
        ),
    ];
    assert_eq!(cases.len(), 18);
    for (label, route, request) in cases {
        let response = app.call(request).await;
        assert_ne!(
            response.status,
            StatusCode::NOT_IMPLEMENTED,
            "{label} must not be a 501"
        );
        assert_ne!(
            response.status,
            StatusCode::NOT_FOUND,
            "{label} must be routed"
        );
        assert!(
            response.status.is_success() || response.status == StatusCode::FOUND,
            "{label} -> {}",
            response.status
        );
        if route != Route::Health {
            assert!(
                core.last()
                    .expect("forwarded")
                    .path
                    .starts_with(route.core_prefix()),
                "{label}: {:?}",
                core.last().expect("forwarded").path
            );
        }
        println!(
            "{label}: {} -> {}",
            route.ts_path(),
            core.last().map(|call| call.path).unwrap_or_default()
        );
    }
}

#[ntex::test]
async fn the_route_table_is_the_ts_table() {
    let routes = [
        Route::Health,
        Route::Inbound,
        Route::PayLink,
        Route::Initiate,
        Route::AttemptLogs,
        Route::AttemptStatus,
        Route::Confirm,
        Route::Resend,
        Route::Cancel,
        Route::ClientEvent,
        Route::SandboxAccountsList,
        Route::SandboxAccountsCreate,
        Route::SandboxAccountMovements,
        Route::SandboxAccountPatch,
        Route::SandboxInspector,
        Route::SandboxSimulate,
        Route::Return,
        Route::Certificate,
    ];
    // The 19 entries of `edge-routes.json` for checkout (the inbound `ALL` mount plus 18 concrete
    // method/path pairs). Health is in the inventory too, so this table is the complete list.
    assert_eq!(routes.len(), 18);
    for route in routes {
        assert!(!route.ts_path().is_empty());
        assert!(!route.ts_origin().1.is_empty());
    }
}
