//! Database-gated integration tests for the remaining P6 workers.
//!
//! They run against `PG_TEST_DATABASE_URL` (default
//! `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`, schema 46) and skip with
//! a message when that database is unreachable, so `cargo test -p pg-workers` is green on a machine
//! without PostgreSQL. Every test creates uniquely-named rows and removes them again; the
//! append-only tables are cleaned through the maintenance settings in
//! `pg_workers::db::APPEND_ONLY_CLEANUP_SQL` (superuser only).

use std::sync::Arc;
use std::time::Duration;

use chrono::{NaiveDateTime, Utc};
use pg_workers::cases::ensure_system_actor;
use pg_workers::cron::{last_scheduled_at_or_before, parse_cron, DEFAULT_TIME_ZONE};
use pg_workers::db::APPEND_ONLY_CLEANUP_SQL;
use pg_workers::notices::NoticeAddressCipher;
use pg_workers::remaining_workers::{
    consistency_audit::{ConsistencyAuditConfig, ConsistencyAuditWorker},
    expiry_housekeeping::{ExpiryHousekeepingConfig, ExpiryHousekeepingWorker},
    join_request_expiry::{JoinRequestExpiryConfig, JoinRequestExpiryWorker},
    journal_partition::{
        inspect_journal_partitions, JournalPartitionConfig, JournalPartitionWorker,
    },
    retention::{RetentionConfig, RetentionWorker},
    statement_schedule::{StatementScheduleConfig, StatementScheduleWorker},
};
use pg_workers::runtime::WorkerError;
use sqlx::PgPool;
use uuid::Uuid;

const DEFAULT_TEST_DATABASE_URL: &str =
    "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

async fn test_pool() -> Option<PgPool> {
    let url = std::env::var("PG_TEST_DATABASE_URL")
        .unwrap_or_else(|_| DEFAULT_TEST_DATABASE_URL.to_owned());
    let attempt = async {
        PgPool::connect(&url)
            .await
            .map_err(|error| error.to_string())
    };
    match tokio::time::timeout(Duration::from_secs(3), attempt).await {
        Ok(Ok(pool)) => Some(pool),
        _ => {
            eprintln!("skip: PostgreSQL not reachable at {url}");
            None
        }
    }
}

/// Cleanup helper: each statement takes one `uuid[]` parameter.
async fn cleanup_uuids(pool: &PgPool, statements: &[(&str, Vec<Uuid>)]) {
    let Ok(mut tx) = pool.begin().await else {
        return;
    };
    let _ = sqlx::query(APPEND_ONLY_CLEANUP_SQL).execute(&mut *tx).await;
    for (sql, ids) in statements {
        if ids.is_empty() {
            continue;
        }
        if let Err(error) = sqlx::query(sqlx::AssertSqlSafe(*sql))
            .bind(ids)
            .execute(&mut *tx)
            .await
        {
            eprintln!("cleanup failed for {sql}: {error}");
        }
    }
    let _ = tx.commit().await;
}

/// Cleanup helper: each statement takes one `text` parameter.
async fn cleanup_text(pool: &PgPool, statements: &[(&str, String)]) {
    let Ok(mut tx) = pool.begin().await else {
        return;
    };
    let _ = sqlx::query(APPEND_ONLY_CLEANUP_SQL).execute(&mut *tx).await;
    for (sql, value) in statements {
        if let Err(error) = sqlx::query(sqlx::AssertSqlSafe(*sql))
            .bind(value)
            .execute(&mut *tx)
            .await
        {
            eprintln!("cleanup failed for {sql}: {error}");
        }
    }
    let _ = tx.commit().await;
}

struct PlainCipher;

impl NoticeAddressCipher for PlainCipher {
    fn seal(&self, address: &str, associated_data: &str) -> Result<String, WorkerError> {
        Ok(format!("sealed:{associated_data}:{address}"))
    }
}

fn sealed_cipher() -> Arc<dyn NoticeAddressCipher> {
    Arc::new(PlainCipher)
}

fn suffix() -> String {
    Uuid::now_v7().to_string()
}

async fn insert_merchant(pool: &PgPool, suffix: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO merchants (id, created_at, updated_at, legal_name, trade_name, onboarding_channel, country)
         VALUES ($1, now(), now(), $2, $2, 'SELF_SERVICE', 'LY')",
    )
    .bind(id)
    .bind(format!("Test Merchant {suffix}"))
    .execute(pool)
    .await
    .expect("merchant");
    id
}

async fn insert_user(
    pool: &PgPool,
    suffix: &str,
    role: &str,
    merchant_id: Option<Uuid>,
) -> (Uuid, String) {
    let id = Uuid::now_v7();
    let email = format!("worker-{suffix}@example.test");
    sqlx::query(
        "INSERT INTO users (id, created_at, updated_at, merchant_id, email, role, authorities_map,
                            is_maker, is_checker, mfa_required, status)
         VALUES ($1, now(), now(), $2, $3, $4::\"UserRole\", '{}'::jsonb, false, false, false,
                 'ACTIVE')",
    )
    .bind(id)
    .bind(merchant_id)
    .bind(&email)
    .bind(role)
    .execute(pool)
    .await
    .expect("user");
    (id, email)
}

// -------------------------------------------------------------------------------------------
// Journal partition worker
// -------------------------------------------------------------------------------------------

fn month_parts(suffix: &str) -> (i32, u32) {
    let (year, month) = suffix.split_once('_').expect("YYYY_MM");
    (year.parse().expect("year"), month.parse().expect("month"))
}

fn month_offset(current: (i32, u32), later: (i32, u32)) -> i64 {
    i64::from(later.0 - current.0) * 12 + i64::from(later.1) - i64::from(current.1)
}

#[tokio::test]
async fn journal_partition_worker_is_idempotent_and_creates_the_next_months() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let current: String =
        sqlx::query_scalar("SELECT to_char(date_trunc('month', now()), 'YYYY_MM')")
            .fetch_one(&pool)
            .await
            .expect("current month");
    let highest: Option<String> = sqlx::query_scalar(
        "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'journal_lines'::regclass AND c.relname ~ '^journal_lines_[0-9]{4}_[0-9]{2}$'
          ORDER BY c.relname DESC LIMIT 1",
    )
    .fetch_optional(&pool)
    .await
    .expect("highest partition");
    let highest_suffix = highest
        .as_deref()
        .map(|name| name.trim_start_matches("journal_lines_").to_owned());
    let highest_offset = highest_suffix
        .as_deref()
        .map(|suffix| month_offset(month_parts(&current), month_parts(suffix)))
        .unwrap_or(-1);
    let months_ahead = (highest_offset + 2).clamp(1, 60);
    let expected = usize::try_from(months_ahead - highest_offset - 1).unwrap_or(0);
    let started = Utc::now().naive_utc();

    let worker = JournalPartitionWorker::new(
        pool.clone(),
        JournalPartitionConfig {
            months_ahead,
            default_rows_cap: 1_000,
            ..JournalPartitionConfig::default()
        },
    );
    let before = inspect_journal_partitions(&pool, months_ahead, 1_000)
        .await
        .expect("inspect");
    assert_eq!(before.missing.len(), expected);
    let first = worker.tick_once().await.expect("first tick");
    assert_eq!(first.created.len(), expected);
    assert!(first.inspection.missing.is_empty());
    let last_partition: String = sqlx::query_scalar(
        "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'journal_lines'::regclass AND c.relname ~ '^journal_lines_[0-9]{4}_[0-9]{2}$'
          ORDER BY c.relname DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .expect("last partition");
    let created_suffix = format!("journal_lines_{}", first.created.last().expect("created"));
    assert_eq!(last_partition, created_suffix);

    let second = worker.tick_once().await.expect("second tick");
    assert!(
        second.created.is_empty(),
        "a second tick must not create a partition again"
    );
    assert!(second.inspection.missing.is_empty());

    // The audit row names the months created in the first tick.
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log
          WHERE action = 'JOURNAL_PARTITIONS_ENSURED' AND created_at >= $1
            AND after_json->'created' ? $2",
    )
    .bind(started)
    .bind(first.created.first().expect("first created"))
    .fetch_one(&pool)
    .await
    .expect("audit");
    assert_eq!(audits, 1);

    // Drop only the empty future months this test created.
    for month in &first.created {
        let sql = format!("DROP TABLE IF EXISTS \"journal_lines_{month}\"");
        let _ = sqlx::query(sqlx::AssertSqlSafe(sql)).execute(&pool).await;
    }
    cleanup_text(
        &pool,
        &[(
            "DELETE FROM audit_log WHERE action = 'JOURNAL_PARTITIONS_ENSURED' AND created_at >= $1::timestamp",
            started.to_string(),
        )],
    )
    .await;
    for subject in [
        pg_workers::remaining_workers::JOURNAL_PARTITION_CASE_DEFAULT_ROWS,
        pg_workers::remaining_workers::JOURNAL_PARTITION_CASE_ENSURE_FAILED,
    ] {
        cleanup_text(
            &pool,
            &[
                (
                    "DELETE FROM operator_case_events WHERE case_id IN (SELECT id FROM operator_cases WHERE subject_key = $1)",
                    subject.to_owned(),
                ),
                (
                    "DELETE FROM operator_cases WHERE subject_key = $1",
                    subject.to_owned(),
                ),
            ],
        )
        .await;
    }
}

// -------------------------------------------------------------------------------------------
// Join request expiry
// -------------------------------------------------------------------------------------------

#[tokio::test]
async fn join_request_expiry_expires_only_past_deadline_requests_with_one_audit_and_notice_each() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = suffix();
    let merchant_id = insert_merchant(&pool, &suffix).await;
    let (user_id, _email) = insert_user(&pool, &suffix, "MERCHANT_ADMIN", Some(merchant_id)).await;
    let started = Utc::now().naive_utc();
    let old = started - chrono::Duration::days(40);
    let draft_old = Uuid::now_v7();
    let draft_new = Uuid::now_v7();
    let review_old = Uuid::now_v7();
    let pending_checker = Uuid::now_v7();
    for (id, status, created_at, sla_due_at) in [
        (draft_old, "DRAFT", old, started + chrono::Duration::days(1)),
        (
            draft_new,
            "DRAFT",
            started - chrono::Duration::days(1),
            started + chrono::Duration::days(1),
        ),
        (
            review_old,
            "SUBMITTED",
            old,
            started - chrono::Duration::hours(1),
        ),
        (
            pending_checker,
            "PENDING_CHECKER",
            old,
            started - chrono::Duration::hours(1),
        ),
    ] {
        sqlx::query(
            "INSERT INTO join_requests (id, created_at, updated_at, merchant_id, submitted_by_user_id,
                                        status, onboarding_channel, sla_due_at)
             VALUES ($1, $2, $2, $3, $4, $5::\"JoinRequestStatus\", 'SELF_SERVICE', $6)",
        )
        .bind(id)
        .bind(created_at)
        .bind(merchant_id)
        .bind(user_id)
        .bind(status)
        .bind(sla_due_at)
        .execute(&pool)
        .await
        .expect("join request");
    }

    let worker = JoinRequestExpiryWorker::new(
        pool.clone(),
        JoinRequestExpiryConfig::default(),
        Some(sealed_cipher()),
    );
    let processed = worker.tick_once().await.expect("tick");
    assert_eq!(processed, 2);
    for (id, expected) in [
        (draft_old, "EXPIRED"),
        (draft_new, "DRAFT"),
        (review_old, "EXPIRED"),
        (pending_checker, "PENDING_CHECKER"),
    ] {
        let status: String =
            sqlx::query_scalar("SELECT status::text FROM join_requests WHERE id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("status");
        assert_eq!(status, expected);
    }

    let expired_ids = vec![draft_old.to_string(), review_old.to_string()];
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log
          WHERE action = 'JOIN_REQUEST_EXPIRED' AND entity_id = ANY($1::text[]) AND created_at >= $2",
    )
    .bind(&expired_ids)
    .bind(started)
    .fetch_one(&pool)
    .await
    .expect("audits");
    assert_eq!(audits, 2);
    for id in [draft_old, review_old] {
        let notices: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM notifications
              WHERE event_id LIKE 'notice:join-request-expired:' || $1 || ':%'",
        )
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .expect("notices");
        assert_eq!(notices, 2, "in-app and e-mail per expired request");
    }

    // A second tick finds nothing: the transition is idempotent.
    let again = worker.tick_once().await.expect("second tick");
    assert_eq!(again, 0);

    cleanup_uuids(
        &pool,
        &[
            (
                "DELETE FROM notifications WHERE recipient_user_id = ANY($1)",
                vec![user_id],
            ),
            (
                "DELETE FROM audit_log WHERE action = 'JOIN_REQUEST_EXPIRED' AND entity_id = ANY($1::uuid[]::text[])",
                vec![draft_old, review_old],
            ),
            (
                "DELETE FROM join_requests WHERE merchant_id = ANY($1)",
                vec![merchant_id],
            ),
            ("DELETE FROM users WHERE merchant_id = ANY($1)", vec![merchant_id]),
            ("DELETE FROM merchants WHERE id = ANY($1)", vec![merchant_id]),
        ],
    )
    .await;
}

// -------------------------------------------------------------------------------------------
// Expiry housekeeping
// -------------------------------------------------------------------------------------------

struct LinkFixture {
    gl_account_id: Uuid,
    wallet_id: Uuid,
    application_id: Uuid,
    merchant_id: Uuid,
}

async fn seed_link_fixture(
    pool: &PgPool,
    suffix: &str,
    locked: i32,
    updated_at: NaiveDateTime,
    expires_at: NaiveDateTime,
) -> (LinkFixture, Uuid) {
    let merchant_id = insert_merchant(pool, suffix).await;
    let gl_account_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO gl_accounts (id, created_at, updated_at, account_type, currency, shard_count)
         VALUES ($1, now(), now(), 'MERCHANT_WALLET', 'LYD', 1)",
    )
    .bind(gl_account_id)
    .execute(pool)
    .await
    .expect("gl account");
    let wallet_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO wallets (id, created_at, updated_at, merchant_id, gl_account_id)
         VALUES ($1, now(), now(), $2, $3)",
    )
    .bind(wallet_id)
    .bind(merchant_id)
    .bind(gl_account_id)
    .execute(pool)
    .await
    .expect("wallet");
    let application_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO applications (id, created_at, updated_at, merchant_id, name, assigned_wallet_id)
         VALUES ($1, now(), now(), $2, $3, $4)",
    )
    .bind(application_id)
    .bind(merchant_id)
    .bind(format!("Test app {suffix}"))
    .bind(wallet_id)
    .execute(pool)
    .await
    .expect("application");
    let link_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO payment_links (id, created_at, updated_at, key, application_id, wallet_id,
                                    amount, currency, fee_bearer, state, expires_at,
                                    infinite_use, use_count, active_locked_count)
         VALUES ($1, now(), $2, $3, $4, $5, 10.0000, 'LYD', 'MERCHANT_ABSORBS', 'PENDING',
                 $6, false, 5, $7)",
    )
    .bind(link_id)
    .bind(updated_at)
    .bind(format!("test-link-{suffix}"))
    .bind(application_id)
    .bind(wallet_id)
    .bind(expires_at)
    .bind(locked)
    .execute(pool)
    .await
    .expect("payment link");
    (
        LinkFixture {
            gl_account_id,
            wallet_id,
            application_id,
            merchant_id,
        },
        link_id,
    )
}

async fn cleanup_link_fixture(pool: &PgPool, fixture: &LinkFixture, link_id: Uuid) {
    cleanup_uuids(
        pool,
        &[
            (
                "DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[]::text[])",
                vec![link_id],
            ),
            (
                "DELETE FROM payment_links WHERE application_id = ANY($1)",
                vec![fixture.application_id],
            ),
            (
                "DELETE FROM applications WHERE id = ANY($1)",
                vec![fixture.application_id],
            ),
            (
                "DELETE FROM wallets WHERE id = ANY($1)",
                vec![fixture.wallet_id],
            ),
            (
                "DELETE FROM gl_shard_checkpoints WHERE gl_account_id = ANY($1)",
                vec![fixture.gl_account_id],
            ),
            (
                "DELETE FROM gl_shard_repairs WHERE gl_account_id = ANY($1)",
                vec![fixture.gl_account_id],
            ),
            (
                "DELETE FROM gl_account_shards WHERE gl_account_id = ANY($1)",
                vec![fixture.gl_account_id],
            ),
            (
                "DELETE FROM gl_accounts WHERE id = ANY($1)",
                vec![fixture.gl_account_id],
            ),
            (
                "DELETE FROM merchants WHERE id = ANY($1)",
                vec![fixture.merchant_id],
            ),
        ],
    )
    .await;
}

#[tokio::test]
async fn expiry_housekeeping_expires_the_documented_rows_and_never_emergency_approvals() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = suffix();
    let (maker_id, _maker_email) = insert_user(&pool, &suffix, "OPERATOR", None).await;
    let (inviter_id, _inviter_email) =
        insert_user(&pool, &format!("inviter-{suffix}"), "SECURITY_ADMIN", None).await;
    let started = Utc::now().naive_utc();
    let past = started - chrono::Duration::hours(2);
    let future = started + chrono::Duration::hours(2);

    let expired_standard = Uuid::now_v7();
    let emergency = Uuid::now_v7();
    let own_lifecycle = Uuid::now_v7();
    let future_approval = Uuid::now_v7();
    let expired_draft = Uuid::now_v7();
    for (id, subject, state, mode, expires_at) in [
        (
            expired_standard,
            "WALLET",
            "PENDING_REVIEW",
            "STANDARD",
            past,
        ),
        (
            emergency,
            "WALLET",
            "PENDING_REVIEW",
            "EMERGENCY_RATIFICATION",
            past,
        ),
        (
            own_lifecycle,
            "ADJUSTMENT",
            "PENDING_REVIEW",
            "STANDARD",
            past,
        ),
        (
            future_approval,
            "WALLET",
            "PENDING_REVIEW",
            "STANDARD",
            future,
        ),
        (expired_draft, "VELOCITY_RULE", "DRAFT", "STANDARD", past),
    ] {
        sqlx::query(
            "INSERT INTO approval_requests (id, created_at, updated_at, subject_type, subject_id,
                                            payload_diff_json, maker_user_id, state, expires_at, mode)
             VALUES ($1, now(), now(), $2, $3, '{}'::jsonb, $4, $5::\"ApprovalState\", $6,
                     $7::\"ApprovalMode\")",
        )
        .bind(id)
        .bind(subject)
        .bind(Uuid::now_v7().to_string())
        .bind(maker_id)
        .bind(state)
        .bind(expires_at)
        .bind(mode)
        .execute(&pool)
        .await
        .expect("approval");
    }

    let invited_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, created_at, updated_at, email, role, authorities_map, is_maker,
                            is_checker, mfa_required, status, invitation_token_hash,
                            invitation_expires_at, invited_by)
         VALUES ($1, now(), now(), $2, 'OPERATOR', '{}'::jsonb, false, false, false, 'INVITED',
                 $3, $4, $5)",
    )
    .bind(invited_id)
    .bind(format!("invited-{suffix}@example.test"))
    .bind("a".repeat(64))
    .bind(past)
    .bind(inviter_id)
    .execute(&pool)
    .await
    .expect("invited user");
    let invitation_notice = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO notifications (id, created_at, updated_at, event_id, recipient_user_id,
                                    address_masked, address_ciphertext, template_code, channel, lang,
                                    payload_json, status, attempts)
         VALUES ($1, now(), $2, $3, $4, 'in***@example.test', 'sealed', 'STAFF_INVITATION',
                 'EMAIL', 'EN', '{\"tokenCiphertext\":\"sealed-token\"}'::jsonb, 'QUEUED', 0)",
    )
    .bind(invitation_notice)
    .bind(started)
    .bind(format!("test-invitation-{suffix}"))
    .bind(invited_id)
    .execute(&pool)
    .await
    .expect("invitation notice");

    let (fixture, link_id) = seed_link_fixture(
        &pool,
        &suffix,
        0,
        started - chrono::Duration::hours(2),
        past,
    )
    .await;

    let expired_mfa = Uuid::now_v7();
    let fresh_mfa = Uuid::now_v7();
    for (id, expires_at) in [
        (expired_mfa, started - chrono::Duration::hours(30)),
        (fresh_mfa, future),
    ] {
        sqlx::query(
            "INSERT INTO mfa_challenges (id, created_at, user_id, channel, code_hash, expires_at)
             VALUES ($1, now(), $2, 'EMAIL', $3, $4)",
        )
        .bind(id)
        .bind(maker_id)
        .bind("b".repeat(64))
        .bind(expires_at)
        .execute(&pool)
        .await
        .expect("mfa challenge");
    }

    let finished_notice = Uuid::now_v7();
    let queued_notice = Uuid::now_v7();
    for (id, status) in [(finished_notice, "SENT"), (queued_notice, "QUEUED")] {
        sqlx::query(
            "INSERT INTO notifications (id, created_at, updated_at, event_id, recipient_user_id,
                                        address_masked, address_ciphertext, template_code, channel,
                                        lang, payload_json, status, attempts)
             VALUES ($1, now(), $2, $3, $4, 'in-app', '', 'TEST_SECRET', 'IN_APP', 'EN',
                     '{\"codeCiphertext\":\"x\",\"tokenCiphertext\":\"y\"}'::jsonb,
                     $5::\"NotificationStatus\", 0)",
        )
        .bind(id)
        .bind(started - chrono::Duration::minutes(120))
        .bind(format!("test-secret-{status}-{suffix}"))
        .bind(maker_id)
        .bind(status)
        .execute(&pool)
        .await
        .expect("secret notification");
    }

    let expired_jti = format!("test-expired-{suffix}");
    let future_jti = format!("test-future-{suffix}");
    for (jti, expires_at) in [
        (&expired_jti, Utc::now() - chrono::Duration::hours(1)),
        (&future_jti, Utc::now() + chrono::Duration::hours(1)),
    ] {
        sqlx::query("INSERT INTO session_revocations (jti, expires_at) VALUES ($1, $2)")
            .bind(jti)
            .bind(expires_at)
            .execute(&pool)
            .await
            .expect("revocation");
    }

    let worker = ExpiryHousekeepingWorker::new(
        pool.clone(),
        ExpiryHousekeepingConfig::default(),
        Some(sealed_cipher()),
    );
    let summary = worker.tick_once().await.expect("tick");
    assert!(summary.failed.is_empty());
    assert_eq!(summary.counts.approvals, 2);
    assert_eq!(summary.counts.invitations, 1);
    assert_eq!(summary.counts.payment_links, 1);
    assert_eq!(summary.counts.mfa_challenges, 1);
    assert_eq!(summary.counts.secrets, 1);
    assert_eq!(summary.counts.revocations, 1);

    for (id, expected) in [
        (expired_standard, "EXPIRED"),
        (emergency, "PENDING_REVIEW"),
        (own_lifecycle, "PENDING_REVIEW"),
        (future_approval, "PENDING_REVIEW"),
        (expired_draft, "EXPIRED"),
    ] {
        let state: String =
            sqlx::query_scalar("SELECT state::text FROM approval_requests WHERE id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("approval state");
        assert_eq!(state, expected);
    }
    let rejection: Option<String> =
        sqlx::query_scalar("SELECT rejection_reason FROM approval_requests WHERE id = $1")
            .bind(expired_standard)
            .fetch_one(&pool)
            .await
            .expect("rejection");
    assert!(rejection
        .as_deref()
        .is_some_and(|reason| reason.starts_with("EXPIRED: not decided before ")));

    let token_hash: Option<String> =
        sqlx::query_scalar("SELECT invitation_token_hash FROM users WHERE id = $1")
            .bind(invited_id)
            .fetch_one(&pool)
            .await
            .expect("token hash");
    assert!(token_hash.is_none());
    let suppressed: String =
        sqlx::query_scalar("SELECT status::text FROM notifications WHERE id = $1")
            .bind(invitation_notice)
            .fetch_one(&pool)
            .await
            .expect("invitation status");
    assert_eq!(suppressed, "SUPPRESSED");
    let scrubbed: serde_json::Value =
        sqlx::query_scalar("SELECT payload_json FROM notifications WHERE id = $1")
            .bind(invitation_notice)
            .fetch_one(&pool)
            .await
            .expect("invitation payload");
    assert!(scrubbed.get("tokenCiphertext").is_none());

    let link_state: String =
        sqlx::query_scalar("SELECT state::text FROM payment_links WHERE id = $1")
            .bind(link_id)
            .fetch_one(&pool)
            .await
            .expect("link state");
    assert_eq!(link_state, "EXPIRED");
    let outbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox_events WHERE topic = 'link.expired' AND aggregate_id = $1",
    )
    .bind(link_id.to_string())
    .fetch_one(&pool)
    .await
    .expect("outbox");
    assert_eq!(outbox, 1);

    let expired_mfa_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM mfa_challenges WHERE id = $1)")
            .bind(expired_mfa)
            .fetch_one(&pool)
            .await
            .expect("expired mfa");
    assert!(!expired_mfa_exists);
    let fresh_mfa_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM mfa_challenges WHERE id = $1)")
            .bind(fresh_mfa)
            .fetch_one(&pool)
            .await
            .expect("fresh mfa");
    assert!(fresh_mfa_exists);

    let finished_payload: serde_json::Value =
        sqlx::query_scalar("SELECT payload_json FROM notifications WHERE id = $1")
            .bind(finished_notice)
            .fetch_one(&pool)
            .await
            .expect("finished payload");
    assert!(finished_payload.get("codeCiphertext").is_none());
    assert!(finished_payload.get("tokenCiphertext").is_none());
    let queued_payload: serde_json::Value =
        sqlx::query_scalar("SELECT payload_json FROM notifications WHERE id = $1")
            .bind(queued_notice)
            .fetch_one(&pool)
            .await
            .expect("queued payload");
    assert!(queued_payload.get("codeCiphertext").is_some());

    let expired_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_revocations WHERE jti = $1)")
            .bind(&expired_jti)
            .fetch_one(&pool)
            .await
            .expect("expired revocation");
    assert!(!expired_exists);
    let future_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_revocations WHERE jti = $1)")
            .bind(&future_jti)
            .fetch_one(&pool)
            .await
            .expect("future revocation");
    assert!(future_exists);

    let approval_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'APPROVAL_REQUEST_EXPIRED'
          AND entity_id = ANY($1::text[]) AND created_at >= $2",
    )
    .bind(vec![
        expired_standard.to_string(),
        expired_draft.to_string(),
    ])
    .bind(started)
    .fetch_one(&pool)
    .await
    .expect("approval audits");
    assert_eq!(approval_audits, 2);
    let notices: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notifications WHERE template_code = 'APPROVAL_REQUEST_EXPIRED'
          AND recipient_user_id = $1 AND created_at >= $2",
    )
    .bind(maker_id)
    .bind(started)
    .fetch_one(&pool)
    .await
    .expect("approval notices");
    assert_eq!(notices, 4, "in-app and e-mail for two expired approvals");

    cleanup_uuids(
        &pool,
        &[
            (
                "DELETE FROM notifications WHERE recipient_user_id = ANY($1)",
                vec![maker_id, invited_id, inviter_id],
            ),
            (
                "DELETE FROM approval_requests WHERE id = ANY($1)",
                vec![
                    expired_standard,
                    emergency,
                    own_lifecycle,
                    future_approval,
                    expired_draft,
                ],
            ),
            (
                "DELETE FROM mfa_challenges WHERE user_id = ANY($1)",
                vec![maker_id],
            ),
            ("DELETE FROM users WHERE id = ANY($1)", vec![invited_id]),
            (
                "DELETE FROM users WHERE id = ANY($1)",
                vec![maker_id, inviter_id],
            ),
        ],
    )
    .await;
    cleanup_text(
        &pool,
        &[
            (
                "DELETE FROM notifications WHERE event_id LIKE $1",
                format!("test-secret-%-{suffix}"),
            ),
            (
                "DELETE FROM notifications WHERE event_id = $1",
                format!("test-invitation-{suffix}"),
            ),
            (
                "DELETE FROM audit_log WHERE action IN ('APPROVAL_REQUEST_EXPIRED','STAFF_INVITATION_EXPIRED') AND created_at >= $1::timestamp",
                started.to_string(),
            ),
            (
                "DELETE FROM session_revocations WHERE jti LIKE $1",
                format!("test-%-{suffix}"),
            ),
        ],
    )
    .await;
    cleanup_link_fixture(&pool, &fixture, link_id).await;
}

// -------------------------------------------------------------------------------------------
// Statement schedule
// -------------------------------------------------------------------------------------------

#[tokio::test]
async fn statement_schedule_reports_one_case_per_missing_slot_and_resolves_a_late_statement() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = suffix();
    let started = Utc::now().naive_utc();
    let gateway_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO gateways (id, created_at, updated_at, code, name, operator, aliases, kind)
         VALUES ($1, now(), now(), $2, $3, 'TEST', '[]'::jsonb, 'DIRECT')",
    )
    .bind(gateway_id)
    .bind(format!("TEST-{suffix}"))
    .bind(format!("Test gateway {suffix}"))
    .execute(&pool)
    .await
    .expect("gateway");
    let source_id = Uuid::now_v7();
    let invalid_source_id = Uuid::now_v7();
    for (id, cron) in [
        (source_id, "0 6 * * *".to_owned()),
        (invalid_source_id, "not a cron".to_owned()),
    ] {
        sqlx::query(
            "INSERT INTO statement_sources (id, created_at, updated_at, gateway_id, type,
                                            parser_config, schedule_cron)
             VALUES ($1, $2, now(), $3, 'API', '{}'::jsonb, $4)",
        )
        .bind(id)
        .bind(started - chrono::Duration::days(45))
        .bind(gateway_id)
        .bind(cron)
        .execute(&pool)
        .await
        .expect("statement source");
    }

    let worker = StatementScheduleWorker::new(
        pool.clone(),
        StatementScheduleConfig {
            case_sla_hours: 24,
            source_ids: Some(vec![source_id, invalid_source_id]),
            ..StatementScheduleConfig::default()
        },
    );
    let first = worker.tick_once().await.expect("first tick");
    assert!(first.errors.is_empty(), "{:?}", first.errors);
    assert_eq!(first.opened, 7, "seven missed daily slots");
    assert_eq!(first.resolved, 0);
    let prefix = format!("statement.missing:{source_id}:");
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM operator_cases
          WHERE subject_key LIKE $1 || '%' AND state <> 'RESOLVED'",
    )
    .bind(&prefix)
    .fetch_one(&pool)
    .await
    .expect("open cases");
    assert_eq!(open, 7);
    let priority: String = sqlx::query_scalar(
        "SELECT priority::text FROM operator_cases WHERE subject_key LIKE $1 || '%' LIMIT 1",
    )
    .bind(&prefix)
    .fetch_one(&pool)
    .await
    .expect("priority");
    assert_eq!(priority, "P2");
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'STATEMENT_MISSING' AND entity_id = $1",
    )
    .bind(source_id.to_string())
    .fetch_one(&pool)
    .await
    .expect("audits");
    assert_eq!(audits, 7);

    // A second tick does not duplicate the cases or the invalid-cron report.
    let second = worker.tick_once().await.expect("second tick");
    assert_eq!(second.opened, 0);
    let invalid: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM operator_cases WHERE subject_key = $1 AND state <> 'RESOLVED'",
    )
    .bind(format!("statement.schedule_invalid:{invalid_source_id}"))
    .fetch_one(&pool)
    .await
    .expect("invalid case");
    assert_eq!(invalid, 1);

    // A statement arrives after the newest slot: its case (and the one inside the grace window)
    // resolves itself.
    let cron = parse_cron("0 6 * * *").expect("cron");
    let newest = last_scheduled_at_or_before(
        &cron,
        Utc::now() - chrono::Duration::minutes(120),
        DEFAULT_TIME_ZONE,
        None,
    )
    .expect("schedule")
    .expect("slot");
    let run_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO reconciliation_runs (id, created_at, updated_at, statement_source_id,
                                          window_start, window_end, file_hash, stats_json)
         VALUES ($1, $2, now(), $3, $4, $5, $6, '{}'::jsonb)",
    )
    .bind(run_id)
    .bind((newest + chrono::Duration::minutes(1)).naive_utc())
    .bind(source_id)
    .bind(newest.naive_utc() - chrono::Duration::days(1))
    .bind(newest.naive_utc())
    .bind(format!("{:0>64}", suffix.replace('-', "")))
    .execute(&pool)
    .await
    .expect("reconciliation run");
    let third = worker.tick_once().await.expect("third tick");
    assert_eq!(third.opened, 0);
    assert!(third.resolved >= 1, "the late statement resolves its slot");
    let newest_key = format!(
        "statement.missing:{source_id}:{}",
        newest.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    );
    let resolved: String =
        sqlx::query_scalar("SELECT state::text FROM operator_cases WHERE subject_key = $1")
            .bind(&newest_key)
            .fetch_one(&pool)
            .await
            .expect("newest case");
    assert_eq!(resolved, "RESOLVED");
    let resolution: Option<String> =
        sqlx::query_scalar("SELECT resolution_code FROM operator_cases WHERE subject_key = $1")
            .bind(&newest_key)
            .fetch_one(&pool)
            .await
            .expect("resolution");
    assert_eq!(resolution.as_deref(), Some("SOURCE_CLEARED"));
    let remaining: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM operator_cases
          WHERE subject_key LIKE $1 || '%' AND state <> 'RESOLVED'",
    )
    .bind(&prefix)
    .fetch_one(&pool)
    .await
    .expect("remaining cases");
    assert!(remaining >= 5, "the older slots stay open for a person");

    cleanup_text(
        &pool,
        &[
            (
                "DELETE FROM operator_case_events WHERE case_id IN (SELECT id FROM operator_cases WHERE subject_key LIKE $1)",
                format!("statement.missing:{source_id}:%"),
            ),
            (
                "DELETE FROM operator_cases WHERE subject_key LIKE $1",
                format!("statement.missing:{source_id}:%"),
            ),
            (
                "DELETE FROM operator_case_events WHERE case_id IN (SELECT id FROM operator_cases WHERE subject_key = $1)",
                format!("statement.schedule_invalid:{invalid_source_id}"),
            ),
            (
                "DELETE FROM operator_cases WHERE subject_key = $1",
                format!("statement.schedule_invalid:{invalid_source_id}"),
            ),
            (
                "DELETE FROM audit_log WHERE action = 'STATEMENT_MISSING' AND entity_id = $1",
                source_id.to_string(),
            ),
        ],
    )
    .await;
    cleanup_uuids(
        &pool,
        &[
            (
                "DELETE FROM reconciliation_runs WHERE id = ANY($1)",
                vec![run_id],
            ),
            (
                "DELETE FROM statement_sources WHERE id = ANY($1)",
                vec![source_id, invalid_source_id],
            ),
            ("DELETE FROM gateways WHERE id = ANY($1)", vec![gateway_id]),
        ],
    )
    .await;
}

// -------------------------------------------------------------------------------------------
// Consistency audit
// -------------------------------------------------------------------------------------------

#[tokio::test]
async fn consistency_audit_reports_drift_and_repairs_only_with_the_flag() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = suffix();
    let started = Utc::now().naive_utc();
    let (fixture, link_id) = seed_link_fixture(
        &pool,
        &suffix,
        3,
        started - chrono::Duration::hours(2),
        started + chrono::Duration::days(1),
    )
    .await;
    let drifted: i64 =
        sqlx::query_scalar("SELECT active_locked_count::bigint FROM payment_links WHERE id = $1")
            .bind(link_id)
            .fetch_one(&pool)
            .await
            .expect("recorded");
    assert_eq!(drifted, 3);

    let report_only = ConsistencyAuditWorker::new(
        pool.clone(),
        ConsistencyAuditConfig {
            link_ids: Some(vec![link_id]),
            ..ConsistencyAuditConfig::default()
        },
    );
    let summary = report_only.tick_once().await.expect("report tick");
    assert_eq!(summary.drifted, 1);
    assert_eq!(summary.repaired, 0);
    let recorded: i64 =
        sqlx::query_scalar("SELECT active_locked_count::bigint FROM payment_links WHERE id = $1")
            .bind(link_id)
            .fetch_one(&pool)
            .await
            .expect("recorded after report");
    assert_eq!(recorded, 3, "report only must not change the counter");
    let case: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM operator_cases WHERE subject_key = $1 AND state <> 'RESOLVED'",
    )
    .bind(format!("link.slot_drift:{link_id}"))
    .fetch_one(&pool)
    .await
    .expect("case");
    assert_eq!(case, 1);

    let repair = ConsistencyAuditWorker::new(
        pool.clone(),
        ConsistencyAuditConfig {
            repair: true,
            link_ids: Some(vec![link_id]),
            ..ConsistencyAuditConfig::default()
        },
    );
    let summary = repair.tick_once().await.expect("repair tick");
    assert_eq!(summary.drifted, 1);
    assert_eq!(summary.repaired, 1);
    let recorded: i64 =
        sqlx::query_scalar("SELECT active_locked_count::bigint FROM payment_links WHERE id = $1")
            .bind(link_id)
            .fetch_one(&pool)
            .await
            .expect("recorded after repair");
    assert_eq!(recorded, 0);
    let audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'PAYMENT_LINK_SLOTS_REPAIRED'
          AND entity_id = $1 AND created_at >= $2",
    )
    .bind(link_id.to_string())
    .bind(started)
    .fetch_one(&pool)
    .await
    .expect("repair audit");
    assert_eq!(audit, 1);

    // A third tick finds no drift.
    let again = repair.tick_once().await.expect("third tick");
    assert_eq!(again.drifted, 0);

    cleanup_text(
        &pool,
        &[
            (
                "DELETE FROM operator_case_events WHERE case_id IN (SELECT id FROM operator_cases WHERE subject_key = $1)",
                format!("link.slot_drift:{link_id}"),
            ),
            (
                "DELETE FROM operator_cases WHERE subject_key = $1",
                format!("link.slot_drift:{link_id}"),
            ),
            (
                "DELETE FROM audit_log WHERE action = 'PAYMENT_LINK_SLOTS_REPAIRED' AND entity_id = $1",
                link_id.to_string(),
            ),
        ],
    )
    .await;
    cleanup_link_fixture(&pool, &fixture, link_id).await;
}

// -------------------------------------------------------------------------------------------
// Retention
// -------------------------------------------------------------------------------------------

#[tokio::test]
async fn retention_deletes_only_rows_before_the_cutoff_and_respects_the_dry_run() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = suffix();
    let mut conn = pool.acquire().await.expect("connection");
    let actor_id = ensure_system_actor(&mut conn).await.expect("system actor");
    drop(conn);
    let started = Utc::now().naive_utc();
    // Ten years of retention keeps every recently created row of the shared test database.
    let retention_days = 3_650_i64;
    let old = started - chrono::Duration::days(4_000);
    let old_notification = Uuid::now_v7();
    let new_notification = Uuid::now_v7();
    for (id, event, created_at) in [
        (
            old_notification,
            format!("test-retention-old-{suffix}"),
            old,
        ),
        (
            new_notification,
            format!("test-retention-new-{suffix}"),
            started,
        ),
    ] {
        sqlx::query(
            "INSERT INTO notifications (id, created_at, updated_at, event_id, address_masked,
                                        address_ciphertext, template_code, channel, lang,
                                        payload_json, status, attempts)
             VALUES ($1, $2, $2, $3, 'in-app', '', 'TEST_RETENTION', 'IN_APP', 'EN', '{}'::jsonb,
                     'SENT', 0)",
        )
        .bind(id)
        .bind(created_at)
        .bind(event)
        .execute(&pool)
        .await
        .expect("notification");
    }
    let old_detail = Uuid::now_v7();
    let new_detail = Uuid::now_v7();
    for (id, entity, created_at) in [
        (old_detail, format!("test-retention-old-{suffix}"), old),
        (new_detail, format!("test-retention-new-{suffix}"), started),
    ] {
        sqlx::query(
            "INSERT INTO detail_change_logs (id, created_at, updated_at, actor_id, entity_type,
                                             entity_id, field_name, source, request_id)
             VALUES ($1, $2, $2, $3, 'TEST', $4, 'field', 'SYSTEM', $5)",
        )
        .bind(id)
        .bind(created_at)
        .bind(actor_id)
        .bind(entity)
        .bind(format!("req-{suffix}"))
        .execute(&pool)
        .await
        .expect("detail change");
    }
    let old_audit = Uuid::now_v7();
    let new_audit = Uuid::now_v7();
    for (id, created_at) in [(old_audit, old), (new_audit, started)] {
        sqlx::query(
            "INSERT INTO audit_log (id, created_at, updated_at, actor_id, role, action,
                                    entity_type, entity_id, before_json, after_json)
             VALUES ($1, $2, $2, $3, 'SYSTEM', 'TEST_RETENTION', 'TEST', $4, '{}'::jsonb,
                     '{}'::jsonb)",
        )
        .bind(id)
        .bind(created_at)
        .bind(actor_id)
        .bind(format!("test-retention-{suffix}"))
        .execute(&pool)
        .await
        .expect("audit row");
    }

    let worker = RetentionWorker::new(
        pool.clone(),
        RetentionConfig {
            retention_days: Some(retention_days),
            batch_size: 100,
            max_batches_per_table: 5,
            ..RetentionConfig::default()
        },
    );
    let summary = worker.tick_once().await.expect("retention tick");
    assert_eq!(summary.notifications, 1);
    assert_eq!(summary.detail_change_logs, 1);
    assert_eq!(summary.audit_log, 1);
    assert_eq!(summary.payment_attempts, 0);
    assert_eq!(summary.journal_entries, 0);
    let notification_exists = |id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM notifications WHERE id = $1)",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("exists")
        }
    };
    assert!(!notification_exists(old_notification).await);
    assert!(notification_exists(new_notification).await);
    let old_detail_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM detail_change_logs WHERE id = $1)")
            .bind(old_detail)
            .fetch_one(&pool)
            .await
            .expect("detail exists");
    assert!(!old_detail_exists);
    let old_audit_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM audit_log WHERE id = $1)")
            .bind(old_audit)
            .fetch_one(&pool)
            .await
            .expect("audit exists");
    assert!(!old_audit_exists);
    let new_audit_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM audit_log WHERE id = $1)")
            .bind(new_audit)
            .fetch_one(&pool)
            .await
            .expect("audit exists");
    assert!(new_audit_exists);

    // The dry run reports the same row and deletes nothing.
    let dry_old = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO notifications (id, created_at, updated_at, event_id, address_masked,
                                    address_ciphertext, template_code, channel, lang, payload_json,
                                    status, attempts)
         VALUES ($1, $2, $2, $3, 'in-app', '', 'TEST_RETENTION', 'IN_APP', 'EN', '{}'::jsonb,
                 'SENT', 0)",
    )
    .bind(dry_old)
    .bind(old)
    .bind(format!("test-retention-dry-{suffix}"))
    .execute(&pool)
    .await
    .expect("dry notification");
    let dry = RetentionWorker::new(
        pool.clone(),
        RetentionConfig {
            retention_days: Some(retention_days),
            dry_run: true,
            batch_size: 100,
            max_batches_per_table: 5,
            ..RetentionConfig::default()
        },
    );
    let summary = dry.tick_once().await.expect("dry tick");
    assert_eq!(summary.notifications, 1);
    assert!(
        notification_exists(dry_old).await,
        "the dry run must delete nothing"
    );

    cleanup_text(
        &pool,
        &[
            (
                "DELETE FROM notifications WHERE event_id LIKE $1",
                format!("test-retention-%-{suffix}"),
            ),
            (
                "DELETE FROM detail_change_logs WHERE entity_id LIKE $1",
                format!("test-retention-%-{suffix}"),
            ),
            (
                "DELETE FROM audit_log WHERE action = 'TEST_RETENTION' AND entity_id = $1",
                format!("test-retention-{suffix}"),
            ),
        ],
    )
    .await;
}
