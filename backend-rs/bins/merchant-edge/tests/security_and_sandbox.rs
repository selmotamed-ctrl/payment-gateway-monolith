//! Port of `merchant-back/test/{security-regressions,sandbox-proxy,sandbox-routing,
//! session-cookie-and-logout,merchant-kyb-and-external}.test.ts`.

mod common;

use common::{
    authenticated, bearer_for_audience, body, expired_bearer, multipart, session_bearer, Harness,
    Part, PNG,
};
use merchant_edge::app::IncomingRequest;
use merchant_edge::http::EdgeResponse;
use serde_json::{json, Value};

fn cookie_mode(harness: &Harness) -> bool {
    harness.app.config.session_cookie_mode
}

#[tokio::test]
async fn external_tokens_need_the_issued_shape() {
    let harness = Harness::new();
    for header in [
        Some("Bearer pg_live_totallymadeup".to_owned()),
        Some("Bearer pg_live_".to_owned()),
        Some("Bearer merchant-session".to_owned()),
        Some(format!("Bearer pg_live_{} extra", "A".repeat(43))),
        None,
    ] {
        let mut request = IncomingRequest::synthetic("GET", "/api/v1/external/links/abcdef123456");
        if let Some(header) = header {
            request = request.with_header("authorization", &header);
        }
        let response = harness.send(request).await;
        assert_eq!(response.status, 401);
    }
    assert_eq!(harness.call_count(), 0);

    let token = format!("Bearer pg_live_{}", "B".repeat(43));
    let response = harness
        .send(
            IncomingRequest::synthetic("GET", "/api/v1/external/links/abcdef123456")
                .with_header("authorization", &token),
        )
        .await;
    assert_eq!(response.status, 200);
    assert_eq!(
        harness.last_call().expect("call").header("authorization"),
        Some(token.as_str())
    );
}

#[tokio::test]
async fn access_token_creation_policy_is_enforced_before_core() {
    let harness = Harness::new();
    harness.core.push_json(201, json!({ "id": "tok_1" }));
    let valid = |extra: Value| {
        let mut payload = json!({
            "name": "integration token",
            "scopes": ["link:read"],
            "allowedCidrs": ["10.0.0.0/8"]
        });
        for (key, value) in extra.as_object().expect("object") {
            payload[key] = value.clone();
        }
        payload
    };
    let create =
        |payload: Value| authenticated("POST", "/api/v1/merchant/tokens").with_json(&payload);
    let response = harness.send(create(valid(json!({})))).await;
    assert_eq!(response.status, 201);
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/tokens"
    );

    let before = harness.call_count();
    for cidrs in [
        json!(["0.0.0.0/0"]),
        json!(["::/0"]),
        json!(["1.0.0.0/4"]),
        json!(["999.1.1.1/8"]),
        json!(["not-a-cidr"]),
        json!(["10.0.0.0/33"]),
        json!(["10.0.0.0/8", "::/0"]),
    ] {
        assert_eq!(
            harness
                .send(create(valid(json!({ "allowedCidrs": cidrs }))))
                .await
                .status,
            400
        );
    }
    assert_eq!(harness.call_count(), before);

    harness.core.push_json(201, json!({ "id": "tok_2" }));
    assert_eq!(
        harness
            .send(create(valid(
                json!({ "allowedCidrs": ["203.0.113.7", "2001:db8::/48"] })
            )))
            .await
            .status,
        201
    );

    for scopes in [
        json!(["*"]),
        json!(["*:*"]),
        json!(["admin:*"]),
        json!(["Links:Read"]),
        json!(["no.such.scope"]),
        json!(["link:read", "link:read"]),
    ] {
        assert_eq!(
            harness
                .send(create(valid(json!({ "scopes": scopes }))))
                .await
                .status,
            400
        );
    }
    let too_many: Vec<String> = (0..21).map(|index| format!("link:action{index}")).collect();
    assert_eq!(
        harness
            .send(create(valid(json!({ "scopes": too_many }))))
            .await
            .status,
        400
    );

    // Missing expiry defaults to TOKEN_DEFAULT_TTL_DAYS.
    harness.core.push_json(201, json!({ "id": "tok_3" }));
    let response = harness
        .send(create(
            json!({ "name": "no expiry", "scopes": ["link:read"] }),
        ))
        .await;
    assert_eq!(response.status, 201);
    let sent = harness.last_call().expect("call").json_body();
    let expires = sent["expiresAt"].as_str().expect("expiresAt");
    let parsed = chrono::DateTime::parse_from_rfc3339(expires).expect("iso");
    let days = (parsed.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_days();
    assert!((88..=90).contains(&days), "{days}");

    for expires_at in [
        (chrono::Utc::now() - chrono::Duration::days(1))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
        (chrono::Utc::now() + chrono::Duration::days(370))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
        "tomorrow".to_owned(),
        "2999".to_owned(),
    ] {
        assert_eq!(
            harness
                .send(create(valid(json!({ "expiresAt": expires_at }))))
                .await
                .status,
            400,
            "{expires_at}"
        );
    }
    harness.core.push_json(200, json!({ "ok": true }));
    assert_eq!(
        harness
            .send(
                authenticated("PUT", "/api/v1/merchant/tokens/tok_1/ips")
                    .with_json(&json!({ "allowedCidrs": ["0.0.0.0/0"] })),
            )
            .await
            .status,
        400
    );
    assert_eq!(
        harness
            .send(
                authenticated("PUT", "/api/v1/merchant/tokens/tok_1/ips")
                    .with_json(&json!({ "allowedCidrs": ["10.1.0.0/16"] })),
            )
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn unauthenticated_uploads_are_refused_before_the_body_is_parsed() {
    let harness = Harness::new();
    // A body that would fail multipart parsing if it were parsed; the 401 must win.
    let response = harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/onboarding/kyb-documents")
                .with_body(
                    "multipart/form-data; boundary=nope",
                    b"not a multipart body".to_vec(),
                ),
        )
        .await;
    assert_eq!(response.status, 401);
    assert_eq!(body(&response)["code"], json!("AUTH_REQUIRED"));
    assert_eq!(harness.call_count(), 0);
}

#[tokio::test]
async fn malformed_credentials_are_refused_before_a_file_is_buffered() {
    let harness = Harness::new();
    let (content_type, raw) = common::kyb_form(PNG, "x.png", "image/png");
    let refused = [
        "Bearer x".to_owned(),
        format!("Bearer pg_live_{}", "A".repeat(43)),
        expired_bearer(),
        bearer_for_audience("payment-gateway-admin"),
    ];
    for authorization in refused {
        let response = harness
            .send(
                IncomingRequest::synthetic("POST", "/api/v1/merchant/onboarding/kyb-documents")
                    .with_header("authorization", &authorization)
                    .with_body(&content_type, raw.clone()),
            )
            .await;
        assert_eq!(response.status, 401, "{authorization}");
    }
    assert_eq!(harness.call_count(), 0);
}

#[tokio::test]
async fn an_upload_declaring_more_than_the_limit_is_refused_without_parsing() {
    let harness = Harness::with_config(|config| config.max_upload_bytes = 1024);
    let (content_type, raw) = common::kyb_form(PNG, "x.png", "image/png");
    let mut request =
        IncomingRequest::synthetic("POST", "/api/v1/merchant/onboarding/kyb-documents")
            .with_header("authorization", &session_bearer())
            .with_body(&content_type, raw);
    // The declared length is what the pre-parser guard reads (the real body is small here).
    request.content_length = Some(2_000_000);
    let response = harness.send(request).await;
    assert_eq!(response.status, 413);
    assert_eq!(body(&response)["code"], json!("UPLOAD_TOO_LARGE"));
    assert_eq!(harness.call_count(), 0);
}

#[tokio::test]
async fn uploads_validate_the_magic_bytes_and_the_declared_type() {
    let harness = Harness::new();
    let fake = common::kyb_form(b"this is definitely not an image", "fake.png", "image/png");
    let bad = harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/onboarding/kyb-documents")
                .with_header("authorization", &session_bearer())
                .with_body(&fake.0, fake.1),
        )
        .await;
    assert_eq!(bad.status, 415);
    assert_eq!(body(&bad)["code"], json!("UPLOAD_SIGNATURE_MISMATCH"));
    assert_eq!(harness.call_count(), 0);

    let wrong_type = common::kyb_form(b"hello", "notes.txt", "text/plain");
    let refused = harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/onboarding/kyb-documents")
                .with_header("authorization", &session_bearer())
                .with_body(&wrong_type.0, wrong_type.1),
        )
        .await;
    assert_eq!(refused.status, 415);
    assert_eq!(body(&refused)["code"], json!("UNSUPPORTED_UPLOAD_TYPE"));

    // Oversized file (the body is under the multipart budget, the file over MAX_UPLOAD_BYTES).
    let harness = Harness::with_config(|config| config.max_upload_bytes = 1024);
    let big = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    let mut huge = big.clone();
    huge.extend(std::iter::repeat_n(1_u8, 2_000));
    let (content_type, raw) = multipart(&[
        Part::field("documentType", "OTHER"),
        Part::file("document", "huge.png", "image/png", &huge),
    ]);
    let mut request =
        IncomingRequest::synthetic("POST", "/api/v1/merchant/onboarding/kyb-documents")
            .with_header("authorization", &session_bearer())
            .with_body(&content_type, raw);
    // The declared length is what the pre-parser guard reads (the real body is small here).
    request.content_length = Some(2_000_000);
    let response = harness.send(request).await;
    assert_eq!(response.status, 413);
    assert_eq!(body(&response)["code"], json!("UPLOAD_TOO_LARGE"));
}

#[tokio::test]
async fn a_missing_document_field_is_upload_required() {
    let harness = Harness::new();
    let (content_type, raw) = multipart(&[Part::field("documentType", "OTHER")]);
    let response = harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/onboarding/kyb-documents")
                .with_header("authorization", &session_bearer())
                .with_body(&content_type, raw),
        )
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(body(&response)["code"], json!("UPLOAD_REQUIRED"));
}

#[tokio::test]
async fn the_upload_budget_is_per_client_address() {
    let harness = Harness::with_config(|config| config.upload_rate_limit_max = 2);
    let small = common::kyb_form(b"\x89PNG\r\n\x1a\n\x01", "x.png", "image/png");
    let mut statuses = Vec::new();
    for _ in 0..4 {
        harness.core.push_json(201, json!({ "id": "doc" }));
        let response = harness
            .send(
                IncomingRequest::synthetic("POST", "/api/v1/merchant/onboarding/kyb-documents")
                    .with_header("authorization", &session_bearer())
                    .with_header("x-real-client-ip", "198.51.100.30")
                    .with_body(&small.0, small.1.clone()),
            )
            .await;
        statuses.push(response.status);
    }
    assert!(statuses[0] < 300);
    assert_eq!(statuses[3], 429);
}

#[tokio::test]
async fn a_website_must_be_an_http_url() {
    let harness = Harness::new();
    let put = |website: &str| {
        authenticated("PUT", "/api/v1/merchant/onboarding/join-request")
            .with_json(&json!({ "website": website }))
    };
    for website in [
        "javascript:alert(1)",
        "data:text/html,<script>1</script>",
        "ftp://example.com",
    ] {
        let response = harness.send(put(website)).await;
        assert_eq!(response.status, 400, "{website}");
    }
    harness.core.push_json(200, json!({ "ok": true }));
    let accepted = harness.send(put("https://example.com")).await;
    assert!(accepted.status < 300);
}

#[tokio::test]
async fn cashout_idempotency_accepts_the_body_and_the_header() {
    let harness = Harness::new();
    let payload = json!({
        "walletId": "wal_1",
        "amount": "10.0000",
        "currency": "LYD",
        "bankAccountId": "bank_1"
    });
    harness.core.push_json(201, json!({ "id": "co_1" }));
    let response = harness
        .send(
            authenticated("POST", "/api/v1/merchant/cashouts").with_json(&{
                let mut payload = payload.clone();
                payload["idempotencyKey"] = json!("cashout-key-0001");
                payload
            }),
        )
        .await;
    assert_eq!(response.status, 201);
    assert_eq!(
        harness.last_call().expect("call").json_body()["idempotencyKey"],
        json!("cashout-key-0001")
    );

    harness.core.push_json(201, json!({ "id": "co_2" }));
    let response = harness
        .send(
            authenticated("POST", "/api/v1/merchant/cashouts")
                .with_header("idempotency-key", "cashout-header-0002")
                .with_json(&payload),
        )
        .await;
    assert_eq!(response.status, 201);
    assert_eq!(
        harness.last_call().expect("call").json_body()["idempotencyKey"],
        json!("cashout-header-0002")
    );

    let before = harness.call_count();
    let response = harness
        .send(
            authenticated("POST", "/api/v1/merchant/cashouts")
                .with_header("idempotency-key", "short")
                .with_json(&payload),
        )
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(harness.call_count(), before);
}

#[tokio::test]
async fn edge_owned_core_headers_cannot_be_spoofed() {
    let harness = Harness::new();
    harness.core.push_json(200, json!({}));
    harness
        .send(
            authenticated("GET", "/api/v1/merchant/wallets")
                .with_header("x-edge-service", "core-back")
                .with_header("x-real-client-ip", "1.1.1.1")
                .with_header("x-real-ip", "203.0.113.9"),
        )
        .await;
    let call = harness.last_call().expect("call");
    assert_eq!(call.header("x-edge-service"), Some("merchant-back"));
    assert_eq!(call.header("x-real-client-ip"), Some("203.0.113.9"));
    assert_eq!(
        call.header("x-request-id").map(str::len),
        Some(36),
        "a request id is generated when absent"
    );
    assert_eq!(call.header("x-client-user-agent"), Some(""));
}

#[tokio::test]
async fn security_headers_and_cors_follow_the_edge_rules() {
    let harness = Harness::new();
    let response = harness
        .send(
            IncomingRequest::synthetic("GET", "/health")
                .with_header("origin", "https://evil.example"),
        )
        .await;
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(response.header("referrer-policy"), Some("no-referrer"));
    assert!(response
        .header("content-security-policy")
        .expect("csp")
        .contains("frame-ancestors 'none'"));
    assert_eq!(response.header("cache-control"), Some("no-store"));
    assert!(response.header("access-control-allow-origin").is_none());

    let harness = Harness::with_config(|config| {
        config.cors = pg_edge::CorsAllowList::from_csv(Some("https://portal.example.com"));
    });
    let allowed = harness
        .send(
            IncomingRequest::synthetic("GET", "/health")
                .with_header("origin", "https://portal.example.com"),
        )
        .await;
    assert_eq!(
        allowed.header("access-control-allow-origin"),
        Some("https://portal.example.com")
    );
    let other = harness
        .send(
            IncomingRequest::synthetic("GET", "/health")
                .with_header("origin", "https://evil.example"),
        )
        .await;
    assert!(other.header("access-control-allow-origin").is_none());
}

#[tokio::test]
async fn logout_revokes_at_core_and_clears_the_cookie() {
    let harness = Harness::with_config(|config| config.session_cookie_mode = true);
    assert!(cookie_mode(&harness));
    let token = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJwYXltZW50LWdhdGV3YXktbWVyY2hhbnQifQ.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJlc2lnbg";
    harness.core.push_json(200, json!({ "revoked": true }));
    let response = harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/logout")
                .with_header("authorization", &format!("Bearer {token}")),
        )
        .await;
    assert_eq!(response.status, 200);
    assert_eq!(body(&response), json!({ "revoked": true }));
    let call = harness.last_call().expect("call");
    assert_eq!(call.path, "/internal/merchant/auth/logout");
    assert_eq!(
        call.header("authorization"),
        Some(format!("Bearer {token}").as_str())
    );
    let cookie = response.header("set-cookie").expect("set-cookie");
    assert!(cookie.starts_with("pg_merchant_session=; "));
    assert!(cookie.contains("Max-Age=0"));

    // Logout without a credential never reaches core and still clears the cookie.
    harness.clear();
    let response = harness
        .send(IncomingRequest::synthetic(
            "POST",
            "/api/v1/merchant/auth/logout",
        ))
        .await;
    assert_eq!(response.status, 200);
    assert_eq!(body(&response), json!({ "revoked": false }));
    assert_eq!(harness.call_count(), 0);
}

#[tokio::test]
async fn a_cookie_session_is_forwarded_as_the_bearer_and_needs_csrf_on_writes() {
    let harness = Harness::with_config(|config| config.session_cookie_mode = true);
    let token = "abcdefghijklmnopqrstuvwxyz0123456789";
    let cookie = format!("pg_merchant_session={token}");
    let response = harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/logout")
                .with_header("cookie", &cookie),
        )
        .await;
    assert_eq!(response.status, 403);
    assert_eq!(body(&response)["code"], json!("CSRF_HEADER_REQUIRED"));
    assert_eq!(harness.call_count(), 0);

    harness.core.push_json(200, json!({ "revoked": true }));
    let accepted = harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/logout")
                .with_header("cookie", &cookie)
                .with_header("x-pg-csrf", "1"),
        )
        .await;
    assert_eq!(accepted.status, 200);
    assert_eq!(
        harness.last_call().expect("call").header("authorization"),
        Some(format!("Bearer {token}").as_str())
    );

    // An explicit Authorization header wins over a cookie.
    harness.core.push_json(200, json!({ "revoked": true }));
    harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/auth/logout")
                .with_header("cookie", "pg_merchant_session=aaaaaaaaaaaaaaaaaaaaaaaa")
                .with_header("authorization", &session_bearer()),
        )
        .await;
    assert_eq!(
        harness.last_call().expect("call").header("authorization"),
        Some(session_bearer().as_str())
    );
}

#[tokio::test]
async fn a_token_minted_for_another_channel_is_refused_before_core() {
    let harness = Harness::new();
    for audience in [
        "payment-gateway-admin",
        "payment-gateway-edge",
        "payment-gateway-checkout",
    ] {
        let response = harness
            .send(
                IncomingRequest::synthetic("GET", "/api/v1/merchant/applications")
                    .with_header("authorization", &bearer_for_audience(audience)),
            )
            .await;
        assert_eq!(response.status, 401, "{audience}");
    }
    assert_eq!(harness.call_count(), 0);
    harness.core.push_json(200, json!({ "items": [] }));
    let ok = harness
        .send(
            IncomingRequest::synthetic("GET", "/api/v1/merchant/applications").with_header(
                "authorization",
                &bearer_for_audience("payment-gateway-merchant"),
            ),
        )
        .await;
    assert_eq!(ok.status, 200);
}

#[tokio::test]
async fn the_external_budget_is_per_token_and_address() {
    let harness = Harness::with_config(|config| config.external_rate_limit_max = 2);
    let call = |token: &str| {
        IncomingRequest::synthetic("GET", "/api/v1/external/links/abcdef123456")
            .with_header(
                "authorization",
                &format!("Bearer pg_live_{}", token.repeat(43)),
            )
            .with_header("x-real-client-ip", "198.51.100.20")
    };
    let first = [
        harness.send(call("C")).await.status,
        harness.send(call("C")).await.status,
        harness.send(call("C")).await.status,
    ];
    assert_eq!(first, [200, 200, 429]);
    assert_eq!(harness.send(call("D")).await.status, 200);
}

#[tokio::test]
async fn sandbox_control_studio_and_resource_paths_are_rewritten() {
    let harness = Harness::with_sandbox();
    let token = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJwYXltZW50LWdhdGV3YXktbWVyY2hhbnQifQ.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJlc2lnbg";
    let auth = format!("Bearer {token}");

    harness.core.push_json(201, json!({ "ok": true }));
    harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/sandbox/seed-demo")
                .with_header("authorization", &auth)
                .with_json(&json!({})),
        )
        .await;
    let call = harness.last_call().expect("call");
    assert_eq!(call.plane, pg_upstream::Plane::Sandbox);
    assert_eq!(call.path, "/internal/sandbox/merchant/seed-demo");
    assert_eq!(call.header("authorization"), Some(auth.as_str()));
    assert_eq!(call.header("x-execution-plane"), Some("SANDBOX"));
    assert_eq!(call.header("x-sandbox-proxy"), Some("merchant-back"));

    harness
        .send(
            IncomingRequest::synthetic("GET", "/api/v1/merchant/sandbox/studio/wallets")
                .with_header("authorization", &auth)
                .with_query("page=1&pageSize=20"),
        )
        .await;
    assert_eq!(
        harness.last_call().expect("call").url(),
        "/internal/sandbox/merchant/studio/wallets?page=1&pageSize=20"
    );

    harness
        .send(
            IncomingRequest::synthetic("GET", "/api/v1/merchant/sandbox/wallets")
                .with_header("authorization", &auth)
                .with_query("limit=5"),
        )
        .await;
    assert_eq!(
        harness.last_call().expect("call").url(),
        "/internal/merchant/wallets?limit=5"
    );

    harness
        .send(
            IncomingRequest::synthetic("GET", "/api/v1/merchant/sandbox/wallets/wal_1/ledger")
                .with_header("authorization", &auth),
        )
        .await;
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/sandbox/merchant/wallets/wal_1/ledger"
    );

    harness.core.push_json(201, json!({ "ok": true }));
    harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/merchant/sandbox/payments/pay_1/refund")
                .with_header("authorization", &auth)
                .with_json(&json!({})),
        )
        .await;
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/sandbox/merchant/payments/pay_1/refund"
    );

    harness
        .send(
            IncomingRequest::synthetic("GET", "/api/v1/merchant/sandbox/fake-rails/accounts")
                .with_header("authorization", &auth)
                .with_query("railCode=sadad"),
        )
        .await;
    assert_eq!(
        harness.last_call().expect("call").url(),
        "/internal/sandbox/fake-rails/accounts?railCode=sadad"
    );
}

#[tokio::test]
async fn the_mirror_forwards_to_the_live_merchant_router_on_the_sandbox_pool() {
    let harness = Harness::with_sandbox();
    let token = format!("Bearer pg_test_{}", "A".repeat(43));
    harness
        .core
        .push_response(merchant_edge::upstream::CoreResponse {
            status: 200,
            headers: vec![
                ("content-type".to_owned(), "text/csv".to_owned()),
                (
                    "content-disposition".to_owned(),
                    "attachment; filename=\"x.csv\"".to_owned(),
                ),
            ],
            body: b"id,amount\n1,2\n".to_vec(),
        });
    let response = harness
        .send(
            IncomingRequest::synthetic("GET", "/api/v1/merchant/sandbox/mirror/wallets")
                .with_header("authorization", &token)
                .with_query("page=1"),
        )
        .await;
    assert_eq!(response.status, 200);
    let call = harness.last_call().expect("call");
    assert_eq!(call.plane, pg_upstream::Plane::Sandbox);
    assert_eq!(call.url(), "/internal/merchant/wallets?page=1");
    assert_eq!(response.header("content-type"), Some("text/csv"));
    assert_eq!(
        response.header("content-disposition"),
        Some("attachment; filename=\"x.csv\"")
    );
    assert_eq!(response.body_bytes(), Some(b"id,amount\n1,2\n".as_slice()));
}

#[tokio::test]
async fn a_pg_test_external_token_targets_the_sandbox_pool() {
    let harness = Harness::with_sandbox();
    let token = format!("pg_test_{}", "A".repeat(43));
    harness.core.push_json(201, json!({ "id": "link_1" }));
    let response = harness
        .send(
            IncomingRequest::synthetic("POST", "/api/v1/external/links")
                .with_header("authorization", &format!("Bearer {token}"))
                .with_json(&json!({
                    "title": "Sandbox link",
                    "amount": "10.0000",
                    "currency": "LYD"
                })),
        )
        .await;
    assert_eq!(response.status, 201);
    let call = harness.last_call().expect("call");
    assert_eq!(call.plane, pg_upstream::Plane::Sandbox);
    assert_eq!(call.path, "/internal/merchant/external/links");
    assert_eq!(
        call.header("authorization"),
        Some(format!("Bearer {token}").as_str())
    );
}

#[tokio::test]
async fn an_unconfigured_sandbox_never_falls_back_to_live() {
    let harness = Harness::without_sandbox();
    let token = format!("Bearer pg_test_{}", "A".repeat(43));
    for (method, path) in [
        ("GET", "/api/v1/merchant/sandbox/overview"),
        ("GET", "/api/v1/merchant/sandbox/mirror/wallets"),
        ("GET", "/api/v1/merchant/wallets"),
    ] {
        let response = harness
            .send(IncomingRequest::synthetic(method, path).with_header("authorization", &token))
            .await;
        assert_eq!(response.status, 503, "{method} {path}");
        assert_eq!(
            body(&response)["code"],
            json!("SANDBOX_NODE_UNAVAILABLE"),
            "{method} {path}"
        );
    }
    assert_eq!(harness.call_count(), 0);
}

#[tokio::test]
async fn the_sandbox_mirror_attachment_upload_sends_the_upload_headers() {
    let harness = Harness::with_sandbox();
    // The Studio uploads with the merchant session (an API token is not a session shape).
    let token = session_bearer();
    harness.core.push_json(201, json!({ "id": "att_1" }));
    let (content_type, raw) = multipart(&[
        Part::field("label", "receipt"),
        Part::file("file", "receipt.png", "image/png", PNG),
    ]);
    let response = harness
        .send(
            IncomingRequest::synthetic(
                "POST",
                "/api/v1/merchant/sandbox/mirror/disputes/dis_1/attachments",
            )
            .with_header("authorization", &token)
            .with_body(&content_type, raw),
        )
        .await;
    assert_eq!(response.status, 201);
    let call = harness.last_call().expect("call");
    assert_eq!(call.plane, pg_upstream::Plane::Sandbox);
    assert_eq!(call.path, "/internal/merchant/disputes/dis_1/attachments");
    assert_eq!(call.body, PNG.to_vec());
    assert_eq!(
        call.header("content-type"),
        Some("application/octet-stream")
    );
    assert_eq!(call.header("x-upload-content-type"), Some("image/png"));
    assert!(call.header("x-upload-metadata").is_some());
}

#[tokio::test]
async fn the_pos_stream_is_relayed_as_server_sent_events() {
    let harness = Harness::new();
    let mut response: EdgeResponse = harness
        .send(authenticated(
            "GET",
            "/api/v1/merchant/pos/screens/SCREEN1/stream",
        ))
        .await;
    assert_eq!(response.status, 200);
    assert_eq!(response.header("content-type"), Some("text/event-stream"));
    assert_eq!(
        response.header("cache-control"),
        Some("no-cache, no-transform")
    );
    assert_eq!(response.header("x-accel-buffering"), Some("no"));
    assert_eq!(
        harness.last_call().expect("call").path,
        "/internal/merchant/pos/screens/SCREEN1/stream"
    );
    // The stream yields the fake core's SSE frames.
    let mut collected = Vec::new();
    if let merchant_edge::http::ResponseBody::Stream(stream) = &mut response.body {
        use futures_util::StreamExt as _;
        while let Some(chunk) = stream.next().await {
            collected.extend_from_slice(&chunk.expect("chunk"));
        }
    }
    let text = String::from_utf8_lossy(&collected);
    assert!(text.contains("CASHIER"), "{text}");
}

#[tokio::test]
async fn a_pos_stream_is_limited_per_client_address() {
    let harness = Harness::with_config(|config| config.max_streams_per_ip = 1);
    let first = harness
        .send(authenticated(
            "GET",
            "/api/v1/merchant/pos/screens/SCREEN1/stream",
        ))
        .await;
    assert_eq!(first.status, 200);
    // The slot is released when the stream (and its guard) is dropped.
    drop(first);
    let second = harness
        .send(authenticated(
            "GET",
            "/api/v1/merchant/pos/screens/SCREEN1/stream",
        ))
        .await;
    assert_eq!(second.status, 200);
    assert_eq!(harness.app.streams.open_for("127.0.0.1"), 1);
    drop(second);
    assert_eq!(harness.app.streams.open_for("127.0.0.1"), 0);
}
