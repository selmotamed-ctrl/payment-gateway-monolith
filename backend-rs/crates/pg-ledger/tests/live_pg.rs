//! Database-gated integration tests for the ledger persistence layer.
//!
//! They run against `PG_TEST_DATABASE_URL` (default
//! `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`, schema 46) and skip with
//! a message when that database is unreachable, so `cargo test -p pg-ledger` is green on a machine
//! without PostgreSQL.
//!
//! `journal_entries`, `journal_lines`, `journal_entries` and `gl_shard_repairs` are append-only, so
//! every test posts inside its own transaction and **rolls it back**. GL accounts are seeded in the
//! same transaction; nothing this file creates survives the rollback.

use std::collections::BTreeMap;
use std::str::FromStr;
use std::time::Duration;

use pg_domain_ledger::{fnv1a32_utf16, AccountType, Direction, ShardRepairKind};
use pg_ledger::{
    account_lines, apply_shard_repair, entry_lines, live_balances, lock_shards_for,
    lock_wallet_ledger_balance, plan_shard_repair, post_entry, system_equation, verify_shard,
    wallet_ledger_balance, AccountCache, AccountLinesQuery, AccountSelector, ApplyRepairInput,
    JournalTemplate, LedgerError, LedgerLineTemplate, PostContext, PostOptions, RepairMode,
    ShardVerifyStatus,
};
use rust_decimal::Decimal;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

const DEFAULT_TEST_DATABASE_URL: &str =
    "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

/// A dedicated test currency so the seeded `LYD`/`USD`/`EUR` accounts of a populated stack can
/// never satisfy (or shadow) a lookup. Uncommitted rows of concurrent tests are invisible, so every
/// test still resolves only the accounts it seeded itself.
const CURRENCY: &str = "XTS";

async fn test_pool() -> Option<PgPool> {
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
            eprintln!("skip: PostgreSQL not reachable at {url}");
            return None;
        }
    };
    let probe: Result<String, _> = sqlx::query_scalar("SELECT current_setting('server_version')")
        .fetch_one(&pool)
        .await;
    if probe.is_err() {
        eprintln!("skip: PostgreSQL session failed at {url}");
        return None;
    }
    Some(pool)
}

fn dec(raw: &str) -> Decimal {
    Decimal::from_str(raw).expect("test decimal")
}

fn selector(account_type: AccountType) -> AccountSelector {
    AccountSelector::new(account_type)
}

fn ref_id(label: &str) -> String {
    format!("pg-ledger-test-{label}-{}", Uuid::now_v7())
}

async fn insert_account(
    conn: &mut PgConnection,
    account_type: AccountType,
    owner: Option<&str>,
    shard_count: i16,
) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO gl_accounts (id, updated_at, account_type, owner_id, currency, shard_count) \
         VALUES ($1, now(), $2::\"GlAccountType\", $3, $4, $5)",
    )
    .bind(id)
    .bind(account_type.as_str())
    .bind(owner)
    .bind(CURRENCY)
    .bind(shard_count)
    .execute(&mut *conn)
    .await
    .expect("insert GL account");
    id
}

async fn post(
    conn: &mut PgConnection,
    template: &JournalTemplate,
    context: &PostContext,
) -> Result<pg_ledger::PostResult, LedgerError> {
    post_entry(conn, template, &PostOptions::new(context.clone())).await
}

async fn shard_balances(
    conn: &mut PgConnection,
    account_ids: &[Uuid],
) -> BTreeMap<(Uuid, i32), Decimal> {
    let rows: Vec<(Uuid, i16, Decimal)> = sqlx::query_as(
        "SELECT gl_account_id, shard_id, current_balance FROM gl_account_shards \
         WHERE gl_account_id = ANY($1::uuid[])",
    )
    .bind(account_ids)
    .fetch_all(&mut *conn)
    .await
    .expect("read shard balances");
    rows.into_iter()
        .map(|(account, shard, balance)| ((account, i32::from(shard)), balance))
        .collect()
}

async fn journal_sums(
    conn: &mut PgConnection,
    account_ids: &[Uuid],
) -> BTreeMap<(Uuid, i32), Decimal> {
    let rows: Vec<(Uuid, i16, Decimal)> = sqlx::query_as(
        "SELECT gl_account_id, shard_id, \
                COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) \
           FROM journal_lines WHERE gl_account_id = ANY($1::uuid[]) \
          GROUP BY gl_account_id, shard_id",
    )
    .bind(account_ids)
    .fetch_all(&mut *conn)
    .await
    .expect("read journal sums");
    rows.into_iter()
        .map(|(account, shard, total)| ((account, i32::from(shard)), total))
        .collect()
}

async fn assert_shard_parity(conn: &mut PgConnection, account_ids: &[Uuid]) {
    let balances = shard_balances(conn, account_ids).await;
    let sums = journal_sums(conn, account_ids).await;
    for (key, balance) in &balances {
        let journal = sums.get(key).copied().unwrap_or(Decimal::ZERO);
        assert_eq!(
            *balance, journal,
            "shard {key:?} balance differs from its journal lines"
        );
    }
}

async fn line_shard(conn: &mut PgConnection, entry_id: Uuid, account: Uuid) -> (i32, i64) {
    let row: (i16, i64) = sqlx::query_as(
        "SELECT shard_id, shard_seq FROM journal_lines WHERE entry_id = $1 AND gl_account_id = $2",
    )
    .bind(entry_id)
    .bind(account)
    .fetch_one(&mut *conn)
    .await
    .expect("read line shard");
    (i32::from(row.0), row.1)
}

// ---------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn posts_a_balanced_entry_and_projects_the_shards() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 8).await;
    let provider = insert_account(&mut tx, AccountType::ProviderFeeExpense, None, 4).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;
    let income = insert_account(&mut tx, AccountType::PlatformIncome, None, 8).await;

    let reference = ref_id("balanced");
    let template = JournalTemplate::new("ADJUSTMENT", &reference, "balanced posting", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("99.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::debit(
            dec("1.0000"),
            selector(AccountType::ProviderFeeExpense),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("97.0000"),
            selector(AccountType::MerchantWallet),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("3.0000"),
            selector(AccountType::PlatformIncome),
        ));
    let context = PostContext::new()
        .with_merchant(&owner)
        .with_currency(CURRENCY);
    let result = post(&mut tx, &template, &context).await.expect("post");

    assert!(result.created);
    assert!(!result.idempotent);
    assert_eq!(result.entry.ref_type, "ADJUSTMENT");
    assert_eq!(result.entry.ref_id, reference);
    assert_eq!(result.entry.description, "balanced posting");
    assert_eq!(result.lines.len(), 4);
    assert!(result.lines.iter().all(|line| line.shard_seq >= 1));
    assert_eq!(
        result
            .lines
            .iter()
            .map(|line| line.gl_account_id)
            .collect::<Vec<_>>(),
        vec![treasury, provider, wallet, income],
        "the lines keep template order"
    );

    let lines = entry_lines(&mut tx, result.entry.id)
        .await
        .expect("entry lines");
    assert_eq!(lines.len(), 4);

    let accounts = [treasury, provider, wallet, income];
    assert_shard_parity(&mut tx, &accounts).await;

    // The wallet line is a credit and the wallet is credit-natural: shards store it negative.
    let wallet_shards = shard_balances(&mut tx, &[wallet]).await;
    assert_eq!(
        wallet_shards.values().copied().sum::<Decimal>(),
        dec("-97.0000")
    );

    let balances = live_balances(&mut tx, Some(&accounts))
        .await
        .expect("live balances");
    let by_account: BTreeMap<Uuid, Decimal> = balances
        .iter()
        .map(|row| (row.account_id, row.balance))
        .collect();
    assert_eq!(by_account[&treasury], dec("99.0000"));
    assert_eq!(by_account[&provider], dec("1.0000"));
    assert_eq!(by_account[&wallet], dec("97.0000"));
    assert_eq!(by_account[&income], dec("3.0000"));
    assert!(balances.iter().all(|row| row.source == "shards"));

    let equation = system_equation(&mut tx, Some(&accounts))
        .await
        .expect("equation");
    assert!(equation.ok, "drift {}", equation.drift);
    assert_eq!(equation.left, dec("99.0000"));
    assert_eq!(equation.right, dec("99.0000"));

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn rejects_a_globally_unbalanced_template_before_writing() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 4).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;

    let reference = ref_id("unbalanced");
    let template = JournalTemplate::new("ADJUSTMENT", &reference, "unbalanced", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("100.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("90.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let error = post(
        &mut tx,
        &template,
        &PostContext::new()
            .with_merchant(&owner)
            .with_currency(CURRENCY),
    )
    .await
    .expect_err("unbalanced template");
    assert_eq!(error.code(), "UNBALANCED_JOURNAL_ENTRY");
    assert!(matches!(error, LedgerError::Template(_)));

    let entries: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM journal_entries WHERE ref_type = 'ADJUSTMENT' AND ref_id = $1",
    )
    .bind(&reference)
    .fetch_one(&mut *tx)
    .await
    .expect("count entries");
    assert_eq!(entries, 0);
    let lines: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM journal_lines WHERE gl_account_id = ANY($1::uuid[])",
    )
    .bind([treasury, wallet].as_slice())
    .fetch_one(&mut *tx)
    .await
    .expect("count lines");
    assert_eq!(lines, 0);

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn replays_are_idempotent_and_do_not_advance_sequences() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 8).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;
    let reference = ref_id("replay");
    let template = JournalTemplate::new("ADJUSTMENT", &reference, "replay", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("50.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("50.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let context = PostContext::new()
        .with_merchant(&owner)
        .with_currency(CURRENCY);

    let first = post(&mut tx, &template, &context)
        .await
        .expect("first post");
    let before = shard_balances(&mut tx, &[treasury, wallet]).await;
    let first_lines = entry_lines(&mut tx, first.entry.id).await.expect("lines");
    assert_eq!(first_lines.len(), 2);

    let second = post(&mut tx, &template, &context).await.expect("replay");
    assert!(!second.created);
    assert!(second.idempotent);
    assert_eq!(second.entry.id, first.entry.id);
    assert!(second.lines.is_empty());
    assert_eq!(second.entry.description, first.entry.description);

    let after = shard_balances(&mut tx, &[treasury, wallet]).await;
    assert_eq!(before, after, "a replay must not move a shard");
    let replay_lines = entry_lines(&mut tx, first.entry.id).await.expect("lines");
    assert_eq!(replay_lines.len(), 2, "a replay must not duplicate lines");

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn sequences_are_gapless_per_shard() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 16).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;
    let context = PostContext::new()
        .with_merchant(&owner)
        .with_currency(CURRENCY);

    for amount in ["10.0000", "20.0000", "30.0000"] {
        let reference = ref_id("sequence");
        let template = JournalTemplate::new("ADJUSTMENT", &reference, "sequence", CURRENCY)
            .with_line(LedgerLineTemplate::debit(
                dec(amount),
                selector(AccountType::Treasury),
            ))
            .with_line(LedgerLineTemplate::credit(
                dec(amount),
                selector(AccountType::MerchantWallet),
            ));
        post(&mut tx, &template, &context).await.expect("post");
    }

    let rows: Vec<(Uuid, i16, i64)> = sqlx::query_as(
        "SELECT gl_account_id, shard_id, shard_seq FROM journal_lines \
         WHERE gl_account_id = $1::uuid ORDER BY shard_id, shard_seq",
    )
    .bind(treasury)
    .fetch_all(&mut *tx)
    .await
    .expect("read sequences");
    assert_eq!(rows.len(), 3);

    let mut per_shard: BTreeMap<i16, Vec<i64>> = BTreeMap::new();
    for (_, shard, seq) in rows {
        per_shard.entry(shard).or_default().push(seq);
    }
    for (shard, seqs) in &per_shard {
        let expected: Vec<i64> = (1..=seqs.len() as i64).collect();
        assert_eq!(*seqs, expected, "shard {shard} sequence is not gapless");
    }

    let high_water: Vec<(i16, i64)> = sqlx::query_as(
        "SELECT shard_id, line_seq FROM gl_account_shards WHERE gl_account_id = $1::uuid",
    )
    .bind(treasury)
    .fetch_all(&mut *tx)
    .await
    .expect("read high water");
    for (shard, line_seq) in high_water {
        let count = per_shard.get(&shard).map_or(0, Vec::len) as i64;
        assert_eq!(
            line_seq, count,
            "shard {shard} high-water differs from its lines"
        );
    }

    assert_shard_parity(&mut tx, &[treasury, wallet]).await;
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn multi_line_and_multi_shard_postings_fold_into_one_upsert() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 8).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 4).await;
    let income = insert_account(&mut tx, AccountType::PlatformIncome, None, 8).await;
    let reference = ref_id("fold");
    let template = JournalTemplate::new("ADJUSTMENT", &reference, "fold", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("40.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::debit(
            dec("60.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("97.0000"),
            selector(AccountType::MerchantWallet),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("3.0000"),
            selector(AccountType::PlatformIncome),
        ));
    let context = PostContext::new()
        .with_merchant(&owner)
        .with_currency(CURRENCY);
    let result = post(&mut tx, &template, &context).await.expect("post");

    // The two treasury lines share the same (account, ref) shard: one folded bump, two numbers.
    let treasury_lines: Vec<(i16, i64, Decimal)> = sqlx::query_as(
        "SELECT shard_id, shard_seq, amount FROM journal_lines \
         WHERE entry_id = $1::uuid AND gl_account_id = $2::uuid ORDER BY shard_seq",
    )
    .bind(result.entry.id)
    .bind(treasury)
    .fetch_all(&mut *tx)
    .await
    .expect("treasury lines");
    assert_eq!(treasury_lines.len(), 2);
    assert_eq!(treasury_lines[0].0, treasury_lines[1].0);
    assert_eq!(treasury_lines[0].1, 1);
    assert_eq!(treasury_lines[1].1, 2);
    assert_eq!(treasury_lines[0].2 + treasury_lines[1].2, dec("100.0000"));

    let high_water: (i64,) = sqlx::query_as(
        "SELECT line_seq FROM gl_account_shards WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(treasury_lines[0].0)
    .fetch_one(&mut *tx)
    .await
    .expect("high water");
    assert_eq!(high_water.0, 2);

    // Three different (account, shard) targets were bumped in the one upsert.
    let bumped: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gl_account_shards WHERE gl_account_id = ANY($1::uuid[]) AND line_seq > 0",
    )
    .bind([treasury, wallet, income].as_slice())
    .fetch_one(&mut *tx)
    .await
    .expect("bumped shards");
    assert!(bumped >= 3);

    assert_shard_parity(&mut tx, &[treasury, wallet, income]).await;
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn wallet_debits_route_to_shard_zero() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 8).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 4).await;
    let context = PostContext::new()
        .with_merchant(&owner)
        .with_currency(CURRENCY);

    // A debit lowers the wallet's natural (credit) balance: always shard 0.
    let debit_ref = ref_id("wallet-debit");
    let debit_template = JournalTemplate::new("ADJUSTMENT", &debit_ref, "wallet debit", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("10.0000"),
            selector(AccountType::MerchantWallet),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("10.0000"),
            selector(AccountType::Treasury),
        ));
    let debit = post(&mut tx, &debit_template, &context)
        .await
        .expect("post");
    let (debit_shard, _) = line_shard(&mut tx, debit.entry.id, wallet).await;
    assert_eq!(debit_shard, 0, "a wallet debit must use shard 0");

    // A credit spreads by `fnv1a(refId) % width`; pick a reference that is not shard 0 to prove it.
    let credit_ref = (0..10_000)
        .map(|attempt| format!("wallet-credit-{attempt}-{}", Uuid::now_v7()))
        .find(|candidate| fnv1a32_utf16(candidate) % 4 == 2)
        .expect("a reference hashing to shard 2");
    let credit_template =
        JournalTemplate::new("ADJUSTMENT", &credit_ref, "wallet credit", CURRENCY)
            .with_line(LedgerLineTemplate::debit(
                dec("10.0000"),
                selector(AccountType::Treasury),
            ))
            .with_line(LedgerLineTemplate::credit(
                dec("10.0000"),
                selector(AccountType::MerchantWallet),
            ));
    let credit = post(&mut tx, &credit_template, &context)
        .await
        .expect("post");
    let (credit_shard, _) = line_shard(&mut tx, credit.entry.id, wallet).await;
    assert_eq!(
        credit_shard, 2,
        "a wallet credit spreads like any other line"
    );

    assert_shard_parity(&mut tx, &[treasury, wallet]).await;
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn missing_account_returns_gl_account_not_found() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;
    let reference = ref_id("missing-account");
    let template = JournalTemplate::new("ADJUSTMENT", &reference, "missing", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("10.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("10.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let error = post(
        &mut tx,
        &template,
        &PostContext::new()
            .with_merchant(&owner)
            .with_currency(CURRENCY),
    )
    .await
    .expect_err("no treasury account exists");
    assert!(matches!(
        error,
        LedgerError::AccountNotFound {
            account_type: AccountType::Treasury
        }
    ));
    assert_eq!(error.code(), "GL_ACCOUNT_NOT_FOUND");

    let lines: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM journal_lines WHERE gl_account_id = $1::uuid")
            .bind(wallet)
            .fetch_one(&mut *tx)
            .await
            .expect("count lines");
    assert_eq!(lines, 0);

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn explicit_and_context_accounts_win_over_the_lookup() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let context_treasury = insert_account(&mut tx, AccountType::Treasury, None, 4).await;
    let explicit_treasury = insert_account(&mut tx, AccountType::Treasury, None, 4).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;

    // Context override: wins over the scoped/fallback lookup (the fallback would be the lowest id).
    let context_ref = ref_id("context-override");
    let context_template = JournalTemplate::new("ADJUSTMENT", &context_ref, "context", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("5.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("5.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let context = PostContext::new()
        .with_merchant(&owner)
        .with_currency(CURRENCY)
        .with_account(AccountType::Treasury, context_treasury);
    let result = post(&mut tx, &context_template, &context)
        .await
        .expect("post");
    let debit_account: Uuid = sqlx::query_scalar(
        "SELECT gl_account_id FROM journal_lines WHERE entry_id = $1::uuid AND direction = 'DEBIT'",
    )
    .bind(result.entry.id)
    .fetch_one(&mut *tx)
    .await
    .expect("debit line");
    assert_eq!(debit_account, context_treasury);

    // An explicit selector id wins over the context override.
    let explicit_ref = ref_id("explicit-override");
    let explicit_template = JournalTemplate::new("ADJUSTMENT", &explicit_ref, "explicit", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("6.0000"),
            selector(AccountType::Treasury).with_account_id(explicit_treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("6.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let result = post(&mut tx, &explicit_template, &context)
        .await
        .expect("post");
    let debit_account: Uuid = sqlx::query_scalar(
        "SELECT gl_account_id FROM journal_lines WHERE entry_id = $1::uuid AND direction = 'DEBIT'",
    )
    .bind(result.entry.id)
    .fetch_one(&mut *tx)
    .await
    .expect("debit line");
    assert_eq!(debit_account, explicit_treasury);

    assert_shard_parity(&mut tx, &[context_treasury, explicit_treasury, wallet]).await;
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_cached_scoped_hit_cannot_hide_a_later_wallet_but_a_fallback_is_never_cached() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");
    let cache = AccountCache::new();

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 4).await;
    let fallback_wallet = insert_account(&mut tx, AccountType::MerchantWallet, None, 1).await;
    let owner_a = format!("merchant-a-{}", Uuid::now_v7());
    let owner_b = format!("merchant-b-{}", Uuid::now_v7());
    let context_a = PostContext::new()
        .with_merchant(&owner_a)
        .with_currency(CURRENCY);
    let template_for = |label: &str| {
        JournalTemplate::new("ADJUSTMENT", ref_id(label), label, CURRENCY)
            .with_line(LedgerLineTemplate::debit(
                dec("4.0000"),
                selector(AccountType::Treasury),
            ))
            .with_line(LedgerLineTemplate::credit(
                dec("4.0000"),
                selector(AccountType::MerchantWallet),
            ))
    };

    // No scoped wallet exists yet: the platform fallback is used and must not be remembered.
    let first = post_entry(
        &mut tx,
        &template_for("cache-1"),
        &PostOptions::new(context_a.clone()).with_cache(&cache),
    )
    .await
    .expect("post");
    let wallet_line = |result: &pg_ledger::PostResult| {
        result
            .lines
            .iter()
            .find(|line| line.direction == Direction::Credit)
            .map(|line| line.gl_account_id)
            .expect("wallet line")
    };
    assert_eq!(wallet_line(&first), fallback_wallet);

    // A scoped wallet created afterwards must take over even though the fallback was just resolved.
    let scoped_a = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner_a), 1).await;
    let second = post_entry(
        &mut tx,
        &template_for("cache-2"),
        &PostOptions::new(context_a.clone()).with_cache(&cache),
    )
    .await
    .expect("post");
    assert_eq!(wallet_line(&second), scoped_a);

    // A different merchant resolves its own scope: the cached entry is keyed by owner.
    let context_b = PostContext::new()
        .with_merchant(&owner_b)
        .with_currency(CURRENCY);
    let third = post_entry(
        &mut tx,
        &template_for("cache-3"),
        &PostOptions::new(context_b).with_cache(&cache),
    )
    .await
    .expect("post");
    assert_eq!(wallet_line(&third), fallback_wallet);

    assert_shard_parity(&mut tx, &[treasury, fallback_wallet, scoped_a]).await;
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn cashout_locks_and_balance_reads_use_the_wallet_projection() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 8).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 4).await;
    let income = insert_account(&mut tx, AccountType::PlatformIncome, None, 8).await;
    let context = PostContext::new()
        .with_merchant(&owner)
        .with_currency(CURRENCY);

    let credit_ref = ref_id("cashout-credit");
    let credit = JournalTemplate::new("ADJUSTMENT", &credit_ref, "credit", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("100.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("97.0000"),
            selector(AccountType::MerchantWallet),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("3.0000"),
            selector(AccountType::PlatformIncome),
        ));
    post(&mut tx, &credit, &context).await.expect("credit");

    // The TS cash-out order: advisory lock → pre-lock the shard rows of the posting → read.
    let balance = lock_wallet_ledger_balance(&mut tx, wallet)
        .await
        .expect("wallet balance");
    assert_eq!(balance, dec("97.0000"));

    let cashout_ref = ref_id("cashout");
    let cashout = JournalTemplate::new("ADJUSTMENT", &cashout_ref, "cash-out", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("50.0000"),
            selector(AccountType::MerchantWallet),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("50.0000"),
            selector(AccountType::Treasury),
        ));
    lock_shards_for(&mut tx, &cashout, &context, None)
        .await
        .expect("pre-lock shards");
    assert_eq!(
        wallet_ledger_balance(&mut tx, wallet)
            .await
            .expect("balance"),
        dec("97.0000"),
        "the pre-lock must not change the balance"
    );
    post(&mut tx, &cashout, &context).await.expect("cash-out");
    assert_eq!(
        wallet_ledger_balance(&mut tx, wallet)
            .await
            .expect("balance"),
        dec("47.0000")
    );

    // The wallet debit went to shard 0 even though the wallet is four shards wide.
    let (shard, _) = sqlx::query_as::<_, (i16, i64)>(
        "SELECT shard_id, shard_seq FROM journal_lines \
         WHERE gl_account_id = $1::uuid AND direction = 'DEBIT' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(wallet)
    .fetch_one(&mut *tx)
    .await
    .expect("wallet debit");
    assert_eq!(shard, 0);

    assert_shard_parity(&mut tx, &[treasury, wallet, income]).await;
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------------------------
// Reads and proofs
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn account_and_entry_lines_are_bounded_and_totalled() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 8).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;
    let reference = ref_id("lines");
    let template = JournalTemplate::new("ADJUSTMENT", &reference, "lines", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("30.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("30.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let result = post(
        &mut tx,
        &template,
        &PostContext::new()
            .with_merchant(&owner)
            .with_currency(CURRENCY),
    )
    .await
    .expect("post");

    let around = AccountLinesQuery {
        from: Some(result.entry.created_at - chrono::Duration::minutes(1)),
        to: Some(result.entry.created_at + chrono::Duration::minutes(1)),
        ..AccountLinesQuery::default()
    };
    let page = account_lines(&mut tx, treasury, &around)
        .await
        .expect("lines");
    assert_eq!(page.lines.len(), 1);
    assert_eq!(page.lines[0].direction, Direction::Debit);
    assert_eq!(page.lines[0].ref_id, reference);
    assert_eq!(page.totals.line_count, 1);
    assert_eq!(page.totals.total_debit, dec("30.0000"));
    assert_eq!(page.totals.total_credit, Decimal::ZERO);
    assert_eq!(page.totals.net_debit, dec("30.0000"));

    // A window that ends before the posting prunes it away.
    let before = AccountLinesQuery {
        from: None,
        to: Some(result.entry.created_at - chrono::Duration::minutes(10)),
        ..AccountLinesQuery::default()
    };
    let empty = account_lines(&mut tx, treasury, &before)
        .await
        .expect("lines");
    assert!(empty.lines.is_empty());
    assert_eq!(empty.totals.line_count, 0);

    // The entry's own `created_at` bound returns every line of the entry.
    let lines = entry_lines(&mut tx, result.entry.id)
        .await
        .expect("entry lines");
    assert_eq!(lines.len(), 2);
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.gl_account_id == wallet)
            .count(),
        1
    );

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn verify_shard_detects_gap_and_parity_without_moving_the_checkpoint() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 8).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let _wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;
    let reference = ref_id("verify");
    let template = JournalTemplate::new("ADJUSTMENT", &reference, "verify", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("25.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("25.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let result = post(
        &mut tx,
        &template,
        &PostContext::new()
            .with_merchant(&owner)
            .with_currency(CURRENCY),
    )
    .await
    .expect("post");
    let (shard, _) = line_shard(&mut tx, result.entry.id, treasury).await;

    let verified = verify_shard(&mut tx, treasury, shard)
        .await
        .expect("verify");
    assert_eq!(verified.status, ShardVerifyStatus::Advanced);
    assert_eq!(verified.lines_covered, 1);
    assert!(verified.drift.is_zero());

    let checkpoints: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gl_shard_checkpoints WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .fetch_one(&mut *tx)
    .await
    .expect("checkpoint count");
    assert_eq!(checkpoints, 0, "verify_shard must not move a checkpoint");

    sqlx::query(
        "UPDATE gl_account_shards SET current_balance = current_balance + 1 \
         WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .execute(&mut *tx)
    .await
    .expect("corrupt balance");
    let parity = verify_shard(&mut tx, treasury, shard)
        .await
        .expect("verify");
    assert_eq!(parity.status, ShardVerifyStatus::Parity);
    assert_eq!(parity.drift, dec("1.0000"));

    sqlx::query(
        "UPDATE gl_account_shards SET current_balance = current_balance - 1, line_seq = line_seq + 1 \
         WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .execute(&mut *tx)
    .await
    .expect("damage sequence");
    let gap = verify_shard(&mut tx, treasury, shard)
        .await
        .expect("verify");
    assert_eq!(gap.status, ShardVerifyStatus::Gap);
    assert_eq!(gap.lines_found, 1);
    assert_eq!(gap.line_seq - gap.previous_seq, 2);

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn system_equation_reports_a_corrupted_shard() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 8).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;
    let reference = ref_id("equation");
    let template = JournalTemplate::new("ADJUSTMENT", &reference, "equation", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("40.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("40.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let result = post(
        &mut tx,
        &template,
        &PostContext::new()
            .with_merchant(&owner)
            .with_currency(CURRENCY),
    )
    .await
    .expect("post");
    let (shard, _) = line_shard(&mut tx, result.entry.id, treasury).await;

    let healthy = system_equation(&mut tx, Some(&[treasury, wallet]))
        .await
        .expect("equation");
    assert!(healthy.ok);
    assert!(healthy.drift.is_zero());

    sqlx::query(
        "UPDATE gl_account_shards SET current_balance = current_balance + 1 \
         WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .execute(&mut *tx)
    .await
    .expect("corrupt");

    let corrupted = system_equation(&mut tx, Some(&[treasury, wallet]))
        .await
        .expect("equation");
    assert!(!corrupted.ok);
    assert_eq!(corrupted.drift, dec("1.0000"));
    assert_eq!(corrupted.left, dec("41.0000"));
    assert_eq!(corrupted.right, dec("40.0000"));

    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn repair_recomputes_parity_drift_with_cas_history_and_approval_gate() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let treasury = insert_account(&mut tx, AccountType::Treasury, None, 8).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let _wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;
    let reference = ref_id("repair");
    let template = JournalTemplate::new("ADJUSTMENT", &reference, "repair", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("100.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("100.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let result = post(
        &mut tx,
        &template,
        &PostContext::new()
            .with_merchant(&owner)
            .with_currency(CURRENCY),
    )
    .await
    .expect("post");
    let (shard, line_seq) = line_shard(&mut tx, result.entry.id, treasury).await;

    sqlx::query(
        "UPDATE gl_account_shards SET current_balance = current_balance + 5 \
         WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .execute(&mut *tx)
    .await
    .expect("corrupt");

    let plan = plan_shard_repair(&mut tx, treasury, shard)
        .await
        .expect("plan");
    assert!(plan.needs_repair);
    assert_eq!(plan.kind, Some(ShardRepairKind::Recompute));
    assert!(plan.sequence_intact);
    assert_eq!(plan.delta, dec("-5.0000"));
    assert_eq!(plan.plan_hash.len(), 64);

    let applied = apply_shard_repair(
        &mut tx,
        &ApplyRepairInput {
            gl_account_id: treasury,
            shard_id: shard,
            mode: RepairMode::Manual,
            allowed_kinds: vec![ShardRepairKind::Recompute],
            expected_plan_hash: Some(plan.plan_hash.clone()),
            reason: "test repair".to_owned(),
            actor_id: None,
            approval_request_id: None,
        },
    )
    .await
    .expect("apply");
    assert!(applied.repaired);
    assert!(!applied.stale);
    assert!(applied.repair_id.is_some());

    let balances = shard_balances(&mut tx, &[treasury]).await;
    assert_eq!(balances[&(treasury, shard)], dec("100.0000"));
    let checkpoint: (Decimal, i64, i64, String) = sqlx::query_as(
        "SELECT checkpoint_balance, checkpoint_seq, baseline_seq, status FROM gl_shard_checkpoints \
         WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .fetch_one(&mut *tx)
    .await
    .expect("checkpoint");
    assert_eq!(checkpoint.0, dec("100.0000"));
    assert_eq!(checkpoint.1, line_seq);
    assert_eq!(checkpoint.2, 0);
    assert_eq!(checkpoint.3, "OK");

    let repairs: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT kind, mode, plan_hash FROM gl_shard_repairs \
         WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .fetch_all(&mut *tx)
    .await
    .expect("repair history");
    assert_eq!(repairs.len(), 1);
    assert_eq!(repairs[0].0, "RECOMPUTE");
    assert_eq!(repairs[0].1, "MANUAL");
    assert_eq!(repairs[0].2, plan.plan_hash);

    let repaired = verify_shard(&mut tx, treasury, shard)
        .await
        .expect("verify");
    assert_eq!(repaired.status, ShardVerifyStatus::Noop);
    let healthy = plan_shard_repair(&mut tx, treasury, shard)
        .await
        .expect("plan");
    assert!(!healthy.needs_repair);

    // A plan hash that no longer matches is refused without writing.
    sqlx::query(
        "UPDATE gl_account_shards SET current_balance = current_balance + 1 \
         WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .execute(&mut *tx)
    .await
    .expect("corrupt again");
    let previewed = plan_shard_repair(&mut tx, treasury, shard)
        .await
        .expect("plan");
    sqlx::query(
        "UPDATE gl_account_shards SET current_balance = current_balance + 1 \
         WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .execute(&mut *tx)
    .await
    .expect("corrupt once more");
    let changed = apply_shard_repair(
        &mut tx,
        &ApplyRepairInput {
            gl_account_id: treasury,
            shard_id: shard,
            mode: RepairMode::Manual,
            allowed_kinds: vec![ShardRepairKind::Recompute],
            expected_plan_hash: Some(previewed.plan_hash),
            reason: "stale preview".to_owned(),
            actor_id: None,
            approval_request_id: None,
        },
    )
    .await
    .expect_err("plan changed");
    assert!(matches!(changed, LedgerError::RepairPlanChanged));
    assert_eq!(changed.code(), "SHARD_REPAIR_PLAN_CHANGED");

    // A damaged sequence is refused for a caller that may only RECOMPUTE.
    sqlx::query(
        "UPDATE gl_account_shards SET current_balance = 100.0000, line_seq = line_seq + 1 \
         WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .execute(&mut *tx)
    .await
    .expect("damage sequence");
    let damaged = plan_shard_repair(&mut tx, treasury, shard)
        .await
        .expect("plan");
    assert_eq!(damaged.kind, Some(ShardRepairKind::Rebaseline));
    let refused = apply_shard_repair(
        &mut tx,
        &ApplyRepairInput {
            gl_account_id: treasury,
            shard_id: shard,
            mode: RepairMode::Manual,
            allowed_kinds: vec![ShardRepairKind::Recompute],
            expected_plan_hash: None,
            reason: "needs approval".to_owned(),
            actor_id: None,
            approval_request_id: None,
        },
    )
    .await
    .expect_err("needs approval");
    assert!(matches!(refused, LedgerError::RepairNeedsApproval));
    assert_eq!(refused.code(), "SHARD_REPAIR_NEEDS_APPROVAL");

    let repair_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gl_shard_repairs WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint",
    )
    .bind(treasury)
    .bind(shard as i16)
    .fetch_one(&mut *tx)
    .await
    .expect("repair count");
    assert_eq!(repair_count, 1, "a refused apply writes no history row");

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn outbox_is_off_by_default_and_opt_in() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = pool.begin().await.expect("transaction");

    let _treasury = insert_account(&mut tx, AccountType::Treasury, None, 4).await;
    let owner = format!("merchant-{}", Uuid::now_v7());
    let _wallet = insert_account(&mut tx, AccountType::MerchantWallet, Some(&owner), 1).await;
    let context = PostContext::new()
        .with_merchant(&owner)
        .with_currency(CURRENCY);

    let quiet = JournalTemplate::new("ADJUSTMENT", ref_id("outbox-off"), "quiet", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("1.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("1.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let first = post(&mut tx, &quiet, &context).await.expect("post");
    let quiet_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = $1")
            .bind(first.entry.id.to_string())
            .fetch_one(&mut *tx)
            .await
            .expect("count outbox");
    assert_eq!(quiet_rows, 0, "the outbox event is off by default");

    let loud = JournalTemplate::new("ADJUSTMENT", ref_id("outbox-on"), "loud", CURRENCY)
        .with_line(LedgerLineTemplate::debit(
            dec("2.0000"),
            selector(AccountType::Treasury),
        ))
        .with_line(LedgerLineTemplate::credit(
            dec("2.0000"),
            selector(AccountType::MerchantWallet),
        ));
    let second = post_entry(&mut tx, &loud, &PostOptions::new(context).with_outbox())
        .await
        .expect("post");
    let row: (String, String, String) = sqlx::query_as(
        "SELECT topic, aggregate_type, payload_json->>'entryId' FROM outbox_events \
         WHERE aggregate_id = $1",
    )
    .bind(second.entry.id.to_string())
    .fetch_one(&mut *tx)
    .await
    .expect("outbox row");
    assert_eq!(row.0, "ledger.entry_posted");
    assert_eq!(row.1, "JOURNAL_ENTRY");
    assert_eq!(row.2, second.entry.id.to_string());

    tx.rollback().await.expect("rollback");
}
