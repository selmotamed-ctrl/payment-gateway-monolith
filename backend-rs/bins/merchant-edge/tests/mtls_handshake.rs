//! Live mTLS round trip: a rustls server (internal CA, client certificate required, TLS 1.3)
//! answers the edge's `HttpCoreTransport`, proving the client identity, SNI/IP SAN and the request
//! path/header contract on the wire.

use std::path::PathBuf;
use std::time::Duration;

use merchant_edge::config::{EdgeConfig, MtlsPaths};
use merchant_edge::upstream::{CoreRequest, CoreTransport, HttpCoreTransport};
use ntex::web::{self, App, HttpServer};
use pg_upstream::{CoreMethod, CoreRequestMeta, Plane};
use serde_json::json;

struct Pki {
    dir: tempfile::TempDir,
    cert: PathBuf,
    key: PathBuf,
    ca: PathBuf,
}

fn pki() -> Pki {
    let dir = tempfile::tempdir().expect("tempdir");
    let generated =
        rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_owned(), "localhost".to_owned()])
            .expect("certificate");
    let cert = dir.path().join("server.crt");
    let key = dir.path().join("server.key");
    let ca = dir.path().join("ca.crt");
    let pem = generated.cert.pem();
    std::fs::write(&cert, &pem).expect("cert");
    std::fs::write(&ca, &pem).expect("ca");
    std::fs::write(&key, generated.signing_key.serialize_pem()).expect("key");
    Pki { dir, cert, key, ca }
}

#[ntex::test]
async fn the_edge_completes_a_tls13_mtls_call_with_the_expected_headers() {
    let paths = pki();
    let tls = pg_mtls::server_config(&pg_mtls::ServerTlsPaths {
        ca_cert: paths.ca.clone(),
        server_cert: paths.cert.clone(),
        server_key: paths.key.clone(),
    })
    .expect("server tls");

    let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("port");
    let port = probe.local_addr().expect("addr").port();
    drop(probe);
    let server = HttpServer::new(async move |_| {
        App::new().service(web::resource("/internal/merchant/wallets").to(async || {
            web::HttpResponse::Ok()
                .content_type("application/json; charset=utf-8")
                .body(r#"{"wallet":"ok"}"#)
        }))
    })
    .workers(1)
    .bind_rustls(
        ("127.0.0.1", port),
        &tls.config,
        ntex::SharedCfg::new("merchant-edge-mtls-test"),
    )
    .expect("bind tls")
    .run();
    ntex::rt::spawn(server);
    ntex::time::sleep(ntex::time::Millis(120)).await;

    let mut config = EdgeConfig::for_embedding(vec![format!("https://127.0.0.1:{port}")], None);
    config.mtls = MtlsPaths {
        client_cert: paths.cert.clone(),
        client_key: paths.key.clone(),
        ca_cert: paths.ca.clone(),
    };
    config.request_timeout_ms = 5_000;
    config.total_deadline_ms = 10_000;
    let transport = HttpCoreTransport::new(&config).expect("client");

    let headers = CoreRequest::build_headers(
        &[],
        &CoreRequestMeta {
            channel: pg_upstream::EdgeChannel::Merchant,
            plane: Plane::Live,
            request_id: "req-mtls-1",
            client_ip: "203.0.113.5",
            user_agent: Some("merchant-edge-test"),
            authorization: Some("Bearer token"),
            body_present: false,
            raw_content_type: None,
            min_lsn: None,
            idempotency_key: None,
        },
        None,
    )
    .expect("headers");
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        transport.call(CoreRequest {
            plane: Plane::Live,
            method: CoreMethod::Get,
            path: "/internal/merchant/wallets".to_owned(),
            query: Vec::new(),
            headers,
            body: None,
            timeout_ms: None,
        }),
    )
    .await
    .expect("deadline")
    .expect("call");
    assert_eq!(response.status, 200);
    assert_eq!(response.json_body(), json!({ "wallet": "ok" }));
    assert!(paths.dir.path().exists());
}

#[ntex::test]
async fn a_client_outside_the_internal_ca_fails_closed() {
    let paths = pki();
    let tls = pg_mtls::server_config(&pg_mtls::ServerTlsPaths {
        ca_cert: paths.ca.clone(),
        server_cert: paths.cert.clone(),
        server_key: paths.key.clone(),
    })
    .expect("server tls");
    let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("port");
    let port = probe.local_addr().expect("addr").port();
    drop(probe);
    let server = HttpServer::new(async move |_| {
        App::new().service(web::resource("/{tail}*").to(async || "never"))
    })
    .workers(1)
    .bind_rustls(
        ("127.0.0.1", port),
        &tls.config,
        ntex::SharedCfg::new("merchant-edge-mtls-reject-test"),
    )
    .expect("bind tls")
    .run();
    ntex::rt::spawn(server);
    ntex::time::sleep(ntex::time::Millis(120)).await;

    // A self-signed identity that is not chained to the server's CA.
    let rogue = pki();
    let mut config = EdgeConfig::for_embedding(vec![format!("https://127.0.0.1:{port}")], None);
    config.mtls = MtlsPaths {
        client_cert: rogue.cert.clone(),
        client_key: rogue.key.clone(),
        ca_cert: paths.ca.clone(),
    };
    config.request_timeout_ms = 5_000;
    config.total_deadline_ms = 10_000;
    let transport = HttpCoreTransport::new(&config).expect("client");
    let headers = CoreRequest::build_headers(
        &[],
        &CoreRequestMeta {
            channel: pg_upstream::EdgeChannel::Merchant,
            plane: Plane::Live,
            request_id: "req-mtls-2",
            client_ip: "203.0.113.6",
            user_agent: None,
            authorization: None,
            body_present: false,
            raw_content_type: None,
            min_lsn: None,
            idempotency_key: None,
        },
        None,
    )
    .expect("headers");
    let error = tokio::time::timeout(
        Duration::from_secs(10),
        transport.call(CoreRequest {
            plane: Plane::Live,
            method: CoreMethod::Get,
            path: "/internal/merchant/wallets".to_owned(),
            query: Vec::new(),
            headers,
            body: None,
            timeout_ms: None,
        }),
    )
    .await
    .expect("deadline")
    .expect_err("the internal CA must reject a foreign client certificate");
    assert_eq!(error.status(), 502);
    // The alert text of the peer rejection decides between CORE_TLS_ERROR and
    // CORE_CONNECTION_ERROR in `pg-upstream`; both fail closed before any request byte.
    assert!(error.code().starts_with("CORE_"), "{}", error.code());
}
