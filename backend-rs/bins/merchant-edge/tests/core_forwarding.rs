//! Port of `merchant-back/test/{core-forwarding,webhooks-forwarding}.test.ts`.
//!
//! The Rust harness drives the same dispatcher as the service; a [`FakeCore`] records the call the
//! edge would make over mTLS, so every assertion checks the exact path, method, body and headers.

mod common;

use common::{
    authenticated, body, kyb_form, multipart, session_bearer, Harness, Part, JPEG, PDF, PNG,
};
use merchant_edge::app::IncomingRequest;
use serde_json::{json, Value};

async fn post(harness: &Harness, path: &str, payload: Value) -> merchant_edge::http::EdgeResponse {
    harness
        .send(authenticated("POST", path).with_json(&payload))
        .await
}

#[tokio::test]
async fn post_auth_register_keeps_the_public_payload() {
    let harness = Harness::new();
    harness
        .core
        .push_json(201, json!({ "verificationRequired": true }));
    let response = harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/register").with_json(
                &json!({
                    "email": "test@example.test",
                    "password": "Sup3rSecretPass",
                    "fullName": "Test User"
                }),
            ),
        )
        .await;
    assert_eq!(response.status, 201);
    let call = harness.last_call().expect("call");
    assert_eq!(call.path, "/internal/merchant/auth/register");
    assert_eq!(
        call.json_body(),
        json!({
            "email": "test@example.test",
            "password": "Sup3rSecretPass",
            "fullName": "Test User"
        })
    );
}

#[tokio::test]
async fn onboarding_withdraw_and_wallet_create_are_translated() {
    let harness = Harness::new();
    harness.core.push_json(200, json!({ "ok": true }));
    let withdraw = post(
        &harness,
        "/api/v1/merchant/onboarding/join-request/withdraw",
        json!({ "reason": "Correcting the company details" }),
    )
    .await;
    assert_eq!(withdraw.status, 200);
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/onboarding/join-request/withdraw"
    );
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({ "reason": "Correcting the company details" })
    );

    harness.core.push_json(201, json!({ "id": "wal_1" }));
    let wallet = post(
        &harness,
        "/api/v1/merchant/wallets",
        json!({
            "applicationId": "app_1",
            "label": "Main wallet",
            "currency": "LYD",
            "openingAmount": "10.0000"
        }),
    )
    .await;
    assert_eq!(wallet.status, 201);
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/wallets"
    );
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({ "currency": "LYD", "label": "Main wallet" })
    );
}

#[tokio::test]
async fn applications_translate_and_revalidate_against_the_core_contract() {
    let harness = Harness::new();
    harness.core.push_json(201, json!({ "id": "app_1" }));
    let created = post(
        &harness,
        "/api/v1/merchant/applications",
        json!({
            "name": "Storefront",
            "description": "Online sales channel",
            "website": "https://shop.example",
            "category": "RETAIL",
            "assignedWalletId": "wal_1"
        }),
    )
    .await;
    assert_eq!(created.status, 201);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({
            "name": "Storefront",
            "businessUseDescription": "Online sales channel",
            "assignedWalletId": "wal_1"
        })
    );

    // Core requires `assignedWalletId`; the edge refuses before calling it.
    let before = harness.call_count();
    let refused = post(
        &harness,
        "/api/v1/merchant/applications",
        json!({ "name": "Storefront", "description": "Online sales channel" }),
    )
    .await;
    assert_eq!(refused.status, 400);
    assert_eq!(body(&refused)["code"], json!("VALIDATION_FAILED"));
    assert_eq!(harness.call_count(), before);

    harness.core.push_json(200, json!({ "ok": true }));
    let patched = harness
        .send(
            authenticated("PATCH", "/api/v1/merchant/applications/app_1").with_json(&json!({
                "name": "Storefront",
                "description": "Online sales channel",
                "website": "https://shop.example",
                "baseVersion": 2
            })),
        )
        .await;
    assert_eq!(patched.status, 200);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({ "name": "Storefront", "businessUseDescription": "Online sales channel" })
    );

    // A sensitive change is an approval: core answers 202 and the edge relays that status.
    harness
        .core
        .push_json(202, json!({ "approvalId": "apr_1" }));
    let sensitive = harness
        .send(
            authenticated("PATCH", "/api/v1/merchant/applications/app_1").with_json(&json!({
                "sensitive": {
                    "assignedWalletId": "wal_1",
                    "railWhitelist": ["CASH"],
                    "redirectDomainAllowlist": ["https://shop.example"]
                },
                "reason": "settlement change"
            })),
        )
        .await;
    assert_eq!(sensitive.status, 202);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({
            "assignedWalletId": "wal_1",
            "railWhitelist": ["CASH"],
            "redirectDomainAllowlist": ["https://shop.example"]
        })
    );
}

#[tokio::test]
async fn users_translate_and_bulk_patch_fans_out() {
    let harness = Harness::new();
    harness.core.push_json(201, json!({ "id": "usr_1" }));
    let created = post(
        &harness,
        "/api/v1/merchant/users",
        json!({
            "email": "ops@example.com",
            "phone": "0912345678",
            "fullName": "Ops User",
            "password": "Sup3rSecretPass",
            "role": "MERCHANT_STAFF",
            "locale": "en",
            "authoritiesMap": { "merchant:read": true, "merchant:write": false }
        }),
    )
    .await;
    assert_eq!(created.status, 201);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({
            "email": "ops@example.com",
            "phone": "912345678",
            "password": "Sup3rSecretPass",
            "role": "MERCHANT_STAFF",
            "authoritiesMap": ["merchant:read"]
        })
    );

    harness.clear();
    harness.core.push_json(200, json!({ "id": "usr_1" }));
    harness.core.push_json(200, json!({ "id": "usr_2" }));
    let bulk = harness
        .send(
            authenticated("PATCH", "/api/v1/merchant/users").with_json(&json!({
                "userIds": ["usr_1", "usr_2"],
                "role": "MERCHANT_STAFF",
                "status": "ACTIVE",
                "reason": "rotation"
            })),
        )
        .await;
    assert_eq!(bulk.status, 200);
    let calls = harness.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].path, "/internal/merchant/users");
    assert_eq!(
        calls[0].json_body(),
        json!({ "id": "usr_1", "role": "MERCHANT_STAFF", "status": "ACTIVE" })
    );
    assert_eq!(
        calls[1].json_body(),
        json!({ "id": "usr_2", "role": "MERCHANT_STAFF", "status": "ACTIVE" })
    );
    assert_eq!(body(&bulk)["updated"], json!(2));

    harness.clear();
    harness.core.push_json(200, json!({ "id": "usr_1" }));
    let single = harness
        .send(
            authenticated("PATCH", "/api/v1/merchant/users/usr_1").with_json(&json!({
                "fullName": "Ops User",
                "role": "MERCHANT_CASHIER",
                "status": "SUSPENDED",
                "locale": "ar",
                "baseVersion": 2
            })),
        )
        .await;
    assert_eq!(single.status, 200);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({ "role": "MERCHANT_CASHIER", "status": "SUSPENDED" })
    );
}

#[tokio::test]
async fn credential_sets_cashouts_and_pos_terminals_are_translated() {
    let harness = Harness::new();
    harness.core.push_json(201, json!({ "id": "cs_1" }));
    let credentials = post(
        &harness,
        "/api/v1/merchant/credential-sets",
        json!({
            "name": "Gateway credentials",
            "gatewayId": "gw_1",
            "environment": "sandbox",
            "ownership": "MERCHANT_DIRECT",
            "authMethod": "API_KEY",
            "secrets": { "apiKey": "secret-value" },
            "settings": { "timeout": 30 },
            "externalMerchantId": "merch-42"
        }),
    )
    .await;
    assert_eq!(credentials.status, 201);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({
            "gatewayCode": "gw_1",
            "env": "SANDBOX",
            "externalMerchantId": "merch-42",
            "settlementTarget": "MERCHANT_DIRECT",
            "entries": [{ "key": "apiKey", "type": "HEADER", "value": "secret-value", "isSecret": true }]
        })
    );

    harness.core.push_json(200, json!({ "ok": true }));
    let updated = harness
        .send(
            authenticated("PUT", "/api/v1/merchant/credential-sets/cs_1").with_json(&json!({
                "name": "Gateway credentials",
                "secrets": { "apiKey": "secret-value" },
                "settings": { "timeout": 30 }
            })),
        )
        .await;
    assert_eq!(updated.status, 200);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({
            "entries": [{ "key": "apiKey", "type": "HEADER", "value": "secret-value", "isSecret": true }]
        })
    );

    harness.core.push_json(201, json!({ "id": "co_1" }));
    let cashout = post(
        &harness,
        "/api/v1/merchant/cashouts",
        json!({
            "walletId": "wal_1",
            "amount": "250.0000",
            "currency": "LYD",
            "bankAccountId": "bank_1",
            "reference": "INV-1",
            "idempotencyKey": "idem-00000001"
        }),
    )
    .await;
    assert_eq!(cashout.status, 201);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({
            "walletId": "wal_1",
            "amount": "250.0000",
            "destinationBank": { "bankAccountId": "bank_1" },
            "idempotencyKey": "idem-00000001"
        })
    );

    harness.core.push_json(201, json!({ "id": "pos_1" }));
    let terminal = post(
        &harness,
        "/api/v1/merchant/pos/terminals",
        json!({
            "name": "Till 1",
            "applicationId": "app_1",
            "location": "Tripoli",
            "deviceId": "device-9"
        }),
    )
    .await;
    assert_eq!(terminal.status, 201);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({ "name": "Till 1", "applicationId": "app_1", "location": "Tripoli" })
    );
}

#[tokio::test]
async fn dispute_evidence_is_forwarded_as_canonical_json() {
    let harness = Harness::new();
    harness.core.push_json(200, json!({ "id": "ev_1" }));
    let (content_type, raw) = multipart(&[
        Part::field("evidenceType", "RECEIPT"),
        Part::field("notes", "proof of delivery"),
        Part::file("evidence", "receipt.png", "image/png", PNG),
    ]);
    let response = harness
        .send(
            authenticated("POST", "/api/v1/merchant/disputes/dis_1/evidence")
                .with_body(&content_type, raw),
        )
        .await;
    assert_eq!(response.status, 200);
    let call = harness.last_call().expect("call");
    assert_eq!(call.path, "/internal/merchant/disputes/dis_1/evidence");
    assert_eq!(call.header("content-type"), Some("application/json"));
    let sent = call.json_body();
    assert_eq!(sent["notes"], json!("proof of delivery"));
    assert_eq!(sent["evidence"]["evidenceType"], json!("RECEIPT"));
    assert_eq!(sent["evidence"]["fileName"], json!("receipt.png"));
    assert_eq!(sent["evidence"]["contentType"], json!("image/png"));
    let decoded = base64_decode(
        sent["evidence"]["contentBase64"]
            .as_str()
            .expect("contentBase64"),
    );
    assert_eq!(decoded, PNG);
}

fn base64_decode(value: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .expect("base64")
}

#[tokio::test]
async fn deep_pagination_is_forwarded_on_every_merchant_list() {
    let harness = Harness::new();
    for route in [
        "/api/v1/merchant/wallets",
        "/api/v1/merchant/payments",
        "/api/v1/merchant/links",
        "/api/v1/merchant/cashouts",
        "/api/v1/merchant/disputes",
    ] {
        let response = harness
            .send(authenticated("GET", route).with_query("page=23397&pageSize=25"))
            .await;
        assert_eq!(response.status, 200, "{route}");
        assert_eq!(
            harness.last_call().expect("call").url(),
            format!(
                "{}?page=23397&pageSize=25",
                route.replacen("/api/v1/merchant", "/internal/merchant", 1)
            )
        );
    }
    let statements = harness
        .send(
            authenticated("GET", "/api/v1/merchant/wallets/wal_1/statements")
                .with_query("month=2026-11&page=23397&pageSize=25"),
        )
        .await;
    assert_eq!(statements.status, 200);
    assert_eq!(
        harness.last_call().expect("call").url(),
        "/internal/merchant/wallets/wal_1/statements?month=2026-11&page=23397&pageSize=25"
    );
}

#[tokio::test]
async fn report_engine_routes_forward_in_registration_order() {
    let harness = Harness::new();
    harness.core.push_json(200, json!({ "items": [] }));
    let catalog = harness
        .send(authenticated(
            "GET",
            "/api/v1/merchant/report-engine/catalog",
        ))
        .await;
    assert_eq!(catalog.status, 200);
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/report-engine/catalog"
    );

    harness.core.push_json(200, json!({ "ok": true }));
    let execute = post(
        &harness,
        "/api/v1/merchant/report-engine/catalog/merchant-daily/execute",
        json!({
            "inputs": { "periodRange": { "start": "2026-01-01T00:00:00.000Z", "end": "2026-01-31T23:59:59.999Z" } },
            "locale": "ar"
        }),
    )
    .await;
    assert_eq!(execute.status, 200);
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/report-engine/catalog/merchant-daily/execute"
    );
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({
            "inputs": { "periodRange": { "start": "2026-01-01T00:00:00.000Z", "end": "2026-01-31T23:59:59.999Z" } },
            "locale": "ar"
        })
    );

    let autocomplete = harness
        .send(
            authenticated(
                "GET",
                "/api/v1/merchant/report-engine/autocomplete/applications",
            )
            .with_query("q=shop"),
        )
        .await;
    assert_eq!(autocomplete.status, 200);
    assert_eq!(
        harness.last_call().expect("call").url(),
        "/internal/merchant/report-engine/autocomplete/applications?q=shop"
    );

    let transcript = harness
        .send(authenticated(
            "GET",
            "/api/v1/merchant/report-engine/studio/transcript",
        ))
        .await;
    assert_eq!(transcript.status, 200);
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/report-engine/studio/transcript"
    );

    harness.core.push_json(200, json!({ "ok": true }));
    let verify = post(
        &harness,
        "/api/v1/merchant/report-engine/studio/verify",
        json!({ "specJson": "{}", "assetsZipBase64": "UEsDBA==" }),
    )
    .await;
    assert_eq!(verify.status, 200);
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/report-engine/studio/verify"
    );
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({ "specJson": "{}", "assetsZipBase64": "UEsDBA==" })
    );
}

#[tokio::test]
async fn report_studio_specs_and_chrome_routes_forward() {
    let harness = Harness::new();
    let id = "11111111-1111-4111-8111-111111111111";
    let cases: Vec<(String, String, Option<Value>, String)> = vec![
        (
            "GET".into(),
            "/api/v1/merchant/report-engine/studio/specs".into(),
            None,
            "/internal/merchant/report-engine/studio/specs".into(),
        ),
        (
            "GET".into(),
            format!("/api/v1/merchant/report-engine/studio/specs/{id}"),
            None,
            format!("/internal/merchant/report-engine/studio/specs/{id}"),
        ),
        (
            "POST".into(),
            format!("/api/v1/merchant/report-engine/studio/specs/{id}/publish"),
            Some(json!({})),
            format!("/internal/merchant/report-engine/studio/specs/{id}/publish"),
        ),
        (
            "POST".into(),
            format!("/api/v1/merchant/report-engine/studio/specs/{id}/archive"),
            Some(json!({})),
            format!("/internal/merchant/report-engine/studio/specs/{id}/archive"),
        ),
        (
            "GET".into(),
            "/api/v1/merchant/report-engine/studio/usage".into(),
            None,
            "/internal/merchant/report-engine/studio/usage".into(),
        ),
        (
            "POST".into(),
            "/api/v1/merchant/report-engine/studio/templates/merchant-daily/clone".into(),
            Some(json!({ "code": "my-daily" })),
            "/internal/merchant/report-engine/studio/templates/merchant-daily/clone".into(),
        ),
        (
            "GET".into(),
            "/api/v1/merchant/report-engine/studio/chrome".into(),
            None,
            "/internal/merchant/report-engine/studio/chrome".into(),
        ),
        (
            "GET".into(),
            "/api/v1/merchant/report-engine/studio/chrome/transcript".into(),
            None,
            "/internal/merchant/report-engine/studio/chrome/transcript".into(),
        ),
        (
            "GET".into(),
            format!("/api/v1/merchant/report-engine/studio/chrome/{id}"),
            None,
            format!("/internal/merchant/report-engine/studio/chrome/{id}"),
        ),
        (
            "GET".into(),
            format!("/api/v1/merchant/report-engine/studio/chrome/{id}/migration-prompt"),
            None,
            format!("/internal/merchant/report-engine/studio/chrome/{id}/migration-prompt"),
        ),
        (
            "GET".into(),
            format!("/api/v1/merchant/report-engine/studio/specs/{id}/migration-prompt"),
            None,
            format!("/internal/merchant/report-engine/studio/specs/{id}/migration-prompt"),
        ),
    ];
    for (method, route, payload, expected) in cases {
        let mut request = authenticated(&method, &route);
        if let Some(payload) = payload {
            request = request.with_json(&payload);
        }
        let response = harness.send(request).await;
        assert!(
            response.status < 400,
            "{method} {route}: {}",
            response.status
        );
        assert_eq!(
            harness.last_call().expect("call").path,
            expected,
            "{method} {route}"
        );
    }

    let migration = harness
        .send(
            authenticated(
                "GET",
                "/api/v1/merchant/report-engine/studio/chrome/needs-migration",
            )
            .with_query("page=2&pageSize=5&search=logo"),
        )
        .await;
    assert_eq!(migration.status, 200);
    assert_eq!(
        harness.last_call().expect("call").url(),
        "/internal/merchant/report-engine/studio/chrome/needs-migration?page=2&pageSize=5&search=logo"
    );

    harness.core.push_json(201, json!({ "id": "chrome_1" }));
    let saved = post(
        &harness,
        "/api/v1/merchant/report-engine/studio/chrome",
        json!({ "specJson": "{}", "publish": true, "makeDefault": true }),
    )
    .await;
    assert_eq!(saved.status, 201);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({ "specJson": "{}", "publish": true, "makeDefault": true })
    );
}

#[tokio::test]
async fn webhook_routes_are_forwarded_with_strict_shapes() {
    let harness = Harness::new();
    harness.core.push_json(200, json!({ "eventTypes": [] }));
    let events = harness
        .send(authenticated(
            "GET",
            "/api/v1/merchant/webhooks/event-types",
        ))
        .await;
    assert_eq!(events.status, 200);
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/webhooks/event-types"
    );

    let endpoints = harness
        .send(
            authenticated("GET", "/api/v1/merchant/webhooks/endpoints")
                .with_query("applicationId=app_1"),
        )
        .await;
    assert_eq!(endpoints.status, 200);
    assert_eq!(
        harness.last_call().expect("call").url(),
        "/internal/merchant/webhooks/endpoints?applicationId=app_1"
    );
    let extra = harness
        .send(authenticated("GET", "/api/v1/merchant/webhooks/endpoints").with_query("extra=1"))
        .await;
    assert_eq!(extra.status, 400);

    harness
        .core
        .push_json(201, json!({ "id": "ep_1", "secret": "whsec_x" }));
    let created = post(
        &harness,
        "/api/v1/merchant/webhooks/endpoints",
        json!({
            "applicationId": "app_1",
            "url": "https://hooks.example.ly/pay",
            "eventTypes": ["payment.succeeded"],
            "description": "orders"
        }),
    )
    .await;
    assert_eq!(created.status, 201);
    assert_eq!(created.header("cache-control"), Some("no-store"));
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({
            "applicationId": "app_1",
            "url": "https://hooks.example.ly/pay",
            "eventTypes": ["payment.succeeded"],
            "description": "orders"
        })
    );

    let before = harness.call_count();
    for payload in [
        json!({ "applicationId": "app_1", "url": "https://hooks.example.ly/x", "secret": "whsec_mine" }),
        json!({ "applicationId": "app_1" }),
        json!({ "url": "https://hooks.example.ly/x" }),
        json!({ "applicationId": "app_1", "url": "https://hooks.example.ly/x", "eventTypes": (0..33).map(|index| format!("e{index}")).collect::<Vec<_>>() }),
    ] {
        assert_eq!(
            post(&harness, "/api/v1/merchant/webhooks/endpoints", payload)
                .await
                .status,
            400
        );
    }
    assert_eq!(harness.call_count(), before);

    harness.core.push_json(200, json!({ "ok": true }));
    let patched = harness
        .send(
            authenticated("PATCH", "/api/v1/merchant/webhooks/endpoints/ep_1")
                .with_json(&json!({ "enabled": false, "description": null })),
        )
        .await;
    assert_eq!(patched.status, 200);
    assert_eq!(
        harness.last_call().expect("call").json_body(),
        json!({ "enabled": false, "description": null })
    );
    assert_eq!(
        harness
            .send(
                authenticated("PATCH", "/api/v1/merchant/webhooks/endpoints/ep_1")
                    .with_json(&json!({ "applicationId": "app_2" })),
            )
            .await
            .status,
        400
    );

    harness
        .core
        .push_json(200, json!({ "secret": "whsec_new" }));
    let rotated = harness
        .send(
            authenticated(
                "POST",
                "/api/v1/merchant/webhooks/endpoints/ep_1/rotate-secret",
            )
            .with_json(&json!({})),
        )
        .await;
    assert_eq!(rotated.status, 200);
    assert_eq!(rotated.header("cache-control"), Some("no-store"));
    assert_eq!(
        harness
            .send(
                authenticated(
                    "POST",
                    "/api/v1/merchant/webhooks/endpoints/ep_1/rotate-secret",
                )
                .with_json(&json!({ "sneaky": 1 })),
            )
            .await
            .status,
        400
    );

    harness.core.push_json(202, json!({ "queued": true }));
    let tested = harness
        .send(
            authenticated("POST", "/api/v1/merchant/webhooks/endpoints/ep_1/test")
                .with_json(&json!({})),
        )
        .await;
    assert_eq!(tested.status, 202);
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/webhooks/endpoints/ep_1/test"
    );

    harness.core.push_json(200, json!({ "items": [] }));
    let deliveries = harness
        .send(
            authenticated("GET", "/api/v1/merchant/webhooks/deliveries")
                .with_query("endpointId=ep_1&status=PARKED&limit=20"),
        )
        .await;
    assert_eq!(deliveries.status, 200);
    assert_eq!(
        harness.last_call().expect("call").url(),
        "/internal/merchant/webhooks/deliveries?endpointId=ep_1&status=PARKED&limit=20"
    );
    assert_eq!(
        harness
            .send(
                authenticated("GET", "/api/v1/merchant/webhooks/deliveries")
                    .with_query("status=LOST"),
            )
            .await
            .status,
        400
    );
    assert_eq!(
        harness
            .send(
                authenticated("GET", "/api/v1/merchant/webhooks/deliveries")
                    .with_query("limit=1000"),
            )
            .await
            .status,
        400
    );

    harness.core.push_json(202, json!({ "queued": true }));
    let redelivered = harness
        .send(
            authenticated(
                "POST",
                "/api/v1/merchant/webhooks/deliveries/dl_1/redeliver",
            )
            .with_json(&json!({})),
        )
        .await;
    assert_eq!(redelivered.status, 202);
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/webhooks/deliveries/dl_1/redeliver"
    );

    // Every webhook route needs a session.
    harness.clear();
    for (method, path) in [
        ("GET", "/api/v1/merchant/webhooks/endpoints"),
        ("POST", "/api/v1/merchant/webhooks/endpoints"),
        ("PATCH", "/api/v1/merchant/webhooks/endpoints/ep_1"),
        (
            "POST",
            "/api/v1/merchant/webhooks/endpoints/ep_1/rotate-secret",
        ),
        ("GET", "/api/v1/merchant/webhooks/deliveries"),
        (
            "POST",
            "/api/v1/merchant/webhooks/deliveries/dl_1/redeliver",
        ),
    ] {
        let mut request = IncomingRequest::synthetic(method, path);
        if method != "GET" {
            request = request.with_json(&json!({}));
        }
        assert_eq!(harness.send(request).await.status, 401, "{method} {path}");
    }
    assert_eq!(harness.call_count(), 0);
}

#[tokio::test]
async fn kyb_documents_forward_the_raw_bytes_and_upload_headers() {
    let harness = Harness::new();
    for (bytes, filename, mime, expected) in [
        (PNG, "license.png", "image/png", "image/png"),
        (JPEG, "id.jpg", "image/jpeg", "image/jpeg"),
        (PDF, "registry.pdf", "application/pdf", "application/pdf"),
    ] {
        harness.core.push_json(201, json!({ "id": "doc_1" }));
        let (content_type, raw) = kyb_form(bytes, filename, mime);
        let response = harness
            .send(
                IncomingRequest::synthetic("POST", "/api/v1/merchant/onboarding/kyb-documents")
                    .with_header("authorization", &session_bearer())
                    .with_body(&content_type, raw),
            )
            .await;
        assert_eq!(response.status, 201, "{filename}");
        let call = harness.last_call().expect("call");
        assert_eq!(call.path, "/internal/merchant/onboarding/kyb-documents");
        assert_eq!(call.body, bytes.to_vec());
        assert_eq!(call.header("x-upload-content-type"), Some(expected));
        assert!(call.header("x-upload-sha256").is_some());
        assert!(call.header("x-upload-metadata").is_some());
        assert_eq!(
            call.header("content-type"),
            Some("application/octet-stream")
        );
    }
}

#[tokio::test]
async fn the_health_route_reports_the_edge() {
    let harness = Harness::new();
    let response = harness
        .send(IncomingRequest::synthetic("GET", "/health"))
        .await;
    assert_eq!(response.status, 200);
    let payload = body(&response);
    assert_eq!(payload["status"], json!("ok"));
    assert_eq!(payload["service"], json!("merchant-back"));
    assert_eq!(payload["release"], json!("test-release"));
    assert_eq!(payload["commit"], json!("test-commit"));
    assert_eq!(payload["implementation"], json!("rust"));
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
}
