//! DB-gated tests of the admin finance ledger and audit-log GET routes (P4-T04).
//!
//! They drive the real dispatcher for static paths and the real mounted handler + `authorize` for
//! `:id` paths (the P3 dispatcher still matches paths exactly; the coordinator switches it to
//! pattern matching). The database is `PG_TEST_DATABASE_URL`, `DATABASE_URL` or the project default
//! (`postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`, schema 46). When it is
//! unreachable every test prints a skip line and returns.
//!
//! Fixtures use fresh UUIDs; the cleanup removes every row they created (the append-only journal and
//! audit tables are deleted inside the documented `pgw.ledger_maintenance` maintenance transaction).

use std::sync::Arc;

use chrono::{Duration, Utc};
use core_rs::config::CoreConfig;
use core_rs::routes::{self, Handler, MountedRoute};
use core_rs::state::AppState;
use ntex::http::header::HeaderMap;
use ntex::http::Method;
use ntex::web::test;
use pg_domain_auth::{sign_session_at, Channel, SessionClaims};
use serde_json::{json, Value};
use uuid::Uuid;

const MASTER_KEY: &str = "core-rs-admin-ledger-test-key-0123456789";
const DEFAULT_URL: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

fn database_url() -> String {
    std::env::var("PG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_URL.to_owned())
}

async fn state_or_skip() -> Option<Arc<AppState>> {
    let url = database_url();
    match AppState::connect(CoreConfig::for_tests(&url, MASTER_KEY)).await {
        Ok(state) => Some(state),
        Err(error) => {
            eprintln!("SKIP: PostgreSQL is unreachable at {url}: {error}");
            None
        }
    }
}

struct Response {
    status: u16,
    headers: HeaderMap,
    body: String,
}

impl Response {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|_| panic!("expected JSON body, got {:?}", self.body))
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }
}

/// A `:param` segment matcher (the coordinator's dispatcher will do this natively).
fn pattern_matches(pattern: &str, path: &str) -> bool {
    let pattern: Vec<&str> = pattern.trim_matches('/').split('/').collect();
    let path: Vec<&str> = path.trim_matches('/').split('/').collect();
    pattern.len() == path.len()
        && pattern
            .iter()
            .zip(path.iter())
            .all(|(expected, actual)| expected.starts_with(':') || expected == actual)
}

fn test_request(method: &str, path: &str, headers: &[(&str, String)]) -> test::TestRequest {
    let mut request = test::TestRequest::default()
        .method(Method::from_bytes(method.as_bytes()).expect("method"))
        .uri(path);
    for (name, value) in headers {
        request = request.header(*name, value.as_str());
    }
    request
}

async fn call(
    state: &Arc<AppState>,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
) -> Response {
    let path_only = path.split('?').next().unwrap_or(path);
    let request = test_request(method, path, headers);
    if let Some(route) = routes::find(method, path_only) {
        return dispatch(state, request.to_http_request(), route).await;
    }
    let route = routes::mounted_routes()
        .into_iter()
        .find(|route| {
            route.policy.method.eq_ignore_ascii_case(method)
                && pattern_matches(&route.policy.path, path_only)
        })
        .unwrap_or_else(|| panic!("no mounted route for {method} {path_only}"));
    let http_request = request.to_http_request();
    let principal = match routes::authorize(state.as_ref(), &route, &http_request).await {
        Ok(principal) => principal,
        Err(error) => {
            return Response {
                status: error.status,
                headers: HeaderMap::new(),
                body: error.to_json(),
            };
        }
    };
    let response = dispatch_custom(state, &route, http_request, principal).await;
    collect(response).await
}

async fn dispatch(
    state: &Arc<AppState>,
    request: ntex::web::HttpRequest,
    _route: MountedRoute,
) -> Response {
    let response = core_rs::app::dispatch(
        state.clone(),
        request,
        ntex::web::types::Payload(ntex::http::Payload::None),
    )
    .await;
    collect(response).await
}

async fn dispatch_custom(
    state: &Arc<AppState>,
    route: &MountedRoute,
    request: ntex::web::HttpRequest,
    principal: Option<pg_domain_auth::Principal>,
) -> ntex::web::HttpResponse {
    match route.handler {
        Handler::Custom(handler) => {
            handler(
                state.as_ref(),
                &request,
                principal.as_ref(),
                ntex::web::types::Payload(ntex::http::Payload::None),
            )
            .await
        }
        _ => panic!("expected a custom handler"),
    }
}

async fn collect(response: ntex::web::HttpResponse) -> Response {
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = test::read_body(response).await;
    Response {
        status,
        headers,
        body: String::from_utf8_lossy(&body).to_string(),
    }
}

async fn insert_user(state: &AppState, authorities: Value) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let email = format!("{id}@admin-ledger.integration");
    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, is_maker, is_checker,
                            mfa_required, status)
         VALUES ($1, now(), $2, 'COMPLIANCE'::\"UserRole\", $3::jsonb, true, true, false, 'ACTIVE'::\"UserStatus\")",
    )
    .bind(id)
    .bind(&email)
    .bind(authorities)
    .execute(&state.pools.main)
    .await
    .expect("insert user");
    (id, email)
}

fn session(user_id: Uuid) -> String {
    let now = Utc::now();
    let mut claims = SessionClaims::new(user_id.to_string(), "COMPLIANCE")
        .with_authorities(["finance:read", "security:read"])
        .with_channel(Channel::Admin)
        .expect("admin channel");
    claims.jti = Some(Uuid::new_v4().to_string());
    claims.iat = Some(now.timestamp());
    claims.exp = Some(now.timestamp() + pg_domain_auth::SESSION_TTL_SECONDS);
    sign_session_at(&claims, MASTER_KEY, now).expect("sign")
}

fn auth(token: &str) -> Vec<(&'static str, String)> {
    vec![("authorization", format!("Bearer {token}"))]
}

struct Fixture {
    treasury: Uuid,
    income: Uuid,
    entries: Vec<Uuid>,
    marker: String,
}

async fn insert_fixture(state: &AppState) -> Fixture {
    let marker = format!("it-admin-ledger-{}", Uuid::new_v4());
    let treasury = Uuid::new_v4();
    let income = Uuid::new_v4();
    let now = Utc::now().naive_utc();
    sqlx::query(
        "INSERT INTO gl_accounts (id, created_at, updated_at, account_type, currency, shard_count)
         VALUES ($1, $2, $3, 'TREASURY'::\"GlAccountType\", 'LYD', 2)",
    )
    .bind(treasury)
    .bind(now)
    .bind(now)
    .execute(&state.pools.main)
    .await
    .expect("insert treasury");
    sqlx::query(
        "INSERT INTO gl_accounts (id, created_at, updated_at, account_type, currency, shard_count)
         VALUES ($1, $2, $3, 'PLATFORM_INCOME'::\"GlAccountType\", 'LYD', 1)",
    )
    .bind(income)
    .bind(now)
    .bind(now)
    .execute(&state.pools.main)
    .await
    .expect("insert income");
    sqlx::query(
        "UPDATE gl_account_shards
           SET current_balance = 175.0000, line_seq = 3, updated_at = now()
         WHERE gl_account_id = $1 AND shard_id = 0",
    )
    .bind(treasury)
    .execute(&state.pools.main)
    .await
    .expect("update treasury shard 0");
    sqlx::query(
        "UPDATE gl_account_shards
           SET current_balance = 0.0000, line_seq = 0, updated_at = now()
         WHERE gl_account_id = $1 AND shard_id = 1",
    )
    .bind(treasury)
    .execute(&state.pools.main)
    .await
    .expect("update treasury shard 1");
    sqlx::query(
        "UPDATE gl_account_shards
           SET current_balance = -175.0000, line_seq = 3, updated_at = now()
         WHERE gl_account_id = $1 AND shard_id = 0",
    )
    .bind(income)
    .execute(&state.pools.main)
    .await
    .expect("update income shard 0");
    sqlx::query(
        "INSERT INTO gl_shard_checkpoints
           (gl_account_id, shard_id, checkpoint_balance, checkpoint_seq, checkpoint_at, status,
            consecutive_failures)
         VALUES ($1, 0, 100.0000, 1, now(), 'OK', 0)",
    )
    .bind(treasury)
    .execute(&state.pools.main)
    .await
    .expect("insert checkpoint");

    let mut entries = Vec::new();
    let amounts = [100_i64, 50, 25];
    for (index, amount) in amounts.iter().enumerate() {
        let entry = Uuid::new_v4();
        entries.push(entry);
        let created = now - Duration::seconds(10 - index as i64);
        let ref_id = format!("{marker}-{index}");
        sqlx::query(
            "INSERT INTO journal_entries (id, created_at, updated_at, ref_type, ref_id, description)
             VALUES ($1, $2, $2, 'PAYMENT_ATTEMPT'::\"JournalRefType\", $3, $4)",
        )
        .bind(entry)
        .bind(created)
        .bind(&ref_id)
        .bind(format!("{marker} fixture {index}"))
        .execute(&state.pools.main)
        .await
        .expect("insert entry");
        let line = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO journal_lines
               (id, created_at, updated_at, entry_id, gl_account_id, direction, amount, shard_id, shard_seq)
             VALUES ($1, $2, $2, $3, $4, 'DEBIT'::\"JournalDirection\", $5, 0, $6)",
        )
        .bind(line)
        .bind(created)
        .bind(entry)
        .bind(treasury)
        .bind(*amount as i32)
        .bind((index + 1) as i64)
        .execute(&state.pools.main)
        .await
        .expect("insert debit line");
        sqlx::query(
            "INSERT INTO journal_lines
               (id, created_at, updated_at, entry_id, gl_account_id, direction, amount, shard_id, shard_seq)
             VALUES ($1, $2, $2, $3, $4, 'CREDIT'::\"JournalDirection\", $5, 0, $6)",
        )
        .bind(Uuid::new_v4())
        .bind(created)
        .bind(entry)
        .bind(income)
        .bind(*amount as i32)
        .bind((index + 1) as i64)
        .execute(&state.pools.main)
        .await
        .expect("insert credit line");
    }
    Fixture {
        treasury,
        income,
        entries,
        marker,
    }
}

async fn insert_audit_rows(state: &AppState, actor: Uuid, marker: &str) -> Vec<Uuid> {
    let now = Utc::now().naive_utc();
    let mut ids = Vec::new();
    for index in 0..3 {
        let id = Uuid::new_v4();
        ids.push(id);
        sqlx::query(
            "INSERT INTO audit_log
               (id, created_at, updated_at, actor_id, role, action, entity_type, entity_id,
                before_json, after_json)
             VALUES ($1, $2, $2, $3, 'COMPLIANCE', $4, 'TEST_ENTITY', $5, '{}'::jsonb, '{}'::jsonb)",
        )
        .bind(id)
        .bind(now - Duration::seconds(10 - index))
        .bind(actor)
        .bind(format!("TEST_ADMIN_LEDGER_{marker}_{index}"))
        .bind(format!("{marker}-{index}"))
        .execute(&state.pools.main)
        .await
        .expect("insert audit row");
    }
    ids
}

async fn cleanup(state: &AppState, users: &[Uuid], fixture: Option<&Fixture>) {
    let mut tx = state.pools.main.begin().await.expect("begin cleanup");
    sqlx::query("SET LOCAL pgw.ledger_maintenance = 'on'")
        .execute(&mut *tx)
        .await
        .expect("maintenance GUC");
    sqlx::query("DELETE FROM audit_outbox WHERE actor_id = ANY($1::uuid[])")
        .bind(users)
        .execute(&mut *tx)
        .await
        .expect("delete audit outbox");
    sqlx::query("DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])")
        .bind(users)
        .execute(&mut *tx)
        .await
        .expect("delete audit log");
    if let Some(fixture) = fixture {
        let accounts = vec![fixture.treasury, fixture.income];
        sqlx::query("DELETE FROM journal_lines WHERE gl_account_id = ANY($1::uuid[])")
            .bind(&accounts)
            .execute(&mut *tx)
            .await
            .expect("delete journal lines");
        sqlx::query("DELETE FROM journal_entries WHERE id = ANY($1::uuid[])")
            .bind(fixture.entries.as_slice())
            .execute(&mut *tx)
            .await
            .expect("delete journal entries");
        sqlx::query("DELETE FROM gl_shard_checkpoints WHERE gl_account_id = ANY($1::uuid[])")
            .bind(&accounts)
            .execute(&mut *tx)
            .await
            .expect("delete checkpoints");
        sqlx::query("DELETE FROM gl_account_shards WHERE gl_account_id = ANY($1::uuid[])")
            .bind(&accounts)
            .execute(&mut *tx)
            .await
            .expect("delete shards");
        sqlx::query("DELETE FROM gl_accounts WHERE id = ANY($1::uuid[])")
            .bind(&accounts)
            .execute(&mut *tx)
            .await
            .expect("delete accounts");
    }
    tx.commit().await.expect("commit cleanup");
    for user in users {
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user)
            .execute(&state.pools.main)
            .await
            .expect("delete user");
    }
}

#[tokio::test]
async fn journal_entries_list_filters_and_paginates() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_fixture(&state).await;
    let (user, _) = insert_user(&state, json!({"finance:read": true})).await;
    let token = session(user);
    let headers = auth(&token);

    let first = call(
        &state,
        "GET",
        "/internal/admin/finance/journal-entries?pageSize=2&page=1",
        &headers,
    )
    .await;
    assert_eq!(first.status, 200, "{}", first.body);
    let body = first.json();
    assert!(body["total"].as_i64().unwrap_or(0) >= 3);
    assert_eq!(body["page"], 1);
    assert_eq!(body["pageSize"], 2);
    assert_eq!(body["journalEntries"].as_array().map(Vec::len), Some(2));
    assert!(
        body["nextCursor"].is_string(),
        "keyset cursor on a full page"
    );

    let filtered = call(
        &state,
        "GET",
        &format!(
            "/internal/admin/finance/journal-entries?search={}&glAccountId={}&refType=PAYMENT_ATTEMPT",
            fixture.marker, fixture.treasury
        ),
        &headers,
    )
    .await;
    assert_eq!(filtered.status, 200, "{}", filtered.body);
    let body = filtered.json();
    assert_eq!(body["total"], 3);
    let entries = body["journalEntries"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(entries.len(), 3);
    let mut debits: Vec<&str> = entries
        .iter()
        .filter_map(|entry| entry["totalDebit"].as_str())
        .collect();
    debits.sort_unstable();
    assert_eq!(debits, vec!["100.0000", "25.0000", "50.0000"]);
    for entry in &entries {
        assert_eq!(entry["currency"], "LYD");
        assert_eq!(entry["balanced"], true);
        assert!(entry["id"].as_str().is_some());
    }

    let empty = call(
        &state,
        "GET",
        "/internal/admin/finance/journal-entries?search=no-such-journal-entry",
        &headers,
    )
    .await;
    assert_eq!(empty.status, 200);
    assert_eq!(empty.json()["total"], 0);
    assert_eq!(empty.json()["journalEntries"], json!([]));

    let no_total = call(
        &state,
        "GET",
        &format!(
            "/internal/admin/finance/journal-entries?search={}&includeTotal=false",
            fixture.marker
        ),
        &headers,
    )
    .await;
    assert_eq!(no_total.status, 200);
    assert_eq!(no_total.json()["total"], Value::Null);

    cleanup(&state, &[user], Some(&fixture)).await;
}

#[tokio::test]
async fn journal_entry_detail_and_404() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_fixture(&state).await;
    let (user, _) = insert_user(&state, json!({"finance:read": true})).await;
    let headers = auth(&session(user));

    let response = call(
        &state,
        "GET",
        &format!(
            "/internal/admin/finance/journal-entries/{}",
            fixture.entries[0]
        ),
        &headers,
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["totalDebit"], "100.0000");
    assert_eq!(body["totalCredit"], "100.0000");
    assert_eq!(body["balanced"], true);
    assert_eq!(body["currency"], "LYD");
    assert_eq!(body["reference"]["route"], "attempt");
    let lines = body["lines"].as_array().cloned().unwrap_or_default();
    assert_eq!(lines.len(), 2);
    let debit = lines
        .iter()
        .find(|line| line["direction"] == "DEBIT")
        .expect("debit line");
    let credit = lines
        .iter()
        .find(|line| line["direction"] == "CREDIT")
        .expect("credit line");
    assert_eq!(debit["amount"], "100.0000");
    assert_eq!(debit["glAccount"]["accountType"], "TREASURY");
    assert_eq!(credit["amount"], "100.0000");
    assert_eq!(credit["glAccount"]["accountType"], "PLATFORM_INCOME");

    let missing = call(
        &state,
        "GET",
        &format!("/internal/admin/finance/journal-entries/{}", Uuid::new_v4()),
        &headers,
    )
    .await;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json()["code"], "JOURNAL_ENTRY_NOT_FOUND");

    cleanup(&state, &[user], Some(&fixture)).await;
}

#[tokio::test]
async fn gl_account_snapshot_shards_and_checkpoints() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_fixture(&state).await;
    let (user, _) = insert_user(&state, json!({"finance:read": true})).await;
    let headers = auth(&session(user));

    let response = call(
        &state,
        "GET",
        &format!("/internal/admin/finance/gl-accounts/{}", fixture.treasury),
        &headers,
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["account"]["accountType"], "TREASURY");
    assert_eq!(body["account"]["currency"], "LYD");
    assert_eq!(body["account"]["checkpointBalance"], "100.0000");
    assert!(body["account"]["checkpointAt"].is_string());
    assert_eq!(body["liveBalance"], "175.0000");
    assert_eq!(body["naturalBalance"], "175.0000");
    assert_eq!(body["balanceSource"], "shards");
    assert_eq!(body["checkpoint"]["status"], "OK");
    assert_eq!(body["checkpoint"]["pendingLines"], "2");
    assert_eq!(body["checkpoint"]["shardsBehind"], 1);
    let shards = body["shards"].as_array().cloned().unwrap_or_default();
    assert_eq!(shards.len(), 2);
    assert_eq!(shards[0]["shardId"], 0);
    assert_eq!(shards[0]["lineSeq"], "3");
    assert_eq!(shards[0]["checkpointSeq"], "1");
    assert_eq!(shards[0]["pendingLines"], "2");
    assert_eq!(shards[0]["checkpointBalance"], "100.0000");

    // A credit-normal account keeps the TS double-sign convention: `liveBalance` is debit-positive
    // while `naturalBalance` is the natural sign.
    let income = call(
        &state,
        "GET",
        &format!("/internal/admin/finance/gl-accounts/{}", fixture.income),
        &headers,
    )
    .await;
    assert_eq!(income.status, 200);
    assert_eq!(income.json()["liveBalance"], "-175.0000");
    assert_eq!(income.json()["naturalBalance"], "175.0000");

    let missing = call(
        &state,
        "GET",
        &format!("/internal/admin/finance/gl-accounts/{}", Uuid::new_v4()),
        &headers,
    )
    .await;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json()["code"], "GL_ACCOUNT_NOT_FOUND");

    cleanup(&state, &[user], Some(&fixture)).await;
}

#[tokio::test]
async fn account_lines_paginate_and_filter() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_fixture(&state).await;
    let (user, _) = insert_user(&state, json!({"finance:read": true})).await;
    let headers = auth(&session(user));
    let path = format!(
        "/internal/admin/finance/gl-accounts/{}/lines",
        fixture.treasury
    );

    let first = call(&state, "GET", &format!("{path}?pageSize=2"), &headers).await;
    assert_eq!(first.status, 200, "{}", first.body);
    let body = first.json();
    assert_eq!(body["total"], 3);
    assert_eq!(body["pageSize"], 2);
    assert_eq!(body["lines"].as_array().map(Vec::len), Some(2));
    assert_eq!(body["totals"]["lineCount"], 3);
    assert_eq!(body["totals"]["totalDebit"], "175.0000");
    assert_eq!(body["totals"]["totalCredit"], "0.0000");
    assert_eq!(body["totals"]["netDebit"], "175.0000");
    assert!(body["nextCursor"].is_string());

    let debit = call(&state, "GET", &format!("{path}?direction=DEBIT"), &headers).await;
    assert_eq!(debit.status, 200);
    assert_eq!(debit.json()["total"], 3);

    let credit = call(&state, "GET", &format!("{path}?direction=CREDIT"), &headers).await;
    assert_eq!(credit.status, 200);
    assert_eq!(credit.json()["total"], 0);
    assert_eq!(credit.json()["lines"], json!([]));

    let other_type = call(
        &state,
        "GET",
        &format!("{path}?refType=ADJUSTMENT"),
        &headers,
    )
    .await;
    assert_eq!(other_type.status, 200);
    assert_eq!(other_type.json()["total"], 0);

    let search = call(
        &state,
        "GET",
        &format!("{path}?search={}", fixture.marker),
        &headers,
    )
    .await;
    assert_eq!(search.status, 200);
    assert_eq!(search.json()["total"], 3);

    let amount_sort = call(
        &state,
        "GET",
        &format!("{path}?sortKey=amount&sortDirection=asc&pageSize=1"),
        &headers,
    )
    .await;
    assert_eq!(amount_sort.status, 200);
    assert_eq!(amount_sort.json()["lines"][0]["amount"], "25.0000");

    let invalid_direction = call(
        &state,
        "GET",
        &format!("{path}?direction=SIDEWAYS"),
        &headers,
    )
    .await;
    assert_eq!(invalid_direction.status, 400);
    assert_eq!(invalid_direction.json()["code"], "INVALID_FILTER");

    let missing = call(
        &state,
        "GET",
        &format!(
            "/internal/admin/finance/gl-accounts/{}/lines",
            Uuid::new_v4()
        ),
        &headers,
    )
    .await;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json()["code"], "GL_ACCOUNT_NOT_FOUND");

    cleanup(&state, &[user], Some(&fixture)).await;
}

#[tokio::test]
async fn repair_plan_is_read_only_and_serialised() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let fixture = insert_fixture(&state).await;
    let (user, _) = insert_user(&state, json!({"finance:read": true})).await;
    let headers = auth(&session(user));

    let response = call(
        &state,
        "GET",
        &format!(
            "/internal/admin/finance/gl-accounts/{}/shards/0/repair-plan",
            fixture.treasury
        ),
        &headers,
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["needsRepair"], false);
    assert_eq!(body["kind"], Value::Null);
    assert_eq!(body["sequenceIntact"], true);
    assert_eq!(body["journal"]["total"], "175.0000");
    assert_eq!(body["journal"]["linesAfterBaseline"], "3");
    assert_eq!(body["before"]["lineSeq"], "3");
    assert_eq!(body["before"]["checkpointSeq"], "1");
    let hash = body["planHash"].as_str().unwrap_or_default();
    assert_eq!(hash.len(), 64);
    assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));

    let missing = call(
        &state,
        "GET",
        &format!(
            "/internal/admin/finance/gl-accounts/{}/shards/7/repair-plan",
            fixture.treasury
        ),
        &headers,
    )
    .await;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.json()["code"], "GL_SHARD_NOT_FOUND");

    cleanup(&state, &[user], Some(&fixture)).await;
}

#[tokio::test]
async fn audit_list_summary_detail_and_empty() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let (user, email) = insert_user(&state, json!({"security:read": true})).await;
    let marker = format!("it-audit-{}", Uuid::new_v4());
    insert_audit_rows(&state, user, &marker).await;
    let headers = auth(&session(user));

    let response = call(
        &state,
        "GET",
        &format!("/internal/admin/audit-logs?search={marker}&pageSize=2"),
        &headers,
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["total"], 3);
    assert_eq!(body["auditLogs"].as_array().map(Vec::len), Some(2));
    assert_eq!(body["auditLogs"][0]["actorEmail"], email);
    assert_eq!(body["auditLogs"][0]["entityType"], "TEST_ENTITY");

    let contains = call(
        &state,
        "GET",
        &format!("/internal/admin/audit-logs?entityType=TEST_ENTITY&search={marker}"),
        &headers,
    )
    .await;
    assert_eq!(contains.status, 200);
    assert_eq!(contains.json()["total"], 3);

    let empty = call(
        &state,
        "GET",
        "/internal/admin/audit-logs?search=no-such-audit-entry",
        &headers,
    )
    .await;
    assert_eq!(empty.status, 200);
    assert_eq!(empty.json()["total"], 0);
    assert_eq!(empty.json()["auditLogs"], json!([]));

    let summary = call(
        &state,
        "GET",
        "/internal/admin/audit-logs/summary",
        &headers,
    )
    .await;
    assert_eq!(summary.status, 200);
    let summary_body = summary.json();
    assert!(summary_body["summary"]["total"].as_i64().unwrap_or(0) >= 3);
    assert_eq!(
        summary_body["summary"]["byAction"].get(format!("TEST_ADMIN_LEDGER_{marker}_0")),
        Some(&json!(1))
    );
    assert!(
        summary_body["summary"]["byEntityType"]["TEST_ENTITY"]
            .as_i64()
            .unwrap_or(0)
            >= 3
    );

    let missing_id = Uuid::new_v4();
    let id = call(
        &state,
        "GET",
        &format!("/internal/admin/audit-logs/{missing_id}"),
        &headers,
    )
    .await;
    assert_eq!(id.status, 404);
    assert_eq!(id.json()["code"], "AUDIT_LOG_NOT_FOUND");

    let real_id = {
        let row: (Uuid,) =
            sqlx::query_as("SELECT id FROM audit_log WHERE actor_id = $1 AND action = $2 LIMIT 1")
                .bind(user)
                .bind(format!("TEST_ADMIN_LEDGER_{marker}_0"))
                .fetch_one(&state.pools.main)
                .await
                .expect("audit id");
        row.0
    };
    let detail = call(
        &state,
        "GET",
        &format!("/internal/admin/audit-logs/{real_id}"),
        &headers,
    )
    .await;
    assert_eq!(detail.status, 200, "{}", detail.body);
    assert_eq!(detail.header("cache-control"), Some("no-store"));
    assert_eq!(detail.json()["auditLog"]["id"], real_id.to_string());
    assert_eq!(detail.json()["auditLog"]["actorEmail"], email);

    cleanup(&state, &[user], None).await;
}

#[tokio::test]
async fn export_handlers_append_their_audit_rows() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let (user, _) = insert_user(&state, json!({"finance:read": true, "security:read": true})).await;
    let headers = auth(&session(user));

    let summary = call(
        &state,
        "GET",
        "/internal/admin/finance/journal-entries/summary/export?checklist=JOURNAL_SCOPE_VERIFIED",
        &headers,
    )
    .await;
    assert_eq!(summary.status, 200, "{}", summary.body);
    assert!(summary.json()["exportedAt"].is_string());

    let profitability = call(
        &state,
        "GET",
        "/internal/admin/finance/profitability/export?currency=LYD",
        &headers,
    )
    .await;
    assert_eq!(profitability.status, 200, "{}", profitability.body);
    assert!(profitability.json()["exportedAt"].is_string());

    let liquidity = call(
        &state,
        "GET",
        "/internal/admin/finance/liquidity/export?currency=LYD",
        &headers,
    )
    .await;
    assert_eq!(liquidity.status, 200, "{}", liquidity.body);
    assert!(liquidity.json()["exportedAt"].is_string());

    let invariant = call(
        &state,
        "GET",
        "/internal/admin/finance/invariant-check/export",
        &headers,
    )
    .await;
    assert_eq!(invariant.status, 200, "{}", invariant.body);
    assert!(invariant.json()["exportedAt"].is_string());

    let audit_summary = call(
        &state,
        "GET",
        "/internal/admin/audit-logs/summary/export",
        &headers,
    )
    .await;
    assert_eq!(audit_summary.status, 200, "{}", audit_summary.body);
    assert!(audit_summary.json()["exportedAt"].is_string());

    let audit_export = call(
        &state,
        "GET",
        "/internal/admin/audit-logs/export?action=JOURNAL_ENTRY_SUMMARY_EXPORTED",
        &headers,
    )
    .await;
    assert_eq!(audit_export.status, 200, "{}", audit_export.body);
    assert!(audit_export.json()["exported"].as_i64().unwrap_or(0) >= 1);

    let (audit_rows,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM audit_log WHERE actor_id = $1
           AND action IN ('JOURNAL_ENTRY_SUMMARY_EXPORTED', 'PROFITABILITY_EXPORTED',
                          'LIQUIDITY_EXPORTED', 'INVARIANT_EXPORTED',
                          'AUDIT_LOG_SUMMARY_EXPORTED')",
    )
    .bind(user)
    .fetch_one(&state.pools.main)
    .await
    .expect("count audit rows");
    assert_eq!(audit_rows, 5);

    let (outbox,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM audit_outbox WHERE actor_id = $1 AND action = 'AUDIT_LOGS_EXPORTED'",
    )
    .bind(user)
    .fetch_one(&state.pools.main)
    .await
    .expect("count audit outbox");
    assert_eq!(outbox, 1);

    cleanup(&state, &[user], None).await;
}

#[tokio::test]
async fn finance_dashboards_return_the_expected_shapes() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let (user, _) = insert_user(&state, json!({"finance:read": true})).await;
    let headers = auth(&session(user));

    let profitability = call(
        &state,
        "GET",
        "/internal/admin/finance/profitability?currency=LYD",
        &headers,
    )
    .await;
    assert_eq!(profitability.status, 200, "{}", profitability.body);
    let body = profitability.json();
    assert_eq!(body["period"], "last_30d");
    assert_eq!(body["currency"], "LYD");
    for key in [
        "grossVolume",
        "grossCommissionRevenue",
        "netContribution",
        "commissionReceivable",
        "averageTicket",
    ] {
        let value = body[key].as_str().unwrap_or_default();
        assert!(
            value.contains('.') && value.split('.').nth(1).unwrap_or_default().len() == 4,
            "{key}={value}"
        );
    }
    assert!(body["byRail"].is_array());
    assert!(body["byDay"].is_array());
    assert!(body["byGateway"].is_array());

    let empty = call(
        &state,
        "GET",
        "/internal/admin/finance/profitability?from=2000-01-01&to=2000-01-02&currency=LYD",
        &headers,
    )
    .await;
    assert_eq!(empty.status, 200);
    assert_eq!(empty.json()["succeededAttempts"], 0);
    assert_eq!(empty.json()["grossVolume"], "0.0000");

    let liquidity = call(
        &state,
        "GET",
        "/internal/admin/finance/liquidity?currency=LYD",
        &headers,
    )
    .await;
    assert_eq!(liquidity.status, 200, "{}", liquidity.body);
    let body = liquidity.json();
    assert_eq!(body["currency"], "LYD");
    assert!(body["byCurrency"].is_array());
    assert!(body["cashoutQueue"]["pending"].as_i64().is_some());
    assert!(body["clearingAgeing"].as_array().map(Vec::len) == Some(3));

    let invariant = call(
        &state,
        "GET",
        "/internal/admin/finance/invariant-check",
        &headers,
    )
    .await;
    assert_eq!(invariant.status, 200, "{}", invariant.body);
    let body = invariant.json();
    assert!(body["ok"].is_boolean());
    assert!(body["drift"].is_string());
    assert!(body["accounts"].is_array());

    let caps = call(
        &state,
        "GET",
        "/internal/admin/finance/route-caps",
        &headers,
    )
    .await;
    assert_eq!(caps.status, 200, "{}", caps.body);
    let body = caps.json();
    assert!(body["timeZone"].is_string());
    assert!(body["businessDay"]["since"].is_string());
    assert!(body["routes"].is_array());

    cleanup(&state, &[user], None).await;
}

#[tokio::test]
async fn missing_authorities_are_refused() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let (user, _) = insert_user(&state, json!({"merchant:read": true})).await;
    let headers = auth(&session(user));

    for path in [
        "/internal/admin/finance/journal-entries",
        "/internal/admin/finance/gl-accounts/00000000-0000-4000-8000-000000000000",
        "/internal/admin/audit-logs",
    ] {
        let response = call(&state, "GET", path, &headers).await;
        assert_eq!(response.status, 403, "{path}: {}", response.body);
        assert_eq!(response.json()["code"], "AUTHORITY_REQUIRED", "{path}");
    }

    cleanup(&state, &[user], None).await;
}

#[tokio::test]
async fn unauthenticated_requests_are_refused() {
    let Some(state) = state_or_skip().await else {
        return;
    };
    let response = call(
        &state,
        "GET",
        "/internal/admin/finance/invariant-check",
        &[],
    )
    .await;
    assert_eq!(response.status, 401);
    assert_eq!(response.json()["code"], "AUTH_REQUIRED");
}
