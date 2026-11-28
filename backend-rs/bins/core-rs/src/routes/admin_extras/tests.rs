//! Tests for the admin extras read routes.
//!
//! The first group is database-free: the policy table must match the route inventory and the
//! dispatcher table, and the exported count is asserted. The second group is DB-gated against
//! `PG_TEST_DATABASE_URL`, `DATABASE_URL` or the project default test database (schema 46); it
//! prints `SKIP:` and returns when PostgreSQL is unreachable, uses random fixtures and removes
//! them (plus the audit rows the exports write) afterwards.

#![forbid(unsafe_code)]

use std::sync::Arc;

use tokio::sync::Mutex;

use chrono::Utc;
use ntex::http::Method;
use ntex::web::test;
use pg_domain_auth::{sign_session_at, Channel, SessionClaims};
use pg_http::Channel as HttpChannel;
use serde_json::Value;
use uuid::Uuid;

use crate::config::CoreConfig;
use crate::state::AppState;

const MASTER_KEY: &str = "core-rs-admin-extras-test-key-0123456789";
const DEFAULT_URL: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";
const EXPECTED_SCHEMA_VERSION: i64 = 46;

const INVENTORY: &str =
    include_str!("../../../../../tests/golden-vectors/route-inventory/routes.json");

/* ------------------------------------------------------------ policy table */

#[test]
fn every_route_is_in_the_inventory_and_the_dispatch_table() {
    let inventory: Vec<Value> = serde_json::from_str(INVENTORY).expect("inventory json");
    let routes = super::routes();
    assert_eq!(routes.len(), super::ROUTE_COUNT);
    let mounted = crate::routes::mounted_routes();
    for route in &routes {
        assert_eq!(route.policy.method, "GET");
        assert_eq!(route.policy.channel, HttpChannel::Admin);
        assert_eq!(route.policy.authn, pg_http::Authn::Session);
        assert_eq!(route.guard, crate::routes::PrincipalGuard::Staff);
        let found = inventory.iter().any(|entry| {
            entry.get("method").and_then(Value::as_str) == Some("GET")
                && entry.get("fullPath").and_then(Value::as_str) == Some(route.policy.path.as_str())
        });
        assert!(found, "{} is not in the route inventory", route.policy.path);
        let matches: Vec<_> = mounted
            .iter()
            .filter(|candidate| {
                candidate.policy.method == "GET" && candidate.policy.path == route.policy.path
            })
            .collect();
        assert_eq!(
            matches.len(),
            1,
            "{} must be mounted exactly once",
            route.policy.path
        );
    }
    let mut paths: Vec<&str> = routes
        .iter()
        .map(|route| route.policy.path.as_str())
        .collect();
    paths.sort_unstable();
    paths.dedup();
    assert_eq!(paths.len(), routes.len(), "duplicate path in admin extras");
}

#[test]
fn every_route_has_a_ts_origin_and_the_expected_families() {
    let routes = super::routes();
    let mut families: Vec<&str> = routes
        .iter()
        .map(|route| {
            let path = route.policy.path.as_str();
            match path {
                path if path.starts_with("/internal/admin/system/backups/") => "backups",
                path if path.starts_with("/internal/admin/inbound-events") => "inbound",
                path if path.contains("/content") || path.ends_with("/statement") => "content",
                path if path.starts_with("/internal/admin/settings/")
                    || path == "/internal/admin/users/export"
                    || path == "/internal/admin/users/summary/export"
                    || path == "/internal/admin/stats/recent-activity/export" =>
                {
                    "settings-users"
                }
                _ => "gateways",
            }
        })
        .collect();
    families.sort_unstable();
    families.dedup();
    assert_eq!(
        families,
        vec![
            "backups",
            "content",
            "gateways",
            "inbound",
            "settings-users"
        ]
    );
    for route in routes {
        assert!(!route.policy.ts_origin.trim().is_empty());
        assert!(route.policy.ts_origin.contains("core-back/api/internal/"));
    }
}

/* --------------------------------------------------------------- DB fixture */

fn database_url() -> String {
    std::env::var("PG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_URL.to_owned())
}

async fn state_or_skip() -> Option<Arc<AppState>> {
    static TRACING: std::sync::Once = std::sync::Once::new();
    TRACING.call_once(|| {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::ERROR)
            .with_test_writer()
            .try_init();
    });
    let url = database_url();
    let state = match AppState::connect(CoreConfig::for_tests(&url, MASTER_KEY)).await {
        Ok(state) => state,
        Err(error) => {
            eprintln!("SKIP: PostgreSQL is unreachable at {url}: {error}");
            return None;
        }
    };
    let version: Option<i64> = sqlx::query_scalar("SELECT max(version) FROM schema_versions")
        .fetch_one(&state.pools.main)
        .await
        .ok();
    if version != Some(EXPECTED_SCHEMA_VERSION) {
        eprintln!(
            "SKIP: test database schema version is {version:?}, expected {EXPECTED_SCHEMA_VERSION}"
        );
        return None;
    }
    Some(state)
}

struct Response {
    status: u16,
    body: Value,
}

async fn call(state: &Arc<AppState>, path: &str, authorities: &[&str]) -> Response {
    let Some(user_id) = insert_user(state, authorities).await else {
        return Response {
            status: 0,
            body: Value::Null,
        };
    };
    let response = call_as(state, path, user_id).await;
    delete_user(state, user_id).await;
    response
}

/// The HTTP exchange for an explicit actor (used by the content test that then asserts the audit
/// row written for that actor).
async fn call_as(state: &Arc<AppState>, path: &str, user_id: Uuid) -> Response {
    let token = session_token(user_id);
    let request = test::TestRequest::default()
        .method(Method::from_bytes(b"GET").expect("method"))
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .to_http_request();
    let response = crate::app::dispatch(
        state.clone(),
        request,
        ntex::web::types::Payload(ntex::http::Payload::None),
    )
    .await;
    let status = response.status().as_u16();
    let body = test::read_body(response).await;
    Response {
        status,
        body: serde_json::from_slice(body.as_ref()).unwrap_or(Value::Null),
    }
}

fn session_token(user_id: Uuid) -> String {
    let now = Utc::now();
    let mut claims = SessionClaims::new(user_id.to_string(), "COMPLIANCE")
        .with_channel(Channel::Admin)
        .expect("admin channel");
    claims.jti = Some(Uuid::new_v4().to_string());
    claims.iat = Some(now.timestamp());
    claims.exp = Some(now.timestamp() + pg_domain_auth::SESSION_TTL_SECONDS);
    sign_session_at(&claims, MASTER_KEY, now).expect("sign")
}

async fn insert_user(state: &AppState, authorities: &[&str]) -> Option<Uuid> {
    let id = Uuid::new_v4();
    let email = format!("{id}@admin-extras.test");
    let authorities = Value::Array(
        authorities
            .iter()
            .map(|value| Value::String((*value).to_owned()))
            .collect(),
    );
    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, is_maker, is_checker,
                            mfa_required, status)
         VALUES ($1, now(), $2, 'COMPLIANCE'::\"UserRole\", $3::jsonb, true, true, false, 'ACTIVE'::\"UserStatus\")",
    )
    .bind(id)
    .bind(email)
    .bind(authorities)
    .execute(&state.pools.main)
    .await
    .ok()?;
    Some(id)
}

async fn delete_user(state: &AppState, id: Uuid) {
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&state.pools.main)
        .await;
}

/// Audit rows are append-only; the test's own rows are removed through the retention bypass.
async fn purge_audit(state: &AppState, actor_id: Uuid) {
    let Ok(mut connection) = state.pools.main.acquire().await else {
        return;
    };
    let _ = sqlx::query("SET pgw.audit_retention = 'on'")
        .execute(&mut *connection)
        .await;
    let _ = sqlx::query("DELETE FROM audit_log WHERE actor_id = $1")
        .bind(actor_id)
        .execute(&mut *connection)
        .await;
}

async fn audit_count(state: &AppState, actor_id: Uuid, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE actor_id = $1 AND action = $2")
        .bind(actor_id)
        .bind(action)
        .fetch_one(&state.pools.main)
        .await
        .unwrap_or(0)
}

fn random_hex() -> String {
    pg_crypto::sha256_hex(Uuid::new_v4().as_bytes())
}

struct GatewayFixture {
    gateway: Uuid,
    version: Uuid,
    channel: Uuid,
    code: String,
}

async fn insert_gateway(state: &AppState) -> Option<GatewayFixture> {
    let gateway = Uuid::new_v4();
    let version = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let code = format!("extras-{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO gateways (id, created_at, updated_at, code, name, operator, aliases, kind)
         VALUES ($1, now(), now(), $2, $3, 'EXTRAS TEST', '[]'::jsonb, 'DIRECT'::\"GatewayKind\")",
    )
    .bind(gateway)
    .bind(&code)
    .bind(format!("Extras {code}"))
    .execute(&state.pools.main)
    .await
    .ok()?;
    sqlx::query(
        "INSERT INTO gateway_versions (id, created_at, updated_at, gateway_id, version_number,
                                       snapshot_ciphertext, content_hash, state)
         VALUES ($1, now(), now(), $2, 1, '{}', $3, 'DRAFT'::\"GatewayVersionState\")",
    )
    .bind(version)
    .bind(gateway)
    .bind(random_hex())
    .execute(&state.pools.main)
    .await
    .ok()?;
    sqlx::query(
        "INSERT INTO confirmation_channels (id, created_at, updated_at, gateway_version_id, type,
                                            path_token, verify_method, body_format, event_map)
         VALUES ($1, now(), now(), $2, 'WEBHOOK'::\"ConfirmationChannelType\", $3,
                 'NONE_PLUS_INQUIRY'::\"VerifyMethod\", 'JSON'::\"BodyFormat\", '{}'::jsonb)",
    )
    .bind(channel)
    .bind(version)
    .bind(format!("extras-{}", Uuid::new_v4().simple()))
    .execute(&state.pools.main)
    .await
    .ok()?;
    Some(GatewayFixture {
        gateway,
        version,
        channel,
        code,
    })
}

async fn remove_gateway(state: &AppState, fixture: &GatewayFixture) {
    let _ = sqlx::query("DELETE FROM inbound_events WHERE gateway_id = $1")
        .bind(fixture.gateway)
        .execute(&state.pools.main)
        .await;
    let _ = sqlx::query("DELETE FROM confirmation_channels WHERE id = $1")
        .bind(fixture.channel)
        .execute(&state.pools.main)
        .await;
    let _ = sqlx::query("DELETE FROM gateway_versions WHERE id = $1")
        .bind(fixture.version)
        .execute(&state.pools.main)
        .await;
    let _ = sqlx::query("DELETE FROM gateways WHERE id = $1")
        .bind(fixture.gateway)
        .execute(&state.pools.main)
        .await;
}

/// Serialises the object-storage environment switches with the content test.
static STORAGE_ENV_LOCK: Mutex<()> = Mutex::const_new(());

/* ---------------------------------------------------------------- inbound */

#[tokio::test]
async fn inbound_events_list_and_detail_redact_the_raw_body() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let Some(fixture) = insert_gateway(&state).await else {
        eprintln!("SKIP: could not create the gateway fixture");
        return;
    };
    let event = Uuid::new_v4();
    let dedupe = random_hex();
    let raw = br#"{"card_number":"4111111111111111","token":"super-secret","amount":"10.00"}"#;
    sqlx::query(
        "INSERT INTO inbound_events (id, created_at, updated_at, channel_id, gateway_id, env,
                                     raw_body_bytes, redacted_headers_json, source_ip, verified,
                                     dedupe_key, received_at)
         VALUES ($1, now(), now(), $2, $3, 'LIVE', $4, '{\"x-test\":\"yes\"}'::jsonb,
                 '10.0.0.9', true, $5, now())",
    )
    .bind(event)
    .bind(fixture.channel)
    .bind(fixture.gateway)
    .bind(raw.to_vec())
    .bind(&dedupe)
    .execute(&state.pools.main)
    .await
    .expect("inbound fixture");

    let list = call(
        &state,
        &format!(
            "/internal/admin/inbound-events?gatewayId={}&verified=true&search={}",
            fixture.gateway, dedupe
        ),
        &["attempt:read"],
    )
    .await;
    assert_eq!(list.status, 200, "{:?}", list.body);
    let events = list.body["inboundEvents"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["id"], event.to_string());
    assert_eq!(events[0]["gateway"]["code"], fixture.code);
    assert_eq!(events[0]["dedupeKey"], dedupe);
    assert_eq!(list.body["total"], 1);

    let detail = call(
        &state,
        &format!("/internal/admin/inbound-events/{event}"),
        &["case:read"],
    )
    .await;
    assert_eq!(detail.status, 200, "{:?}", detail.body);
    assert_eq!(detail.body["bodySize"], Value::from(raw.len() as i64));
    assert_eq!(detail.body["bodySha256"], pg_crypto::sha256_hex(raw));
    let preview = detail.body["bodyPreview"].as_str().unwrap_or_default();
    assert!(!preview.contains("4111111111111111"), "{preview}");
    assert!(!preview.contains("super-secret"), "{preview}");
    assert_eq!(detail.body["redactedHeaders"]["x-test"], "yes");

    sqlx::query("DELETE FROM inbound_events WHERE id = $1")
        .bind(event)
        .execute(&state.pools.main)
        .await
        .expect("cleanup event");
    remove_gateway(&state, &fixture).await;
}

/* ------------------------------------------------------------------ files */

#[tokio::test]
async fn asset_content_decrypts_the_shared_vault() {
    use pg_objstore::blob_store::{BlobStore, BucketTier, FsBlobStore};
    use pg_objstore::pgos1::{seal_pgos1, KekKeyring};

    let Some(state) = state_or_skip().await else {
        return;
    };
    let _guard = STORAGE_ENV_LOCK.lock().await;
    let previous_root = std::env::var("OBJECT_STORAGE_ROOT_DIR").ok();
    let previous_keyring = std::env::var("OBJECT_STORAGE_KEK_KEYRING").ok();
    let previous_daemon = std::env::var("OBJECT_STORAGE_DAEMON_URL").ok();
    let root = std::env::temp_dir().join(format!("pg-extras-storage-{}", Uuid::new_v4()));
    std::env::set_var("OBJECT_STORAGE_ROOT_DIR", &root);
    std::env::set_var(
        "OBJECT_STORAGE_KEK_KEYRING",
        format!("v1:{}", "22".repeat(32)),
    );
    std::env::remove_var("OBJECT_STORAGE_DAEMON_URL");
    let keyring =
        KekKeyring::parse(&format!("v1:{}", "22".repeat(32)), Some(1)).expect("test keyring");

    let object_id = Uuid::new_v4();
    let asset_id = Uuid::new_v4();
    let plaintext = b"the stored brand asset bytes";
    let (ciphertext, metadata) =
        seal_pgos1(object_id, plaintext, &keyring, None).expect("seal object");
    let store = FsBlobStore::new(root.clone()).await.expect("fs store");
    let storage_key = format!("system-brand-assets-test/{object_id}.bin");
    store
        .put(BucketTier::Hot, &storage_key, &ciphertext)
        .await
        .expect("write blob");

    let wrapped =
        super::storage::base64_decode_for_tests(&metadata.wrapped_dek).expect("wrapped dek");
    let nonce = super::storage::base64_decode_for_tests(&metadata.dek_nonce).expect("dek nonce");
    let prefix =
        super::storage::base64_decode_for_tests(&metadata.stream_prefix).expect("stream prefix");
    sqlx::query(
        "INSERT INTO storage_objects
            (id, bucket, namespace, storage_key, status, sha256_hex, byte_size,
             chunk_size_bytes, chunk_count, detected_mime_type, original_filename,
             kek_key_version, wrapped_dek, dek_nonce, stream_nonce_prefix,
             uploaded_by_actor_type, uploaded_by_actor_id, required_authority,
             confidentiality_tier, metadata, staging_expires_at, activated_at, created_at,
             updated_at)
         VALUES ($1, 'HOT', 'SYSTEM_BRAND_ASSETS', $2, 'ACTIVE', $3, $4, $5, $6, 'image/png',
                 'brand.png', 1, $7, $8, $9, 'ADMIN', 'admin-extras-test',
                 'system:assets:read', 'PUBLIC_BRAND', '{}'::jsonb, now(), now(), now(), now())",
    )
    .bind(object_id)
    .bind(&storage_key)
    .bind(&metadata.plaintext_sha256)
    .bind(plaintext.len() as i64)
    .bind(metadata.chunk_size as i32)
    .bind(metadata.chunk_count as i32)
    .bind(&wrapped)
    .bind(&nonce)
    .bind(&prefix)
    .execute(&state.pools.main)
    .await
    .expect("insert storage object");
    sqlx::query(
        "INSERT INTO storage_object_locks
            (object_id, holder_type, holder_id, acquired_by_actor_id, acquired_reason)
         VALUES ($1, 'CATALOG_ASSET', $2, 'admin-extras-test', 'CATALOG_ASSET_UPLOADED')",
    )
    .bind(object_id)
    .bind(asset_id.to_string())
    .execute(&state.pools.main)
    .await
    .expect("insert lock");
    let name = format!("extras-asset-{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO assets (id, created_at, updated_at, name, mime, size_bytes, storage_key,
                             storage_object_id, sha256)
         VALUES ($1, now(), now(), $2, 'IMAGE_PNG'::\"AssetMime\", $3, $4, $5, $6)",
    )
    .bind(asset_id)
    .bind(&name)
    .bind(plaintext.len() as i32)
    .bind(&storage_key)
    .bind(object_id)
    .bind(random_hex())
    .execute(&state.pools.main)
    .await
    .expect("insert asset");

    let Some(actor) = insert_user(&state, &["gateway:read"]).await else {
        eprintln!("SKIP: could not create the actor");
        return;
    };
    let token = session_token(actor);
    let request = test::TestRequest::default()
        .method(Method::from_bytes(b"GET").expect("method"))
        .uri(&format!("/internal/admin/assets/{asset_id}/content"))
        .header("authorization", format!("Bearer {token}"))
        .to_http_request();
    let raw_response = crate::app::dispatch(
        state.clone(),
        request,
        ntex::web::types::Payload(ntex::http::Payload::None),
    )
    .await;
    let status = raw_response.status().as_u16();
    let content_type = raw_response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let disposition = raw_response
        .headers()
        .get("content-disposition")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = test::read_body(raw_response).await;
    assert_eq!(status, 200);
    assert_eq!(content_type.as_deref(), Some("image/png"));
    assert!(
        disposition
            .as_deref()
            .unwrap_or_default()
            .contains(&format!("{name}.png")),
        "{disposition:?}"
    );
    assert_eq!(body.as_ref(), plaintext);
    let access_logged: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM storage_object_access_logs
          WHERE object_id = $1 AND allowed = true AND action = 'READ_AUTHORIZED'",
    )
    .bind(object_id)
    .fetch_one(&state.pools.main)
    .await
    .unwrap_or(0);
    assert_eq!(access_logged, 1);

    let _ = sqlx::query("DELETE FROM storage_object_access_logs WHERE object_id = $1")
        .bind(object_id)
        .execute(&state.pools.main)
        .await;
    let _ = sqlx::query("DELETE FROM storage_object_locks WHERE object_id = $1")
        .bind(object_id)
        .execute(&state.pools.main)
        .await;
    let _ = sqlx::query("DELETE FROM assets WHERE id = $1")
        .bind(asset_id)
        .execute(&state.pools.main)
        .await;
    let _ = sqlx::query("DELETE FROM storage_objects WHERE id = $1")
        .bind(object_id)
        .execute(&state.pools.main)
        .await;
    delete_user(&state, actor).await;
    let _ = std::fs::remove_dir_all(&root);
    match previous_root {
        Some(value) => std::env::set_var("OBJECT_STORAGE_ROOT_DIR", value),
        None => std::env::remove_var("OBJECT_STORAGE_ROOT_DIR"),
    }
    match previous_keyring {
        Some(value) => std::env::set_var("OBJECT_STORAGE_KEK_KEYRING", value),
        None => std::env::remove_var("OBJECT_STORAGE_KEK_KEYRING"),
    }
    match previous_daemon {
        Some(value) => std::env::set_var("OBJECT_STORAGE_DAEMON_URL", value),
        None => std::env::remove_var("OBJECT_STORAGE_DAEMON_URL"),
    }
}

#[tokio::test]
async fn kyb_content_refuses_an_unscanned_document() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let merchant: Option<Uuid> = sqlx::query_scalar("SELECT id FROM merchants LIMIT 1")
        .fetch_optional(&state.pools.main)
        .await
        .ok()
        .flatten();
    let Some(merchant) = merchant else {
        eprintln!("SKIP: the test database has no merchant");
        return;
    };
    let document = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO kyb_documents (id, created_at, updated_at, merchant_id, subject_type,
                                    subject_id, doc_type, storage_key, original_file_name, sha256,
                                    mime, size_bytes, av_status, status)
         VALUES ($1, now(), now(), $2, 'MERCHANT'::\"KybSubjectType\", $3,
                 'OTHER'::\"KybDocumentType\", 'legacy/key', 'doc.pdf', $4, 'application/pdf', 10,
                 'PENDING'::\"AvStatus\", 'UPLOADED'::\"KybDocumentStatus\")",
    )
    .bind(document)
    .bind(merchant)
    .bind(merchant.to_string())
    .bind(random_hex())
    .execute(&state.pools.main)
    .await
    .expect("kyb fixture");

    let response = call(
        &state,
        &format!("/internal/admin/kyb-documents/{document}/content"),
        &["kyb:read"],
    )
    .await;
    assert_eq!(response.status, 409);
    assert_eq!(response.body["error"]["code"], "KIB_DOCUMENT_NOT_SCANNED");

    let missing = call(
        &state,
        &format!("/internal/admin/assets/{}/content", Uuid::new_v4()),
        &["gateway:read"],
    )
    .await;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.body["error"]["code"], "ASSET_NOT_FOUND");

    sqlx::query("DELETE FROM kyb_documents WHERE id = $1")
        .bind(document)
        .execute(&state.pools.main)
        .await
        .expect("cleanup kyb");
}

/* ---------------------------------------------------------------- backups */

#[tokio::test]
async fn backups_catalog_and_overview_use_the_local_rows_when_the_daemon_is_absent() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let _guard = STORAGE_ENV_LOCK.lock().await;
    let previous = std::env::var("BACKUP_DAEMON_URL").ok();
    std::env::remove_var("BACKUP_DAEMON_URL");

    let run = Uuid::new_v4();
    let drill = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO backup_catalog_runs (id, target, kind, engine, status, started_at,
                                          completed_at, duration_ms, size_bytes, start_lsn,
                                          end_lsn, storage_targets, error_message)
         VALUES ($1, 'postgres_core', 'full', 'pg-native', 'PASSED', now() - interval '1 hour',
                 now(), 1234, 4096, '0/1', '0/2', '[\"local\"]'::jsonb, NULL)",
    )
    .bind(run)
    .execute(&state.pools.main)
    .await
    .expect("run fixture");
    sqlx::query(
        "INSERT INTO backup_restore_drills (id, status, started_at, completed_at, duration_ms,
                                            target_time, replayed_lsn, double_entry_drift,
                                            balance_mismatches, audit_broken_links,
                                            journal_line_count, checkpoints_json)
         VALUES ($1, 'PASSED', now() - interval '1 hour', now(), 999, now() - interval '2 hours',
                 '0/3', 0, 0, 0, 100,
                 '{\"checks\":{\"doubleEntry\":{\"ok\":true,\"detail\":\"ok\"},\"balanceParity\":{\"ok\":true,\"detail\":\"ok\"},\"auditChain\":{\"ok\":true,\"detail\":\"ok\"}}}'::jsonb)",
    )
    .bind(drill)
    .execute(&state.pools.main)
    .await
    .expect("drill fixture");

    let catalog = call(
        &state,
        "/internal/admin/system/backups/catalog",
        &["security:read"],
    )
    .await;
    assert_eq!(catalog.status, 200, "{:?}", catalog.body);
    let runs = catalog.body["runs"].as_array().cloned().unwrap_or_default();
    let our_run = runs
        .iter()
        .find(|entry| entry["id"] == run.to_string())
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(our_run["sizeBytes"], 4096);
    assert_eq!(our_run["engine"], "pg-native");
    let drills = catalog.body["drills"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let our_drill = drills
        .iter()
        .find(|entry| entry["id"] == drill.to_string())
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(our_drill["journalLineCount"], 100);
    assert_eq!(our_drill["checks"]["doubleEntry"]["ok"], true);

    let overview = call(
        &state,
        "/internal/admin/system/backups/overview",
        &["gateway:read"],
    )
    .await;
    assert_eq!(overview.status, 200, "{:?}", overview.body);
    assert_eq!(overview.body["configured"], false);
    assert_eq!(overview.body["daemonReachable"], false);
    assert_eq!(overview.body["engineMode"], "none");
    assert_eq!(overview.body["walArchiveHealthy"], false);
    assert_eq!(overview.body["wal"]["archiveLagSeconds"], 0);
    assert!(overview.body["latestDrill"]["id"] == drill.to_string());
    assert!(overview.body["localCatalog"]["backups"]
        .as_array()
        .is_some_and(|entries| entries.iter().any(|entry| entry["id"] == run.to_string())));

    let _ = sqlx::query("DELETE FROM backup_restore_drills WHERE id = $1")
        .bind(drill)
        .execute(&state.pools.main)
        .await;
    let _ = sqlx::query("DELETE FROM backup_catalog_runs WHERE id = $1")
        .bind(run)
        .execute(&state.pools.main)
        .await;
    match previous {
        Some(value) => std::env::set_var("BACKUP_DAEMON_URL", value),
        None => std::env::remove_var("BACKUP_DAEMON_URL"),
    }
}

/* ---------------------------------------------------------------- exports */

#[tokio::test]
async fn users_export_forwards_filters_and_writes_the_audit_row() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let target = Uuid::new_v4();
    let email = format!("extras-export-{target}@example.test");
    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, is_maker, is_checker,
                            mfa_required, status)
         VALUES ($1, now(), $2, 'COMPLIANCE'::\"UserRole\", '{}'::jsonb, true, false, false,
                 'ACTIVE'::\"UserStatus\")",
    )
    .bind(target)
    .bind(&email)
    .execute(&state.pools.main)
    .await
    .expect("user fixture");

    let actor = insert_user(&state, &["user:read"]).await.expect("actor");
    let response = call_as(
        &state,
        &format!("/internal/admin/users/export?search={target}&role=COMPLIANCE"),
        actor,
    )
    .await;
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(response.body["total"], 1);
    assert_eq!(response.body["exported"], 1);
    assert_eq!(response.body["truncated"], false);
    assert_eq!(response.body["users"][0]["email"], email);
    assert_eq!(response.body["users"][0]["role"], "COMPLIANCE");
    assert_eq!(audit_count(&state, actor, "ADMIN_USERS_EXPORTED").await, 1);

    let denied = call(
        &state,
        &format!("/internal/admin/users/export?search={target}"),
        &["gateway:read"],
    )
    .await;
    assert_eq!(denied.status, 403);
    assert_eq!(denied.body["error"]["code"], "AUTHORITY_REQUIRED");

    purge_audit(&state, actor).await;
    delete_user(&state, actor).await;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(target)
        .execute(&state.pools.main)
        .await
        .expect("cleanup user");
}

#[tokio::test]
async fn gateways_export_returns_the_ts_projection_and_audits() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let Some(fixture) = insert_gateway(&state).await else {
        eprintln!("SKIP: could not create the gateway fixture");
        return;
    };
    let actor = insert_user(&state, &["gateway:read"]).await.expect("actor");
    let response = call_as(
        &state,
        &format!("/internal/admin/gateways/export?search={}", fixture.code),
        actor,
    )
    .await;
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert_eq!(response.body["total"], 1, "{:?}", response.body);
    let gateway = &response.body["gateways"][0];
    assert_eq!(gateway["code"], fixture.code);
    assert_eq!(gateway["activeVersion"], Value::Null);
    assert_eq!(gateway["pendingVersion"], Value::Null);
    assert_eq!(gateway["versionCount"], 1);
    assert_eq!(gateway["routeHealth"]["healthy"], 0);
    assert_eq!(audit_count(&state, actor, "GATEWAYS_EXPORTED").await, 1);

    // The summary export carries `exportedAt` and writes its own action.
    let summary = call_as(&state, "/internal/admin/gateways/summary/export", actor).await;
    assert_eq!(summary.status, 200, "{:?}", summary.body);
    assert!(summary.body["exportedAt"].is_string());
    assert!(summary.body["total"].as_i64().unwrap_or(0) >= 1);
    assert_eq!(
        audit_count(&state, actor, "GATEWAY_SUMMARY_EXPORTED").await,
        1
    );

    purge_audit(&state, actor).await;
    delete_user(&state, actor).await;
    remove_gateway(&state, &fixture).await;
}

#[tokio::test]
async fn settings_export_redacts_secrets_and_audits() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let version = i32::MAX;
    sqlx::query(
        "INSERT INTO platform_settings (id, created_at, updated_at, key, scope, value_json,
                                        version, source, effective_from)
         VALUES ($1, now(), now(), 'communication.email', 'PLATFORM',
                 '{\"smtpHost\":\"mail.test\",\"smtpPassword\":\"plain-secret\"}'::jsonb, $2,
                 'ADMIN', now())",
    )
    .bind(Uuid::new_v4())
    .bind(version)
    .execute(&state.pools.main)
    .await
    .expect("setting fixture");

    let actor = insert_user(&state, &["settings:read"])
        .await
        .expect("actor");
    let response = call_as(&state, "/internal/admin/settings/export", actor).await;
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert!(response.body["exportedAt"].is_string());
    let settings = response.body["settings"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let email = settings
        .iter()
        .find(|entry| entry["key"] == "communication.email")
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(email["valueJson"]["smtpPassword"], "<redacted>");
    assert_eq!(email["valueJson"]["smtpHost"], "mail.test");
    assert_eq!(
        audit_count(&state, actor, "PLATFORM_SETTINGS_EXPORTED").await,
        1
    );

    purge_audit(&state, actor).await;
    delete_user(&state, actor).await;
    sqlx::query("DELETE FROM platform_settings WHERE key = 'communication.email' AND version = $1")
        .bind(version)
        .execute(&state.pools.main)
        .await
        .expect("cleanup setting");
}

#[tokio::test]
async fn recent_activity_export_honours_the_limit_and_audits() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let actor = insert_user(&state, &["security:read"])
        .await
        .expect("actor");
    let response = call_as(
        &state,
        "/internal/admin/stats/recent-activity/export?limit=1",
        actor,
    )
    .await;
    assert_eq!(response.status, 200, "{:?}", response.body);
    assert!(response.body["recentActivity"].is_array());
    assert!(response.body["exported"].as_u64().unwrap_or(2) <= 1);
    assert!(response.body["exportedAt"].is_string());
    assert_eq!(
        audit_count(&state, actor, "DASHBOARD_RECENT_ACTIVITY_EXPORTED").await,
        1
    );
    purge_audit(&state, actor).await;
    delete_user(&state, actor).await;
}

#[tokio::test]
async fn gateway_health_answers_404_for_an_unknown_gateway() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let response = call(
        &state,
        &format!("/internal/admin/gateways/{}/health", Uuid::new_v4()),
        &["gateway:read"],
    )
    .await;
    assert_eq!(response.status, 404);
    assert_eq!(response.body["error"]["code"], "GATEWAY_NOT_FOUND");
}
