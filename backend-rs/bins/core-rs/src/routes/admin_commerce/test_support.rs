//! DB-gated fixture for the admin commerce read-route tests.
//!
//! Every test creates its own merchant with a UUID-suffixed name so parallel runs and the seeded
//! dataset cannot interfere, and deletes every row it created (by merchant/attempt scoped deletes)
//! even when an assertion fails. When PostgreSQL is unreachable the test prints a skip line.

#![cfg(test)]

use std::time::Duration;

use pg_domain_auth::{Principal, PrincipalKind};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

const DEFAULT_URL: &str = "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

/// Connect or return `None` after printing the skip reason.
pub async fn pool_or_skip() -> Option<PgPool> {
    let url = std::env::var("PG_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_URL.to_owned());
    let connect = PgPoolOptions::new().max_connections(4).connect(&url);
    let pool = match tokio::time::timeout(Duration::from_secs(4), connect).await {
        Ok(Ok(pool)) => pool,
        Ok(Err(error)) => {
            eprintln!("SKIP: PostgreSQL is unreachable at {url}: {error}");
            return None;
        }
        Err(_) => {
            eprintln!("SKIP: PostgreSQL connect timed out at {url}");
            return None;
        }
    };
    let version: i32 = sqlx::query_scalar("SELECT version FROM schema_versions")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    if version < 46 {
        eprintln!("SKIP: schema version {version} is older than 46");
        return None;
    }
    Some(pool)
}

/// A staff principal with the given authorities.
pub fn staff(role: &str, authorities: &[&str]) -> Principal {
    Principal {
        kind: PrincipalKind::Session,
        user_id: Some(Uuid::new_v4().to_string()),
        role: Some(role.to_owned()),
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
        session_channel: Some(pg_domain_auth::Channel::Admin),
        app_scope_ids: Vec::new(),
    }
}

fn hex64() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Every row one test creates.
#[derive(Clone)]
pub struct Fixture {
    pub merchant: Uuid,
    pub user: Uuid,
    pub gateway: Uuid,
    pub gateway_version: Uuid,
    pub rail: Uuid,
    pub route: Uuid,
    pub credential_set: Uuid,
    pub commission_profile: Uuid,
    pub gl_account: Uuid,
    pub wallet: Uuid,
    pub application: Uuid,
    pub link: Uuid,
    pub pos: Uuid,
    pub screen: Uuid,
    pub token: Uuid,
    pub asset: Uuid,
    pub group: Uuid,
    pub attempt: Uuid,
    pub cashout: Uuid,
    pub case: Uuid,
    pub unique: String,
}

impl Fixture {
    #[must_use]
    pub fn new(label: &str) -> Self {
        let unique = format!("{label}-{}", Uuid::new_v4().simple());
        Self {
            merchant: Uuid::new_v4(),
            user: Uuid::new_v4(),
            gateway: Uuid::new_v4(),
            gateway_version: Uuid::new_v4(),
            rail: Uuid::new_v4(),
            route: Uuid::new_v4(),
            credential_set: Uuid::new_v4(),
            commission_profile: Uuid::new_v4(),
            gl_account: Uuid::new_v4(),
            wallet: Uuid::new_v4(),
            application: Uuid::new_v4(),
            link: Uuid::new_v4(),
            pos: Uuid::new_v4(),
            screen: Uuid::new_v4(),
            token: Uuid::new_v4(),
            asset: Uuid::new_v4(),
            group: Uuid::new_v4(),
            attempt: Uuid::new_v4(),
            cashout: Uuid::new_v4(),
            case: Uuid::new_v4(),
            unique,
        }
    }

    /// Build the whole graph the eight resources need.
    pub async fn populate(&mut self, pool: &PgPool) -> Result<(), String> {
        let exec = |sql: &'static str| sqlx::query(sql);

        exec(
            "INSERT INTO users (id, updated_at, email, role, authorities_map, status) \
             VALUES ($1, now(), $2, 'GATEWAY_ADMIN', '{}'::jsonb, 'ACTIVE')",
        )
        .bind(self.user)
        .bind(format!("{}@example.test", self.unique))
        .execute(pool)
        .await
        .map_err(|error| format!("user: {error}"))?;

        exec(
            "INSERT INTO gateways (id, updated_at, code, name, operator, aliases, kind) \
             VALUES ($1, now(), $2, $3, 'test', '[]'::jsonb, 'DIRECT')",
        )
        .bind(self.gateway)
        .bind(format!("gw_{}", self.unique))
        .bind(format!("Gateway {}", self.unique))
        .execute(pool)
        .await
        .map_err(|error| format!("gateway: {error}"))?;

        exec(
            "INSERT INTO rails (id, updated_at, code, name_ar, name_en, collection_mode, capabilities) \
             VALUES ($1, now(), $2, $3, $3, 'OTP_PULL', '[]'::jsonb)",
        )
        .bind(self.rail)
        .bind(format!("rail_{}", self.unique))
        .bind(format!("Rail {}", self.unique))
        .execute(pool)
        .await
        .map_err(|error| format!("rail: {error}"))?;

        exec(
            "INSERT INTO gateway_versions \
             (id, updated_at, gateway_id, version_number, snapshot_ciphertext, content_hash, created_by) \
             VALUES ($1, now(), $2, 1, 'cipher', $3, $4)",
        )
        .bind(self.gateway_version)
        .bind(self.gateway)
        .bind(hex64())
        .bind(self.user)
        .execute(pool)
        .await
        .map_err(|error| format!("gateway version: {error}"))?;

        exec(
            "INSERT INTO gateway_settings \
             (id, updated_at, gateway_version_id, amount_scale, amount_precision, amount_rounding, \
              amount_format, reference_format, session_ttl_seconds, otp_ttl_seconds, \
              otp_resend_cooldown_seconds, supports_status_check) \
             VALUES ($1, now(), $2, 2, 2, 'HALF_UP', 'plain', '{}'::jsonb, 900, 300, 60, true)",
        )
        .bind(Uuid::new_v4())
        .bind(self.gateway_version)
        .execute(pool)
        .await
        .map_err(|error| format!("gateway settings: {error}"))?;

        exec(
            "INSERT INTO rail_routes \
             (id, updated_at, rail_id, gateway_id, credential_policy, cost_model, mismatch_policy, scope) \
             VALUES ($1, now(), $2, $3, 'PLATFORM', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)",
        )
        .bind(self.route)
        .bind(self.rail)
        .bind(self.gateway)
        .execute(pool)
        .await
        .map_err(|error| format!("rail route: {error}"))?;

        exec(
            "INSERT INTO credential_sets \
             (id, updated_at, gateway_id, env, owner_type, settlement_target, entries_ciphertext) \
             VALUES ($1, now(), $2, 'LIVE', 'PLATFORM', 'PLATFORM_CLEARING', '{}'::jsonb)",
        )
        .bind(self.credential_set)
        .bind(self.gateway)
        .execute(pool)
        .await
        .map_err(|error| format!("credential set: {error}"))?;

        exec(
            "INSERT INTO merchants \
             (id, updated_at, legal_name, trade_name, display_name, status, kyb_status, risk_tier, \
              onboarding_channel, country, contact_email, contact_phone, tax_id, registration_no, \
              activated_at, next_kyb_review_at, negative_balance_ceiling, \
              commission_receivable_ceiling, payout_bank_details_json) \
             VALUES ($1, now(), $2, $3, $3, 'ACTIVE', 'VERIFIED', 'HIGH', 'SELF_SERVICE', 'LY', \
              $4, '+218910000000', $5, $6, now(), now() + interval '20 days', 0, 1000.0000, \
              '{\"bank\":\"Test Bank\"}'::jsonb)",
        )
        .bind(self.merchant)
        .bind(format!("{} Legal", self.unique))
        .bind(format!("{} Trade", self.unique))
        .bind(format!("{}@merchant.test", self.unique))
        .bind(format!("TAX-{}", self.unique))
        .bind(format!("REG-{}", self.unique))
        .execute(pool)
        .await
        .map_err(|error| format!("merchant: {error}"))?;

        exec(
            "INSERT INTO commission_profiles \
             (id, updated_at, merchant_id, rail_code, calc_type, fee_bearer_default, rounding_mode, effective_from) \
             VALUES ($1, now(), $2, $3, 'FLAT', 'MERCHANT_ABSORBS', 'HALF_UP', now())",
        )
        .bind(self.commission_profile)
        .bind(self.merchant)
        .bind(format!("rail_{}", self.unique))
        .execute(pool)
        .await
        .map_err(|error| format!("commission profile: {error}"))?;

        exec(
            "INSERT INTO gl_accounts (id, updated_at, account_type, currency, shard_count) \
             VALUES ($1, now(), 'MERCHANT_WALLET', 'LYD', 1)",
        )
        .bind(self.gl_account)
        .execute(pool)
        .await
        .map_err(|error| format!("gl account: {error}"))?;

        sqlx::query(
            "UPDATE gl_account_shards SET current_balance = -25.0000, line_seq = 5 \
             WHERE gl_account_id = $1 AND shard_id = 0",
        )
        .bind(self.gl_account)
        .execute(pool)
        .await
        .map_err(|error| format!("gl shard: {error}"))?;

        exec(
            "INSERT INTO gl_shard_checkpoints \
             (gl_account_id, shard_id, checkpoint_balance, checkpoint_seq, checkpoint_at, status) \
             VALUES ($1, 0, -25.0000, 3, now(), 'OK')",
        )
        .bind(self.gl_account)
        .execute(pool)
        .await
        .map_err(|error| format!("gl checkpoint: {error}"))?;

        exec(
            "INSERT INTO wallets (id, updated_at, merchant_id, gl_account_id, currency, status, name) \
             VALUES ($1, now(), $2, $3, 'LYD', 'ACTIVE', $4)",
        )
        .bind(self.wallet)
        .bind(self.merchant)
        .bind(self.gl_account)
        .bind(format!("{} wallet", self.unique))
        .execute(pool)
        .await
        .map_err(|error| format!("wallet: {error}"))?;

        for index in 0..3 {
            let id = if index == 0 {
                self.application
            } else {
                Uuid::new_v4()
            };
            exec(
                "INSERT INTO applications \
                 (id, updated_at, merchant_id, name, assigned_wallet_id, expected_monthly_volume, \
                  rail_whitelist, redirect_domain_allowlist, status) \
                 VALUES ($1, now(), $2, $3, $4, 1234.5000, '[]'::jsonb, '[]'::jsonb, 'ACTIVE')",
            )
            .bind(id)
            .bind(self.merchant)
            .bind(format!("{}-app-{index}", self.unique))
            .bind(self.wallet)
            .execute(pool)
            .await
            .map_err(|error| format!("application {index}: {error}"))?;
        }

        exec(
            "INSERT INTO payment_links \
             (id, updated_at, key, application_id, wallet_id, amount, currency, fee_bearer, state, \
              use_count, confirmed_count, active_locked_count) \
             VALUES ($1, now(), $2, $3, $4, 100.5000, 'LYD', 'MERCHANT_ABSORBS', 'PENDING', 3, 0, 1)",
        )
        .bind(self.link)
        .bind(format!("pl_{}", self.unique))
        .bind(self.application)
        .bind(self.wallet)
        .execute(pool)
        .await
        .map_err(|error| format!("payment link: {error}"))?;

        exec(
            "INSERT INTO pos_terminals (id, updated_at, application_id, name, location, status) \
             VALUES ($1, now(), $2, $3, 'Lobby', 'ACTIVE')",
        )
        .bind(self.pos)
        .bind(self.application)
        .bind(format!("{} POS", self.unique))
        .execute(pool)
        .await
        .map_err(|error| format!("pos terminal: {error}"))?;

        exec(
            "INSERT INTO pos_screens \
             (id, updated_at, pos_id, screen_code, auth_token_hash, last_active_at) \
             VALUES ($1, now(), $2, $3, $4, now())",
        )
        .bind(self.screen)
        .bind(self.pos)
        .bind(format!("screen-{}", self.unique))
        .bind(hex64())
        .execute(pool)
        .await
        .map_err(|error| format!("pos screen: {error}"))?;

        exec(
            "INSERT INTO access_tokens \
             (id, updated_at, merchant_id, application_id, name, token_hash, last_four, scopes, \
              env, ip_whitelist_enabled, expires_at) \
             VALUES ($1, now(), $2, $3, $4, $5, '9999', '[\"payments:read\"]'::jsonb, 'LIVE', true, \
              now() + interval '1 day')",
        )
        .bind(self.token)
        .bind(self.merchant)
        .bind(self.application)
        .bind(format!("{} token", self.unique))
        .bind(hex64())
        .execute(pool)
        .await
        .map_err(|error| format!("access token: {error}"))?;

        exec(
            "INSERT INTO access_token_ips (id, updated_at, token_id, cidr) \
             VALUES ($1, now(), $2, '10.0.0.0/8')",
        )
        .bind(Uuid::new_v4())
        .bind(self.token)
        .execute(pool)
        .await
        .map_err(|error| format!("access token ip: {error}"))?;

        exec(
            "INSERT INTO assets (id, updated_at, name, mime, size_bytes, storage_key, sha256) \
             VALUES ($1, now(), $2, 'IMAGE_PNG', 1234, $3, $4)",
        )
        .bind(self.asset)
        .bind(format!("{}.png", self.unique))
        .bind(format!("test/{}.png", self.unique))
        .bind(hex64())
        .execute(pool)
        .await
        .map_err(|error| format!("asset: {error}"))?;

        exec(
            "INSERT INTO attempt_groups (id, updated_at, link_id, customer_fingerprint) \
             VALUES ($1, now(), $2, $3)",
        )
        .bind(self.group)
        .bind(self.link)
        .bind(hex64())
        .execute(pool)
        .await
        .map_err(|error| format!("attempt group: {error}"))?;

        exec(
            "INSERT INTO payment_attempts \
             (id, updated_at, reference, link_id, attempt_group_id, application_id, merchant_id, \
              rail_id, route_id, credential_set_id, gateway_version_id, commission_profile_id, env, \
              mode, status, requested_amount, total_charged_amount, platform_commission_amount, \
              net_merchant_amount, fee_bearer, settlement_target, wallet_id, wallet_gl_account_id, \
              currency, customer_fields_masked, context_ciphertext, expires_at, grace_expires_at) \
             VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'LIVE', 'OTP', 'UNKNOWN', \
              150.7500, 150.7500, 0, 150.7500, 'MERCHANT_ABSORBS', 'PLATFORM_CLEARING', $12, $13, \
              'LYD', '{\"phone\":\"+218910000000\"}'::jsonb, '', now() + interval '1 hour', \
              now() + interval '2 hours')",
        )
        .bind(self.attempt)
        .bind(format!("ref-{}", self.unique))
        .bind(self.link)
        .bind(self.group)
        .bind(self.application)
        .bind(self.merchant)
        .bind(self.rail)
        .bind(self.route)
        .bind(self.credential_set)
        .bind(self.gateway_version)
        .bind(self.commission_profile)
        .bind(self.wallet)
        .bind(self.gl_account)
        .execute(pool)
        .await
        .map_err(|error| format!("payment attempt: {error}"))?;

        exec(
            "INSERT INTO cashout_requests \
             (id, updated_at, merchant_id, wallet_id, amount, destination_bank_json, state) \
             VALUES ($1, now(), $2, $3, 5.0000, '{\"iban\":\"LY000000000000000000\"}'::jsonb, 'PENDING')",
        )
        .bind(self.cashout)
        .bind(self.merchant)
        .bind(self.wallet)
        .execute(pool)
        .await
        .map_err(|error| format!("cashout: {error}"))?;

        exec(
            "INSERT INTO operator_cases (id, updated_at, attempt_id, kind, priority, sla_due_at, state) \
             VALUES ($1, now(), $2, 'UNKNOWN', 'P2', now() + interval '1 hour', 'OPEN')",
        )
        .bind(self.case)
        .bind(self.attempt)
        .execute(pool)
        .await
        .map_err(|error| format!("operator case: {error}"))?;

        sqlx::query(
            "INSERT INTO approval_requests \
             (id, updated_at, subject_type, subject_id, payload_diff_json, maker_reason, mode, \
              maker_user_id, state, expires_at) \
             VALUES ($1, now(), 'WALLET', $2, $3, 'test change', 'STANDARD', $4, 'PENDING_REVIEW', \
              now() + interval '7 days')",
        )
        .bind(Uuid::new_v4())
        .bind(self.wallet.to_string())
        .bind(json!({ "action": "WALLET_UNFREEZE" }))
        .bind(self.user)
        .execute(pool)
        .await
        .map_err(|error| format!("approval: {error}"))?;

        Ok(())
    }

    /// Delete every row the fixture created (safe to call more than once).
    pub async fn cleanup(&self, pool: &PgPool) -> Result<(), String> {
        let mut errors: Vec<String> = Vec::new();
        macro_rules! run {
            ($sql:expr, $bind:expr) => {
                if let Err(error) = sqlx::query($sql).bind($bind).execute(pool).await {
                    errors.push(format!("{}: {error}", $sql));
                }
            };
        }

        run!(
            "DELETE FROM approval_requests WHERE subject_id = $1",
            self.wallet.to_string()
        );
        run!(
            "DELETE FROM operator_cases WHERE attempt_id = $1",
            self.attempt
        );
        run!(
            "DELETE FROM adjustments WHERE source_attempt_id = $1",
            self.attempt
        );
        run!("DELETE FROM disputes WHERE attempt_id = $1", self.attempt);
        run!(
            "DELETE FROM payment_attempts WHERE merchant_id = $1",
            self.merchant
        );
        run!("DELETE FROM attempt_groups WHERE link_id = $1", self.link);
        run!(
            "DELETE FROM access_token_ips WHERE token_id = $1",
            self.token
        );
        run!(
            "DELETE FROM access_tokens WHERE merchant_id = $1",
            self.merchant
        );
        run!("DELETE FROM pos_screens WHERE pos_id = $1", self.pos);
        run!(
            "DELETE FROM pos_terminals WHERE application_id IN \
             (SELECT id FROM applications WHERE merchant_id = $1)",
            self.merchant
        );
        run!(
            "DELETE FROM payment_links WHERE application_id IN \
             (SELECT id FROM applications WHERE merchant_id = $1)",
            self.merchant
        );
        run!("DELETE FROM assets WHERE id = $1", self.asset);
        run!(
            "DELETE FROM applications WHERE merchant_id = $1",
            self.merchant
        );
        run!(
            "DELETE FROM cashout_requests WHERE merchant_id = $1",
            self.merchant
        );
        run!("DELETE FROM wallets WHERE merchant_id = $1", self.merchant);
        run!(
            "DELETE FROM gl_shard_checkpoints WHERE gl_account_id = $1",
            self.gl_account
        );
        run!(
            "DELETE FROM gl_account_shards WHERE gl_account_id = $1",
            self.gl_account
        );
        run!("DELETE FROM gl_accounts WHERE id = $1", self.gl_account);
        run!(
            "DELETE FROM commission_profiles WHERE merchant_id = $1",
            self.merchant
        );
        run!(
            "DELETE FROM credential_sets WHERE id = $1",
            self.credential_set
        );
        run!("DELETE FROM rail_routes WHERE id = $1", self.route);
        run!(
            "DELETE FROM gateway_settings WHERE gateway_version_id = $1",
            self.gateway_version
        );
        run!(
            "DELETE FROM gateway_versions WHERE id = $1",
            self.gateway_version
        );
        run!("DELETE FROM rails WHERE id = $1", self.rail);
        run!("DELETE FROM gateways WHERE id = $1", self.gateway);
        run!("DELETE FROM merchants WHERE id = $1", self.merchant);
        run!("DELETE FROM users WHERE id = $1", self.user);

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

/// Run a test body with a populated fixture and always clean the rows up.
pub async fn with_fixture<F, Fut>(label: &str, body: F) -> Result<(), String>
where
    F: FnOnce(PgPool, Fixture) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let Some(pool) = pool_or_skip().await else {
        return Ok(());
    };
    let mut fixture = Fixture::new(label);
    if let Err(error) = fixture.populate(&pool).await {
        let _ = fixture.cleanup(&pool).await;
        return Err(error);
    }
    let outcome = body(pool.clone(), fixture.clone()).await;
    let cleanup = fixture.cleanup(&pool).await;
    outcome.and(cleanup)
}

/// Read a JSON object field as a string.
pub fn text(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
