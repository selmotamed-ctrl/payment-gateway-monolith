//! Fixtures for the adapter integration tests.
//!
//! Every fixture is inserted through the connection the test owns, so the test can roll back and
//! leave no row behind. The ids are random v7 values and the values are deliberately unusual
//! (`XTS`-style currency is not used because the ledger scenarios are asserted in `LYD`).

#![allow(dead_code)]

use std::str::FromStr;
use std::time::Duration;

use pg_flow_engine::ports::{Attempt, Environment, FeeBearer, OwnershipMode};
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

pub const DEFAULT_TEST_DATABASE_URL: &str =
    "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";
pub const CURRENCY: &str = "LYD";

/// Connects to the test database or prints a `SKIP:` line and returns `None`.
pub async fn test_pool() -> Option<PgPool> {
    let url = std::env::var("PG_TEST_DATABASE_URL")
        .unwrap_or_else(|_| DEFAULT_TEST_DATABASE_URL.to_owned());
    let attempt = async {
        PgPool::connect(&url)
            .await
            .map_err(|error| error.to_string())
    };
    let pool = match tokio::time::timeout(Duration::from_secs(3), attempt).await {
        Ok(Ok(pool)) => pool,
        _ => {
            eprintln!("SKIP: PostgreSQL not reachable at {url}");
            return None;
        }
    };
    let probe: Result<String, _> = sqlx::query_scalar("SELECT current_setting('server_version')")
        .fetch_one(&pool)
        .await;
    if probe.is_err() {
        eprintln!("SKIP: PostgreSQL session failed at {url}");
        return None;
    }
    Some(pool)
}

#[must_use]
pub fn dec(value: &str) -> Decimal {
    Decimal::from_str(value).expect("test decimal")
}

#[derive(Debug, Clone)]
pub struct Fixture {
    pub user_id: Uuid,
    pub merchant_id: Uuid,
    pub wallet_gl_id: Uuid,
    pub wallet_id: Uuid,
    pub application_id: Uuid,
    pub gateway_id: Uuid,
    pub gateway_version_id: Uuid,
    pub credential_set_id: Uuid,
    pub rail_id: Uuid,
    pub route_id: Uuid,
    pub commission_profile_id: Uuid,
    pub attempt_group_id: Uuid,
    pub link_id: Uuid,
    pub attempt_id: Uuid,
    pub reference: String,
    pub flow_id: Uuid,
    pub step_id: Uuid,
    pub treasury_id: Uuid,
    pub income_id: Uuid,
    pub provider_fee_id: Uuid,
    pub gateway_clearing_id: Uuid,
    pub suspense_id: Uuid,
}

impl Fixture {
    /// The attempt as the engine/ports see it (built from the same values as the row).
    #[must_use]
    pub fn attempt(&self) -> Attempt {
        let mut attempt = Attempt::new(
            self.attempt_id.to_string(),
            self.reference.clone(),
            dec("100.0000"),
            CURRENCY,
        );
        attempt.gateway_reference = Some(format!("GW-{}", self.attempt_id));
        attempt.merchant_id = Some(self.merchant_id.to_string());
        attempt.application_id = Some(self.application_id.to_string());
        attempt.gateway_id = Some(self.gateway_id.to_string());
        attempt.gateway_version_id = Some(self.gateway_version_id.to_string());
        attempt.route_id = Some(self.route_id.to_string());
        attempt.rail_id = Some(self.rail_id.to_string());
        attempt.link_id = Some(self.link_id.to_string());
        attempt.credential_set_id = Some(self.credential_set_id.to_string());
        attempt.wallet_id = Some(self.wallet_id.to_string());
        attempt.wallet_gl_account_id = Some(self.wallet_gl_id.to_string());
        attempt.commission_profile_id = Some(self.commission_profile_id.to_string());
        attempt.ownership_mode = OwnershipMode::PlatformClearing;
        attempt.fee_bearer = FeeBearer::MerchantAbsorbs;
        attempt.currency = CURRENCY.to_owned();
        attempt.env = Environment::Live;
        attempt.platform_commission_amount = Some(dec("3.0000"));
        attempt.net_merchant_amount = Some(dec("97.0000"));
        attempt
    }
}

/// Inserts one complete, realistic attempt fixture. Every insert joins `conn`.
pub async fn seed(conn: &mut PgConnection) -> Fixture {
    let user_id = Uuid::now_v7();
    let merchant_id = Uuid::now_v7();
    let wallet_gl_id = Uuid::now_v7();
    let wallet_id = Uuid::now_v7();
    let application_id = Uuid::now_v7();
    let gateway_id = Uuid::now_v7();
    let gateway_version_id = Uuid::now_v7();
    let credential_set_id = Uuid::now_v7();
    let rail_id = Uuid::now_v7();
    let route_id = Uuid::now_v7();
    let commission_profile_id = Uuid::now_v7();
    let link_id = Uuid::now_v7();
    let attempt_group_id = Uuid::now_v7();
    let attempt_id = Uuid::now_v7();
    let reference = format!("ADAPTERS-{attempt_id}");
    let flow_id = Uuid::now_v7();
    let step_id = Uuid::now_v7();
    let treasury_id = Uuid::now_v7();
    let income_id = Uuid::now_v7();
    let provider_fee_id = Uuid::now_v7();
    let gateway_clearing_id = Uuid::now_v7();
    let suspense_id = Uuid::now_v7();

    sqlx::query(
        "INSERT INTO users (id, updated_at, email, role, authorities_map, status) \
         VALUES ($1, now(), $2, 'GATEWAY_ADMIN', '{}'::jsonb, 'ACTIVE')",
    )
    .bind(user_id)
    .bind(format!("adapters-{user_id}@example.test"))
    .execute(&mut *conn)
    .await
    .expect("insert user");

    sqlx::query(
        "INSERT INTO merchants (id, updated_at, legal_name, trade_name, onboarding_channel, country, status) \
         VALUES ($1, now(), 'Adapters Ltd', 'Adapters', 'API', 'LY', 'ACTIVE')",
    )
    .bind(merchant_id)
    .execute(&mut *conn)
    .await
    .expect("insert merchant");

    sqlx::query(
        "INSERT INTO gateways (id, updated_at, code, name, operator, aliases, kind, status, verification_state) \
         VALUES ($1, now(), $2, 'Adapters gateway', 'Adapters', '[]'::jsonb, 'DIRECT', 'LIVE', 'UNVERIFIED')",
    )
    .bind(gateway_id)
    .bind(format!("ADG-{gateway_id}"))
    .execute(&mut *conn)
    .await
    .expect("insert gateway");

    sqlx::query(
        "INSERT INTO credential_sets \
         (id, updated_at, gateway_id, env, owner_type, settlement_target, entries_ciphertext) \
         VALUES ($1, now(), $2, 'LIVE', 'PLATFORM', 'PLATFORM_CLEARING', $3)",
    )
    .bind(credential_set_id)
    .bind(gateway_id)
    .bind(json!([
        {"key": "MID", "type": "BODY", "value": "MID-1", "isSecret": false},
        {"key": "apiKey", "type": "HEADER", "value": "secret-key", "isSecret": false}
    ]))
    .execute(&mut *conn)
    .await
    .expect("insert credential set");

    for (id, account_type, owner, gateway, credential, env) in [
        (
            wallet_gl_id,
            "MERCHANT_WALLET",
            Some(merchant_id),
            None,
            None,
            None,
        ),
        (treasury_id, "TREASURY", None, None, None, None),
        (income_id, "PLATFORM_INCOME", None, None, None, None),
        (
            provider_fee_id,
            "PROVIDER_FEE_EXPENSE",
            None,
            None,
            None,
            None,
        ),
        (suspense_id, "SUSPENSE", None, None, None, None),
        (
            gateway_clearing_id,
            "GATEWAY_CLEARING",
            None,
            Some(gateway_id),
            Some(credential_set_id),
            Some("LIVE"),
        ),
    ] {
        sqlx::query(
            "INSERT INTO gl_accounts \
             (id, updated_at, account_type, owner_id, gateway_id, credential_set_id, env, currency, shard_count) \
             VALUES ($1, now(), $2::text::\"GlAccountType\", $3, $4, $5, $6, $7, 4)",
        )
        .bind(id)
        .bind(account_type)
        .bind(owner.map(|value| value.to_string()))
        .bind(gateway)
        .bind(credential)
        .bind(env)
        .bind(CURRENCY)
        .execute(&mut *conn)
        .await
        .expect("insert GL account");
    }

    sqlx::query(
        "INSERT INTO wallets (id, updated_at, merchant_id, gl_account_id, currency, status) \
         VALUES ($1, now(), $2, $3, $4, 'ACTIVE')",
    )
    .bind(wallet_id)
    .bind(merchant_id)
    .bind(wallet_gl_id)
    .bind(CURRENCY)
    .execute(&mut *conn)
    .await
    .expect("insert wallet");

    sqlx::query(
        "INSERT INTO applications (id, updated_at, merchant_id, name, assigned_wallet_id, status) \
         VALUES ($1, now(), $2, 'Adapters app', $3, 'ACTIVE')",
    )
    .bind(application_id)
    .bind(merchant_id)
    .bind(wallet_id)
    .execute(&mut *conn)
    .await
    .expect("insert application");

    sqlx::query(
        "INSERT INTO gateway_versions \
         (id, updated_at, gateway_id, version_number, snapshot_ciphertext, content_hash, state, created_by) \
         VALUES ($1, now(), $2, 1, '{}', $3, 'LIVE', $4)",
    )
    .bind(gateway_version_id)
    .bind(gateway_id)
    .bind(format!("{:0<64}", gateway_version_id.simple()))
    .bind(user_id)
    .execute(&mut *conn)
    .await
    .expect("insert gateway version");

    sqlx::query(
        "INSERT INTO gateway_settings \
         (id, updated_at, gateway_version_id, amount_scale, amount_precision, amount_rounding, amount_format, \
          reference_format, session_ttl_seconds, otp_ttl_seconds, otp_resend_cooldown_seconds, max_otp_attempts) \
         VALUES ($1, now(), $2, 2, 4, 'HALF_UP', '#,##0.00', '{}'::jsonb, 900, 120, 60, 3)",
    )
    .bind(Uuid::now_v7())
    .bind(gateway_version_id)
    .execute(&mut *conn)
    .await
    .expect("insert gateway settings");

    sqlx::query(
        "INSERT INTO gateway_environments \
         (id, updated_at, gateway_version_id, env, base_urls, allowed_hosts, inbound_ip_allowlist, outbound_egress_ips) \
         VALUES ($1, now(), $2, 'LIVE', $3, $4, '[]'::jsonb, '[]'::jsonb)",
    )
    .bind(Uuid::now_v7())
    .bind(gateway_version_id)
    .bind(json!({"api": "https://sandbox.adapters.test/", "inquiry": "https://sandbox.adapters.test"}))
    .bind(json!(["sandbox.adapters.test"]))
    .execute(&mut *conn)
    .await
    .expect("insert gateway environment");

    sqlx::query(
        "INSERT INTO gateway_auth (id, updated_at, gateway_version_id, env, method, auth_apply) \
         VALUES ($1, now(), $2, 'LIVE', 'API_KEY', 'HEADER')",
    )
    .bind(Uuid::now_v7())
    .bind(gateway_version_id)
    .execute(&mut *conn)
    .await
    .expect("insert gateway auth");

    sqlx::query(
        "INSERT INTO rails \
         (id, updated_at, code, name_ar, name_en, collection_mode, capabilities) \
         VALUES ($1, now(), $2, 'اختبار', 'Adapters rail', 'OTP_PULL', '{}'::jsonb)",
    )
    .bind(rail_id)
    .bind(format!("adr-{rail_id}"))
    .execute(&mut *conn)
    .await
    .expect("insert rail");

    sqlx::query(
        "INSERT INTO rail_routes \
         (id, updated_at, rail_id, gateway_id, credential_policy, cost_model, mismatch_policy, scope) \
         VALUES ($1, now(), $2, $3, 'PLATFORM', $4, $5, '{}'::jsonb)",
    )
    .bind(route_id)
    .bind(rail_id)
    .bind(gateway_id)
    .bind(json!({"accrue_fee_at_confirm": true}))
    .bind(json!({"tolerance_amount": "0.0100"}))
    .execute(&mut *conn)
    .await
    .expect("insert rail route");

    sqlx::query(
        "INSERT INTO commission_profiles \
         (id, updated_at, rail_code, calc_type, fee_bearer_default, rounding_mode, effective_from, percentage_rate) \
         VALUES ($1, now(), 'adr-test', 'PERCENTAGE', 'MERCHANT_ABSORBS', 'HALF_UP', now(), 0.03)",
    )
    .bind(commission_profile_id)
    .execute(&mut *conn)
    .await
    .expect("insert commission profile");

    sqlx::query(
        "INSERT INTO payment_links \
         (id, updated_at, key, application_id, wallet_id, amount, currency, fee_bearer, use_count, env, state) \
         VALUES ($1, now(), $2, $3, $4, 100.0000, $5, 'MERCHANT_ABSORBS', 1, 'LIVE', 'PENDING')",
    )
    .bind(link_id)
    .bind(format!("adl-{link_id}"))
    .bind(application_id)
    .bind(wallet_id)
    .bind(CURRENCY)
    .execute(&mut *conn)
    .await
    .expect("insert payment link");

    sqlx::query(
        "INSERT INTO attempt_groups (id, updated_at, link_id, customer_fingerprint) \
         VALUES ($1, now(), $2, $3)",
    )
    .bind(attempt_group_id)
    .bind(link_id)
    .bind(format!("{:0<64}", attempt_group_id.simple()))
    .execute(&mut *conn)
    .await
    .expect("insert attempt group");

    sqlx::query(
        r#"
INSERT INTO payment_attempts
    (id, updated_at, reference, link_id, attempt_group_id, application_id, merchant_id, rail_id,
     route_id, credential_set_id, gateway_version_id, commission_profile_id, env, mode, sub_mode,
     status, requested_amount, surcharge_amount, total_charged_amount, fee_bearer, settlement_target,
     wallet_id, wallet_gl_account_id, currency, customer_fields_masked, context_ciphertext,
     expires_at, grace_expires_at)
VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'LIVE', 'API', NULL,
        'CREATED', 100.0000, 0.0000, 100.0000, 'MERCHANT_ABSORBS', 'PLATFORM_CLEARING',
        $12, $13, $14, $15, '', now() + interval '30 minutes', now() + interval '35 minutes')
"#,
    )
    .bind(attempt_id)
    .bind(&reference)
    .bind(link_id)
    .bind(attempt_group_id)
    .bind(application_id)
    .bind(merchant_id)
    .bind(rail_id)
    .bind(route_id)
    .bind(credential_set_id)
    .bind(gateway_version_id)
    .bind(commission_profile_id)
    .bind(wallet_id)
    .bind(wallet_gl_id)
    .bind(CURRENCY)
    .bind(json!({"customer_mobile": "0912345678", "customer_ip": "203.0.113.10"}))
    .execute(&mut *conn)
    .await
    .expect("insert payment attempt");

    sqlx::query(
        "INSERT INTO flows (id, updated_at, gateway_version_id, rail_id, sub_mode, phase) \
         VALUES ($1, now(), $2, $3, NULL, 'INITIATE')",
    )
    .bind(flow_id)
    .bind(gateway_version_id)
    .bind(rail_id)
    .execute(&mut *conn)
    .await
    .expect("insert flow");

    sqlx::query(
        r#"
INSERT INTO flow_steps
    (id, updated_at, flow_id, order_index, type, method, url_template, content_type,
     side_effect, retry_policy, idempotency_config, point_of_no_return)
VALUES ($1, now(), $2, 0, 'HTTP', 'POST', '{api}/verify', 'APPLICATION_JSON',
        'SENDS_NOTIFICATION', 'SAFE_WITH_COOLDOWN', '{}'::jsonb, false)
"#,
    )
    .bind(step_id)
    .bind(flow_id)
    .execute(&mut *conn)
    .await
    .expect("insert flow step");

    sqlx::query(
        "INSERT INTO step_parameters \
         (id, updated_at, step_id, place, key, source, selector, transforms) \
         VALUES ($1, now(), $2, 'BODY', 'mobile_number', 'CUSTOMER_FIELD', 'customer_mobile', '[]'::jsonb)",
    )
    .bind(Uuid::now_v7())
    .bind(step_id)
    .execute(&mut *conn)
    .await
    .expect("insert step parameter");

    sqlx::query(
        "INSERT INTO step_outputs (id, updated_at, step_id, name, selector, transforms, store_as, required) \
         VALUES ($1, now(), $2, 'process_id', 'result.process_id', '[]'::jsonb, 'STATE', true)",
    )
    .bind(Uuid::now_v7())
    .bind(step_id)
    .execute(&mut *conn)
    .await
    .expect("insert step output");

    sqlx::query(
        "INSERT INTO status_rules \
         (id, updated_at, gateway_version_id, phase, order_index, selector, op, value_json, canonical_status) \
         VALUES ($1, now(), $2, 'INITIATE', 0, 'status', 'EQUALS', '\"OTP_SENT\"'::jsonb, 'AWAITING_CUSTOMER')",
    )
    .bind(Uuid::now_v7())
    .bind(gateway_version_id)
    .execute(&mut *conn)
    .await
    .expect("insert status rule");

    Fixture {
        user_id,
        merchant_id,
        wallet_gl_id,
        wallet_id,
        application_id,
        gateway_id,
        gateway_version_id,
        credential_set_id,
        rail_id,
        route_id,
        commission_profile_id,
        attempt_group_id,
        link_id,
        attempt_id,
        reference,
        flow_id,
        step_id,
        treasury_id,
        income_id,
        provider_fee_id,
        gateway_clearing_id,
        suspense_id,
    }
}
