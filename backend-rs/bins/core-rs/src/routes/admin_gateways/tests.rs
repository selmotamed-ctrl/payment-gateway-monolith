//! DB-gated tests for the admin gateway/rail/route read routes.
//!
//! The suite runs against `PG_TEST_DATABASE_URL` (default
//! `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`, schema 46). When the
//! database is unreachable every test prints `SKIP:` and returns, so `cargo test -p core-rs` stays
//! green on a machine without PostgreSQL. Every fixture uses random ids and removes exactly the
//! rows it created (append-only audit tables are never written by these tests).

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{Duration as ChronoDuration, NaiveDateTime, Utc};
use ntex::web::test::TestRequest;
use ntex::web::types::Payload;
use ntex::web::HttpResponse;
use parking_lot::RwLock;
use pg_domain_auth::{ExecutionPlane, Principal, PrincipalKind};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::AuthService;
use crate::config::CoreConfig;
use crate::routes::PrincipalGuard;
use crate::state::{AppState, LeaderProbe, Pools};
use crate::workers::WorkerRegistry;

const DEFAULT_TEST_URL: &str =
    "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";
const TEST_MASTER_KEY: &str = "0123456789abcdef0123456789abcdef";
const EXPECTED_SCHEMA_VERSION: i32 = 46;

fn test_url() -> String {
    std::env::var("PG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_TEST_URL.to_owned())
}

fn request(path: &str) -> ntex::web::HttpRequest {
    TestRequest::get().uri(path).to_http_request()
}

async fn read(response: HttpResponse) -> (u16, Value) {
    let status = response.status().as_u16();
    let body = ntex::web::test::read_body(response).await;
    let value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    (status, value)
}

async fn call(future: super::super::HandlerFuture<'_>) -> (u16, Value) {
    read(future.await).await
}

fn state_for(pool: &PgPool) -> AppState {
    AppState {
        config: Arc::new(CoreConfig::for_tests(&test_url(), TEST_MASTER_KEY)),
        pools: Pools {
            main: pool.clone(),
            audit: None,
            log: None,
            leader: None,
        },
        auth: AuthService::new(
            pool.clone(),
            TEST_MASTER_KEY.to_owned(),
            ExecutionPlane::Live,
            None,
        ),
        leader: None,
        leader_probe: RwLock::new(LeaderProbe::default()),
        workers: WorkerRegistry::new(),
        log_sink: None,
        started_at: Instant::now(),
    }
}

/// A test database and everything the test created, deleted in FK order.
struct Fixture {
    pool: PgPool,
    users: Vec<Uuid>,
    gateways: Vec<Uuid>,
    versions: Vec<Uuid>,
    credential_sets: Vec<Uuid>,
    rails: Vec<Uuid>,
    rail_fields: Vec<Uuid>,
    routes: Vec<Uuid>,
    widgets: Vec<Uuid>,
    redirects: Vec<Uuid>,
    polls: Vec<Uuid>,
    samples: Vec<Uuid>,
    probes: Vec<Uuid>,
    events: Vec<Uuid>,
    merchants: Vec<Uuid>,
    gl_accounts: Vec<Uuid>,
    wallets: Vec<Uuid>,
    applications: Vec<Uuid>,
    links: Vec<Uuid>,
    attempt_groups: Vec<Uuid>,
    attempts: Vec<Uuid>,
    operator_cases: Vec<Uuid>,
    schedules: Vec<Uuid>,
    commission_profiles: Vec<Uuid>,
    velocity_rules: Vec<Uuid>,
    approvals: Vec<Uuid>,
}

impl Fixture {
    async fn connect() -> Option<Self> {
        let url = test_url();
        let pool = match sqlx::postgres::PgPoolOptions::new()
            .max_connections(4)
            .acquire_timeout(Duration::from_secs(3))
            .connect(&url)
            .await
        {
            Ok(pool) => pool,
            Err(error) => {
                eprintln!("SKIP: PostgreSQL is unreachable at {url}: {error}");
                return None;
            }
        };
        let version: Option<i32> =
            sqlx::query_scalar("SELECT version FROM schema_versions WHERE id = 1")
                .fetch_one(&pool)
                .await
                .ok();
        if version != Some(EXPECTED_SCHEMA_VERSION) {
            eprintln!(
                "SKIP: test database schema version is {version:?}, expected {EXPECTED_SCHEMA_VERSION}"
            );
            pool.close().await;
            return None;
        }
        Some(Self {
            pool,
            users: Vec::new(),
            gateways: Vec::new(),
            versions: Vec::new(),
            credential_sets: Vec::new(),
            rails: Vec::new(),
            rail_fields: Vec::new(),
            routes: Vec::new(),
            widgets: Vec::new(),
            redirects: Vec::new(),
            polls: Vec::new(),
            samples: Vec::new(),
            probes: Vec::new(),
            events: Vec::new(),
            merchants: Vec::new(),
            gl_accounts: Vec::new(),
            wallets: Vec::new(),
            applications: Vec::new(),
            links: Vec::new(),
            attempt_groups: Vec::new(),
            attempts: Vec::new(),
            operator_cases: Vec::new(),
            schedules: Vec::new(),
            commission_profiles: Vec::new(),
            velocity_rules: Vec::new(),
            approvals: Vec::new(),
        })
    }

    async fn user(&mut self) -> Uuid {
        let id = Uuid::now_v7();
        let email = format!("gw-read-{}@test.invalid", id.simple());
        sqlx::query(
            "INSERT INTO users (id, email, role, authorities_map, status, updated_at)
             VALUES ($1, $2, 'COMPLIANCE', '{}'::jsonb, 'ACTIVE', now())",
        )
        .bind(id)
        .bind(email)
        .execute(&self.pool)
        .await
        .expect("insert user");
        self.users.push(id);
        id
    }

    async fn gateway(&mut self, suffix: &str, status: &str, kind: &str) -> Uuid {
        let id = Uuid::now_v7();
        let code = format!("gw-{suffix}-{}", &id.simple().to_string()[..8]);
        sqlx::query(
            "INSERT INTO gateways
               (id, code, name, operator, country, aliases, kind, status, verification_state, risk_class, updated_at)
             VALUES ($1, $2, $3, 'Test Operator', 'LY', '[\"alias\"]'::jsonb,
                     $4::\"GatewayKind\", $5::\"GatewayStatus\", 'VERIFIED', 'NORMAL', now())",
        )
        .bind(id)
        .bind(&code)
        .bind(format!("Gateway {suffix}"))
        .bind(kind)
        .bind(status)
        .execute(&self.pool)
        .await
        .expect("insert gateway");
        self.gateways.push(id);
        id
    }

    async fn version(&mut self, gateway: Uuid, created_by: Uuid, number: i32, state: &str) -> Uuid {
        let id = Uuid::now_v7();
        let content_hash = format!("{}{}", Uuid::now_v7().simple(), Uuid::now_v7().simple());
        sqlx::query(
            "INSERT INTO gateway_versions
               (id, gateway_id, version_number, snapshot_ciphertext, content_hash, state, created_by, change_note, updated_at)
             VALUES ($1, $2, $3, '{\"seed\":true}', $4, $5::\"GatewayVersionState\", $6, 'fixture', now())",
        )
        .bind(id)
        .bind(gateway)
        .bind(number)
        .bind(content_hash)
        .bind(state)
        .bind(created_by)
        .execute(&self.pool)
        .await
        .expect("insert gateway version");
        self.versions.push(id);
        id
    }

    async fn activate(&mut self, gateway: Uuid, version: Uuid) {
        sqlx::query("UPDATE gateways SET active_version_id = $2 WHERE id = $1")
            .bind(gateway)
            .bind(version)
            .execute(&self.pool)
            .await
            .expect("activate version");
    }

    async fn credential_set(
        &mut self,
        gateway: Uuid,
        env: &str,
        external: &str,
        status: &str,
        entries: Value,
        mtls_marker: &str,
    ) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO credential_sets
               (id, gateway_id, env, owner_type, external_merchant_id, settlement_target,
                entries_ciphertext, mtls_cert_ciphertext, status, updated_at)
             VALUES ($1, $2, $3::\"GatewayEnvironmentType\", 'PLATFORM', $4,
                     'PLATFORM_CLEARING', $5, $6, $7::\"CredentialStatus\", now())",
        )
        .bind(id)
        .bind(gateway)
        .bind(env)
        .bind(external)
        .bind(entries)
        .bind(mtls_marker)
        .bind(status)
        .execute(&self.pool)
        .await
        .expect("insert credential set");
        self.credential_sets.push(id);
        id
    }

    async fn rail(
        &mut self,
        suffix: &str,
        mode: &str,
        blocked: bool,
        display: i32,
        min: Decimal,
    ) -> Uuid {
        let id = Uuid::now_v7();
        let code = format!("rail-{suffix}-{}", &id.simple().to_string()[..8]);
        sqlx::query(
            "INSERT INTO rails
               (id, code, name_ar, name_en, collection_mode, currency, min_amount,
                display_order, blocked, capabilities, updated_at)
             VALUES ($1, $2, 'سكة', $3, $4::\"CollectionMode\", 'LYD', $5, $6, $7,
                     '{\"OTP\":true,\"REFUND\":false}'::jsonb, now())",
        )
        .bind(id)
        .bind(&code)
        .bind(format!("Rail {suffix}"))
        .bind(mode)
        .bind(min)
        .bind(display)
        .bind(blocked)
        .execute(&self.pool)
        .await
        .expect("insert rail");
        self.rails.push(id);
        id
    }

    async fn rail_field(&mut self, rail: Uuid, key: &str, order: i32) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO rail_fields
               (id, rail_id, key, type, checksum, label_ar, label_en, required, order_index,
                sensitivity, options_json, updated_at)
             VALUES ($1, $2, $3, 'PHONE', 'NONE', 'هاتف', 'Phone', true, $4, 'NORMAL',
                     '{\"options\":[\"a\",\"b\"]}'::jsonb, now())",
        )
        .bind(id)
        .bind(rail)
        .bind(key)
        .bind(order)
        .execute(&self.pool)
        .await
        .expect("insert rail field");
        self.rail_fields.push(id);
        id
    }

    async fn route(&mut self, rail: Uuid, gateway: Uuid, priority: i32) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO rail_routes
               (id, rail_id, gateway_id, credential_policy, priority, cost_model, mismatch_policy,
                min_amount, scope, updated_at)
             VALUES ($1, $2, $3, 'PLATFORM', $4,
                     '{\"flatFee\":\"0.5000\",\"percentFee\":\"1.25\",\"minFee\":\"0.1000\",\"maxFee\":\"9.0000\",\"currency\":\"LYD\"}'::jsonb,
                     '{\"tolerance_amount\":\"0.0100\"}'::jsonb, 0, '{}'::jsonb, now())",
        )
        .bind(id)
        .bind(rail)
        .bind(gateway)
        .bind(priority)
        .execute(&self.pool)
        .await
        .expect("insert route");
        self.routes.push(id);
        id
    }

    async fn route_health_override(
        &mut self,
        route: Uuid,
        state: &str,
        expires: NaiveDateTime,
        user: Uuid,
    ) {
        sqlx::query(
            "UPDATE rail_routes
                SET health_state = $2::\"HealthState\",
                    health_computed_state = 'OPEN_BREAKER'::\"HealthState\",
                    health_override_state = $2::\"HealthState\",
                    health_override_reason = 'operator test',
                    health_override_set_at = $3,
                    health_override_set_by = $4,
                    health_override_expires_at = $5
              WHERE id = $1",
        )
        .bind(route)
        .bind(state)
        .bind(Utc::now().naive_utc())
        .bind(user)
        .bind(expires)
        .execute(&self.pool)
        .await
        .expect("override route health");
    }

    async fn widget(&mut self, route: Uuid) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO widget_definitions
               (id, route_id, kind, script_urls, script_sri_hashes, config_template, callbacks_map,
                allowed_origins, iframe_sandbox_attrs, updated_at)
             VALUES ($1, $2, 'LIGHTBOX', '[\"https://cdn.example/widget.js\"]'::jsonb,
                     '[\"sha384-x\"]'::jsonb, '{}'::jsonb, '{}'::jsonb,
                     '[\"https://cdn.example\"]'::jsonb, '[\"allow-scripts\"]'::jsonb, now())",
        )
        .bind(id)
        .bind(route)
        .execute(&self.pool)
        .await
        .expect("insert widget");
        self.widgets.push(id);
        id
    }

    async fn redirect(&mut self, route: Uuid) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO redirect_definitions
               (id, route_id, method, url_source_output, target, return_method_expected, return_params_map, updated_at)
             VALUES ($1, $2, 'POST_FORM', 'redirect_url', 'SAME_WINDOW', 'GET', '{}'::jsonb, now())",
        )
        .bind(id)
        .bind(route)
        .execute(&self.pool)
        .await
        .expect("insert redirect");
        self.redirects.push(id);
        id
    }

    async fn poll(&mut self, route: Uuid) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO poll_policies
               (id, route_id, first_after_seconds, backoff_seconds, max_duration_seconds, stop_on_states, updated_at)
             VALUES ($1, $2, 5, '[5,10,30]'::jsonb, 900, '[]'::jsonb, now())",
        )
        .bind(id)
        .bind(route)
        .execute(&self.pool)
        .await
        .expect("insert poll policy");
        self.polls.push(id);
        id
    }

    async fn commission_profile(&mut self, rail_code: &str) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO commission_profiles
               (id, rail_code, calc_type, flat_fee, percentage_rate, tiers_json, min_fee, max_fee,
                fee_bearer_default, rounding_mode, effective_from, updated_at)
             VALUES ($1, $2, 'TIERED', 0.5000, 1.250000,
                     '[{\"upTo\":\"100.0000\",\"flatFee\":\"0.5000\",\"percentageRate\":\"1.000000\"}]'::jsonb,
                     0.1000, 9.0000, 'MERCHANT_ABSORBS', 'HALF_UP', now(), now())",
        )
        .bind(id)
        .bind(rail_code)
        .execute(&self.pool)
        .await
        .expect("insert commission profile");
        self.commission_profiles.push(id);
        id
    }

    async fn velocity_rule(&mut self) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO velocity_rules
               (id, scope_type, scope_value, window_seconds, max_count, max_amount, action,
                active, version, effective_from, updated_at)
             VALUES ($1, 'END_CLIENT_IP', '10.0.0.0/8', 3600, 10, 5000.0000, 'REJECT', true, 1, now(), now())",
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .expect("insert velocity rule");
        self.velocity_rules.push(id);
        id
    }

    async fn approval(&mut self, subject_type: &str, subject_id: &str, maker: Uuid) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO approval_requests
               (id, subject_type, subject_id, payload_diff_json, maker_reason, maker_user_id,
                state, expires_at, updated_at)
             VALUES ($1, $2, $3, '{\"action\":\"EXPIRE\"}'::jsonb, 'fixture', $4,
                     'PENDING_REVIEW', now() + interval '1 day', now())",
        )
        .bind(id)
        .bind(subject_type)
        .bind(subject_id)
        .bind(maker)
        .execute(&self.pool)
        .await
        .expect("insert approval");
        self.approvals.push(id);
        id
    }

    /// The attempt graph needed by `gateway_inquiries` (merchant → wallet → application →
    /// link → group → commission profile → attempt).
    async fn attempt(
        &mut self,
        _gateway: Uuid,
        version: Uuid,
        rail: Uuid,
        route: Uuid,
        credential: Uuid,
        commission_rail_code: &str,
    ) -> Uuid {
        let merchant = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO merchants
               (id, legal_name, trade_name, onboarding_channel, country, updated_at)
             VALUES ($1, 'Inquiry Legal', 'Inquiry Trade', 'ADMIN', 'LY', now())",
        )
        .bind(merchant)
        .execute(&self.pool)
        .await
        .expect("insert merchant");
        self.merchants.push(merchant);

        let gl = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO gl_accounts (id, account_type, currency, shard_count, updated_at)
             VALUES ($1, 'MERCHANT_WALLET', 'LYD', 1, now())",
        )
        .bind(gl)
        .execute(&self.pool)
        .await
        .expect("insert gl account");
        self.gl_accounts.push(gl);

        let wallet = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO wallets (id, merchant_id, gl_account_id, currency, status, updated_at)
             VALUES ($1, $2, $3, 'LYD', 'ACTIVE', now())",
        )
        .bind(wallet)
        .bind(merchant)
        .bind(gl)
        .execute(&self.pool)
        .await
        .expect("insert wallet");
        self.wallets.push(wallet);

        let application = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO applications (id, merchant_id, name, assigned_wallet_id, status, updated_at)
             VALUES ($1, $2, 'Inquiry App', $3, 'ACTIVE', now())",
        )
        .bind(application)
        .bind(merchant)
        .bind(wallet)
        .execute(&self.pool)
        .await
        .expect("insert application");
        self.applications.push(application);

        let link = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO payment_links
               (id, key, application_id, wallet_id, amount, currency, fee_bearer, state, updated_at)
             VALUES ($1, $2, $3, $4, 10.0000, 'LYD', 'MERCHANT_ABSORBS', 'PENDING', now())",
        )
        .bind(link)
        .bind(format!("inquiry-link-{}", link.simple()))
        .bind(application)
        .bind(wallet)
        .execute(&self.pool)
        .await
        .expect("insert link");
        self.links.push(link);

        let group = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO attempt_groups (id, link_id, customer_fingerprint, updated_at)
             VALUES ($1, $2, $3, now())",
        )
        .bind(group)
        .bind(link)
        .bind("f".repeat(64))
        .execute(&self.pool)
        .await
        .expect("insert attempt group");
        self.attempt_groups.push(group);

        let commission = self.commission_profile(commission_rail_code).await;

        let attempt = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO payment_attempts
               (id, reference, link_id, attempt_group_id, application_id, merchant_id, rail_id,
                route_id, credential_set_id, gateway_version_id, commission_profile_id, env, mode,
                status, requested_amount, total_charged_amount, fee_bearer, currency,
                customer_fields_masked, context_ciphertext, expires_at, grace_expires_at,
                provider_reference, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'LIVE', 'OTP',
                     'UNKNOWN', 10.0000, 10.0000, 'MERCHANT_ABSORBS', 'LYD',
                     '{\"phone\":\"0910000000\"}'::jsonb, '', now() + interval '1 hour',
                     now() + interval '2 hours', 'PROV-1', now())",
        )
        .bind(attempt)
        .bind(format!("ATT-{}", &attempt.simple().to_string()[..12]))
        .bind(link)
        .bind(group)
        .bind(application)
        .bind(merchant)
        .bind(rail)
        .bind(route)
        .bind(credential)
        .bind(version)
        .bind(commission)
        .execute(&self.pool)
        .await
        .expect("insert attempt");
        self.attempts.push(attempt);
        attempt
    }

    async fn inquiry(&mut self, attempt: Uuid, scheduled_by: Uuid) -> (Uuid, Uuid) {
        let case = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO operator_cases
               (id, attempt_id, kind, priority, sla_due_at, state, updated_at)
             VALUES ($1, $2, 'MANUAL_REVIEW', 'P1', now() + interval '2 hours', 'OPEN', now())",
        )
        .bind(case)
        .bind(attempt)
        .execute(&self.pool)
        .await
        .expect("insert operator case");
        self.operator_cases.push(case);

        let schedule = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO gateway_inquiry_schedules
               (id, attempt_id, operator_case_id, source, status, scheduled_by_user_id, reason,
                next_run_at, attempts, updated_at)
             VALUES ($1, $2, $3, 'OPERATOR_CASE', 'SCHEDULED', $4, 'fixture',
                     now() - interval '5 minutes', 0, now())",
        )
        .bind(schedule)
        .bind(attempt)
        .bind(case)
        .bind(scheduled_by)
        .execute(&self.pool)
        .await
        .expect("insert inquiry schedule");
        self.schedules.push(schedule);
        (case, schedule)
    }

    async fn other_schedule_statuses(&mut self, attempt: Uuid) {
        for status in ["COMPLETED", "FAILED", "RETRYING"] {
            let id = Uuid::now_v7();
            sqlx::query(
                "INSERT INTO gateway_inquiry_schedules
                   (id, attempt_id, source, status, next_run_at, attempts, updated_at)
                 VALUES ($1, $2, 'AUTOMATIC', $3::\"GatewayInquiryScheduleStatus\",
                         now() + interval '1 hour', 1, now())",
            )
            .bind(id)
            .bind(attempt)
            .bind(status)
            .execute(&self.pool)
            .await
            .expect("insert other schedule");
            self.schedules.push(id);
        }
    }

    async fn delete_ids(&self, table: &str, column: &str, ids: &[Uuid]) {
        if ids.is_empty() {
            return;
        }
        let sql = format!("DELETE FROM {table} WHERE {column} = ANY($1)");
        let _ = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(ids)
            .execute(&self.pool)
            .await;
    }

    async fn cleanup(self) {
        self.delete_ids("gateway_inquiry_schedules", "id", &self.schedules)
            .await;
        self.delete_ids("operator_cases", "id", &self.operator_cases)
            .await;
        self.delete_ids("payment_attempts", "id", &self.attempts)
            .await;
        self.delete_ids("attempt_groups", "id", &self.attempt_groups)
            .await;
        self.delete_ids("payment_links", "id", &self.links).await;
        self.delete_ids("gateway_health_samples", "id", &self.samples)
            .await;
        self.delete_ids("route_health_probes", "id", &self.probes)
            .await;
        self.delete_ids("route_health_events", "id", &self.events)
            .await;
        self.delete_ids("poll_policies", "id", &self.polls).await;
        self.delete_ids("widget_definitions", "id", &self.widgets)
            .await;
        self.delete_ids("redirect_definitions", "id", &self.redirects)
            .await;
        self.delete_ids("rail_routes", "id", &self.routes).await;
        self.delete_ids("gateway_versions", "id", &self.versions)
            .await;
        self.delete_ids("rail_fields", "id", &self.rail_fields)
            .await;
        self.delete_ids("rails", "id", &self.rails).await;
        self.delete_ids("credential_sets", "id", &self.credential_sets)
            .await;
        self.delete_ids("gateways", "id", &self.gateways).await;
        self.delete_ids("applications", "id", &self.applications)
            .await;
        self.delete_ids("wallets", "id", &self.wallets).await;
        self.delete_ids("merchants", "id", &self.merchants).await;
        self.delete_ids("gl_shard_repairs", "gl_account_id", &self.gl_accounts)
            .await;
        self.delete_ids("gl_shard_checkpoints", "gl_account_id", &self.gl_accounts)
            .await;
        self.delete_ids("gl_account_shards", "gl_account_id", &self.gl_accounts)
            .await;
        self.delete_ids("gl_accounts", "id", &self.gl_accounts)
            .await;
        self.delete_ids("commission_profiles", "id", &self.commission_profiles)
            .await;
        self.delete_ids("velocity_rules", "id", &self.velocity_rules)
            .await;
        self.delete_ids("approval_requests", "id", &self.approvals)
            .await;
        self.delete_ids("users", "id", &self.users).await;
        self.pool.close().await;
    }
}

fn random_path(base: &str) -> String {
    format!("{base}/{}", Uuid::now_v7())
}

// ---------------------------------------------------------------------------------------------
// Policy table (no database)
// ---------------------------------------------------------------------------------------------

#[test]
fn mounted_routes_and_authorities_match_typescript() {
    let routes = super::routes();
    assert_eq!(routes.len(), 23, "P4-T04 chunk mounts 23 GET routes");
    for route in &routes {
        assert_eq!(route.policy.method, "GET");
        assert_eq!(route.policy.channel, pg_http::Channel::Admin);
        assert_eq!(route.policy.authn, pg_http::Authn::Session);
        assert_eq!(route.guard, PrincipalGuard::Staff);
        assert!(!route.policy.ts_origin.trim().is_empty());
        assert!(matches!(route.handler, crate::routes::Handler::Custom(_)));
    }
    let expected = [
        (
            "/internal/admin/gateways",
            vec!["gateway:read"],
            "core-back/api/internal/admin.ts:13006",
        ),
        (
            "/internal/admin/gateway-versions/:vid",
            vec!["gateway:read"],
            "core-back/api/internal/admin.ts:14141",
        ),
        (
            "/internal/admin/credential-sets",
            vec![
                "credential:read",
                "credential:write",
                "gateway:read",
                "gateway:write",
            ],
            "core-back/api/internal/admin.ts:13802",
        ),
        (
            "/internal/admin/gateway-inquiries",
            vec!["case:read", "operator:read"],
            "core-back/api/internal/admin.ts:11868",
        ),
        (
            "/internal/admin/rails",
            vec!["gateway:read"],
            "core-back/api/internal/admin.ts:15854",
        ),
        (
            "/internal/admin/routes",
            vec!["gateway:read"],
            "core-back/api/internal/admin.ts:16299",
        ),
        (
            "/internal/admin/routes/:id/health",
            vec!["gateway:read"],
            "core-back/api/internal/admin.ts:16584",
        ),
        (
            "/internal/admin/commission-profiles",
            vec!["commission:read", "finance:read"],
            "core-back/api/internal/admin.ts:18758",
        ),
        (
            "/internal/admin/velocity-rules",
            vec!["velocity:read", "compliance:read"],
            "core-back/api/internal/admin.ts:18955",
        ),
    ];
    for (path, authorities, origin) in expected {
        let route = routes
            .iter()
            .find(|route| route.policy.path == path)
            .unwrap_or_else(|| panic!("route {path} is not mounted"));
        assert_eq!(route.policy.authorities, authorities, "{path}");
        assert_eq!(route.policy.ts_origin, origin, "{path}");
    }
    for path in [
        "/internal/admin/gateways/summary",
        "/internal/admin/gateways/:id",
        "/internal/admin/gateways/:id/versions",
        "/internal/admin/gateway-inquiries/summary",
        "/internal/admin/gateway-inquiries/:id",
        "/internal/admin/rails/summary",
        "/internal/admin/rails/:id",
        "/internal/admin/routes/summary",
        "/internal/admin/routes/:id",
        "/internal/admin/commission-profiles/summary",
        "/internal/admin/commission-profiles/:id/history",
        "/internal/admin/velocity-rules/summary",
        "/internal/admin/velocity-rules/:id/history",
        "/internal/admin/credential-sets/:id",
    ] {
        assert!(
            routes.iter().any(|route| route.policy.path == path),
            "{path} is not mounted"
        );
    }
}

#[test]
fn authority_guard_rejects_a_principal_without_the_route_authority() {
    let principal = Principal {
        kind: PrincipalKind::Session,
        user_id: Some(Uuid::now_v7().to_string()),
        role: Some("COMPLIANCE".to_owned()),
        merchant_id: None,
        application_id: None,
        authorities: vec!["gateway:read".to_owned()],
        scopes: vec!["gateway:read".to_owned()],
        token_id: None,
        token_plane: None,
        session_jti: None,
        session_exp: None,
        session_channel: None,
        app_scope_ids: Vec::new(),
    };
    let required = ["commission:read".to_owned(), "finance:read".to_owned()];
    let required_refs: Vec<&str> = required.iter().map(String::as_str).collect();
    let error = principal
        .require_authorities(&required_refs)
        .expect_err("gateway:read must not reach commission profiles");
    assert_eq!(error.code, "AUTHORITY_REQUIRED");

    let allowed = Principal {
        authorities: vec!["finance:read".to_owned()],
        scopes: vec!["finance:read".to_owned()],
        ..principal.clone()
    };
    allowed
        .require_authorities(&required_refs)
        .expect("finance:read is one of the OR-ed authorities");

    let velocity = ["velocity:read", "compliance:read"];
    let velocity_refs: Vec<&str> = velocity.to_vec();
    assert!(principal.require_authorities(&velocity_refs).is_err());
    let compliant = Principal {
        authorities: vec!["compliance:read".to_owned()],
        scopes: vec!["compliance:read".to_owned()],
        ..principal
    };
    compliant
        .require_authorities(&velocity_refs)
        .expect("compliance:read reaches velocity rules");
}

// ---------------------------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn gateways_list_detail_versions_and_summary() {
    let Some(mut fx) = Fixture::connect().await else {
        return;
    };
    let state = state_for(&fx.pool);
    let user = fx.user().await;
    let suffix = Uuid::new_v4().simple().to_string()[..8].to_owned();
    let first = fx.gateway(&suffix, "DRAFT", "DIRECT").await;
    let second = fx
        .gateway(&format!("b{suffix}"), "LIVE", "AGGREGATOR")
        .await;
    let v1 = fx.version(first, user, 1, "LIVE").await;
    let v2 = fx.version(first, user, 2, "PENDING_APPROVAL").await;
    fx.activate(first, v1).await;
    let credential = fx
        .credential_set(first, "LIVE", "ext-1", "VERIFIED", json!([]), "MTLS-MARKER")
        .await;
    let rail = fx
        .rail(&suffix, "OTP_PULL", false, 1, Decimal::new(1, 0))
        .await;
    let _route = fx.route(rail, first, 1).await;
    let rail2 = fx
        .rail(
            &format!("b{suffix}"),
            "REDIRECT",
            true,
            2,
            Decimal::new(2, 0),
        )
        .await;
    let route2 = fx.route(rail2, second, 2).await;
    fx.route_health_override(
        route2,
        "DEGRADED",
        Utc::now().naive_utc() + ChronoDuration::hours(1),
        user,
    )
    .await;

    let (status, body) = call(super::gateways::list(
        &state,
        &request("/internal/admin/gateways?pageSize=50&search=gw-"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body["total"].as_i64().unwrap_or(0) >= 2);
    let row = body["gateways"]
        .as_array()
        .expect("gateways array")
        .iter()
        .find(|row| row["id"] == first.to_string())
        .expect("fixture gateway in the list");
    assert_eq!(row["versionCount"], 2);
    assert_eq!(row["activeVersion"]["versionNumber"], 1);
    assert_eq!(row["pendingVersion"]["versionNumber"], 2);
    assert_eq!(row["pendingVersion"]["id"], v2.to_string());
    assert_eq!(row["routeCount"], 1);
    assert_eq!(row["credentialSetCount"], 1);
    assert_eq!(row["_count"]["credentialSets"], 1);
    assert_eq!(row["routeHealth"]["healthy"], 1);
    assert_eq!(row["routeHealth"]["openBreaker"], 0);
    assert_eq!(row["country"], "LY");
    assert_eq!(row["aliases"][0], "alias");
    assert_eq!(row["versions"].as_array().unwrap().len(), 2);

    // Filters, pagination and sort.
    let (status, body) = call(super::gateways::list(
        &state,
        &request(&format!(
            "/internal/admin/gateways?search={suffix}&kind=DIRECT&status=DRAFT"
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["total"], 1);
    assert_eq!(body["gateways"][0]["id"], first.to_string());

    let (status, page_two) = call(super::gateways::list(
        &state,
        &request("/internal/admin/gateways?pageSize=1&page=2&sortKey=code&sortDirection=asc"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(page_two["page"], 2);
    assert_eq!(page_two["pageSize"], 1);
    assert_eq!(page_two["gateways"].as_array().unwrap().len(), 1);

    let (status, detail) = call(super::gateways::detail(
        &state,
        &request(&format!("/internal/admin/gateways/{first}")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{detail}");
    let gateway = &detail["gateway"];
    assert_eq!(gateway["id"], first.to_string());
    assert_eq!(gateway["versions"].as_array().unwrap().len(), 2);
    assert!(
        gateway["versions"][0].get("snapshotCiphertext").is_none(),
        "the detail projection must not expose the snapshot ciphertext"
    );
    let credential_row = gateway["credentialSets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == credential.to_string())
        .expect("credential set in gateway detail");
    assert_eq!(credential_row["gatewayCode"], gateway["code"]);
    assert_eq!(credential_row["status"], "VERIFIED");

    let (status, versions) = call(super::gateways::versions(
        &state,
        &request(&format!("/internal/admin/gateways/{first}/versions")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(versions["versions"].as_array().unwrap().len(), 2);
    assert_eq!(versions["versions"][0]["versionNumber"], 2);

    let (status, summary) = call(super::gateways::summary(
        &state,
        &request("/internal/admin/gateways/summary"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert!(summary["total"].as_i64().unwrap_or(0) >= 2);
    assert!(summary["pendingVersions"].as_i64().unwrap_or(0) >= 1);
    assert!(summary["byStatus"].is_object());

    let (status, missing) = call(super::gateways::detail(
        &state,
        &request(&random_path("/internal/admin/gateways")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 404);
    assert_eq!(missing["code"], "GATEWAY_NOT_FOUND");

    let (status, missing_versions) = call(super::gateways::versions(
        &state,
        &request(&format!(
            "{}/versions",
            random_path("/internal/admin/gateways")
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(missing_versions["versions"].as_array().unwrap().len(), 0);

    fx.cleanup().await;
}

#[tokio::test]
async fn gateway_version_detail_projection_matches_the_wizard_contract() {
    let Some(mut fx) = Fixture::connect().await else {
        return;
    };
    let state = state_for(&fx.pool);
    let user = fx.user().await;
    let suffix = Uuid::new_v4().simple().to_string()[..8].to_owned();
    let gateway = fx.gateway(&suffix, "DRAFT", "DIRECT").await;
    let version = fx.version(gateway, user, 1, "DRAFT").await;
    let rail = fx
        .rail(&suffix, "OTP_PULL", false, 1, Decimal::new(1, 0))
        .await;
    let _field = fx.rail_field(rail, "phone", 0).await;
    let route = fx.route(rail, gateway, 7).await;
    let _widget = fx.widget(route).await;
    let _redirect = fx.redirect(route).await;
    let _poll = fx.poll(route).await;
    let _credential = fx
        .credential_set(gateway, "LIVE", "ext-v", "VERIFIED", json!([]), "MTLS")
        .await;

    sqlx::query(
        "INSERT INTO gateway_environments
           (id, gateway_version_id, env, base_urls, allowed_hosts, inbound_ip_allowlist, outbound_egress_ips, updated_at)
         VALUES ($1, $2, 'LIVE', '{\"LIVE\":\"https://gw.example\",\"SANDBOX\":\"https://sb.example\"}'::jsonb,
                 '[\"gw.example\"]'::jsonb, '[\"10.0.0.0/8\"]'::jsonb, '[]'::jsonb, now())",
    )
    .bind(Uuid::now_v7())
    .bind(version)
    .execute(&fx.pool)
    .await
    .expect("insert environment");
    sqlx::query(
        "INSERT INTO gateway_auth
           (id, gateway_version_id, env, method, auth_apply, refresh_config_json, updated_at)
         VALUES ($1, $2, 'LIVE', 'TOKEN_ENDPOINT', 'HEADER',
                 '{\"tokenUrl\":\"https://gw.example/token\",\"clientIdRef\":\"client-id\",\"clientSecretRef\":\"client-secret\",\"extraHeaders\":[{\"key\":\"X\",\"value\":\"1\"}]}'::jsonb, now())",
    )
    .bind(Uuid::now_v7())
    .bind(version)
    .execute(&fx.pool)
    .await
    .expect("insert auth");
    sqlx::query(
        "INSERT INTO gateway_settings
           (id, gateway_version_id, amount_scale, amount_precision, amount_rounding, amount_format,
            reference_format, session_ttl_seconds, otp_ttl_seconds, otp_resend_cooldown_seconds, updated_at)
         VALUES ($1, $2, 2, 3, 'HALF_UP', 'DECIMAL', '{}'::jsonb, 3600, 300, 30, now())",
    )
    .bind(Uuid::now_v7())
    .bind(version)
    .execute(&fx.pool)
    .await
    .expect("insert setting");
    let crypto = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO crypto_profiles
           (id, gateway_version_id, name, purpose, algorithm, secret_key_ref, secret_key_encoding,
            canonicalization_mode, included_fields, excluded_fields, output_encoding, updated_at)
         VALUES ($1, $2, 'sig', 'OUTBOUND_SIGN', 'HMAC_SHA256', 'ref-1', 'HEX',
                 'SORTED_KEY_VALUE_AMP', '[\"amount\",\"currency\"]'::jsonb, '[]'::jsonb, 'HEX_LOWER', now())",
    )
    .bind(crypto)
    .bind(version)
    .execute(&fx.pool)
    .await
    .expect("insert crypto profile");
    let flow = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO flows (id, gateway_version_id, rail_id, phase, updated_at)
         VALUES ($1, $2, $3, 'INITIATE', now())",
    )
    .bind(flow)
    .bind(version)
    .bind(rail)
    .execute(&fx.pool)
    .await
    .expect("insert flow");
    sqlx::query(
        "INSERT INTO flow_steps
           (id, flow_id, order_index, type, method, url_template, side_effect, retry_policy, idempotency_config, updated_at)
         VALUES ($1, $2, 0, 'HTTP', 'POST', 'https://gw.example/pay', 'MOVES_MONEY', 'NEVER', '{}'::jsonb, now())",
    )
    .bind(Uuid::now_v7())
    .bind(flow)
    .execute(&fx.pool)
    .await
    .expect("insert flow step");
    sqlx::query(
        "INSERT INTO status_rules
           (id, gateway_version_id, phase, order_index, selector, op, value_json, canonical_status,
            canonical_error, canonical_substatus, updated_at)
         VALUES ($1, $2, 'VERIFY', 0, '$.status', 'EQUALS', '\"PAID\"'::jsonb, 'SUCCEEDED',
                 'PAID', 'OK', now())",
    )
    .bind(Uuid::now_v7())
    .bind(version)
    .execute(&fx.pool)
    .await
    .expect("insert status rule");
    sqlx::query(
        "INSERT INTO error_maps
           (id, gateway_version_id, gateway_code, canonical_error, classification, retryable,
            customer_message_ar, customer_message_en, updated_at)
         VALUES ($1, $2, 'OTP_WRONG', 'OTP_INVALID', 'RETRYABLE_OTP', true, 'خطأ', 'Wrong code', now())",
    )
    .bind(Uuid::now_v7())
    .bind(version)
    .execute(&fx.pool)
    .await
    .expect("insert error map");
    sqlx::query(
        "INSERT INTO confirmation_channels
           (id, gateway_version_id, route_id, type, path_token, crypto_profile_id, verify_method,
            body_format, event_map, must_inquire, updated_at)
         VALUES ($1, $2, $3, 'POLL', $4, $5, 'NONE_PLUS_INQUIRY', 'JSON',
                 '[{\"event\":\"PAID\",\"canonical\":\"SUCCEEDED\"}]'::jsonb, true, now())",
    )
    .bind(Uuid::now_v7())
    .bind(version)
    .bind(route)
    .bind(format!("chan-{}", Uuid::now_v7().simple()))
    .bind(crypto)
    .execute(&fx.pool)
    .await
    .expect("insert confirmation channel");

    let (status, body) = call(super::versions::detail(
        &state,
        &request(&format!("/internal/admin/gateway-versions/{version}")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["versionNumber"], 1);
    assert_eq!(
        body["identity"]["code"],
        format!("gw-{suffix}-{}", &gateway.simple().to_string()[..8])
    );
    assert_eq!(body["identity"]["country"], "LY");
    assert_eq!(body["environments"][0]["env"], "LIVE");
    assert_eq!(body["environments"][0]["baseUrl"], "https://gw.example");
    assert_eq!(body["environments"][0]["allowedHosts"][0], "gw.example");
    assert_eq!(body["auth"]["method"], "TOKEN_ENDPOINT");
    assert_eq!(body["auth"]["tokenUrl"], "https://gw.example/token");
    assert_eq!(body["auth"]["extraHeaders"][0]["key"], "X");
    assert_eq!(body["credentialSets"][0]["label"], "ext-v");
    assert_eq!(body["credentialSets"][0]["secret"], "");
    let rail_code: String = sqlx::query_scalar("SELECT code FROM rails WHERE id = $1")
        .bind(rail)
        .fetch_one(&fx.pool)
        .await
        .expect("rail code");
    assert_eq!(body["rails"][0]["code"], rail_code);
    assert_eq!(body["rails"][0]["fields"][0]["fieldKey"], "phone");
    assert_eq!(body["rails"][0]["fields"][0]["inputType"], "phone");
    assert_eq!(body["rails"][0]["fields"][0]["normalizer"], "NONE");
    assert_eq!(body["rails"][0]["capabilities"][0], "OTP");
    assert_eq!(body["cryptoProfiles"][0]["keyEncoding"], "hex");
    assert_eq!(body["cryptoProfiles"][0]["secretRef"], "ref-1");
    assert_eq!(body["flows"][0]["phase"], "INITIATE");
    assert_eq!(body["flows"][0]["steps"][0]["order"], 0);
    assert_eq!(body["flows"][0]["steps"][0]["name"], "POST");
    assert_eq!(body["statusRules"][0]["terminal"], json!(true));
    assert_eq!(body["errorMaps"][0]["otpRetryable"], json!(true));
    assert_eq!(body["confirmationChannels"][0]["kind"], "INQUIRY_POLL");
    assert_eq!(
        body["confirmationChannels"][0]["eventMap"][0]["event"],
        "PAID"
    );
    assert_eq!(body["confirmationChannels"][0]["mustInquire"], json!(true));
    let kinds: Vec<&str> = body["clientActions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|action| action["kind"].as_str())
        .collect();
    assert!(kinds.contains(&"RENDER_EMBEDDED"));
    assert!(kinds.contains(&"HTTP_REDIRECT"));
    let redirect = body["clientActions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|action| action["kind"] == "HTTP_REDIRECT")
        .unwrap();
    assert_eq!(redirect["redirectMethod"], "POST_FORM");
    assert_eq!(redirect["redirectUrl"], "redirect_url");
    assert_eq!(body["pollPolicies"][0]["maxAttempts"], 3);
    assert_eq!(body["pollPolicies"][0]["backoffSchedule"][1], 10);
    assert_eq!(body["amountPipeline"]["scale"], 2);
    assert_eq!(body["amountPipeline"]["currency"], "LYD");
    assert_eq!(body["costModel"]["flatFee"], "0.5000");
    assert_eq!(body["statementMapping"]["format"], "CSV");

    let (status, missing) = call(super::versions::detail(
        &state,
        &request(&random_path("/internal/admin/gateway-versions")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 404);
    assert_eq!(missing["code"], "GATEWAY_VERSION_NOT_FOUND");

    // Remove the child rows touched here before the cascade-limited cleanup.
    sqlx::query("DELETE FROM confirmation_channels WHERE gateway_version_id = $1")
        .bind(version)
        .execute(&fx.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM error_maps WHERE gateway_version_id = $1")
        .bind(version)
        .execute(&fx.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM status_rules WHERE gateway_version_id = $1")
        .bind(version)
        .execute(&fx.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM flow_steps WHERE flow_id = $1")
        .bind(flow)
        .execute(&fx.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM flows WHERE gateway_version_id = $1")
        .bind(version)
        .execute(&fx.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM crypto_profiles WHERE gateway_version_id = $1")
        .bind(version)
        .execute(&fx.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM gateway_settings WHERE gateway_version_id = $1")
        .bind(version)
        .execute(&fx.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM gateway_auth WHERE gateway_version_id = $1")
        .bind(version)
        .execute(&fx.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM gateway_environments WHERE gateway_version_id = $1")
        .bind(version)
        .execute(&fx.pool)
        .await
        .ok();

    fx.cleanup().await;
}

// ---------------------------------------------------------------------------------------------
// Rails
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn rails_list_detail_and_summary() {
    let Some(mut fx) = Fixture::connect().await else {
        return;
    };
    let state = state_for(&fx.pool);
    let suffix = Uuid::new_v4().simple().to_string()[..8].to_owned();
    let first = fx
        .rail(&suffix, "OTP_PULL", false, 11, Decimal::new(1, 0))
        .await;
    let second = fx
        .rail(
            &format!("b{suffix}"),
            "REDIRECT",
            true,
            12,
            Decimal::new(50, 0),
        )
        .await;
    let _f1 = fx.rail_field(first, "phone", 1).await;
    let _f2 = fx.rail_field(first, "otp", 2).await;
    let gateway = fx.gateway(&suffix, "DRAFT", "DIRECT").await;
    let route = fx.route(first, gateway, 1).await;
    let user = fx.user().await;
    fx.route_health_override(
        route,
        "DEGRADED",
        Utc::now().naive_utc() + ChronoDuration::hours(1),
        user,
    )
    .await;

    let (status, body) = call(super::rails::list(
        &state,
        &request(&format!("/internal/admin/rails?search=rail-{suffix}")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["total"], 1);
    let rail = &body["rails"][0];
    assert_eq!(rail["id"], first.to_string());
    assert_eq!(rail["fieldCount"], 2);
    assert_eq!(rail["fields"].as_array().unwrap().len(), 2);
    assert_eq!(rail["fields"][0]["key"], "phone");
    assert_eq!(rail["_count"]["routes"], 1);
    assert_eq!(rail["routeHealth"]["degraded"], 1);
    assert_eq!(rail["routeHealth"]["active"], 1);
    assert_eq!(rail["minAmount"], "1");
    assert_eq!(rail["capabilities"]["OTP"], json!(true));

    let (status, blocked) = call(super::rails::list(
        &state,
        &request(&format!(
            "/internal/admin/rails?blocked=true&search=rail-b{suffix}"
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(blocked["total"], 1);
    assert_eq!(blocked["rails"][0]["id"], second.to_string());

    let (status, ranged) = call(super::rails::list(
        &state,
        &request(&format!(
            "/internal/admin/rails?amountMin=40&amountMax=60&search=b{suffix}"
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(ranged["total"], 1);
    assert_eq!(ranged["rails"][0]["id"], second.to_string());

    let (status, paged) = call(super::rails::list(
        &state,
        &request("/internal/admin/rails?pageSize=1&page=2"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(paged["page"], 2);
    assert_eq!(paged["rails"].as_array().unwrap().len(), 1);

    let (status, detail) = call(super::rails::detail(
        &state,
        &request(&format!("/internal/admin/rails/{first}")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(detail["rail"]["fields"].as_array().unwrap().len(), 2);
    assert_eq!(detail["rail"]["routes"].as_array().unwrap().len(), 1);
    assert_eq!(
        detail["rail"]["routes"][0]["gatewayId"],
        gateway.to_string()
    );

    let (status, summary) = call(super::rails::summary(
        &state,
        &request("/internal/admin/rails/summary"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert!(summary["total"].as_i64().unwrap_or(0) >= 2);
    assert!(summary["blocked"].as_i64().unwrap_or(0) >= 1);
    assert!(summary["byMode"].is_object());
    assert!(summary["routes"].is_object());

    let (status, missing) = call(super::rails::detail(
        &state,
        &request(&random_path("/internal/admin/rails")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 404);
    assert_eq!(missing["code"], "RAIL_NOT_FOUND");

    fx.cleanup().await;
}

// ---------------------------------------------------------------------------------------------
// Routes and route health
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn routes_list_detail_and_health_reads() {
    let Some(mut fx) = Fixture::connect().await else {
        return;
    };
    let state = state_for(&fx.pool);
    let user = fx.user().await;
    let suffix = Uuid::new_v4().simple().to_string()[..8].to_owned();
    let rail = fx
        .rail(&suffix, "OTP_PULL", false, 1, Decimal::new(1, 0))
        .await;
    let gateway = fx.gateway(&suffix, "LIVE", "DIRECT").await;
    let active = fx.route(rail, gateway, 5).await;
    let expired_rail = fx
        .rail(
            &format!("b{suffix}"),
            "REDIRECT",
            false,
            2,
            Decimal::new(1, 0),
        )
        .await;
    let expired = fx.route(expired_rail, gateway, 6).await;
    fx.route_health_override(
        active,
        "DEGRADED",
        Utc::now().naive_utc() + ChronoDuration::hours(1),
        user,
    )
    .await;
    fx.route_health_override(
        expired,
        "HEALTHY",
        Utc::now().naive_utc() - ChronoDuration::hours(1),
        user,
    )
    .await;
    // The expired override still has the stored health_state HEALTHY, but the computed state is
    // OPEN_BREAKER: effectiveRouteHealth must fall back to the computed state.
    sqlx::query(
        "UPDATE rail_routes SET health_computed_state = 'DEGRADED'::\"HealthState\" WHERE id = $1",
    )
    .bind(expired)
    .execute(&fx.pool)
    .await
    .expect("set computed health");

    let sample = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO gateway_health_samples
           (id, route_id, window_start, definitive_failures, ambiguous_unknowns, rate_limits_429,
            ignored_outcomes, successes, p50_ms, p95_ms, p99_ms, updated_at)
         VALUES ($1, $2, now() - interval '5 minutes', 2, 1, 0, 0, 8, 100, 250, 400, now())",
    )
    .bind(sample)
    .bind(active)
    .execute(&fx.pool)
    .await
    .expect("insert health sample");
    fx.samples.push(sample);
    let probe = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO route_health_probes
           (id, route_id, method, status, reason, latency_ms)
         VALUES ($1, $2, 'CREDENTIAL_CHECK', 'PASSED', 'ok', 42)",
    )
    .bind(probe)
    .bind(active)
    .execute(&fx.pool)
    .await
    .expect("insert health probe");
    fx.probes.push(probe);
    let event = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO route_health_events
           (id, route_id, from_state, to_state, source, reason, actor_user_id)
         VALUES ($1, $2, 'HEALTHY', 'DEGRADED', 'OVERRIDE', 'operator', $3)",
    )
    .bind(event)
    .bind(active)
    .bind(user)
    .execute(&fx.pool)
    .await
    .expect("insert health event");
    fx.events.push(event);

    let (status, body) = call(super::route_health::list(
        &state,
        &request(&format!(
            "/internal/admin/routes?search={suffix}&railId={rail}&status=ACTIVE"
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["total"], 1);
    let row = &body["routes"][0];
    assert_eq!(row["id"], active.to_string());
    assert_eq!(row["healthState"], "DEGRADED");
    assert_eq!(row["healthComputedState"], "OPEN_BREAKER");
    assert_eq!(row["railCode"], row["rail"]["code"]);
    assert_eq!(row["railName"], row["rail"]["nameEn"]);
    assert_eq!(row["gatewayCode"], row["gateway"]["code"]);
    assert_eq!(row["gatewayName"], row["gateway"]["name"]);
    assert_eq!(row["minAmount"], "0");

    let (status, expired_row) = call(super::route_health::list(
        &state,
        &request(&format!("/internal/admin/routes?railId={expired_rail}")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(expired_row["routes"][0]["healthState"], "DEGRADED");

    let (status, page_two) = call(super::route_health::list(
        &state,
        &request("/internal/admin/routes?pageSize=1&page=1&sortKey=priority&sortDirection=asc"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(page_two["pageSize"], 1);
    assert_eq!(page_two["routes"].as_array().unwrap().len(), 1);

    let (status, detail) = call(super::route_health::detail(
        &state,
        &request(&format!("/internal/admin/routes/{active}")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(detail["route"]["id"], active.to_string());
    assert_eq!(detail["route"]["rail"]["nameEn"], row["railName"]);
    assert_eq!(detail["route"]["gateway"]["code"], row["gatewayCode"]);

    let (status, health) = call(super::route_health::health(
        &state,
        &request(&format!("/internal/admin/routes/{active}/health")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{health}");
    assert_eq!(health["routeId"], active.to_string());
    assert_eq!(health["rail"]["code"], row["rail"]["code"]);
    assert_eq!(health["gateway"]["code"], row["gateway"]["code"]);
    assert_eq!(health["health"]["effectiveState"], "DEGRADED");
    assert_eq!(health["health"]["computedState"], "OPEN_BREAKER");
    assert_eq!(health["health"]["overrideSetBy"], user.to_string());
    assert!(health["health"]["overrideSetByName"].is_string());
    assert_eq!(health["samples"].as_array().unwrap().len(), 1);
    assert_eq!(health["samples"][0]["successes"], 8);
    assert_eq!(health["probes"].as_array().unwrap().len(), 1);
    assert_eq!(health["probes"][0]["status"], "PASSED");
    assert_eq!(health["events"].as_array().unwrap().len(), 1);
    assert_eq!(health["events"][0]["toState"], "DEGRADED");
    assert_eq!(health["canary"]["percent"], 5);
    assert_eq!(health["policy"]["sampleBucketSeconds"], 300);

    let (status, summary) = call(super::route_health::summary(
        &state,
        &request("/internal/admin/routes/summary"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert!(summary["total"].as_i64().unwrap_or(0) >= 2);
    assert!(summary["byStatus"].is_object());
    assert!(summary["byHealth"].is_object());
    assert!(summary["railGatewayPairs"].as_i64().unwrap_or(0) >= 2);

    let (status, missing) = call(super::route_health::detail(
        &state,
        &request(&random_path("/internal/admin/routes")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 404);
    assert_eq!(missing["code"], "ROUTE_NOT_FOUND");

    let (status, missing_health) = call(super::route_health::health(
        &state,
        &request(&format!("{}/health", random_path("/internal/admin/routes"))),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 404);
    assert_eq!(missing_health["code"], "ROUTE_NOT_FOUND");

    fx.cleanup().await;
}

// ---------------------------------------------------------------------------------------------
// Credential sets
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn credential_sets_never_expose_secrets() {
    let Some(mut fx) = Fixture::connect().await else {
        return;
    };
    let state = state_for(&fx.pool);
    let suffix = Uuid::new_v4().simple().to_string()[..8].to_owned();
    let gateway = fx.gateway(&suffix, "DRAFT", "DIRECT").await;
    let secret_marker = format!("SECRET-MARKER-{}", Uuid::now_v7().simple());
    let mtls_marker = format!("MTLS-MARKER-{}", Uuid::now_v7().simple());
    let first = fx
        .credential_set(
            gateway,
            "LIVE",
            &format!("external-{suffix}"),
            "VERIFIED",
            json!([
                {"key": "apiKey", "type": "API_KEY", "value": secret_marker, "isSecret": true, "secretVersion": 1},
                {"key": "merchantId", "type": "STRING", "value": "public-value", "isSecret": false, "secretVersion": 1}
            ]),
            &mtls_marker,
        )
        .await;
    let _second = fx
        .credential_set(
            gateway,
            "SANDBOX",
            &format!("sandbox-{suffix}"),
            "UNTESTED",
            json!([]),
            "x",
        )
        .await;

    let gateway_code = format!("gw-{suffix}-{}", &gateway.simple().to_string()[..8]);
    let (status, list) = call(super::credentials::list(
        &state,
        &request(&format!(
            "/internal/admin/credential-sets?search={suffix}&gatewayCode={gateway_code}"
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(list["total"], 2);
    let rendered = serde_json::to_string(&list).unwrap();
    assert!(
        !rendered.contains(&secret_marker),
        "the secret value leaked"
    );
    assert!(
        !rendered.contains(&mtls_marker),
        "the mTLS ciphertext leaked"
    );
    assert!(list["credentialSets"][0].get("entriesCiphertext").is_none());
    assert!(list["credentialSets"][0]
        .get("mtlsCertCiphertext")
        .is_none());
    assert_eq!(list["credentialSets"][0]["gatewayCode"], gateway_code);

    let (status, filtered) = call(super::credentials::list(
        &state,
        &request(&format!(
            "/internal/admin/credential-sets?env=SANDBOX&search={suffix}"
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(filtered["total"], 1);
    assert_eq!(filtered["credentialSets"][0]["env"], "SANDBOX");

    let (status, paged) = call(super::credentials::list(
        &state,
        &request("/internal/admin/credential-sets?pageSize=1&page=1"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert!(paged["total"].as_i64().unwrap_or(0) >= 2);
    assert_eq!(paged["credentialSets"].as_array().unwrap().len(), 1);

    let (status, detail) = call(super::credentials::detail(
        &state,
        &request(&format!("/internal/admin/credential-sets/{first}")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{detail}");
    let rendered = serde_json::to_string(&detail).unwrap();
    assert!(!rendered.contains(&secret_marker));
    assert!(!rendered.contains(&mtls_marker));
    assert!(detail.get("entriesCiphertext").is_none());
    assert!(detail.get("mtlsCertCiphertext").is_none());
    assert_eq!(detail["entries"][0]["key"], "apiKey");
    assert_eq!(detail["entries"][0]["value"], "[REDACTED]");
    assert_eq!(detail["entries"][0]["isSecret"], json!(true));
    assert_eq!(detail["entries"][1]["value"], "[WRITE_ONLY]");
    assert_eq!(detail["entries"][1]["isSecret"], json!(false));

    let (status, missing) = call(super::credentials::detail(
        &state,
        &request(&random_path("/internal/admin/credential-sets")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 404);
    assert_eq!(missing["code"], "CREDENTIAL_SET_NOT_FOUND");

    fx.cleanup().await;
}

// ---------------------------------------------------------------------------------------------
// Commission profiles and velocity rules
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn commission_profiles_and_velocity_rules_reads() {
    let Some(mut fx) = Fixture::connect().await else {
        return;
    };
    let state = state_for(&fx.pool);
    let user = fx.user().await;
    let suffix = Uuid::new_v4().simple().to_string()[..8].to_owned();
    let rail_code = format!("rail-{suffix}");
    let profile = fx.commission_profile(&rail_code).await;
    let _approval = fx
        .approval("COMMISSION_PROFILE", &profile.to_string(), user)
        .await;
    let rule = fx.velocity_rule().await;
    let _approval = fx.approval("VELOCITY_RULE", &rule.to_string(), user).await;

    let (status, body) = call(super::pricing::commission_profiles(
        &state,
        &request("/internal/admin/commission-profiles"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{body}");
    let row = body["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == profile.to_string())
        .expect("profile in the list");
    assert_eq!(row["railCode"], rail_code);
    assert_eq!(row["calcType"], "TIERED");
    assert_eq!(row["flatFee"], "0.5");
    assert_eq!(row["percentageRate"], "1.25");
    assert_eq!(row["minFee"], "0.1");
    assert_eq!(row["maxFee"], "9");
    assert_eq!(row["tiersJson"][0]["flatFee"], "0.5000");
    assert!(row["pendingApprovalId"].is_string());

    let (status, summary) = call(super::pricing::commission_summary(
        &state,
        &request("/internal/admin/commission-profiles/summary"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert!(summary["summary"]["total"].as_i64().unwrap_or(0) >= 1);
    assert!(summary["summary"]["pendingLifecycle"].as_i64().unwrap_or(0) >= 1);
    assert!(summary["summary"]["byCalcType"].is_object());

    let (status, history) = call(super::pricing::commission_history(
        &state,
        &request(&format!(
            "/internal/admin/commission-profiles/{profile}/history"
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert!(history["history"].is_array());

    let (status, missing) = call(super::pricing::commission_history(
        &state,
        &request(&format!(
            "{}/history",
            random_path("/internal/admin/commission-profiles")
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 404);
    assert_eq!(missing["code"], "COMMISSION_PROFILE_NOT_FOUND");

    let (status, rules) = call(super::pricing::velocity_rules(
        &state,
        &request("/internal/admin/velocity-rules"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{rules}");
    let rule_row = rules["rules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == rule.to_string())
        .expect("rule in the list");
    assert_eq!(rule_row["scopeType"], "END_CLIENT_IP");
    assert_eq!(rule_row["action"], "REJECT");
    assert_eq!(rule_row["maxAmount"], "5000");
    assert_eq!(rule_row["active"], json!(true));
    assert!(rule_row["pendingApprovalId"].is_string());

    let (status, summary) = call(super::pricing::velocity_summary(
        &state,
        &request("/internal/admin/velocity-rules/summary"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert!(summary["summary"]["total"].as_i64().unwrap_or(0) >= 1);
    assert!(summary["summary"]["reject"].as_i64().unwrap_or(0) >= 1);
    assert!(
        summary["summary"]["longestWindowSeconds"]
            .as_i64()
            .unwrap_or(0)
            >= 3600
    );

    let (status, history) = call(super::pricing::velocity_history(
        &state,
        &request(&format!("/internal/admin/velocity-rules/{rule}/history")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert!(history["history"].is_array());

    let (status, missing) = call(super::pricing::velocity_history(
        &state,
        &request(&format!(
            "{}/history",
            random_path("/internal/admin/velocity-rules")
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 404);
    assert_eq!(missing["code"], "VELOCITY_RULE_NOT_FOUND");

    fx.cleanup().await;
}

// ---------------------------------------------------------------------------------------------
// Gateway inquiries
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn gateway_inquiries_list_summary_and_detail() {
    let Some(mut fx) = Fixture::connect().await else {
        return;
    };
    let state = state_for(&fx.pool);
    let user = fx.user().await;
    let suffix = Uuid::new_v4().simple().to_string()[..8].to_owned();
    let gateway = fx.gateway(&suffix, "LIVE", "DIRECT").await;
    let version = fx.version(gateway, user, 1, "LIVE").await;
    let rail = fx
        .rail(&suffix, "OTP_PULL", false, 1, Decimal::new(1, 0))
        .await;
    let route = fx.route(rail, gateway, 1).await;
    let credential = fx
        .credential_set(
            gateway,
            "LIVE",
            &format!("ext-{suffix}"),
            "VERIFIED",
            json!([]),
            "x",
        )
        .await;
    let attempt = fx
        .attempt(
            gateway,
            version,
            rail,
            route,
            credential,
            &format!("rail-{suffix}"),
        )
        .await;
    let (_case, schedule) = fx.inquiry(attempt, user).await;
    fx.other_schedule_statuses(attempt).await;

    let reference: String =
        sqlx::query_scalar("SELECT reference FROM payment_attempts WHERE id = $1")
            .bind(attempt)
            .fetch_one(&fx.pool)
            .await
            .expect("attempt reference");
    let rail_code: String = sqlx::query_scalar("SELECT code FROM rails WHERE id = $1")
        .bind(rail)
        .fetch_one(&fx.pool)
        .await
        .expect("rail code");
    let gateway_code: String = sqlx::query_scalar("SELECT code FROM gateways WHERE id = $1")
        .bind(gateway)
        .fetch_one(&fx.pool)
        .await
        .expect("gateway code");
    let scheduled_email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user)
        .fetch_one(&fx.pool)
        .await
        .expect("scheduler email");

    let (status, body) = call(super::inquiries::list(
        &state,
        &request(&format!(
            "/internal/admin/gateway-inquiries?attemptReference={reference}&status=SCHEDULED"
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["total"], 1);
    let row = &body["schedules"][0];
    assert_eq!(row["id"], schedule.to_string());
    assert_eq!(row["status"], "SCHEDULED");
    assert_eq!(row["source"], "OPERATOR_CASE");
    assert_eq!(row["attemptReference"], reference);
    assert_eq!(row["caseRef"], reference);
    assert_eq!(row["casePriority"], "P1");
    assert_eq!(row["caseType"], "MANUAL_REVIEW");
    assert_eq!(row["merchantName"], "Inquiry Trade");
    assert_eq!(row["railCode"], rail_code);
    assert_eq!(row["gatewayCode"], gateway_code);
    assert_eq!(row["gatewaySupportsStatusCheck"], json!(false));
    assert_eq!(row["amount"], "10");
    assert_eq!(row["currency"], "LYD");
    assert_eq!(row["attemptTerminal"], json!(false));
    assert_eq!(row["isOverdue"], json!(true));
    assert_eq!(row["canCancel"], json!(true));
    assert_eq!(row["canRunNow"], json!(true));
    assert_eq!(row["canRetry"], json!(false));
    assert_eq!(row["scheduledByEmail"], scheduled_email);

    let (status, by_gateway) = call(super::inquiries::list(
        &state,
        &request(&format!(
            "/internal/admin/gateway-inquiries?gatewayId={gateway}"
        )),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(by_gateway["total"], 4);
    assert_eq!(by_gateway["schedules"].as_array().unwrap().len(), 4);

    let (status, by_merchant) = call(super::inquiries::list(
        &state,
        &request("/internal/admin/gateway-inquiries?merchantName=Inquiry&pageSize=1"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(by_merchant["schedules"].as_array().unwrap().len(), 1);

    let (status, summary) = call(super::inquiries::summary(
        &state,
        &request("/internal/admin/gateway-inquiries/summary"),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200);
    let summary = &summary["summary"];
    assert!(summary["total"].as_i64().unwrap_or(0) >= 4);
    assert!(summary["scheduled"].as_i64().unwrap_or(0) >= 1);
    assert!(summary["overdue"].as_i64().unwrap_or(0) >= 1);
    assert!(summary["byStatus"]["SCHEDULED"].as_i64().unwrap_or(0) >= 1);

    let (status, detail) = call(super::inquiries::detail(
        &state,
        &request(&format!("/internal/admin/gateway-inquiries/{schedule}")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!(detail["schedule"]["id"], schedule.to_string());
    assert!(detail["auditTrail"].is_array());

    let (status, missing) = call(super::inquiries::detail(
        &state,
        &request(&random_path("/internal/admin/gateway-inquiries")),
        None,
        Payload(ntex::http::Payload::None),
    ))
    .await;
    assert_eq!(status, 404);
    assert_eq!(missing["code"], "GATEWAY_INQUIRY_NOT_FOUND");

    fx.cleanup().await;
}
