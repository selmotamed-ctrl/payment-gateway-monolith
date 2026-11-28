//! The posting pipeline: entry, account resolution, shard reservation, journal lines, outbox.
//!
//! Port of `LedgerPoster.post` and its raw-SQL write (`core-back/engine/ledger/LedgerPoster.ts:790-972`)
//! combined with the shard writer (`core-back/lib/storageEngine/ledgerShardWriter.ts`) and the
//! cash-out lock helpers (`core-back/lib/cashoutBalance.ts`, `ledgerShardWriter.ts:107-129`).
//!
//! The pipeline is exactly the TypeScript one (design chapter 2 §14):
//!
//! 1. `validate_template` (amounts > 0, Σdebit = Σcredit);
//! 2. `INSERT journal_entries … ON CONFLICT (ref_type, ref_id) DO NOTHING RETURNING`; a replay reads
//!    the existing entry and returns it with **empty lines** and no payload comparison;
//! 3. resolve every GL account (explicit id → context override → scoped → platform fallback →
//!    `GL_ACCOUNT_NOT_FOUND`);
//! 4. route each line to its shard (`fnv1a(refId) % width`; wallet debits to shard 0);
//! 5. fold per `(account, shard)`, sorted, one `INSERT … SELECT FROM unnest(...) ON CONFLICT DO
//!    UPDATE` that adds the signed delta and the line count to `line_seq` and returns the new
//!    high-water marks;
//! 6. insert the lines with `shard_seq = high_water - n + j` in one `unnest` statement and v7 ids;
//! 7. optionally emit `ledger.entry_posted` (off by default).
//!
//! Everything runs on the caller's transaction: the poster never begins or commits one, so the
//! money movement and the state change that authorises it commit together (chapter 2 §17).

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::NaiveDateTime;
use pg_domain_ledger::{
    assign_sequences, fold_lines, route_validated_lines, validate_template, Direction, LineRoute,
    ShardFold, ValidatedLine,
};
use rust_decimal::Decimal;
use sqlx::{FromRow, PgConnection, Row};
use uuid::Uuid;

use crate::accounts::{resolve_account_ids, AccountCache};
use crate::error::LedgerError;
use crate::template::{check_ledger_raw_sql, money4, JournalTemplate, PostContext, PostOptions};

/// Default number of entries a resolved-account cache may hold (`LedgerPoster.ts:202`).
pub use crate::accounts::ACCOUNT_CACHE_MAX_ENTRIES;
/// Default TTL of the scoped account cache (`LedgerPoster.ts:195`).
pub use crate::accounts::ACCOUNT_CACHE_TTL;

/// `journal_entries` as the poster returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalEntry {
    pub id: Uuid,
    pub ref_type: String,
    pub ref_id: String,
    pub description: String,
    /// `timestamp(3)` without time zone, UTC by convention (the pool pins `timezone=UTC`).
    pub created_at: NaiveDateTime,
}

/// One posted `journal_lines` row.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalLine {
    pub id: Uuid,
    pub entry_id: Uuid,
    pub gl_account_id: Uuid,
    pub direction: Direction,
    pub amount: Decimal,
    pub shard_id: i32,
    pub shard_seq: i64,
}

/// Port of `LedgerPostResult` (`LedgerPoster.ts:162-167`).
#[derive(Debug, Clone, PartialEq)]
pub struct PostResult {
    pub entry: JournalEntry,
    pub lines: Vec<JournalLine>,
    /// `true` when this call inserted the entry and its lines.
    pub created: bool,
    /// `true` when the reference was already posted: `entry` is the existing entry and `lines` is
    /// empty (no payload comparison, exactly like TS).
    pub idempotent: bool,
}

/// `LEDGER_RAW_SQL=false` is refused once per process; every later post reuses the answer.
static RAW_SQL_ALLOWED: OnceLock<bool> = OnceLock::new();

/// The pure kill-switch parser plus the process-wide refusal used by [`post_entry`].
fn ensure_raw_sql_enabled() -> Result<(), LedgerError> {
    let allowed = *RAW_SQL_ALLOWED.get_or_init(|| {
        let value = std::env::var("LEDGER_RAW_SQL").ok();
        check_ledger_raw_sql(value.as_deref()).is_ok()
    });
    if allowed {
        Ok(())
    } else {
        Err(LedgerError::RawSqlDisabled)
    }
}

const ENTRY_INSERT: &str =
    "INSERT INTO journal_entries (id, updated_at, ref_type, ref_id, description) \
     VALUES ($1, now(), $2::\"JournalRefType\", $3, $4) \
     ON CONFLICT (ref_type, ref_id) DO NOTHING \
     RETURNING id, created_at, description";

const ENTRY_SELECT: &str = "SELECT id, created_at, description FROM journal_entries \
     WHERE ref_type = $1::\"JournalRefType\" AND ref_id = $2 LIMIT 1";

const SHARD_UPSERT: &str = "INSERT INTO gl_account_shards AS s \
       (gl_account_id, shard_id, current_balance, line_seq, updated_at) \
     SELECT t.gl_account_id, t.shard_id, t.delta, t.n, now() \
       FROM unnest($1::uuid[], $2::smallint[], $3::numeric[], $4::bigint[]) AS t(gl_account_id, shard_id, delta, n) \
      ORDER BY t.gl_account_id, t.shard_id \
     ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET \
       current_balance = s.current_balance + EXCLUDED.current_balance, \
       line_seq = s.line_seq + EXCLUDED.line_seq, \
       updated_at = now() \
     RETURNING s.gl_account_id, s.shard_id, s.line_seq";

const LINE_INSERT: &str = "INSERT INTO journal_lines \
       (id, updated_at, entry_id, gl_account_id, direction, amount, shard_id, shard_seq) \
     SELECT t.id, now(), $1::uuid, t.account_id, t.direction::\"JournalDirection\", t.amount, t.shard_id, t.shard_seq \
       FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::numeric[], $6::smallint[], $7::bigint[]) \
            AS t(id, account_id, direction, amount, shard_id, shard_seq)";

const OUTBOX_INSERT: &str =
    "INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, merchant_id, payload_json) \
     VALUES ($1, $2, $3, NULL, $4::jsonb)";

#[derive(Debug, Clone, FromRow)]
struct EntryRow {
    id: Uuid,
    created_at: NaiveDateTime,
    description: String,
}

#[derive(Debug, Clone, FromRow)]
struct ShardRow {
    gl_account_id: Uuid,
    shard_id: i16,
    line_seq: i64,
}

#[derive(Debug, Clone, FromRow)]
struct WidthRow {
    id: Uuid,
    shard_count: i16,
}

/// Posts one journal template on the caller's transaction.
///
/// Returns the created entry and its lines, or the **existing** entry with empty lines when
/// `(ref_type, ref_id)` was already posted. A template with no line, a non-positive amount or
/// unbalanced debits/credits is refused before any row is written.
///
/// The caller owns the transaction: on `Err` it must roll back, because an account-resolution or
/// database failure can happen after the entry insert (the same window exists in TypeScript).
pub async fn post_entry(
    conn: &mut PgConnection,
    template: &JournalTemplate,
    options: &PostOptions<'_>,
) -> Result<PostResult, LedgerError> {
    ensure_raw_sql_enabled()?;

    // Step 1: validate with the pure domain rule, before any row is touched.
    let validated = validate_template(&template.to_unresolved_domain_template())?;
    if validated.lines.len() != template.lines.len() {
        return Err(LedgerError::TemplateLineMismatch);
    }
    if options.require_currency && template.currency.trim().is_empty() {
        return Err(LedgerError::MissingCurrency);
    }

    // Step 2: insert the entry, or read the one a replay already created.
    let entry_id = Uuid::now_v7();
    let inserted = sqlx::query_as::<_, EntryRow>(ENTRY_INSERT)
        .bind(entry_id)
        .bind(&template.ref_type)
        .bind(&template.ref_id)
        .bind(&template.description)
        .fetch_optional(&mut *conn)
        .await?;
    let entry = match inserted {
        Some(row) => JournalEntry {
            id: row.id,
            ref_type: template.ref_type.clone(),
            ref_id: template.ref_id.clone(),
            description: row.description,
            created_at: row.created_at,
        },
        None => {
            let existing = sqlx::query_as::<_, EntryRow>(ENTRY_SELECT)
                .bind(&template.ref_type)
                .bind(&template.ref_id)
                .fetch_optional(&mut *conn)
                .await?
                .ok_or(LedgerError::EntryConflict)?;
            return Ok(PostResult {
                entry: JournalEntry {
                    id: existing.id,
                    ref_type: template.ref_type.clone(),
                    ref_id: template.ref_id.clone(),
                    description: existing.description,
                    created_at: existing.created_at,
                },
                lines: Vec::new(),
                created: false,
                idempotent: true,
            });
        }
    };

    // Steps 3 and 4: accounts then shards.
    let lines = routed_lines(conn, template, options).await?;
    let folds = fold_lines(&lines);

    // Step 5: one folded, sorted upsert; the returned line_seq values are the high-water marks.
    let high_water = bump_shards(conn, &folds).await?;
    let count_by_key: HashMap<(Uuid, i32), i64> = folds
        .iter()
        .map(|fold| ((fold.gl_account_id, fold.shard_id as i32), fold.line_count))
        .collect();

    // Step 6: the j-th line of a posting on a shard is high_water - n + j.
    let mut ordinal_by_key: HashMap<(Uuid, i32), usize> = HashMap::new();
    let mut rows: Vec<PendingLine> = Vec::with_capacity(lines.len());
    for line in &lines {
        let key = (line.gl_account_id, line.shard_id as i32);
        let top = *high_water
            .get(&key)
            .ok_or(LedgerError::SequenceNotReserved {
                gl_account_id: key.0,
                shard_id: key.1,
            })?;
        let count = *count_by_key
            .get(&key)
            .ok_or(LedgerError::SequenceNotReserved {
                gl_account_id: key.0,
                shard_id: key.1,
            })?;
        let ordinal = {
            let next = ordinal_by_key.entry(key).or_insert(0);
            *next += 1;
            *next
        };
        rows.push(PendingLine {
            id: Uuid::now_v7(),
            gl_account_id: line.gl_account_id,
            direction: line.direction,
            amount: money4(line.amount),
            shard_id: line.shard_id as i32,
            shard_seq: assign_sequences(top, count, ordinal),
        });
    }
    insert_lines(conn, entry.id, &rows).await?;

    // Step 7: optional transactional outbox row; off by default because the topic has no consumer.
    if options.emit_outbox {
        enqueue_entry_posted(conn, &entry).await?;
    }

    let entry_id = entry.id;
    Ok(PostResult {
        entry,
        lines: rows
            .into_iter()
            .map(|row| JournalLine {
                id: row.id,
                entry_id,
                gl_account_id: row.gl_account_id,
                direction: row.direction,
                amount: row.amount,
                shard_id: row.shard_id,
                shard_seq: row.shard_seq,
            })
            .collect(),
        created: true,
        idempotent: false,
    })
}

struct PendingLine {
    id: Uuid,
    gl_account_id: Uuid,
    direction: Direction,
    amount: Decimal,
    shard_id: i32,
    shard_seq: i64,
}

/// Validates, resolves and routes the template lines in one pass (steps 1/3/4 without the entry).
async fn routed_lines(
    conn: &mut PgConnection,
    template: &JournalTemplate,
    options: &PostOptions<'_>,
) -> Result<Vec<ValidatedLine>, LedgerError> {
    let mut validated = validate_template(&template.to_unresolved_domain_template())?;
    if validated.lines.len() != template.lines.len() {
        return Err(LedgerError::TemplateLineMismatch);
    }
    if options.require_currency && template.currency.trim().is_empty() {
        return Err(LedgerError::MissingCurrency);
    }
    let account_ids = resolve_account_ids(conn, template, options).await?;
    let widths = load_shard_widths(conn, &account_ids).await?;
    let routes: Vec<LineRoute> = template
        .lines
        .iter()
        .zip(&account_ids)
        .map(|(line, account_id)| LineRoute {
            account_type: line.account.account_type,
            shard_count: widths.get(account_id).copied().unwrap_or(1),
        })
        .collect();
    route_validated_lines(&mut validated, &routes)?;
    for (line, account_id) in validated.lines.iter_mut().zip(&account_ids) {
        line.gl_account_id = *account_id;
    }
    Ok(validated.lines)
}

async fn load_shard_widths(
    conn: &mut PgConnection,
    account_ids: &[Uuid],
) -> Result<HashMap<Uuid, u32>, LedgerError> {
    let rows = sqlx::query_as::<_, WidthRow>(
        "SELECT id, shard_count FROM gl_accounts WHERE id = ANY($1::uuid[])",
    )
    .bind(account_ids)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.id,
                pg_domain_ledger::clamp_shard_width(u32::try_from(row.shard_count).unwrap_or(1)),
            )
        })
        .collect())
}

async fn bump_shards(
    conn: &mut PgConnection,
    folds: &[ShardFold],
) -> Result<HashMap<(Uuid, i32), i64>, LedgerError> {
    if folds.is_empty() {
        return Ok(HashMap::new());
    }
    let account_ids: Vec<Uuid> = folds.iter().map(|fold| fold.gl_account_id).collect();
    let shard_ids: Vec<i16> = folds.iter().map(|fold| fold.shard_id as i16).collect();
    let deltas: Vec<Decimal> = folds.iter().map(|fold| money4(fold.delta)).collect();
    let counts: Vec<i64> = folds.iter().map(|fold| fold.line_count).collect();
    let rows = sqlx::query_as::<_, ShardRow>(SHARD_UPSERT)
        .bind(account_ids.as_slice())
        .bind(shard_ids.as_slice())
        .bind(deltas.as_slice())
        .bind(counts.as_slice())
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| ((row.gl_account_id, i32::from(row.shard_id)), row.line_seq))
        .collect())
}

async fn insert_lines(
    conn: &mut PgConnection,
    entry_id: Uuid,
    rows: &[PendingLine],
) -> Result<(), LedgerError> {
    if rows.is_empty() {
        return Ok(());
    }
    let ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();
    let accounts: Vec<Uuid> = rows.iter().map(|row| row.gl_account_id).collect();
    let directions: Vec<String> = rows
        .iter()
        .map(|row| row.direction.as_str().to_owned())
        .collect();
    let amounts: Vec<Decimal> = rows.iter().map(|row| row.amount).collect();
    let shard_ids: Vec<i16> = rows.iter().map(|row| row.shard_id as i16).collect();
    let shard_seqs: Vec<i64> = rows.iter().map(|row| row.shard_seq).collect();
    sqlx::query(LINE_INSERT)
        .bind(entry_id)
        .bind(ids.as_slice())
        .bind(accounts.as_slice())
        .bind(directions.as_slice())
        .bind(amounts.as_slice())
        .bind(shard_ids.as_slice())
        .bind(shard_seqs.as_slice())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn enqueue_entry_posted(
    conn: &mut PgConnection,
    entry: &JournalEntry,
) -> Result<(), LedgerError> {
    let payload = serde_json::json!({
        "entryId": entry.id.to_string(),
        "refType": entry.ref_type,
        "refId": entry.ref_id,
    });
    sqlx::query(OUTBOX_INSERT)
        .bind("ledger.entry_posted")
        .bind("JOURNAL_ENTRY")
        .bind(entry.id.to_string())
        .bind(payload)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Cash-out lock helpers
// ---------------------------------------------------------------------------------------------

/// Takes the transaction-scoped wallet advisory lock **without** reading the balance.
///
/// Port of the `SELECT 1 … pg_advisory_xact_lock(hashtextextended('wallet-balance:'||id, 0))`
/// statement (`cashoutBalance.ts:42-44`). Wallet debits (cash-outs, chargebacks) are serialized by
/// this lock, which must be taken FIRST — before the transaction holds any shard row, so a waiter
/// holds nothing and cannot be part of a lock cycle (GAP-200).
pub async fn acquire_wallet_advisory_lock(
    conn: &mut PgConnection,
    gl_account_id: Uuid,
) -> Result<(), LedgerError> {
    sqlx::query("SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS l")
        .bind(format!("wallet-balance:{gl_account_id}"))
        .fetch_optional(&mut *conn)
        .await?;
    Ok(())
}

/// The wallet ledger balance, credit-positive, as the sum of its shard rows.
///
/// Call it **after** [`acquire_wallet_advisory_lock`] (and, for a cash-out, after
/// [`lock_shards_for`]): a single CTE that locked and summed in one statement would take its
/// snapshot before the wait (`cashoutBalance.ts:29-36`).
pub async fn wallet_ledger_balance(
    conn: &mut PgConnection,
    gl_account_id: Uuid,
) -> Result<Decimal, LedgerError> {
    let total: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(current_balance), 0) FROM gl_account_shards WHERE gl_account_id = $1::uuid",
    )
    .bind(gl_account_id)
    .fetch_one(&mut *conn)
    .await?;
    // The wallet is a liability: its shards carry a negative (credit) balance.
    Ok(if total.is_zero() {
        Decimal::ZERO
    } else {
        -total
    })
}

/// [`acquire_wallet_advisory_lock`] followed by [`wallet_ledger_balance`], with no shard pre-lock.
///
/// A caller that is about to post a cash-out should instead call the three steps in order:
/// advisory lock, [`lock_shards_for`] with the cash-out template, then [`wallet_ledger_balance`].
pub async fn lock_wallet_ledger_balance(
    conn: &mut PgConnection,
    gl_account_id: Uuid,
) -> Result<Decimal, LedgerError> {
    acquire_wallet_advisory_lock(conn, gl_account_id).await?;
    wallet_ledger_balance(conn, gl_account_id).await
}

/// Locks, in one statement and in the global `(account, shard)` order, every shard row a posting of
/// `template` will update — without posting anything (`lockShardsFor`, `LedgerPoster.ts:974-999`,
/// `ledgerShardWriter.ts:107-129`).
///
/// Call it before a balance check that the posting must not race (a cash-out): routing and folding
/// are identical to the real posting, so the rows locked are the rows the posting will update.
pub async fn lock_shards_for(
    conn: &mut PgConnection,
    template: &JournalTemplate,
    context: &PostContext,
    cache: Option<&AccountCache>,
) -> Result<(), LedgerError> {
    let lines = routed_lines(
        conn,
        template,
        &PostOptions {
            context: context.clone(),
            emit_outbox: false,
            require_currency: false,
            cache,
        },
    )
    .await?;
    lock_shard_targets(conn, &fold_lines(&lines)).await
}

/// [`lock_shards_for`] for SEVERAL postings one transaction is about to make (a cash-out and the
/// commission netting before it): the union of their shard rows is locked in ONE statement in the
/// global order (`lockShardsForMany`, `LedgerPoster.ts:1007-1028`).
pub async fn lock_shards_for_many(
    conn: &mut PgConnection,
    postings: &[(&JournalTemplate, &PostContext)],
    cache: Option<&AccountCache>,
) -> Result<(), LedgerError> {
    let mut lines: Vec<ValidatedLine> = Vec::new();
    for (template, context) in postings {
        lines.extend(
            routed_lines(
                conn,
                template,
                &PostOptions {
                    context: (*context).clone(),
                    emit_outbox: false,
                    require_currency: false,
                    cache,
                },
            )
            .await?,
        );
    }
    lock_shard_targets(conn, &fold_lines(&lines)).await
}

async fn lock_shard_targets(
    conn: &mut PgConnection,
    folds: &[ShardFold],
) -> Result<(), LedgerError> {
    if folds.is_empty() {
        return Ok(());
    }
    let account_ids: Vec<Uuid> = folds.iter().map(|fold| fold.gl_account_id).collect();
    let shard_ids: Vec<i16> = folds.iter().map(|fold| fold.shard_id as i16).collect();
    sqlx::query(
        "SELECT 1 FROM gl_account_shards s \
         WHERE (s.gl_account_id, s.shard_id) IN (\
           SELECT t.gl_account_id, t.shard_id FROM unnest($1::uuid[], $2::smallint[]) AS t(gl_account_id, shard_id)) \
         ORDER BY s.gl_account_id, s.shard_id \
         FOR UPDATE",
    )
    .bind(account_ids.as_slice())
    .bind(shard_ids.as_slice())
    .fetch_all(&mut *conn)
    .await?;
    Ok(())
}

/// Reads the `created_at` of an entry (helper for [`crate::reads::entry_lines`] callers and tests).
pub async fn entry_created_at(
    conn: &mut PgConnection,
    entry_id: Uuid,
) -> Result<Option<NaiveDateTime>, LedgerError> {
    let row = sqlx::query("SELECT created_at FROM journal_entries WHERE id = $1::uuid")
        .bind(entry_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.map(|row| row.get::<NaiveDateTime, _>("created_at")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::template::AccountSelector;
    use pg_domain_ledger::AccountType;
    use std::str::FromStr;

    fn dec(raw: &str) -> Decimal {
        Decimal::from_str(raw).expect("decimal")
    }

    #[test]
    fn raw_sql_guard_is_allowed_without_the_env_var() {
        // The DB-free test environment does not set LEDGER_RAW_SQL; the guard must not refuse.
        if std::env::var("LEDGER_RAW_SQL").is_err() {
            assert!(ensure_raw_sql_enabled().is_ok());
        }
    }

    #[test]
    fn a_balanced_template_is_accepted_by_the_domain_rule() {
        let template = JournalTemplate::new("ADJUSTMENT", "ref-1", "balanced", "LYD")
            .with_line(crate::template::LedgerLineTemplate::debit(
                dec("10"),
                AccountSelector::new(AccountType::Treasury),
            ))
            .with_line(crate::template::LedgerLineTemplate::credit(
                dec("10"),
                AccountSelector::new(AccountType::MerchantWallet),
            ));
        assert!(validate_template(&template.to_unresolved_domain_template()).is_ok());
    }
}
