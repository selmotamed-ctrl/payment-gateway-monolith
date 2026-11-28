//! Admin system read routes (P4-T04 chunk): dashboard stats, settings, system monitors, staff
//! users, the object-storage console and shared autocomplete options.
//!
//! Ports the `GET` handlers of `core-back/api/internal/{admin,adminSystem,objectStorage}.ts` that
//! belong to the "system" slice. Paths, channels, authorities and `tsOrigin` line numbers are taken
//! from the committed route inventory (`tests/golden-vectors/route-inventory/routes.json`).
//!
//! | Method | Path | TS authority | TS source |
//! | :--- | :--- | :--- | :--- |
//! | GET | `/internal/admin/stats/recent-activity` | `security:read` | `admin.ts:1270` |
//! | GET | `/internal/admin/stats/overview` | any staff read | `admin.ts:1306` |
//! | GET | `/internal/admin/options/:kind` | `user:read`/`security:read` for users, else staff read | `admin.ts:1552` |
//! | GET | `/internal/admin/users` | `user:read`/`security:read` | `admin.ts:1653` |
//! | GET | `/internal/admin/users/summary` | `user:read`/`security:read` | `admin.ts:1775` |
//! | GET | `/internal/admin/users/:id` | `user:read`/`security:read` | `admin.ts:1815` |
//! | GET | `/internal/admin/settings` | `settings:read` | `admin.ts:20221` |
//! | GET | `/internal/admin/settings/summary` | `settings:read` | `admin.ts:20543` |
//! | GET | `/internal/admin/settings/communication/status` | `settings:read` | `admin.ts:20227` |
//! | GET | `/internal/admin/settings/checkout-support` | `settings:read` | `admin.ts:19792` |
//! | GET | `/internal/admin/settings/checkout-support/history` | `settings:read` | `admin.ts:19806` |
//! | GET | `/internal/admin/settings/checkout-support/summary` | `settings:read` | `admin.ts:19853` |
//! | GET | `/internal/admin/system/jobs-outbox/summary` | `security:read` | `adminSystem.ts:51` |
//! | GET | `/internal/admin/system/jobs` | `security:read` | `adminSystem.ts:159` |
//! | GET | `/internal/admin/system/outbox` | `security:read` | `adminSystem.ts:236` |
//! | GET | `/internal/admin/system/audit-outbox` | `security:read` | `adminSystem.ts:285` |
//! | GET | `/internal/admin/system/notifications` | `security:read` | `adminSystem.ts:354` |
//! | GET | `/internal/admin/settings/notification-templates` | `settings:read` | `adminSystem.ts:470` |
//! | GET | `/internal/admin/object-storage/summary` | storage read/admin/legal-hold | `objectStorage.ts:123` |
//! | GET | `/internal/admin/object-storage/objects` | storage read/admin/legal-hold | `objectStorage.ts:182` |
//! | GET | `/internal/admin/object-storage/objects/:id` | storage read/admin/legal-hold | `objectStorage.ts:226` |
//! | GET | `/internal/admin/object-storage/access-logs` | storage read/admin/legal-hold | `objectStorage.ts:326` |
//!
//! The export variants (`/stats/recent-activity/export`, `/users/export`,
//! `/users/summary/export`, `/settings/export`, `/settings/summary/export`,
//! `/settings/checkout-support/summary/export`) are deliberately left to the export chunk: they
//! write an audit row and belong with the shared XLSX/audit pipeline. `/internal/admin/health`
//! already exists in the P3 shell; TS has no `/internal/admin/system/info` route, so "system
//! information" here is the jobs/outbox/notification monitors plus that health payload.
//!
//! Deviations recorded for this chunk (all inside the allowed read surface):
//!
//! - the object-storage daemon client is not part of `AppState` yet, so `/object-storage/summary`
//!   reports the documented TS `UnavailableBlobStore.healthCheck()` fallback (`ok:false`, shared
//!   storage required) instead of a live health probe; the control-plane list/detail/access-log
//!   reads do not need the daemon;
//! - `/users/:id` runs a `publicProgress` subset (drops `_server` and expired exam sessions). Full
//!   catalog validation/content-version resolution lands with P8-T08;
//! - communication configuration uses the presence of the latest `platform_setting_secrets` row
//!   instead of decrypting it: `configured`, `missingFields` and the mask are identical, and the
//!   plaintext is only needed by the transport (P8-T07);
//! - `/options/:kind` enforces its conditional `user:read`/`security:read` gate in the handler; the
//!   policy lists the union of both authority sets so neither branch is refused before the handler.
//!

#![forbid(unsafe_code)]

mod dashboard;
mod helpers;
mod settings;
mod storage;
mod system;
mod users;

use pg_http::{Authn, Channel, Policy};

use super::{Handler, MountedRoute, PrincipalGuard};
use helpers::STAFF_READ_AUTHORITIES;

/// `/options/:kind` enforces its conditional authority inside the handler; the policy lists the
/// union so neither branch is refused before the handler can apply the TS rule.
const OPTION_AUTHORITIES: &[&str] = &[
    "merchant:read",
    "finance:read",
    "gateway:read",
    "case:read",
    "operator:read",
    "kyb:read",
    "compliance:read",
    "aml:read",
    "security:read",
    "reconciliation:read",
    "approval:read",
    "cashout:read",
    "dispute:read",
    "attempt:read",
    "user:read",
];

const STORAGE_AUTHORITIES: &[&str] = &[
    "system:storage:read",
    "system:storage:admin",
    "system:storage:legal-hold",
];

fn route(
    method: &str,
    path: &str,
    origin: &str,
    authorities: &[&str],
    handler: Handler,
) -> MountedRoute {
    MountedRoute {
        policy: Policy::new(method, path, Channel::Admin, Authn::Session, origin)
            .authorities(authorities)
            .body(pg_http::BodyRule::None),
        handler,
        guard: PrincipalGuard::Staff,
    }
}

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "GET",
            "/internal/admin/stats/recent-activity",
            "core-back/api/internal/admin.ts:1270",
            &["security:read"],
            Handler::Custom(dashboard::recent_activity_handler),
        ),
        route(
            "GET",
            "/internal/admin/stats/overview",
            "core-back/api/internal/admin.ts:1306",
            STAFF_READ_AUTHORITIES,
            Handler::Custom(dashboard::overview_handler),
        ),
        route(
            "GET",
            "/internal/admin/options/:kind",
            "core-back/api/internal/admin.ts:1552",
            OPTION_AUTHORITIES,
            Handler::Custom(users::options_handler),
        ),
        route(
            "GET",
            "/internal/admin/users",
            "core-back/api/internal/admin.ts:1653",
            &["user:read", "security:read"],
            Handler::Custom(users::list_users_handler),
        ),
        route(
            "GET",
            "/internal/admin/users/summary",
            "core-back/api/internal/admin.ts:1775",
            &["user:read", "security:read"],
            Handler::Custom(users::users_summary_handler),
        ),
        route(
            "GET",
            "/internal/admin/users/:id",
            "core-back/api/internal/admin.ts:1815",
            &["user:read", "security:read"],
            Handler::Custom(users::user_detail_handler),
        ),
        route(
            "GET",
            "/internal/admin/settings",
            "core-back/api/internal/admin.ts:20221",
            &["settings:read"],
            Handler::Custom(settings::list_settings_handler),
        ),
        route(
            "GET",
            "/internal/admin/settings/summary",
            "core-back/api/internal/admin.ts:20543",
            &["settings:read"],
            Handler::Custom(settings::settings_summary_handler),
        ),
        route(
            "GET",
            "/internal/admin/settings/communication/status",
            "core-back/api/internal/admin.ts:20227",
            &["settings:read"],
            Handler::Custom(settings::communication_status_handler),
        ),
        route(
            "GET",
            "/internal/admin/settings/checkout-support",
            "core-back/api/internal/admin.ts:19792",
            &["settings:read"],
            Handler::Custom(settings::checkout_support_handler),
        ),
        route(
            "GET",
            "/internal/admin/settings/checkout-support/history",
            "core-back/api/internal/admin.ts:19806",
            &["settings:read"],
            Handler::Custom(settings::checkout_support_history_handler),
        ),
        route(
            "GET",
            "/internal/admin/settings/checkout-support/summary",
            "core-back/api/internal/admin.ts:19853",
            &["settings:read"],
            Handler::Custom(settings::checkout_support_summary_handler),
        ),
        route(
            "GET",
            "/internal/admin/system/jobs-outbox/summary",
            "core-back/api/internal/adminSystem.ts:51",
            &["security:read"],
            Handler::Custom(system::jobs_outbox_summary_handler),
        ),
        route(
            "GET",
            "/internal/admin/system/jobs",
            "core-back/api/internal/adminSystem.ts:159",
            &["security:read"],
            Handler::Custom(system::jobs_handler),
        ),
        route(
            "GET",
            "/internal/admin/system/outbox",
            "core-back/api/internal/adminSystem.ts:236",
            &["security:read"],
            Handler::Custom(system::outbox_handler),
        ),
        route(
            "GET",
            "/internal/admin/system/audit-outbox",
            "core-back/api/internal/adminSystem.ts:285",
            &["security:read"],
            Handler::Custom(system::audit_outbox_handler),
        ),
        route(
            "GET",
            "/internal/admin/system/notifications",
            "core-back/api/internal/adminSystem.ts:354",
            &["security:read"],
            Handler::Custom(system::notifications_handler),
        ),
        route(
            "GET",
            "/internal/admin/settings/notification-templates",
            "core-back/api/internal/adminSystem.ts:470",
            &["settings:read"],
            Handler::Custom(system::notification_templates_handler),
        ),
        route(
            "GET",
            "/internal/admin/object-storage/summary",
            "core-back/api/internal/objectStorage.ts:123",
            STORAGE_AUTHORITIES,
            Handler::Custom(storage::summary_handler),
        ),
        route(
            "GET",
            "/internal/admin/object-storage/objects",
            "core-back/api/internal/objectStorage.ts:182",
            STORAGE_AUTHORITIES,
            Handler::Custom(storage::objects_handler),
        ),
        route(
            "GET",
            "/internal/admin/object-storage/objects/:id",
            "core-back/api/internal/objectStorage.ts:226",
            STORAGE_AUTHORITIES,
            Handler::Custom(storage::object_detail_handler),
        ),
        route(
            "GET",
            "/internal/admin/object-storage/access-logs",
            "core-back/api/internal/objectStorage.ts:326",
            STORAGE_AUTHORITIES,
            Handler::Custom(storage::access_logs_handler),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::config::CoreConfig;
    use crate::state::AppState;
    use chrono::Utc;
    use ntex::http::Method;
    use ntex::web::test;
    use pg_domain_auth::{sign_session_at, Channel as AuthChannel, SessionClaims};
    use serde_json::{json, Value};
    use uuid::Uuid;

    use super::helpers::SECRET_MASK;
    use super::*;

    const MASTER_KEY: &str = "core-rs-admin-system-test-key-0123456789";
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

    fn request(path: &str) -> ntex::web::HttpRequest {
        test::TestRequest::default().uri(path).to_http_request()
    }

    struct CallResult {
        status: u16,
        body: Value,
    }

    async fn call(state: &Arc<AppState>, path: &str, token: Option<&str>) -> CallResult {
        let mut builder = test::TestRequest::default().method(Method::GET).uri(path);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let http_request = builder.to_http_request();
        let response = crate::app::dispatch(
            state.clone(),
            http_request,
            ntex::web::types::Payload(ntex::http::Payload::None),
        )
        .await;
        let status = response.status().as_u16();
        let body: ntex::util::Bytes = test::read_body(response).await;
        CallResult {
            status,
            body: serde_json::from_slice(&body).unwrap_or(Value::Null),
        }
    }

    async fn insert_user(state: &AppState, authorities: Value) -> Uuid {
        let id = Uuid::new_v4();
        let email = format!("{id}@admin-system.test");
        sqlx::query(
            "INSERT INTO users (id, updated_at, email, password_hash, role, authorities_map,
                                is_maker, is_checker, mfa_required, mfa_secret_ciphertext, status)
             VALUES ($1, now(), $2, 'test-password-hash', 'COMPLIANCE'::\"UserRole\",
                     $3::jsonb, true, true, false, 'test-mfa-secret', 'ACTIVE'::\"UserStatus\")",
        )
        .bind(id)
        .bind(email)
        .bind(authorities)
        .execute(&state.pools.main)
        .await
        .expect("insert user");
        id
    }

    async fn delete_user(state: &AppState, id: Uuid) {
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(id)
            .execute(&state.pools.main)
            .await
            .expect("delete user");
    }

    fn mint_admin_session(
        user_id: Uuid,
        authorities: &[&str],
        now: chrono::DateTime<Utc>,
    ) -> String {
        let claims = SessionClaims::new(user_id.to_string(), "COMPLIANCE")
            .with_authorities(authorities.iter().copied())
            .with_channel(AuthChannel::Admin)
            .expect("admin channel");
        let mut claims = claims;
        claims.jti = Some(Uuid::new_v4().to_string());
        claims.iat = Some(now.timestamp());
        claims.exp = Some(now.timestamp() + pg_domain_auth::SESSION_TTL_SECONDS);
        sign_session_at(&claims, MASTER_KEY, now).expect("sign")
    }

    fn staff_principal(authorities: &[&str]) -> pg_domain_auth::Principal {
        pg_domain_auth::Principal {
            kind: pg_domain_auth::PrincipalKind::Session,
            user_id: Some(Uuid::new_v4().to_string()),
            role: Some("COMPLIANCE".to_owned()),
            merchant_id: None,
            application_id: None,
            authorities: authorities
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            scopes: Vec::new(),
            token_id: None,
            token_plane: None,
            session_jti: None,
            session_exp: None,
            session_channel: Some(AuthChannel::Admin),
            app_scope_ids: Vec::new(),
        }
    }

    async fn max_communication_version(state: &AppState) -> i32 {
        sqlx::query_scalar(
            "SELECT COALESCE(max(version), 0)::int FROM platform_settings
              WHERE key = 'communication.email' AND scope = 'PLATFORM'",
        )
        .fetch_one(&state.pools.main)
        .await
        .expect("max version")
    }

    #[test]
    fn every_route_is_a_get_with_an_exact_ts_origin() {
        let routes = routes();
        assert_eq!(routes.len(), 22);
        for route in &routes {
            assert_eq!(route.policy.method, "GET");
            assert_eq!(route.policy.channel, pg_http::Channel::Admin);
            assert_eq!(route.policy.authn, Authn::Session);
            assert_eq!(route.guard, PrincipalGuard::Staff);
            assert!(route.policy.ts_origin.contains("core-back/api/internal/"));
            assert!(!route.policy.authorities.is_empty(), "{}", route.key());
        }
        assert!(routes
            .iter()
            .any(|route| route.policy.path == "/internal/admin/users/:id"));
        assert!(routes
            .iter()
            .any(|route| route.policy.path == "/internal/admin/object-storage/summary"));
    }

    #[tokio::test]
    async fn dashboard_overview_returns_the_ts_shape() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let req = request("/internal/admin/stats/overview?period=90d&currency=LYD");
        let body = dashboard::overview(&state, &req).await.expect("overview");
        for key in [
            "period",
            "since",
            "merchantsActive",
            "merchantsPending",
            "currency",
            "byCurrency",
            "mixedCurrency",
            "attemptsByState",
            "volumeByState",
            "attemptsTotal",
            "attemptsSucceeded",
            "attemptsCounted",
            "successRate",
            "grossVolume",
            "grossVolumeAttempts",
            "unknownBacklog",
            "unknownOldestAgeSeconds",
            "openCircuitBreakers",
            "routeHealth",
            "webhookInboxLagSeconds",
            "reconciliationMatchRate",
            "reconciliationItems",
            "approvalPending",
            "approvalExpired",
            "approvalEmergencyDue",
            "approvalQueueAgeing",
            "joinRequestOpen",
            "joinRequestSlaBreaches",
            "amlOpen",
            "amlSlaBreaches",
            "operatorOpen",
            "operatorP1",
            "operatorSlaBreaches",
        ] {
            assert!(body.get(key).is_some(), "missing {key}");
        }
        assert_eq!(body["period"], "90d");
        assert_eq!(body["currency"], "LYD");
        assert!(body["since"]
            .as_str()
            .is_some_and(|value| value.ends_with('Z')));
        assert!(body["successRate"].is_number());
        assert!(body["grossVolume"].is_string());
        assert!(body["reconciliationMatchRate"].is_string());
        assert!(body["byCurrency"].is_array());
        assert!(body["routeHealth"]["healthy"].is_number());
    }

    #[tokio::test]
    async fn dashboard_empty_currency_slice_is_zeroed() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        // A currency the fixture does not use: the selected slice has no attempts even when the
        // cross-currency `byCurrency` breakdown still lists other currencies.
        let req = request("/internal/admin/stats/overview?period=24h&currency=XTS");
        let body = dashboard::overview(&state, &req).await.expect("overview");
        assert_eq!(body["currency"], "XTS");
        assert_eq!(body["attemptsTotal"], 0);
        assert_eq!(body["attemptsSucceeded"], 0);
        assert_eq!(body["attemptsCounted"], 0);
        assert_eq!(body["successRate"], 0);
        assert_eq!(body["grossVolume"], "0.0000");
        assert_eq!(body["grossVolumeAttempts"], 0);
        assert_eq!(body["attemptsByState"], json!({}));
        assert_eq!(body["volumeByState"], json!({}));
        assert!(body["reconciliationMatchRate"].is_string());
    }

    #[tokio::test]
    async fn settings_list_masks_secrets_and_summary_counts_versions() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let version = max_communication_version(&state).await + 1;
        sqlx::query(
            "INSERT INTO platform_settings
                (id, updated_at, key, scope, value_json, version, source, effective_from)
             VALUES ($1, now(), 'communication.email', 'PLATFORM',
                     '{\"enabled\": false, \"smtpHost\": \"smtp.test\"}'::jsonb, $2, 'ADMIN', now())",
        )
        .bind(Uuid::new_v4())
        .bind(version)
        .execute(&state.pools.main)
        .await
        .expect("insert setting");
        sqlx::query(
            "INSERT INTO platform_setting_secrets
                (id, updated_at, key, scope, version, field, ciphertext)
             VALUES ($1, now(), 'communication.email', 'PLATFORM', $2, 'smtpPassword', 'sealed')",
        )
        .bind(Uuid::new_v4())
        .bind(version)
        .execute(&state.pools.main)
        .await
        .expect("insert secret");

        let result = settings::list_settings(&state, &request("/internal/admin/settings"))
            .await
            .expect("list settings");
        let row = result["settings"]
            .as_array()
            .expect("settings array")
            .iter()
            .find(|row| row["key"] == "communication.email" && row["version"] == version)
            .expect("inserted setting");
        assert_eq!(row["valueJson"]["smtpPassword"], SECRET_MASK);
        assert_eq!(row["valueJson"]["smtpHost"], "smtp.test");
        assert!(result["settings"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty()));

        let summary =
            settings::settings_summary(&state, &request("/internal/admin/settings/summary"))
                .await
                .expect("summary");
        assert!(summary["summary"]["keys"]
            .as_i64()
            .is_some_and(|value| value >= 1));
        assert!(summary["summary"]["versions"]
            .as_i64()
            .is_some_and(|value| value >= 1));

        sqlx::query("DELETE FROM platform_setting_secrets WHERE key = 'communication.email' AND scope = 'PLATFORM' AND version = $1")
            .bind(version)
            .execute(&state.pools.main)
            .await
            .expect("delete secret");
        sqlx::query("DELETE FROM platform_settings WHERE key = 'communication.email' AND scope = 'PLATFORM' AND version = $1")
            .bind(version)
            .execute(&state.pools.main)
            .await
            .expect("delete setting");
    }

    #[tokio::test]
    async fn users_list_and_detail_never_expose_secrets() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let user_id = insert_user(&state, json!(["user:read"])).await;
        let email = format!("{user_id}@admin-system.test");

        let list = users::list_users(
            &state,
            &request(&format!(
                "/internal/admin/users?search={email}&pageSize=200"
            )),
        )
        .await
        .expect("list users");
        let row = list["users"]
            .as_array()
            .expect("users array")
            .iter()
            .find(|row| row["id"] == user_id.to_string())
            .expect("inserted user");
        assert_eq!(row["email"], email);
        assert!(row.get("passwordHash").is_none());
        assert!(row.get("mfaSecretCiphertext").is_none());
        assert!(row.get("invitationTokenHash").is_none());
        assert_eq!(list["page"], 1);
        assert_eq!(list["pageSize"], 200);

        let detail = users::user_detail(
            &state,
            &request(&format!("/internal/admin/users/{user_id}")),
        )
        .await
        .expect("detail");
        assert_eq!(detail["user"]["id"], user_id.to_string());
        assert!(detail["user"].get("passwordHash").is_none());
        assert!(detail["user"].get("mfaSecretCiphertext").is_none());
        assert!(detail["user"].get("invitationTokenHash").is_none());
        assert!(detail["user"]["academyProgressJson"]
            .get("_server")
            .is_none());
        assert!(detail["approvalHistory"].is_array());
        assert!(detail["auditTrail"].is_array());

        let unknown = users::user_detail(
            &state,
            &request(&format!("/internal/admin/users/{}", Uuid::new_v4())),
        )
        .await
        .expect_err("unknown user");
        assert_eq!(unknown.status, 404);
        assert_eq!(unknown.code, "USER_NOT_FOUND");

        delete_user(&state, user_id).await;
    }

    #[tokio::test]
    async fn object_storage_summary_lists_and_404() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let summary = storage::summary(&state, &request("/internal/admin/object-storage/summary"))
            .await
            .expect("summary");
        assert_eq!(summary["health"]["ok"], false);
        assert!(summary["health"]["error"]
            .as_str()
            .is_some_and(|value| value.contains("shared storage is required")));
        assert!(summary["activeKekVersion"]
            .as_i64()
            .is_some_and(|value| value >= 1));
        assert!(summary["totalObjects"].as_i64().is_some());
        assert!(summary["countsByStatus"].is_object());
        assert!(summary["bytesByNamespace"].is_object());

        let objects = storage::objects(
            &state,
            &request("/internal/admin/object-storage/objects?page=1&pageSize=1"),
        )
        .await
        .expect("objects");
        assert_eq!(objects["page"], 1);
        assert_eq!(objects["pageSize"], 1);
        assert!(objects["objects"].is_array());
        assert!(objects["total"].as_i64().is_some());

        // A bad sort key is refused by the strict query schema.
        let invalid = storage::objects(
            &state,
            &request("/internal/admin/object-storage/objects?sortKey=DROP%20TABLE"),
        )
        .await
        .expect_err("invalid sort");
        assert_eq!(invalid.status, 400);
        assert_eq!(invalid.code, "INVALID_BODY");

        let missing = storage::object_detail(
            &state,
            &request(&format!(
                "/internal/admin/object-storage/objects/{}",
                Uuid::new_v4()
            )),
        )
        .await
        .expect_err("missing object");
        assert_eq!(missing.status, 404);
        assert_eq!(missing.code, "STORAGE_OBJECT_NOT_FOUND");

        let logs = storage::access_logs(
            &state,
            &request("/internal/admin/object-storage/access-logs?page=1&pageSize=5"),
        )
        .await
        .expect("access logs");
        assert!(logs["accessLogs"].is_array());
        assert_eq!(logs["pageSize"], 5);
    }

    #[tokio::test]
    async fn system_lists_return_the_list_envelope() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        for (path, key) in [
            ("/internal/admin/system/jobs?pageSize=5", "jobs"),
            ("/internal/admin/system/outbox?pageSize=5", "outbox"),
            (
                "/internal/admin/system/audit-outbox?pageSize=5",
                "auditOutbox",
            ),
            (
                "/internal/admin/system/notifications?status=ALL&pageSize=5",
                "notifications",
            ),
            (
                "/internal/admin/settings/notification-templates?pageSize=5",
                "templates",
            ),
        ] {
            let req = request(path);
            let body = match key {
                "jobs" => system::jobs(&state, &req).await,
                "outbox" => system::outbox(&state, &req).await,
                "auditOutbox" => system::audit_outbox(&state, &req).await,
                "notifications" => system::notifications(&state, &req).await,
                _ => system::notification_templates(&state, &req).await,
            }
            .unwrap_or_else(|error| panic!("{path}: {error:?}"));
            assert!(body.get(key).and_then(Value::as_array).is_some(), "{path}");
            assert!(body["total"].as_i64().is_some(), "{path}");
            assert_eq!(body["page"], 1, "{path}");
            assert_eq!(body["pageSize"], 5, "{path}");
        }
        let summary_module = system::jobs_outbox_summary(
            &state,
            &request("/internal/admin/system/jobs-outbox/summary"),
        )
        .await
        .expect("summary");
        assert!(summary_module["jobs24h"].is_object());
        assert!(summary_module["ledger"]["shards"].is_number());
    }

    #[tokio::test]
    async fn dynamic_detail_routes_dispatch_through_the_router() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let user_id = insert_user(&state, json!(["user:read", "merchant:read"])).await;
        let now = Utc::now();
        let token = mint_admin_session(user_id, &["user:read", "merchant:read"], now);

        let detail = call(
            &state,
            &format!("/internal/admin/users/{user_id}"),
            Some(&token),
        )
        .await;
        assert_eq!(detail.status, 200);
        assert_eq!(detail.body["user"]["id"], user_id.to_string());

        let summary = call(&state, "/internal/admin/users/summary", Some(&token)).await;
        assert_eq!(summary.status, 200);
        assert!(summary.body["summary"]["total"].is_number());

        let merchants = call(&state, "/internal/admin/options/merchants", Some(&token)).await;
        assert_eq!(merchants.status, 200);
        assert!(merchants.body["items"].is_array());

        let storage_denied = call(
            &state,
            "/internal/admin/object-storage/summary",
            Some(&token),
        )
        .await;
        assert_eq!(storage_denied.status, 403);
        assert_eq!(storage_denied.body["code"], "AUTHORITY_REQUIRED");

        let storage_user = insert_user(&state, json!(["system:storage:read"])).await;
        let storage_token = mint_admin_session(storage_user, &["system:storage:read"], now);
        let storage_summary = call(
            &state,
            "/internal/admin/object-storage/summary",
            Some(&storage_token),
        )
        .await;
        assert_eq!(storage_summary.status, 200);
        assert_eq!(storage_summary.body["health"]["ok"], false);
        let missing = call(
            &state,
            &format!("/internal/admin/object-storage/objects/{}", Uuid::new_v4()),
            Some(&storage_token),
        )
        .await;
        assert_eq!(missing.status, 404);
        assert_eq!(missing.body["code"], "STORAGE_OBJECT_NOT_FOUND");

        delete_user(&state, user_id).await;
        delete_user(&state, storage_user).await;
    }

    #[tokio::test]
    async fn authority_rejection_and_unknown_option() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let unauthenticated = call(&state, "/internal/admin/settings", None).await;
        assert_eq!(unauthenticated.status, 401);
        assert_eq!(unauthenticated.body["code"], "AUTH_REQUIRED");

        let user_id = insert_user(&state, json!(["merchant:read"])).await;
        let now = Utc::now();
        let token = mint_admin_session(user_id, &["merchant:read"], now);
        let forbidden = call(&state, "/internal/admin/settings", Some(&token)).await;
        assert_eq!(forbidden.status, 403);
        assert_eq!(forbidden.body["code"], "AUTHORITY_REQUIRED");

        let forbidden_users = call(&state, "/internal/admin/users", Some(&token)).await;
        assert_eq!(forbidden_users.status, 403);
        assert_eq!(forbidden_users.body["code"], "AUTHORITY_REQUIRED");

        let principal = staff_principal(&["merchant:read"]);
        let error = users::options(
            &state,
            &request("/internal/admin/options/bogus"),
            Some(&principal),
        )
        .await
        .expect_err("unknown kind");
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "UNKNOWN_OPTION_KIND");

        let users_denied = users::options(
            &state,
            &request("/internal/admin/options/users"),
            Some(&principal),
        )
        .await
        .expect_err("users need user:read");
        assert_eq!(users_denied.status, 403);
        assert_eq!(users_denied.code, "AUTHORITY_REQUIRED");

        let allowed_principal = staff_principal(&["user:read"]);
        let users = users::options(
            &state,
            &request("/internal/admin/options/users"),
            Some(&allowed_principal),
        )
        .await
        .expect("user options");
        assert!(users["items"].is_array());
        assert_eq!(
            users["total"],
            users["items"].as_array().map_or(0, Vec::len)
        );

        let bad_uuid = users::user_detail(&state, &request("/internal/admin/users/not-a-uuid"))
            .await
            .expect_err("invalid uuid");
        assert_eq!(bad_uuid.status, 400);
        assert_eq!(bad_uuid.code, "INVALID_BODY");

        delete_user(&state, user_id).await;
    }

    #[tokio::test]
    async fn recent_activity_clamps_the_limit() {
        let Some(state) = state_or_skip().await else {
            return;
        };
        let body = dashboard::recent_activity(
            &state,
            &request("/internal/admin/stats/recent-activity?limit=500"),
        )
        .await
        .expect("recent activity");
        let rows = body["recentActivity"].as_array().expect("array");
        assert!(rows.len() <= 20);
        if let Some(row) = rows.first() {
            for key in [
                "id",
                "createdAt",
                "actorEmail",
                "role",
                "action",
                "entityType",
                "entityId",
                "approvalRequestId",
            ] {
                assert!(row.get(key).is_some(), "missing {key}");
            }
        }
    }
}
