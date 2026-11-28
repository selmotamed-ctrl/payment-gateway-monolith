//! [`FlowStore`] over PostgreSQL.
//!
//! SQL and transaction boundaries follow `engine/runtime/attemptRepository.ts`,
//! `api/internal/checkout.ts` (`claimAttemptForConfirm`, `cancelAttemptAtomically`) and
//! `lib/storageEngine/outbox.ts`.
//!
//! Every write reads the row back through the same projection as [`FlowStore::load_attempt`], so
//! the engine sees the joined data (gateway kind, route mismatch policy, gateway settings) the
//! TypeScript `AttemptRepository` returns.

use async_trait::async_trait;
use chrono::{DateTime, NaiveDateTime, Utc};
use pg_domain_flow::PaymentStatus;
use rust_decimal::Decimal;
use serde_json::Value;
use sqlx::{FromRow, PgConnection, PgPool, Postgres, QueryBuilder};
use uuid::Uuid;

use crate::adapters::{json_object, naive, parse_uuid, utc};
use crate::engine::{AML_VOID_SUBSTATUS, SUSPENSE_SETTLEMENT_SUBSTATUS};
use crate::ports::{
    Attempt, AttemptPatch, CancelOutcome, Environment, FeeBearer, FlowStore, OwnershipMode,
    StepCursor, StepLogRecord, StoreError,
};
use crate::schema::FlowPhase;

/// The `worker_cursors` name prefix the engine cursor is stored under.
///
/// No TypeScript table persists a step cursor (the TS engine re-runs a phase from its context), so
/// the Rust port stores the cursor in the existing worker cursor key/value table instead of asking
/// for a migration.
pub const FLOW_CURSOR_PREFIX: &str = "flow-cursor:";

const LOAD_ATTEMPT_SQL: &str = r#"
SELECT
    pa.id::text                                    AS id,
    pa.reference                                   AS reference,
    pa.gateway_reference                           AS gateway_reference,
    pa.merchant_id::text                           AS merchant_id,
    pa.application_id::text                        AS application_id,
    gv.gateway_id::text                            AS gateway_id,
    pa.gateway_version_id::text                    AS gateway_version_id,
    pa.route_id::text                              AS route_id,
    pa.rail_id::text                               AS rail_id,
    pa.link_id::text                               AS link_id,
    pa.credential_set_id::text                     AS credential_set_id,
    pa.wallet_id::text                             AS wallet_id,
    pa.wallet_gl_account_id::text                  AS wallet_gl_account_id,
    pa.commission_profile_id::text                 AS commission_profile_id,
    pa.sub_mode                                    AS sub_mode,
    pa.settlement_target::text                     AS settlement_target,
    g.kind::text                                   AS gateway_kind,
    pa.fee_bearer::text                            AS fee_bearer,
    CASE
        WHEN (r.cost_model->>'accrue_fee_at_confirm') IN ('true', '1')
          OR (r.cost_model->>'accrueFeeAtConfirm') IN ('true', '1')
        THEN true ELSE false
    END                                            AS fee_accrual,
    pa.status::text                                AS status,
    pa.substatus                                   AS substatus,
    pa.canonical_error                             AS canonical_error,
    trim(pa.currency)                              AS currency,
    pa.env::text                                   AS env,
    pa.requested_amount                            AS requested_amount,
    pa.total_charged_amount                        AS total_charged_amount,
    pa.settled_amount                              AS settled_amount,
    pa.gateway_fee_amount                          AS gateway_fee_amount,
    pa.surcharge_amount                            AS surcharge_amount,
    pa.platform_commission_amount                  AS platform_commission_amount,
    pa.net_merchant_amount                         AS net_merchant_amount,
    NULLIF(
        COALESCE(r.mismatch_policy->>'tolerance_amount', r.mismatch_policy->>'toleranceAmount'),
        ''
    )::numeric                                     AS mismatch_tolerance,
    pa.provider_reference                          AS provider_reference,
    pa.network_reference                           AS network_reference,
    pa.point_of_no_return                          AS point_of_no_return,
    pa.otp_attempts                                AS otp_attempts,
    gs.max_otp_attempts                            AS max_otp_attempts,
    pa.public_outputs                              AS public_outputs,
    pa.customer_fields_masked                      AS context,
    NULLIF(pa.context_ciphertext, '')              AS context_ciphertext,
    pa.ledger_entry_id::text                       AS ledger_entry_id,
    pa.terminal_at                                 AS terminal_at,
    pa.expires_at                                  AS expires_at,
    pa.created_at                                  AS created_at
FROM payment_attempts pa
JOIN gateway_versions gv ON gv.id = pa.gateway_version_id
JOIN gateways g ON g.id = gv.gateway_id
LEFT JOIN gateway_settings gs ON gs.gateway_version_id = pa.gateway_version_id
LEFT JOIN rail_routes r ON r.id = pa.route_id
WHERE pa.id = $1::uuid
"#;

const ATTEMPT_STATUSES_THAT_SET_TERMINAL: [PaymentStatus; 8] = [
    PaymentStatus::Succeeded,
    PaymentStatus::Failed,
    PaymentStatus::Expired,
    PaymentStatus::Cancelled,
    PaymentStatus::Blocked,
    PaymentStatus::PartiallyRefunded,
    PaymentStatus::Refunded,
    PaymentStatus::Disputed,
];

#[derive(Debug, FromRow)]
struct AttemptRow {
    id: String,
    reference: String,
    gateway_reference: Option<String>,
    merchant_id: Option<String>,
    application_id: Option<String>,
    gateway_id: Option<String>,
    gateway_version_id: Option<String>,
    route_id: Option<String>,
    rail_id: Option<String>,
    link_id: Option<String>,
    credential_set_id: Option<String>,
    wallet_id: Option<String>,
    wallet_gl_account_id: Option<String>,
    commission_profile_id: Option<String>,
    sub_mode: Option<String>,
    settlement_target: String,
    gateway_kind: String,
    fee_bearer: String,
    fee_accrual: bool,
    status: String,
    substatus: Option<String>,
    canonical_error: Option<String>,
    currency: String,
    env: String,
    requested_amount: Decimal,
    total_charged_amount: Decimal,
    settled_amount: Option<Decimal>,
    gateway_fee_amount: Option<Decimal>,
    surcharge_amount: Decimal,
    platform_commission_amount: Option<Decimal>,
    net_merchant_amount: Option<Decimal>,
    mismatch_tolerance: Option<Decimal>,
    provider_reference: Option<String>,
    network_reference: Option<String>,
    point_of_no_return: bool,
    otp_attempts: i32,
    max_otp_attempts: Option<i32>,
    public_outputs: Option<Value>,
    context: Value,
    context_ciphertext: Option<String>,
    ledger_entry_id: Option<String>,
    terminal_at: Option<NaiveDateTime>,
    expires_at: Option<NaiveDateTime>,
    created_at: Option<NaiveDateTime>,
}

fn ownership_mode(row: &AttemptRow) -> OwnershipMode {
    if row.gateway_kind == "INTERNAL" {
        OwnershipMode::Internal
    } else if row.settlement_target == "MERCHANT_DIRECT" {
        OwnershipMode::MerchantDirect
    } else {
        OwnershipMode::PlatformClearing
    }
}

impl TryFrom<AttemptRow> for Attempt {
    type Error = StoreError;

    fn try_from(row: AttemptRow) -> Result<Self, Self::Error> {
        let status = PaymentStatus::parse(&row.status).ok_or_else(|| {
            StoreError::Backend(format!(
                "payment_attempts {} has the unknown status '{}'",
                row.id, row.status
            ))
        })?;
        let env = Environment::parse(&row.env).ok_or_else(|| {
            StoreError::Backend(format!(
                "payment_attempts {} has the unknown environment '{}'",
                row.id, row.env
            ))
        })?;
        let fee_bearer = FeeBearer::parse(&row.fee_bearer).ok_or_else(|| {
            StoreError::Backend(format!(
                "payment_attempts {} has the unknown fee bearer '{}'",
                row.id, row.fee_bearer
            ))
        })?;
        let ownership_mode = ownership_mode(&row);
        let otp_attempts = u32::try_from(row.otp_attempts.max(0)).unwrap_or(u32::MAX);
        let max_otp_attempts = row
            .max_otp_attempts
            .and_then(|value| u32::try_from(value).ok());
        Ok(Self {
            id: row.id,
            reference: row.reference,
            gateway_reference: row.gateway_reference,
            merchant_id: row.merchant_id,
            application_id: row.application_id,
            gateway_id: row.gateway_id,
            gateway_version_id: row.gateway_version_id,
            route_id: row.route_id,
            rail_id: row.rail_id,
            link_id: row.link_id,
            credential_set_id: row.credential_set_id,
            wallet_id: row.wallet_id,
            wallet_gl_account_id: row.wallet_gl_account_id,
            commission_profile_id: row.commission_profile_id,
            sub_mode: row.sub_mode,
            customer_fingerprint: None,
            ownership_mode,
            fee_bearer,
            fee_accrual: row.fee_accrual,
            status,
            substatus: row.substatus,
            canonical_error: row.canonical_error,
            currency: row.currency,
            env,
            requested_amount: row.requested_amount,
            total_charged_amount: row.total_charged_amount,
            settled_amount: row.settled_amount,
            gateway_fee_amount: row.gateway_fee_amount,
            surcharge_amount: row.surcharge_amount,
            platform_commission_amount: row.platform_commission_amount,
            net_merchant_amount: row.net_merchant_amount,
            mismatch_tolerance: row.mismatch_tolerance,
            provider_reference: row.provider_reference,
            network_reference: row.network_reference,
            point_of_no_return: row.point_of_no_return,
            otp_attempts,
            max_otp_attempts,
            public_outputs: json_object(row.public_outputs),
            context: json_object(Some(row.context)),
            context_ciphertext: row.context_ciphertext,
            ledger_entry_id: row.ledger_entry_id,
            terminal_at: row.terminal_at.map(utc),
            expires_at: row.expires_at.map(utc),
            created_at: row.created_at.map(utc),
        })
    }
}

fn backend(error: sqlx::Error) -> StoreError {
    StoreError::Backend(format!("database error: {error}"))
}

fn uid(attempt_id: &str) -> Result<Uuid, StoreError> {
    parse_uuid(attempt_id, "attempt id").map_err(StoreError::Backend)
}

/// [`FlowStore`] on the core database.
#[derive(Debug, Clone)]
pub struct PgFlowStore {
    pool: PgPool,
}

impl PgFlowStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Reads one attempt in the caller's transaction.
    pub async fn load_attempt_on(
        &self,
        conn: &mut PgConnection,
        attempt_id: &str,
    ) -> Result<Option<Attempt>, StoreError> {
        let id = uid(attempt_id)?;
        let row: Option<AttemptRow> = sqlx::query_as(LOAD_ATTEMPT_SQL)
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(backend)?;
        row.map(Attempt::try_from).transpose()
    }

    /// The compare-and-set write, in the caller's transaction.
    ///
    /// `expected_status` becomes `WHERE status = $expected`; zero rows is a
    /// [`StoreError::StateConflict`], exactly like `AttemptStateConflictError` in the TS repository.
    pub async fn update_attempt_on(
        &self,
        conn: &mut PgConnection,
        attempt_id: &str,
        patch: AttemptPatch,
    ) -> Result<Attempt, StoreError> {
        let id = uid(attempt_id)?;
        let expected = patch.expected_status;
        let next_status = patch.status;
        let mut builder =
            QueryBuilder::<Postgres>::new("UPDATE payment_attempts SET updated_at = now()");

        if let Some(status) = next_status {
            builder
                .push(", status = ")
                .push_bind(status.as_str())
                .push("::text::\"AttemptStatus\"");
            if status.is_terminal() {
                builder.push(
                    ", terminal_at = now(), next_check_at = NULL, \
                     first_terminal_at = COALESCE(first_terminal_at, now())",
                );
            } else if status == PaymentStatus::Unknown {
                builder.push(", first_unknown_at = COALESCE(first_unknown_at, now())");
            }
        }
        if let Some(substatus) = patch.substatus.as_deref() {
            builder.push(", substatus = ").push_bind(substatus);
        } else if patch.clear_substatus {
            builder.push(", substatus = NULL");
        }
        if let Some(error) = patch.canonical_error.as_deref() {
            builder.push(", canonical_error = ").push_bind(error);
            if patch.substatus.is_none() && !patch.clear_substatus {
                builder.push(", substatus = ").push_bind(error);
            }
        }
        if let Some(attempts) = patch.otp_attempts {
            builder
                .push(", otp_attempts = ")
                .push_bind(i32::try_from(attempts).unwrap_or(i32::MAX));
        }
        if let Some(flag) = patch.point_of_no_return {
            builder.push(", point_of_no_return = ").push_bind(flag);
        }
        if let Some(entry) = patch.ledger_entry_id.as_deref() {
            let entry = parse_uuid(entry, "ledger entry id").map_err(StoreError::Backend)?;
            builder.push(", ledger_entry_id = ").push_bind(entry);
        }
        if let Some(ciphertext) = patch.context_ciphertext.as_deref() {
            builder
                .push(", context_ciphertext = ")
                .push_bind(ciphertext);
        }
        if let Some(public) = patch.public_outputs.as_ref() {
            builder
                .push(", public_outputs = ")
                .push_bind(Value::Object(public.clone()));
        }
        if let Some(reference) = patch.provider_reference.as_deref() {
            builder.push(", provider_reference = ").push_bind(reference);
        }
        if let Some(reference) = patch.network_reference.as_deref() {
            builder.push(", network_reference = ").push_bind(reference);
        }
        if let Some(amount) = patch.settled_amount {
            builder.push(", settled_amount = ").push_bind(amount);
        }
        if let Some(amount) = patch.gateway_fee_amount {
            builder.push(", gateway_fee_amount = ").push_bind(amount);
        }
        if let Some(route_id) = patch.route_id.as_deref() {
            let route_id = parse_uuid(route_id, "route id").map_err(StoreError::Backend)?;
            builder.push(", route_id = ").push_bind(route_id);
        }
        if let Some(link_id) = patch.link_id.as_deref() {
            let link_id = parse_uuid(link_id, "link id").map_err(StoreError::Backend)?;
            builder.push(", link_id = ").push_bind(link_id);
        }

        builder.push(" WHERE id = ").push_bind(id);
        if let Some(expected) = expected {
            builder
                .push(" AND status = ")
                .push_bind(expected.as_str())
                .push("::text::\"AttemptStatus\"");
        }
        let changed = builder
            .build()
            .execute(&mut *conn)
            .await
            .map_err(backend)?
            .rows_affected();
        if changed == 0 {
            let observed: Option<String> =
                sqlx::query_scalar("SELECT status::text FROM payment_attempts WHERE id = $1")
                    .bind(id)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(backend)?;
            return match observed {
                Some(observed) => Err(StoreError::StateConflict {
                    expected: expected.map_or_else(|| "row".to_owned(), |s| s.as_str().to_owned()),
                    observed,
                }),
                None => Err(StoreError::NotFound(attempt_id.to_owned())),
            };
        }
        let attempt = self
            .load_attempt_on(&mut *conn, attempt_id)
            .await?
            .ok_or_else(|| StoreError::NotFound(attempt_id.to_owned()))?;
        if next_status.is_some_and(PaymentStatus::is_terminal) {
            insert_transition_outbox(&mut *conn, &attempt).await?;
        }
        Ok(attempt)
    }

    /// `claimAttemptForConfirm` (`checkout.ts:1011-1045`) in the caller's transaction.
    pub async fn claim_authorizing_on(
        &self,
        conn: &mut PgConnection,
        attempt_id: &str,
        idempotency_key_hash: Option<&str>,
    ) -> Result<bool, StoreError> {
        let id = uid(attempt_id)?;
        let changed = match idempotency_key_hash {
            Some(hash) => sqlx::query(
                r#"
UPDATE payment_attempts
   SET status = 'AUTHORIZING'::"AttemptStatus",
       point_of_no_return = true,
       customer_fields_masked = jsonb_set(
           customer_fields_masked,
           '{confirm_idempotency_key_hash}',
           to_jsonb($2::text),
           true
       ),
       updated_at = now()
 WHERE id = $1::uuid
   AND terminal_at IS NULL
   AND status IN ('CREATED', 'INITIATING', 'AWAITING_CUSTOMER', 'VERIFYING', 'UNKNOWN')
   AND NOT (status IN ('UNKNOWN', 'VERIFYING') AND point_of_no_return = true)
   AND (
       (customer_fields_masked #>> '{confirm_idempotency_key_hash}') IS NULL
       OR (customer_fields_masked #>> '{confirm_idempotency_key_hash}') <> $2
   )
"#,
            )
            .bind(id)
            .bind(hash)
            .execute(&mut *conn)
            .await
            .map_err(backend)?
            .rows_affected(),
            None => sqlx::query(
                r#"
UPDATE payment_attempts
   SET status = 'AUTHORIZING'::"AttemptStatus",
       point_of_no_return = true,
       updated_at = now()
 WHERE id = $1::uuid
   AND terminal_at IS NULL
   AND status IN ('CREATED', 'INITIATING', 'AWAITING_CUSTOMER', 'VERIFYING', 'UNKNOWN')
   AND NOT (status IN ('UNKNOWN', 'VERIFYING') AND point_of_no_return = true)
"#,
            )
            .bind(id)
            .execute(&mut *conn)
            .await
            .map_err(backend)?
            .rows_affected(),
        };
        Ok(changed == 1)
    }

    /// `claimFinalize` (`attemptRepository.ts:139-158`) in the caller's transaction.
    ///
    /// `FAILED`/`EXPIRED` are the states a late success recovers from and always carry
    /// `terminal_at`; the status comparison alone is the single-writer guard there.
    pub async fn claim_finalize_on(
        &self,
        conn: &mut PgConnection,
        attempt_id: &str,
        expected_status: PaymentStatus,
    ) -> Result<bool, StoreError> {
        let id = uid(attempt_id)?;
        let late_success = matches!(
            expected_status,
            PaymentStatus::Failed | PaymentStatus::Expired
        );
        let changed = sqlx::query(
            r#"
UPDATE payment_attempts
   SET substatus = 'FINALIZING', updated_at = now()
 WHERE id = $1::uuid
   AND status = $2::text::"AttemptStatus"
   AND ($3::boolean OR terminal_at IS NULL)
"#,
        )
        .bind(id)
        .bind(expected_status.as_str())
        .bind(late_success)
        .execute(&mut *conn)
        .await
        .map_err(backend)?
        .rows_affected();
        Ok(changed == 1)
    }

    /// `cancelAttemptAtomically` (`checkout.ts:1064-1099`) in the caller's transaction.
    ///
    /// The link counter is *not* released here: the engine calls `SlotStore::release` only for the
    /// call that changed the row, so a repeated cancel cannot free another attempt's slot.
    pub async fn cancel_attempt_on(
        &self,
        conn: &mut PgConnection,
        attempt_id: &str,
    ) -> Result<CancelOutcome, StoreError> {
        let id = uid(attempt_id)?;
        let changed = sqlx::query(
            r#"
UPDATE payment_attempts
   SET status = 'CANCELLED'::"AttemptStatus",
       terminal_at = now(),
       next_check_at = NULL,
       first_terminal_at = COALESCE(first_terminal_at, now()),
       updated_at = now()
 WHERE id = $1::uuid
   AND terminal_at IS NULL
   AND point_of_no_return = false
   AND (substatus IS NULL OR substatus <> 'AML_HOLD')
   AND status NOT IN (
       'SUCCEEDED', 'AUTHORIZING', 'REFUNDED', 'PARTIALLY_REFUNDED',
       'FAILED', 'EXPIRED', 'CANCELLED', 'BLOCKED', 'DISPUTED'
   )
"#,
        )
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(backend)?
        .rows_affected();
        let status: Option<String> =
            sqlx::query_scalar("SELECT status::text FROM payment_attempts WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(backend)?;
        let status = status.ok_or_else(|| StoreError::NotFound(attempt_id.to_owned()))?;
        let status = PaymentStatus::parse(&status).ok_or_else(|| {
            StoreError::Backend(format!(
                "payment_attempts {attempt_id} has an unknown status"
            ))
        })?;
        if changed > 0 {
            insert_cancel_outbox(&mut *conn, id, status).await?;
        }
        Ok(CancelOutcome {
            status,
            released: changed > 0,
        })
    }

    /// `recordStepLogs` (`DynamicRailEngine.ts:1031-1060`) in the caller's transaction.
    pub async fn record_step_on(
        &self,
        conn: &mut PgConnection,
        record: StepLogRecord,
    ) -> Result<(), StoreError> {
        let attempt_id = uid(&record.attempt_id)?;
        let gateway_version_id = record
            .gateway_version_id
            .as_deref()
            .ok_or_else(|| StoreError::Backend("attempt has no gateway version id".to_owned()))
            .and_then(|value| {
                parse_uuid(value, "gateway version id").map_err(StoreError::Backend)
            })?;
        let step_id = Uuid::parse_str(&record.step_id).ok();
        sqlx::query(
            r#"
INSERT INTO attempt_step_logs
    (id, updated_at, attempt_id, gateway_version_id, phase, step_id, step_order,
     redacted_request_json, redacted_response_text, http_status, duration_ms, outcome, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
"#,
        )
        .bind(Uuid::now_v7())
        .bind(naive(record.created_at))
        .bind(attempt_id)
        .bind(gateway_version_id)
        .bind(record.phase.as_str())
        .bind(step_id)
        .bind(i32::try_from(record.step_order).unwrap_or(i32::MAX))
        .bind(record.redacted_request)
        .bind(record.redacted_response_text)
        .bind(record.http_status.map(i32::from))
        .bind(i64::try_from(record.duration_ms).unwrap_or(i64::MAX))
        .bind(record.outcome)
        .bind(naive(record.created_at))
        .execute(&mut *conn)
        .await
        .map_err(backend)?;
        Ok(())
    }

    fn cursor_key(attempt_id: &str, phase: FlowPhase) -> String {
        let key = format!("{FLOW_CURSOR_PREFIX}{attempt_id}:{}", phase.as_str());
        if key.len() <= 96 {
            key
        } else {
            format!(
                "{FLOW_CURSOR_PREFIX}sha256:{}",
                pg_crypto::sha256_hex(key.as_bytes())
            )
        }
    }
}

async fn insert_transition_outbox(
    conn: &mut PgConnection,
    attempt: &Attempt,
) -> Result<(), StoreError> {
    let payload = serde_json::json!({
        "event": "terminal",
        "attemptId": attempt.id,
        "merchantId": attempt.merchant_id,
        "routeId": attempt.route_id,
        "currency": attempt.currency,
        "status": attempt.status.as_str(),
        "substatus": attempt.substatus,
        "totalChargedAmount": attempt.total_charged_amount.to_string(),
        "netMerchantAmount": attempt.net_merchant_amount.map(|value| value.to_string()),
        "occurredAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    let merchant_id = attempt
        .merchant_id
        .as_deref()
        .map(|value| parse_uuid(value, "merchant id").map_err(StoreError::Backend))
        .transpose()?;
    sqlx::query(
        r#"
INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, merchant_id, payload_json)
VALUES ('attempt.transitioned', 'PAYMENT_ATTEMPT', $1, $2, $3)
"#,
    )
    .bind(&attempt.id)
    .bind(merchant_id)
    .bind(payload)
    .execute(&mut *conn)
    .await
    .map_err(backend)?;
    Ok(())
}

async fn insert_cancel_outbox(
    conn: &mut PgConnection,
    attempt_id: Uuid,
    status: PaymentStatus,
) -> Result<(), StoreError> {
    let row: Option<CancelRow> = sqlx::query_as(
        "SELECT id::text AS id, merchant_id, route_id, trim(currency) AS currency, \
                total_charged_amount, net_merchant_amount, substatus \
           FROM payment_attempts WHERE id = $1",
    )
    .bind(attempt_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(backend)?;
    let Some(row) = row else {
        return Ok(());
    };
    let payload = serde_json::json!({
        "event": "terminal",
        "attemptId": row.id,
        "merchantId": row.merchant_id.map(|value| value.to_string()),
        "routeId": row.route_id.map(|value| value.to_string()),
        "currency": row.currency,
        "status": status.as_str(),
        "substatus": row.substatus,
        "totalChargedAmount": row.total_charged_amount.to_string(),
        "netMerchantAmount": row.net_merchant_amount.to_string(),
        "occurredAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    sqlx::query(
        r#"
INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, merchant_id, payload_json)
VALUES ('attempt.transitioned', 'PAYMENT_ATTEMPT', $1, $2, $3)
"#,
    )
    .bind(&row.id)
    .bind(row.merchant_id)
    .bind(payload)
    .execute(&mut *conn)
    .await
    .map_err(backend)?;
    Ok(())
}

#[derive(Debug, FromRow)]
struct CancelRow {
    id: String,
    merchant_id: Option<Uuid>,
    route_id: Option<Uuid>,
    currency: String,
    total_charged_amount: Decimal,
    net_merchant_amount: Decimal,
    substatus: Option<String>,
}

#[async_trait]
impl FlowStore for PgFlowStore {
    async fn load_attempt(&self, attempt_id: &str) -> Result<Option<Attempt>, StoreError> {
        let mut conn = self.pool.acquire().await.map_err(backend)?;
        self.load_attempt_on(&mut conn, attempt_id).await
    }

    async fn update_attempt(
        &self,
        attempt_id: &str,
        patch: AttemptPatch,
    ) -> Result<Attempt, StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        let attempt = self.update_attempt_on(&mut tx, attempt_id, patch).await?;
        tx.commit().await.map_err(backend)?;
        Ok(attempt)
    }

    async fn claim_finalize(
        &self,
        attempt_id: &str,
        expected_status: PaymentStatus,
    ) -> Result<bool, StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        let claimed = self
            .claim_finalize_on(&mut tx, attempt_id, expected_status)
            .await?;
        tx.commit().await.map_err(backend)?;
        Ok(claimed)
    }

    async fn claim_authorizing(
        &self,
        attempt_id: &str,
        idempotency_key_hash: Option<&str>,
    ) -> Result<bool, StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        let claimed = self
            .claim_authorizing_on(&mut tx, attempt_id, idempotency_key_hash)
            .await?;
        tx.commit().await.map_err(backend)?;
        Ok(claimed)
    }

    async fn cancel_attempt(&self, attempt_id: &str) -> Result<CancelOutcome, StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        let outcome = self.cancel_attempt_on(&mut tx, attempt_id).await?;
        tx.commit().await.map_err(backend)?;
        Ok(outcome)
    }

    async fn load_cursor(
        &self,
        attempt_id: &str,
        phase: FlowPhase,
    ) -> Result<Option<StepCursor>, StoreError> {
        let key = Self::cursor_key(attempt_id, phase);
        let row: Option<(Option<String>,)> =
            sqlx::query_as("SELECT cursor_value FROM worker_cursors WHERE name = $1")
                .bind(&key)
                .fetch_optional(&self.pool)
                .await
                .map_err(backend)?;
        let Some((Some(raw),)) = row else {
            return Ok(None);
        };
        let value: Value = serde_json::from_str(&raw).map_err(|error| {
            StoreError::Backend(format!("the stored flow cursor is not JSON: {error}"))
        })?;
        let next_index = value
            .get("nextIndex")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .unwrap_or(0);
        Ok(Some(StepCursor {
            attempt_id: attempt_id.to_owned(),
            phase,
            next_index,
            previous_response: value.get("previousResponse").cloned(),
            completed: value
                .get("completed")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            updated_at: value
                .get("updatedAt")
                .and_then(Value::as_str)
                .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
                .map(|value| value.with_timezone(&Utc)),
        }))
    }

    async fn save_cursor(&self, cursor: &StepCursor) -> Result<(), StoreError> {
        let key = Self::cursor_key(&cursor.attempt_id, cursor.phase);
        let value = serde_json::json!({
            "attemptId": cursor.attempt_id,
            "phase": cursor.phase.as_str(),
            "nextIndex": cursor.next_index,
            "previousResponse": cursor.previous_response,
            "completed": cursor.completed,
            "updatedAt": cursor.updated_at.unwrap_or_else(Utc::now)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        sqlx::query(
            r#"
INSERT INTO worker_cursors (name, cursor_value, updated_at)
VALUES ($1, $2, now())
ON CONFLICT (name) DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()
"#,
        )
        .bind(&key)
        .bind(value.to_string())
        .execute(&self.pool)
        .await
        .map_err(backend)?;
        Ok(())
    }

    async fn record_step(&self, record: StepLogRecord) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await.map_err(backend)?;
        self.record_step_on(&mut tx, record).await?;
        tx.commit().await.map_err(backend)?;
        Ok(())
    }
}

/// The statuses `finalize_guard` treats as idempotent/refused (`DynamicRailEngine.ts:330`).
///
/// Exposed for the adapter tests and any caller that needs the same partition without importing the
/// engine internals.
#[must_use]
pub fn is_terminal_status(status: PaymentStatus) -> bool {
    ATTEMPT_STATUSES_THAT_SET_TERMINAL.contains(&status)
}

/// The two substatus markers the adapters must keep meaningful.
#[must_use]
pub fn recognized_substatuses() -> [&'static str; 2] {
    [AML_VOID_SUBSTATUS, SUSPENSE_SETTLEMENT_SUBSTATUS]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn cursor_key_is_bounded_and_distinct() {
        let short = PgFlowStore::cursor_key("a1", FlowPhase::Initiate);
        assert!(short.starts_with(FLOW_CURSOR_PREFIX));
        assert!(short.len() <= 96);
        let long_attempt = "x".repeat(120);
        let long = PgFlowStore::cursor_key(&long_attempt, FlowPhase::Submit);
        assert!(long.len() <= 96);
        assert!(long.contains("sha256:"));
        assert_ne!(
            PgFlowStore::cursor_key("a1", FlowPhase::Initiate),
            PgFlowStore::cursor_key("a1", FlowPhase::Submit)
        );
    }

    #[test]
    fn terminal_partition_matches_the_ts_guard() {
        for status in [
            PaymentStatus::Succeeded,
            PaymentStatus::Failed,
            PaymentStatus::Expired,
            PaymentStatus::Cancelled,
            PaymentStatus::Blocked,
            PaymentStatus::PartiallyRefunded,
            PaymentStatus::Refunded,
            PaymentStatus::Disputed,
        ] {
            assert!(is_terminal_status(status), "{status:?}");
        }
        assert!(!is_terminal_status(PaymentStatus::Unknown));
        assert_eq!(recognized_substatuses().len(), 2);
    }

    #[test]
    fn amount_binding_keeps_four_places() {
        let value = Decimal::from_str("100.0000").expect("decimal");
        assert_eq!(value.to_string(), "100.0000");
    }
}
