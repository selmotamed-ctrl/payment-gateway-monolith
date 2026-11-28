//! DB-gated tests of the admin merchant-360 read routes (schema 46).
//!
//! Every test reuses the `admin_commerce` fixture (merchant, user, wallet, three applications, a
//! payment link, a POS terminal, an access token, an attempt and a pending cash-out) and adds the
//! rows this chunk needs: a dispute, an adjustment, a notification, an `audit_log` row, a
//! `detail_change_logs` row, a pending `MERCHANT` approval and a beneficial owner. All extra rows
//! are deleted before the shared fixture cleanup runs; the `audit_log` delete uses the
//! `pgw.append_only_maintenance` guard inside a transaction.
//!
//! PostgreSQL unreachable → the fixture prints `SKIP:` and the test returns green.

#![cfg(test)]

use pg_domain_auth::Principal;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use super::{changes, lists, merchant_exports, stats};
use crate::routes::admin_commerce::test_support;

fn ok<T>(context: &str, result: Result<T, pg_http::ApiError>) -> Result<T, String> {
    result.map_err(|error| {
        format!(
            "{context}: {} {} {}",
            error.status, error.code, error.message
        )
    })
}

fn rows(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(-1)
}

/// The fixture principal, so the export audit rows satisfy the `users` foreign key.
fn staff_as(user: Uuid, role: &str, authorities: &[&str]) -> Principal {
    let mut principal = test_support::staff(role, authorities);
    principal.user_id = Some(user.to_string());
    principal
}

macro_rules! check {
    ($condition:expr $(,)?) => {{
        if !$condition {
            return Err(format!("assertion failed: {}", stringify!($condition)));
        }
    }};
    ($condition:expr, $message:expr $(,)?) => {{
        if !$condition {
            return Err(format!("{}: {}", $message, stringify!($condition)));
        }
    }};
}

macro_rules! check_eq {
    ($left:expr, $right:expr $(,)?) => {{
        let left = $left;
        let right = $right;
        if left != right {
            return Err(format!(
                "assertion failed: {} == {}\n  left: {left:?}\n right: {right:?}",
                stringify!($left),
                stringify!($right)
            ));
        }
    }};
    ($left:expr, $right:expr, $message:expr $(,)?) => {{
        let left = $left;
        let right = $right;
        if left != right {
            return Err(format!(
                "{}: {} == {}\n  left: {left:?}\n right: {right:?}",
                $message,
                stringify!($left),
                stringify!($right)
            ));
        }
    }};
}

/// The rows this chunk adds to the shared merchant fixture.
#[derive(Clone)]
struct Extras {
    dispute: Uuid,
    adjustment: Uuid,
    notification: Uuid,
    audit: Uuid,
    detail_change: Uuid,
    approval: Uuid,
    owner: Uuid,
    unique: String,
}

impl Extras {
    fn new(label: &str) -> Self {
        Self {
            dispute: Uuid::new_v4(),
            adjustment: Uuid::new_v4(),
            notification: Uuid::new_v4(),
            audit: Uuid::new_v4(),
            detail_change: Uuid::new_v4(),
            approval: Uuid::new_v4(),
            owner: Uuid::new_v4(),
            unique: format!("{label}-{}", Uuid::new_v4().simple()),
        }
    }

    async fn populate(&self, pool: &PgPool, fixture: &test_support::Fixture) -> Result<(), String> {
        sqlx::query(
            "INSERT INTO disputes (id, updated_at, attempt_id, gateway_id, rail_id, \
             external_dispute_ref, source, reason_code, amount, currency, status, opened_at, \
             evidence_due_at) \
             VALUES ($1, now(), $2, $3, $4, $5, 'WEBHOOK', 'FRAUD', 10.5000, 'LYD', 'OPENED', \
             now(), now() + interval '3 days')",
        )
        .bind(self.dispute)
        .bind(fixture.attempt)
        .bind(fixture.gateway)
        .bind(fixture.rail)
        .bind(format!("dp-{}", self.unique))
        .execute(pool)
        .await
        .map_err(|error| format!("dispute: {error}"))?;

        sqlx::query(
            "INSERT INTO adjustments (id, updated_at, type, target_gl_account_id, source_attempt_id, \
             amount, reverse_commission, reason, state, created_at) \
             VALUES ($1, now(), 'REFUND', $2, $3, 7.2500, false, $4, 'DRAFT', now())",
        )
        .bind(self.adjustment)
        .bind(fixture.gl_account)
        .bind(fixture.attempt)
        .bind(format!("refund {}", self.unique))
        .execute(pool)
        .await
        .map_err(|error| format!("adjustment: {error}"))?;

        sqlx::query(
            "INSERT INTO notifications (id, updated_at, event_id, recipient_merchant_id, \
             address_masked, address_ciphertext, template_code, channel, lang, payload_json, \
             status, attempts) \
             VALUES ($1, now(), $2, $3, 'ac***@example.test', '', 'MERCHANT_SUSPENDED', 'EMAIL', \
             'EN', '{}'::jsonb, 'QUEUED', 1)",
        )
        .bind(self.notification)
        .bind(format!("evt-{}", self.unique))
        .bind(fixture.merchant)
        .execute(pool)
        .await
        .map_err(|error| format!("notification: {error}"))?;

        sqlx::query(
            "INSERT INTO audit_log (id, created_at, updated_at, actor_id, role, action, entity_type, \
             entity_id, before_json, after_json) \
             VALUES ($1, now(), now(), $2, 'COMPLIANCE', 'MERCHANT_DESCRIPTIVE_UPDATED', 'MERCHANT', \
             $3, '{\"taxId\":\"old\"}'::jsonb, '{\"taxId\":\"new\"}'::jsonb)",
        )
        .bind(self.audit)
        .bind(fixture.user)
        .bind(fixture.merchant.to_string())
        .execute(pool)
        .await
        .map_err(|error| format!("audit row: {error}"))?;

        sqlx::query(
            "INSERT INTO detail_change_logs (id, updated_at, actor_id, merchant_id, entity_type, \
             entity_id, field_name, old_value, new_value, source, request_id) \
             VALUES ($1, now(), $2, $3, 'MERCHANT', $4, '/taxId', 'OLD-TAX', 'NEW-TAX', 'ADMIN', \
             $5)",
        )
        .bind(self.detail_change)
        .bind(fixture.user)
        .bind(fixture.merchant)
        .bind(fixture.merchant.to_string())
        .bind(format!("req-{}", self.unique))
        .execute(pool)
        .await
        .map_err(|error| format!("detail change: {error}"))?;

        sqlx::query(
            "INSERT INTO approval_requests (id, updated_at, subject_type, subject_id, \
             payload_diff_json, maker_reason, mode, base_version, maker_user_id, state, expires_at) \
             VALUES ($1, now(), 'MERCHANT', $2, '{\"kind\":\"SUSPEND\"}'::jsonb, 'test change', \
             'STANDARD', 1, $3, 'PENDING_REVIEW', now() + interval '7 days')",
        )
        .bind(self.approval)
        .bind(fixture.merchant.to_string())
        .bind(fixture.user)
        .execute(pool)
        .await
        .map_err(|error| format!("approval: {error}"))?;

        sqlx::query(
            "INSERT INTO beneficial_owners (id, updated_at, merchant_id, full_name_ar, full_name_en, \
             national_id_ciphertext, national_id_hash, date_of_birth, nationality, \
             ownership_percent, role, screening_status, active, valid_from) \
             VALUES ($1, now(), $2, 'مالك تجريبي', 'Test Owner', 'cipher-text', $3, '1980-05-06', \
             'LY', 40.00, 'OWNER', 'NOT_SCREENED', true, now() - interval '2 days')",
        )
        .bind(self.owner)
        .bind(fixture.merchant)
        .bind("a".repeat(64))
        .execute(pool)
        .await
        .map_err(|error| format!("beneficial owner: {error}"))?;

        Ok(())
    }

    async fn cleanup(&self, pool: &PgPool, fixture: &test_support::Fixture) -> Result<(), String> {
        let mut errors: Vec<String> = Vec::new();
        macro_rules! run {
            ($sql:expr, $bind:expr) => {
                if let Err(error) = sqlx::query($sql).bind($bind).execute(pool).await {
                    errors.push(format!("{}: {error}", $sql));
                }
            };
        }
        run!("DELETE FROM adjustments WHERE id = $1", self.adjustment);
        run!("DELETE FROM disputes WHERE id = $1", self.dispute);
        run!("DELETE FROM notifications WHERE id = $1", self.notification);
        run!(
            "DELETE FROM detail_change_logs WHERE merchant_id = $1",
            fixture.merchant
        );
        run!(
            "DELETE FROM beneficial_owners WHERE merchant_id = $1",
            fixture.merchant
        );
        run!(
            "DELETE FROM approval_requests WHERE subject_type = 'MERCHANT' AND subject_id = $1",
            fixture.merchant.to_string()
        );

        // `audit_log` is append-only: the test cleanup must open the maintenance guard in the same
        // transaction as the delete (the connected role is the migration owner in the test DB).
        let audit = async {
            let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
            sqlx::query(
                "SELECT set_config('pgw.ledger_maintenance', 'on', true), \
                 set_config('pgw.append_only_maintenance', 'on', true), \
                 set_config('pgw.audit_retention', 'on', true)",
            )
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
            let ids = vec![
                fixture.merchant.to_string(),
                "export".to_owned(),
                "summary".to_owned(),
            ];
            sqlx::query(
                "DELETE FROM audit_log WHERE entity_type = 'MERCHANT' \
                 AND entity_id = ANY($1::text[]) AND actor_id = $2",
            )
            .bind(&ids)
            .bind(fixture.user)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
            sqlx::query("DELETE FROM audit_log WHERE id = $1")
                .bind(self.audit)
                .execute(&mut *tx)
                .await
                .map_err(|error| error.to_string())?;
            tx.commit().await.map_err(|error| error.to_string())
        }
        .await;
        if let Err(error) = audit {
            errors.push(format!("audit cleanup: {error}"));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

async fn with_extras<F, Fut>(label: &str, body: F) -> Result<(), String>
where
    F: FnOnce(PgPool, test_support::Fixture, Extras) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    test_support::with_fixture(label, |pool, fixture| async move {
        let extras = Extras::new(label);
        if let Err(error) = extras.populate(&pool, &fixture).await {
            let _ = extras.cleanup(&pool, &fixture).await;
            return Err(error);
        }
        let outcome = body(pool.clone(), fixture.clone(), extras.clone()).await;
        let cleanup = extras.cleanup(&pool, &fixture).await;
        outcome.and(cleanup)
    })
    .await
}

async fn last_audit(pool: &PgPool, entity_id: &str, actor: Uuid) -> Result<Value, String> {
    sqlx::query_scalar::<_, Value>(
        "SELECT after_json FROM audit_log WHERE entity_type = 'MERCHANT' AND entity_id = $1 \
         AND actor_id = $2 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(entity_id)
    .bind(actor)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("audit lookup: {error}"))?
    .ok_or_else(|| format!("no audit row for {entity_id}"))
}

#[tokio::test]
async fn summary_and_exports() {
    let outcome = with_extras("summary", |pool, fixture, _extras| async move {
        let full = staff_as(fixture.user, "GATEWAY_ADMIN", &["*"]);

        let summary = ok("summary", merchant_exports::summary(&pool).await)?;
        let summary = summary.get("summary").ok_or("summary key")?;
        check!(number(summary, "total") >= 1);
        check!(number(summary, "active") >= 1);
        check!(number(summary, "kybVerified") >= 1);
        check!(number(summary, "highRisk") >= 1);
        check!(
            number(summary, "reviewDueSoon") >= 1,
            "next_kyb_review_at is 20 days out"
        );
        check!(number(summary, "pendingApprovals") >= 1);
        check!(number(summary.get("byStatus").ok_or("byStatus")?, "ACTIVE") >= 1);
        check!(summary.get("byChannel").is_some_and(Value::is_object));

        let export = ok(
            "summary export",
            merchant_exports::summary_export(&pool, false, Some(&full)).await,
        )?;
        check!(export.get("summary").is_some_and(Value::is_object));
        let exported_at = export
            .get("exportedAt")
            .and_then(Value::as_str)
            .ok_or("exportedAt")?;
        check!(exported_at.ends_with('Z'), "ISO instant");

        let merchants = ok(
            "merchants export",
            merchant_exports::export_merchants(
                &pool,
                false,
                Some(&full),
                &format!("search={}", fixture.unique),
            )
            .await,
        )?;
        check_eq!(number(&merchants, "total"), 1);
        check_eq!(number(&merchants, "exported"), 1);
        check_eq!(
            merchants.get("truncated").and_then(Value::as_bool),
            Some(false)
        );
        let merchant = rows(&merchants, "merchants")
            .into_iter()
            .next()
            .ok_or("exported merchant")?;
        check_eq!(
            test_support::text(&merchant, "id"),
            fixture.merchant.to_string()
        );
        let export_audit = last_audit(&pool, "export", fixture.user).await?;
        check_eq!(number(&export_audit, "total"), 1);
        check_eq!(number(&export_audit, "exported"), 1);
        check!(test_support::text(&export_audit, "filters").contains(&fixture.unique));

        let merchant_export = ok(
            "merchant summary export",
            merchant_exports::merchant_summary_export(
                &pool,
                false,
                Some(&full),
                &fixture.merchant.to_string(),
                "checklist=MERCHANT_SCOPE_VERIFIED,BOGUS",
            )
            .await,
        )?;
        let merchant = merchant_export.get("merchant").ok_or("merchant")?;
        check_eq!(
            test_support::text(merchant, "id"),
            fixture.merchant.to_string()
        );
        check_eq!(number(merchant, "pendingApprovalCount"), 1);
        check!(
            merchant.get("joinRequests").is_none(),
            "detail sections dropped"
        );
        check_eq!(
            test_support::text(
                merchant_export
                    .get("walletBalance")
                    .ok_or("walletBalance")?,
                "balance"
            ),
            "25.0000"
        );
        let metrics = rows(&merchant_export, "metrics");
        check_eq!(metrics.len(), 1);
        check_eq!(test_support::text(&metrics[0], "status"), "UNKNOWN");
        check_eq!(number(&metrics[0], "count"), 1);
        check_eq!(test_support::text(&metrics[0], "chargedAmount"), "150.7500");
        check_eq!(number(&merchant_export, "openDisputes"), 1);
        check_eq!(number(&merchant_export, "pendingCashouts"), 1);
        check_eq!(number(&merchant_export, "openAmlCases"), 0);
        check!(merchant_export
            .get("generatedAt")
            .and_then(Value::as_str)
            .is_some_and(|value| value.ends_with('Z')));
        let audit = last_audit(&pool, &fixture.merchant.to_string(), fixture.user).await?;
        check_eq!(number(&audit, "pendingApprovalCount"), 1);
        check_eq!(rows(&audit, "checklist").len(), 1);
        check_eq!(test_support::text(&audit, "status"), "ACTIVE");

        let missing = merchant_exports::merchant_summary_export(
            &pool,
            false,
            Some(&full),
            &Uuid::new_v4().to_string(),
            "",
        )
        .await
        .expect_err("missing merchant");
        check_eq!(missing.status, 404);
        check_eq!(missing.code, "MERCHANT_NOT_FOUND");
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn transactions_filters_and_redaction() {
    let outcome = with_extras("transactions", |pool, fixture, _extras| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let id = fixture.merchant.to_string();

        let list = ok(
            "transactions",
            lists::transactions(&pool, Some(&reader), &id, "").await,
        )?;
        check_eq!(number(&list, "total"), 1);
        check_eq!(number(&list, "pageSize"), 10);
        let row = rows(&list, "transactions")
            .into_iter()
            .next()
            .ok_or("transaction row")?;
        check_eq!(test_support::text(&row, "id"), fixture.attempt.to_string());
        check_eq!(
            test_support::text(&row, "reference"),
            format!("ref-{}", fixture.unique)
        );
        check_eq!(test_support::text(&row, "status"), "UNKNOWN");
        check_eq!(test_support::text(&row, "requestedAmount"), "150.7500");
        check_eq!(test_support::text(&row, "totalChargedAmount"), "150.7500");
        check_eq!(
            test_support::text(row.get("application").ok_or("application")?, "id"),
            fixture.application.to_string()
        );
        check_eq!(
            test_support::text(row.get("rail").ok_or("rail")?, "id"),
            fixture.rail.to_string()
        );
        check_eq!(
            test_support::text(row.get("gateway").ok_or("gateway")?, "id"),
            fixture.gateway.to_string()
        );
        check_eq!(
            test_support::text(row.get("link").ok_or("link")?, "id"),
            fixture.link.to_string()
        );
        check_eq!(
            row.get("inquiryEligible").and_then(Value::as_bool),
            Some(true)
        );
        check_eq!(
            test_support::text(&row, "inquiryEligibilityReason"),
            "ELIGIBLE"
        );
        check_eq!(rows(&row, "operatorCases").len(), 1);
        // `merchant:read` without `finance:read` loses the fee/net fields.
        check_eq!(rows(&row, "redactedFields").len(), 4);
        check!(row.get("settledAmount").is_some_and(Value::is_null));
        check!(row.get("gatewayFeeAmount").is_some_and(Value::is_null));
        check!(row
            .get("platformCommissionAmount")
            .is_some_and(Value::is_null));
        check!(row.get("netMerchantAmount").is_some_and(Value::is_null));

        let finance = test_support::staff("FINANCE", &["finance:read"]);
        let list = ok(
            "transactions finance",
            lists::transactions(&pool, Some(&finance), &id, "").await,
        )?;
        let row = rows(&list, "transactions")
            .into_iter()
            .next()
            .ok_or("finance transaction")?;
        check_eq!(rows(&row, "redactedFields").len(), 0);
        check_eq!(test_support::text(&row, "netMerchantAmount"), "150.7500");

        let filtered = ok(
            "transaction filter",
            lists::transactions(&pool, Some(&reader), &id, "status=UNKNOWN").await,
        )?;
        check_eq!(number(&filtered, "total"), 1);
        let empty = ok(
            "transaction empty filter",
            lists::transactions(&pool, Some(&reader), &id, "status=FAILED").await,
        )?;
        check_eq!(number(&empty, "total"), 0);
        let invalid = lists::transactions(&pool, Some(&reader), &id, "amountMin=abc")
            .await
            .expect_err("invalid range");
        check_eq!(invalid.status, 400);
        check_eq!(invalid.code, "INVALID_FILTER");

        let support = test_support::staff("SUPPORT", &["merchant:read"]);
        let list = ok(
            "transactions support",
            lists::transactions(&pool, Some(&support), &id, "").await,
        )?;
        let row = rows(&list, "transactions")
            .into_iter()
            .next()
            .ok_or("support transaction")?;
        check!(row.get("requestedAmount").is_some_and(Value::is_null));
        check!(row.get("providerReference").is_some_and(Value::is_null));
        check!(row.get("link").is_some_and(Value::is_null));
        check_eq!(rows(&row, "redactedFields").len(), 8);
        check_eq!(rows(&list, "redactedFields").len(), 2);

        let missing = lists::transactions(&pool, Some(&reader), &Uuid::new_v4().to_string(), "")
            .await
            .expect_err("missing merchant");
        check_eq!(missing.status, 404);
        check_eq!(missing.code, "MERCHANT_NOT_FOUND");
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn applications_pagination_and_redaction() {
    let outcome = with_extras("applications", |pool, fixture, _extras| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let id = fixture.merchant.to_string();

        let list = ok(
            "applications",
            lists::applications(&pool, Some(&reader), &id, "").await,
        )?;
        check_eq!(number(&list, "total"), 3);
        let row = rows(&list, "applications")
            .into_iter()
            .find(|row| test_support::text(row, "id") == fixture.application.to_string())
            .ok_or("fixture application")?;
        check_eq!(test_support::text(&row, "status"), "ACTIVE");
        check_eq!(
            test_support::text(&row, "expectedMonthlyVolume"),
            "1234.5000"
        );
        check_eq!(test_support::text(&row, "railWhitelistMode"), "NONE");
        check_eq!(number(&row, "railWhitelistCount"), 0);
        check_eq!(number(&row, "accessTokenCount"), 1);
        check_eq!(number(&row, "paymentLinkCount"), 1);
        check_eq!(number(&row, "posTerminalCount"), 1);
        check_eq!(number(&row, "redirectDomainCount"), 0);
        check_eq!(
            test_support::text(row.get("assignedWallet").ok_or("wallet")?, "id"),
            fixture.wallet.to_string()
        );
        check_eq!(rows(&row, "redactedFields").len(), 0);

        let support = test_support::staff("SUPPORT", &["merchant:read"]);
        let list = ok(
            "applications support",
            lists::applications(&pool, Some(&support), &id, "").await,
        )?;
        let row = rows(&list, "applications")
            .into_iter()
            .next()
            .ok_or("support application")?;
        check!(row.get("expectedMonthlyVolume").is_some_and(Value::is_null));
        check_eq!(rows(&row, "redactedFields").len(), 1);

        let page = ok(
            "applications page",
            lists::applications(
                &pool,
                Some(&reader),
                &id,
                "page=1&pageSize=2&sortKey=createdAt&sortDirection=asc",
            )
            .await,
        )?;
        check_eq!(number(&page, "total"), 3);
        check_eq!(rows(&page, "applications").len(), 2);
        check!(
            page.get("nextCursor").and_then(Value::as_str).is_some(),
            "a full page carries a cursor"
        );
        let second = ok(
            "applications page 2",
            lists::applications(
                &pool,
                Some(&reader),
                &id,
                "page=2&pageSize=2&sortKey=createdAt&sortDirection=asc",
            )
            .await,
        )?;
        check_eq!(rows(&second, "applications").len(), 1);

        let no_total = ok(
            "applications includeTotal=false",
            lists::applications(&pool, Some(&reader), &id, "includeTotal=false").await,
        )?;
        check_eq!(
            number(&no_total, "total"),
            3,
            "the TS handlers count regardless of includeTotal"
        );

        let by_wallet = ok(
            "applications wallet filter",
            lists::applications(
                &pool,
                Some(&reader),
                &id,
                &format!("walletId={}", fixture.wallet),
            )
            .await,
        )?;
        check_eq!(number(&by_wallet, "total"), 3);

        let missing = lists::applications(&pool, Some(&reader), &Uuid::new_v4().to_string(), "")
            .await
            .expect_err("missing merchant");
        check_eq!(missing.status, 404);
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn wallets_balances_and_checkpoints() {
    let outcome = with_extras("wallets360", |pool, fixture, _extras| async move {
        let finance = test_support::staff("FINANCE", &["finance:read"]);
        let id = fixture.merchant.to_string();
        let list = ok(
            "wallets",
            lists::wallets_list(&pool, Some(&finance), &id, "").await,
        )?;
        check_eq!(number(&list, "total"), 1);
        let row = rows(&list, "wallets")
            .into_iter()
            .next()
            .ok_or("wallet row")?;
        check_eq!(test_support::text(&row, "id"), fixture.wallet.to_string());
        check_eq!(test_support::text(&row, "currency"), "LYD");
        check_eq!(test_support::text(&row, "balance"), "25.0000");
        check_eq!(test_support::text(&row, "checkpointBalance"), "25.0000");
        check_eq!(number(&row, "applicationCount"), 3);
        check_eq!(number(&row, "paymentLinkCount"), 1);
        check_eq!(number(&row, "cashoutCount"), 1);
        check_eq!(number(&row, "pendingCashoutCount"), 1);
        check_eq!(rows(&row, "redactedFields").len(), 0);

        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let list = ok(
            "wallets reader",
            lists::wallets_list(&pool, Some(&reader), &id, "").await,
        )?;
        let row = rows(&list, "wallets")
            .into_iter()
            .next()
            .ok_or("reader wallet")?;
        check!(row.get("balance").is_some_and(Value::is_null));
        check_eq!(rows(&row, "redactedFields").len(), 2);
        check_eq!(number(&row, "pendingCashoutCount"), 0);

        let missing = lists::wallets_list(&pool, Some(&finance), &Uuid::new_v4().to_string(), "")
            .await
            .expect_err("missing merchant");
        check_eq!(missing.status, 404);
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn financial_lists_and_the_financial_gate() {
    let outcome = with_extras("financial", |pool, fixture, extras| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let finance = test_support::staff("FINANCE", &["finance:read"]);
        let id = fixture.merchant.to_string();

        for (_label, error) in [
            (
                "cashouts",
                lists::cashouts(&pool, Some(&reader), &id, "")
                    .await
                    .expect_err("no financial access"),
            ),
            (
                "disputes",
                lists::disputes(&pool, Some(&reader), &id, "")
                    .await
                    .expect_err("no financial access"),
            ),
            (
                "adjustments",
                lists::adjustments(&pool, Some(&reader), &id, "")
                    .await
                    .expect_err("no financial access"),
            ),
        ] {
            check_eq!(error.status, 403, "{label}");
            check_eq!(error.code, "MERCHANT_FINANCIAL_ACCESS_REQUIRED", "{label}");
        }

        let cashouts = ok(
            "cashouts",
            lists::cashouts(&pool, Some(&finance), &id, "").await,
        )?;
        check_eq!(number(&cashouts, "total"), 1);
        let row = rows(&cashouts, "cashouts")
            .into_iter()
            .next()
            .ok_or("cashout row")?;
        check_eq!(test_support::text(&row, "id"), fixture.cashout.to_string());
        check_eq!(test_support::text(&row, "amount"), "5.0000");
        check_eq!(test_support::text(&row, "currency"), "LYD");
        check_eq!(test_support::text(&row, "state"), "PENDING");
        check_eq!(
            test_support::text(row.get("wallet").ok_or("wallet")?, "id"),
            fixture.wallet.to_string()
        );
        check_eq!(
            test_support::text(row.get("destination").ok_or("destination")?, "iban"),
            "****0000"
        );

        let disputes = ok(
            "disputes",
            lists::disputes(&pool, Some(&finance), &id, "").await,
        )?;
        check_eq!(number(&disputes, "total"), 1);
        let row = rows(&disputes, "disputes")
            .into_iter()
            .next()
            .ok_or("dispute row")?;
        check_eq!(test_support::text(&row, "id"), extras.dispute.to_string());
        check_eq!(
            test_support::text(&row, "externalDisputeRef"),
            format!("dp-{}", extras.unique)
        );
        check_eq!(test_support::text(&row, "source"), "WEBHOOK");
        check_eq!(test_support::text(&row, "status"), "OPENED");
        check_eq!(test_support::text(&row, "amount"), "10.5000");
        check_eq!(test_support::text(&row, "currency"), "LYD");
        check_eq!(
            test_support::text(row.get("attempt").ok_or("attempt")?, "id"),
            fixture.attempt.to_string()
        );
        check_eq!(
            test_support::text(row.get("gateway").ok_or("gateway")?, "id"),
            fixture.gateway.to_string()
        );
        check_eq!(
            test_support::text(row.get("rail").ok_or("rail")?, "id"),
            fixture.rail.to_string()
        );
        check!(row.get("adjustment").is_some_and(Value::is_null));
        let filtered = ok(
            "disputes filter",
            lists::disputes(
                &pool,
                Some(&finance),
                &id,
                "status=OPENED&openedFrom=2000-01-01",
            )
            .await,
        )?;
        check_eq!(number(&filtered, "total"), 1);

        let adjustments = ok(
            "adjustments",
            lists::adjustments(&pool, Some(&finance), &id, "").await,
        )?;
        check_eq!(number(&adjustments, "total"), 1);
        let row = rows(&adjustments, "adjustments")
            .into_iter()
            .next()
            .ok_or("adjustment row")?;
        check_eq!(
            test_support::text(&row, "id"),
            extras.adjustment.to_string()
        );
        check_eq!(test_support::text(&row, "type"), "REFUND");
        check_eq!(test_support::text(&row, "state"), "DRAFT");
        check_eq!(test_support::text(&row, "amount"), "7.2500");
        check_eq!(test_support::text(&row, "currency"), "LYD");
        check_eq!(
            test_support::text(row.get("sourceAttempt").ok_or("source")?, "id"),
            fixture.attempt.to_string()
        );
        check_eq!(
            test_support::text(row.get("targetGlAccount").ok_or("target")?, "id"),
            fixture.gl_account.to_string()
        );
        check!(row.get("dispute").is_some_and(Value::is_null));

        for (_label, error) in [
            (
                "cashouts",
                lists::cashouts(&pool, Some(&finance), &Uuid::new_v4().to_string(), "")
                    .await
                    .expect_err("missing merchant"),
            ),
            (
                "disputes",
                lists::disputes(&pool, Some(&finance), &Uuid::new_v4().to_string(), "")
                    .await
                    .expect_err("missing merchant"),
            ),
            (
                "adjustments",
                lists::adjustments(&pool, Some(&finance), &Uuid::new_v4().to_string(), "")
                    .await
                    .expect_err("missing merchant"),
            ),
        ] {
            check_eq!(error.status, 404, "{label}");
            check_eq!(error.code, "MERCHANT_NOT_FOUND", "{label}");
        }
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn notifications_and_audit_events() {
    let outcome = with_extras("events", |pool, fixture, extras| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let compliance = test_support::staff("COMPLIANCE", &["compliance:read"]);
        let id = fixture.merchant.to_string();

        let notifications = ok(
            "notifications",
            lists::notifications(&pool, Some(&reader), &id, "").await,
        )?;
        check_eq!(number(&notifications, "total"), 1);
        let row = rows(&notifications, "notifications")
            .into_iter()
            .next()
            .ok_or("notification row")?;
        check_eq!(
            test_support::text(&row, "id"),
            extras.notification.to_string()
        );
        check_eq!(
            test_support::text(&row, "templateCode"),
            "MERCHANT_SUSPENDED"
        );
        check_eq!(test_support::text(&row, "channel"), "EMAIL");
        check_eq!(test_support::text(&row, "lang"), "EN");
        check_eq!(test_support::text(&row, "status"), "QUEUED");
        check_eq!(number(&row, "attempts"), 1);
        check_eq!(
            test_support::text(&row, "addressMasked"),
            "ac***@example.test"
        );
        let filtered = ok(
            "notifications filter",
            lists::notifications(
                &pool,
                Some(&reader),
                &id,
                "templateCode=MERCHANT_SUSPENDED&channel=EMAIL",
            )
            .await,
        )?;
        check_eq!(number(&filtered, "total"), 1);

        let events = ok(
            "audit events",
            lists::audit_events(&pool, Some(&reader), &id, "").await,
        )?;
        check_eq!(number(&events, "total"), 1);
        let row = rows(&events, "auditEvents")
            .into_iter()
            .next()
            .ok_or("audit row")?;
        check_eq!(test_support::text(&row, "id"), extras.audit.to_string());
        check_eq!(
            test_support::text(&row, "action"),
            "MERCHANT_DESCRIPTIVE_UPDATED"
        );
        check_eq!(test_support::text(&row, "role"), "COMPLIANCE");
        check_eq!(test_support::text(&row, "entityType"), "MERCHANT");
        check_eq!(test_support::text(&row, "entityId"), id.clone());
        check!(row.get("before").is_some_and(Value::is_null));
        check_eq!(row.get("redacted").and_then(Value::as_bool), Some(true));

        let events = ok(
            "audit events compliance",
            lists::audit_events(
                &pool,
                Some(&compliance),
                &id,
                "action=MERCHANT_DESCRIPTIVE_UPDATED",
            )
            .await,
        )?;
        let row = rows(&events, "auditEvents")
            .into_iter()
            .next()
            .ok_or("audit row compliance")?;
        check_eq!(
            test_support::text(row.get("before").ok_or("before")?, "taxId"),
            "old"
        );
        check_eq!(
            test_support::text(row.get("after").ok_or("after")?, "taxId"),
            "new"
        );
        check_eq!(row.get("redacted").and_then(Value::as_bool), Some(false));

        let missing = lists::notifications(&pool, Some(&reader), &Uuid::new_v4().to_string(), "")
            .await
            .expect_err("missing merchant");
        check_eq!(missing.status, 404);
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}

#[tokio::test]
async fn stats_changes_and_beneficial_owners() {
    let outcome = with_extras("changes", |pool, fixture, extras| async move {
        let reader = test_support::staff("OPERATOR", &["merchant:read"]);
        let compliance = test_support::staff("COMPLIANCE", &["compliance:read"]);
        let finance = test_support::staff("FINANCE", &["finance:read"]);
        let id = fixture.merchant.to_string();

        let denied = stats::stats(&pool, Some(&reader), &id, "")
            .await
            .expect_err("no financial access");
        check_eq!(denied.status, 403);
        check_eq!(denied.code, "MERCHANT_FINANCIAL_ACCESS_REQUIRED");

        let stats = ok(
            "stats",
            stats::stats(&pool, Some(&finance), &id, "period=7d&currency=lyd").await,
        )?;
        check_eq!(test_support::text(&stats, "period"), "7d");
        check_eq!(test_support::text(&stats, "currency"), "LYD");
        check!(stats
            .get("since")
            .and_then(Value::as_str)
            .is_some_and(|value| value.ends_with('Z')));
        check_eq!(
            stats.get("mixedCurrency").and_then(Value::as_bool),
            Some(false)
        );
        let totals = stats.get("totals").ok_or("totals")?;
        check_eq!(number(totals, "attemptCount"), 1);
        check_eq!(number(totals, "successfulCount"), 0);
        check_eq!(number(totals, "successRate"), 0);
        check_eq!(test_support::text(totals, "grossVolume"), "0.0000");
        check_eq!(test_support::text(totals, "averageTicket"), "0.0000");
        check_eq!(number(totals, "unknownCount"), 1);
        let statuses = rows(&stats, "statuses");
        check_eq!(statuses.len(), 1);
        check_eq!(test_support::text(&statuses[0], "status"), "UNKNOWN");
        check_eq!(number(&statuses[0], "count"), 1);
        check_eq!(
            test_support::text(&statuses[0], "chargedAmount"),
            "150.7500"
        );
        check_eq!(
            test_support::text(stats.get("walletBalance").ok_or("wallet")?, "balance"),
            "25.0000"
        );
        check_eq!(
            test_support::text(&stats, "negativeBalanceCeiling"),
            "0.0000"
        );
        check_eq!(
            number(stats.get("pendingCashouts").ok_or("cashouts")?, "count"),
            1
        );
        check_eq!(
            test_support::text(stats.get("pendingCashouts").ok_or("cashouts")?, "amount"),
            "5.0000"
        );
        check_eq!(number(&stats, "openDisputes"), 1);
        check_eq!(number(&stats, "pendingApprovals"), 1);
        check!(stats
            .get("nextKybReviewAt")
            .and_then(Value::as_str)
            .is_some());
        check_eq!(rows(&stats, "byCurrency").len(), 1);

        let changes = ok(
            "detail changes",
            changes::detail_changes(&pool, Some(&reader), &id, "").await,
        )?;
        check_eq!(number(&changes, "total"), 1);
        let row = rows(&changes, "detailChanges")
            .into_iter()
            .next()
            .ok_or("detail change")?;
        check_eq!(
            test_support::text(&row, "id"),
            extras.detail_change.to_string()
        );
        check_eq!(test_support::text(&row, "fieldName"), "/taxId");
        check_eq!(test_support::text(&row, "oldValue"), "[REDACTED]");
        check_eq!(row.get("redacted").and_then(Value::as_bool), Some(true));
        check_eq!(
            test_support::text(row.get("actor").ok_or("actor")?, "email"),
            format!("{}@example.test", fixture.unique)
        );
        let changes = ok(
            "detail changes compliance",
            changes::detail_changes(&pool, Some(&compliance), &id, "").await,
        )?;
        let row = rows(&changes, "detailChanges")
            .into_iter()
            .next()
            .ok_or("detail change compliance")?;
        check_eq!(test_support::text(&row, "oldValue"), "OLD-TAX");
        check_eq!(row.get("redacted").and_then(Value::as_bool), Some(false));

        let pending = ok(
            "pending changes",
            changes::pending_changes(&pool, Some(&reader), &id).await,
        )?;
        let list = rows(&pending, "pendingChanges");
        check_eq!(list.len(), 1);
        check_eq!(
            test_support::text(&list[0], "id"),
            extras.approval.to_string()
        );
        check_eq!(test_support::text(&list[0], "state"), "PENDING_REVIEW");
        check_eq!(test_support::text(&list[0], "mode"), "STANDARD");
        check_eq!(
            test_support::text(&list[0], "maker"),
            format!("{}@example.test", fixture.unique)
        );
        check!(list[0].get("checker").is_some_and(Value::is_null));
        check!(list[0].get("payload").is_some_and(Value::is_null));
        check!(list[0].get("makerReason").is_some_and(Value::is_null));
        let pending = ok(
            "pending changes compliance",
            changes::pending_changes(&pool, Some(&compliance), &id).await,
        )?;
        let list = rows(&pending, "pendingChanges");
        check_eq!(test_support::text(&list[0], "makerReason"), "test change");
        check_eq!(
            test_support::text(list[0].get("payload").ok_or("payload")?, "kind"),
            "SUSPEND"
        );
        let unknown = ok(
            "pending changes unknown merchant",
            changes::pending_changes(&pool, Some(&reader), &Uuid::new_v4().to_string()).await,
        )?;
        check_eq!(rows(&unknown, "pendingChanges").len(), 0);

        let owners = ok(
            "beneficial owners",
            changes::beneficial_owners(&pool, &id).await,
        )?;
        let list = rows(&owners, "beneficialOwners");
        check_eq!(list.len(), 1);
        check_eq!(test_support::text(&list[0], "id"), extras.owner.to_string());
        check_eq!(test_support::text(&list[0], "fullNameAr"), "مالك تجريبي");
        check_eq!(test_support::text(&list[0], "fullNameEn"), "Test Owner");
        check_eq!(test_support::text(&list[0], "role"), "OWNER");
        check_eq!(test_support::text(&list[0], "ownershipPercent"), "40.00");
        check_eq!(test_support::text(&list[0], "nationality"), "LY");
        check_eq!(
            list[0].get("pepDeclared").and_then(Value::as_bool),
            Some(false)
        );
        check_eq!(
            test_support::text(&list[0], "dateOfBirth"),
            "1980-05-06T00:00:00.000Z"
        );
        check!(list[0].get("nationalIdHash").is_none());
        check!(list[0].get("nationalIdCiphertext").is_none());

        let missing = changes::beneficial_owners(&pool, &Uuid::new_v4().to_string())
            .await
            .expect_err("missing merchant");
        check_eq!(missing.status, 404);
        check_eq!(missing.code, "MERCHANT_NOT_FOUND");
        let invalid = changes::beneficial_owners(&pool, "not-a-uuid")
            .await
            .expect_err("invalid merchant id");
        check_eq!(invalid.status, 400);
        check_eq!(invalid.code, "INVALID_BODY");
        Ok(())
    })
    .await;
    if let Err(error) = outcome {
        panic!("{error}");
    }
}
