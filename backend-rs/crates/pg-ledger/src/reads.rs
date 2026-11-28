//! Read helpers for checkpoints, invariants, statements and the lock guards.
//!
//! Ports:
//!
//! | Function | TypeScript |
//! | :--- | :--- |
//! | [`account_lines`] / [`entry_lines`] | `api/internal/ledgerLines.ts` (`listAccountLines`) plus the `created_at` partition bound of design chapter 3 §3.11 rule 1 |
//! | [`live_balances`] | `lib/storageEngine/shardBalances.ts:116-152` (`loadLiveAccountBalances`) |
//! | [`system_equation`] | `engine/ledger/InvariantVerifier.ts:84-162` (the SQL aggregation) |
//! | [`verify_shard`] | `engine/ledger/CheckpointService.ts:116-170` (`inspectShard`, without moving the checkpoint) |
//!
//! Everything here is read-only. The moving capture and its failure bookkeeping live in the worker
//! crate (`pg_workers::checkpoint::CheckpointService`); this module is the library half the worker,
//! the restore drill, the admin finance views and the ledger tests share.
//!
//! `journal_lines` is monthly range-partitioned by `created_at` and append-only, so every query
//! addresses it by `gl_account_id` and a `created_at` or entry bound (design chapter 3 §3.11).

#![forbid(unsafe_code)]

use chrono::{DateTime, NaiveDateTime, Utc};
use pg_domain_ledger::{natural_balance, AccountType, Direction};
use rust_decimal::Decimal;
use sqlx::{FromRow, PgConnection};

use crate::error::LedgerError;

/// Default number of account lines one page returns (the statement/list default).
pub const DEFAULT_ACCOUNT_LINES_LIMIT: i64 = 25;
/// Maximum page size of [`account_lines`] (matches the edge page cap).
pub const MAX_ACCOUNT_LINES_LIMIT: i64 = 200;
/// The partition-pruning margin around a parent entry's `created_at` (design chapter 3 §3.11 rule 1).
pub const ENTRY_LINE_MARGIN_MINUTES: i64 = 5;

// ---------------------------------------------------------------------------------------------
// Account lines
// ---------------------------------------------------------------------------------------------

/// One posted line of an account, joined with its journal entry.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountLineRow {
    pub line_id: uuid::Uuid,
    pub entry_id: uuid::Uuid,
    pub gl_account_id: uuid::Uuid,
    pub direction: Direction,
    pub amount: Decimal,
    pub created_at: NaiveDateTime,
    pub shard_id: i32,
    pub shard_seq: i64,
    pub ref_type: String,
    pub ref_id: String,
    pub description: String,
}

/// The filtered `created_at` window and pagination of [`account_lines`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountLinesQuery {
    /// Inclusive lower bound (`None` = open).
    pub from: Option<NaiveDateTime>,
    /// Exclusive upper bound (`None` = open).
    pub to: Option<NaiveDateTime>,
    /// One side only (`None` = both).
    pub direction: Option<Direction>,
    pub limit: i64,
    pub offset: i64,
}

impl Default for AccountLinesQuery {
    fn default() -> Self {
        Self {
            from: None,
            to: None,
            direction: None,
            limit: DEFAULT_ACCOUNT_LINES_LIMIT,
            offset: 0,
        }
    }
}

impl AccountLinesQuery {
    /// A window starting at `from` and open above.
    #[must_use]
    pub fn since(from: NaiveDateTime) -> Self {
        Self {
            from: Some(from),
            ..Self::default()
        }
    }

    /// The page size clamped into `1..=200` and a non-negative offset, as the edge would.
    #[must_use]
    pub fn page(&self) -> (i64, i64) {
        (
            self.limit.clamp(1, MAX_ACCOUNT_LINES_LIMIT),
            self.offset.max(0),
        )
    }
}

/// Totals of the whole filtered window, not only of the visible page (`listAccountLines` totals).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountLinesTotals {
    pub line_count: i64,
    pub total_debit: Decimal,
    pub total_credit: Decimal,
    /// `total_debit - total_credit`, the account's movement in the window.
    pub net_debit: Decimal,
}

/// One page of account lines plus the filtered totals.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountLinesPage {
    pub lines: Vec<AccountLineRow>,
    pub totals: AccountLinesTotals,
}

#[derive(Debug, Clone, FromRow)]
struct LineRow {
    id: uuid::Uuid,
    entry_id: uuid::Uuid,
    gl_account_id: uuid::Uuid,
    direction: String,
    amount: Decimal,
    created_at: NaiveDateTime,
    shard_id: i16,
    shard_seq: i64,
    ref_type: String,
    ref_id: String,
    description: String,
}

impl LineRow {
    fn into_line(self) -> Result<AccountLineRow, LedgerError> {
        let direction = Direction::parse(&self.direction)
            .ok_or_else(|| LedgerError::UnknownDirection(self.direction.clone()))?;
        Ok(AccountLineRow {
            line_id: self.id,
            entry_id: self.entry_id,
            gl_account_id: self.gl_account_id,
            direction,
            amount: self.amount,
            created_at: self.created_at,
            shard_id: i32::from(self.shard_id),
            shard_seq: self.shard_seq,
            ref_type: self.ref_type,
            ref_id: self.ref_id,
            description: self.description,
        })
    }
}

const ACCOUNT_LINES_SQL: &str =
    "SELECT jl.id, jl.entry_id, jl.gl_account_id, jl.direction::text AS direction, \
        jl.amount, jl.created_at, jl.shard_id, jl.shard_seq, \
        je.ref_type::text AS ref_type, je.ref_id, je.description \
   FROM journal_lines jl \
   INNER JOIN journal_entries je ON je.id = jl.entry_id \
  WHERE jl.gl_account_id = $1::uuid \
    AND ($2::timestamp IS NULL OR jl.created_at >= $2) \
    AND ($3::timestamp IS NULL OR jl.created_at < $3) \
    AND ($4::text IS NULL OR jl.direction = $4::\"JournalDirection\") \
  ORDER BY jl.created_at DESC, jl.id DESC \
  LIMIT $5 OFFSET $6";

const ACCOUNT_LINES_TOTALS_SQL: &str =
    "SELECT jl.direction::text AS direction, COUNT(*)::bigint AS lines, \
        COALESCE(SUM(jl.amount), 0) AS total \
   FROM journal_lines jl \
  WHERE jl.gl_account_id = $1::uuid \
    AND ($2::timestamp IS NULL OR jl.created_at >= $2) \
    AND ($3::timestamp IS NULL OR jl.created_at < $3) \
    AND ($4::text IS NULL OR jl.direction = $4::\"JournalDirection\") \
  GROUP BY jl.direction";

/// One page of the lines posted to a GL account, optionally bounded by `created_at`.
///
/// The bound is what lets PostgreSQL prune the monthly `journal_lines` partitions, so a page costs
/// the same whatever the account's history. `limit` is clamped to `1..=200`.
pub async fn account_lines(
    conn: &mut PgConnection,
    gl_account_id: uuid::Uuid,
    query: &AccountLinesQuery,
) -> Result<AccountLinesPage, LedgerError> {
    let (limit, offset) = query.page();
    let direction = query.direction.map(|value| value.as_str().to_owned());
    let rows = sqlx::query_as::<_, LineRow>(ACCOUNT_LINES_SQL)
        .bind(gl_account_id)
        .bind(query.from)
        .bind(query.to)
        .bind(direction.as_deref())
        .bind(limit)
        .bind(offset)
        .fetch_all(&mut *conn)
        .await?;
    let totals_rows = sqlx::query_as::<_, (String, i64, Decimal)>(ACCOUNT_LINES_TOTALS_SQL)
        .bind(gl_account_id)
        .bind(query.from)
        .bind(query.to)
        .bind(direction.as_deref())
        .fetch_all(&mut *conn)
        .await?;
    let lines = rows
        .into_iter()
        .map(LineRow::into_line)
        .collect::<Result<Vec<_>, _>>()?;
    let mut line_count = 0i64;
    let mut total_debit = Decimal::ZERO;
    let mut total_credit = Decimal::ZERO;
    for (side, count, total) in totals_rows {
        line_count += count;
        match Direction::parse(&side) {
            Some(Direction::Debit) => total_debit = total,
            Some(Direction::Credit) => total_credit = total,
            None => {
                return Err(LedgerError::UnknownDirection(side));
            }
        }
    }
    Ok(AccountLinesPage {
        lines,
        totals: AccountLinesTotals {
            line_count,
            total_debit,
            total_credit,
            net_debit: total_debit - total_credit,
        },
    })
}

/// Every line of one journal entry, with the `created_at` bound of its parent entry.
///
/// A line is inserted in the same transaction as its entry, so bounding `journal_lines.created_at`
/// by the entry's own timestamp (± 5 minutes) reads exactly one partition instead of all of them
/// (design chapter 3 §3.11 rule 1). Never bound by an older business object: a delayed entry can be
/// posted days after the object it refers to.
pub async fn entry_lines(
    conn: &mut PgConnection,
    entry_id: uuid::Uuid,
) -> Result<Vec<AccountLineRow>, LedgerError> {
    let rows = sqlx::query_as::<_, LineRow>(
        "SELECT jl.id, jl.entry_id, jl.gl_account_id, jl.direction::text AS direction, \
                jl.amount, jl.created_at, jl.shard_id, jl.shard_seq, \
                je.ref_type::text AS ref_type, je.ref_id, je.description \
           FROM journal_lines jl \
           INNER JOIN journal_entries je ON je.id = jl.entry_id \
          WHERE jl.entry_id = $1::uuid \
            AND jl.created_at >= (SELECT created_at FROM journal_entries WHERE id = $1::uuid) - make_interval(mins => $2) \
            AND jl.created_at <= (SELECT created_at FROM journal_entries WHERE id = $1::uuid) + make_interval(mins => $2) \
          ORDER BY jl.created_at ASC, jl.id ASC",
    )
    .bind(entry_id)
    .bind(ENTRY_LINE_MARGIN_MINUTES as i32)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter().map(LineRow::into_line).collect()
}

// ---------------------------------------------------------------------------------------------
// Live balances
// ---------------------------------------------------------------------------------------------

/// One account's live balance, in its natural sign, derived from its shard rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveBalance {
    pub account_id: uuid::Uuid,
    pub account_type: AccountType,
    pub currency: String,
    /// Natural sign: credit-normal accounts (wallets) are positive when in credit.
    pub balance: Decimal,
    /// Always `shards`: every account has shard rows, so there is no journal fallback
    /// (`shardBalances.ts:105-114`).
    pub source: &'static str,
}

#[derive(Debug, Clone, FromRow)]
struct LiveRow {
    id: uuid::Uuid,
    account_type: String,
    currency: String,
    raw_balance: Decimal,
}

/// Live natural-sign balances from the shard projection (`loadLiveAccountBalances`).
///
/// One statement: the account list and the shard sum. `None` returns every account; `Some(&[])`
/// returns none. Never reads `journal_lines` (design chapter 3 §3.11 rule 2).
pub async fn live_balances(
    conn: &mut PgConnection,
    account_ids: Option<&[uuid::Uuid]>,
) -> Result<Vec<LiveBalance>, LedgerError> {
    if matches!(account_ids, Some(ids) if ids.is_empty()) {
        return Ok(Vec::new());
    }
    let base = "SELECT g.id, g.account_type::text AS account_type, g.currency::text AS currency, \
                COALESCE(s.total, 0) AS raw_balance \
           FROM gl_accounts g \
           LEFT JOIN (\
             SELECT gl_account_id, SUM(current_balance) AS total \
               FROM gl_account_shards{shard_where} \
              GROUP BY gl_account_id\
           ) s ON s.gl_account_id = g.id";
    let rows = if let Some(ids) = account_ids {
        let sql = base.replace("{shard_where}", " WHERE gl_account_id = ANY($1::uuid[])");
        let sql = format!("{sql} WHERE g.id = ANY($1::uuid[])");
        sqlx::query_as::<_, LiveRow>(sqlx::AssertSqlSafe(sql))
            .bind(ids)
            .fetch_all(&mut *conn)
            .await?
    } else {
        let sql = base.replace("{shard_where}", "");
        sqlx::query_as::<_, LiveRow>(sqlx::AssertSqlSafe(sql))
            .fetch_all(&mut *conn)
            .await?
    };
    rows.into_iter()
        .map(|row| {
            let account_type = AccountType::parse(&row.account_type)
                .ok_or_else(|| LedgerError::UnknownAccountType(row.account_type.clone()))?;
            Ok(LiveBalance {
                account_id: row.id,
                account_type,
                currency: row.currency.trim().to_owned(),
                balance: natural_balance(account_type, row.raw_balance),
                source: "shards",
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// System equation
// ---------------------------------------------------------------------------------------------

/// The platform ledger equation (`InvariantVerifier.verify`): `left == right`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemEquation {
    /// TREASURY + GATEWAY_CLEARING + COMMISSION_RECEIVABLE, in their natural sign.
    pub left: Decimal,
    /// WALLET + INCOME − PROVIDER_FEE − GATEWAY_FEE + ACCRUAL + AML_HOLD + RESERVE + SUSPENSE.
    pub right: Decimal,
    /// `left - right`; zero on a consistent ledger.
    pub drift: Decimal,
    pub ok: bool,
    pub checked_at: DateTime<Utc>,
}

const EQUATION_SQL: &str = "WITH balances AS (\
       SELECT g.account_type, COALESCE(SUM(s.current_balance), 0) AS debit_positive \
         FROM gl_accounts g \
         LEFT JOIN gl_account_shards s ON s.gl_account_id = g.id \
         {scope} \
        GROUP BY g.account_type\
     ) \
     SELECT \
       COALESCE(SUM(CASE WHEN account_type IN ('TREASURY', 'GATEWAY_CLEARING', 'COMMISSION_RECEIVABLE') \
                         THEN debit_positive ELSE 0 END), 0) AS left_side, \
       COALESCE(SUM(CASE WHEN account_type IN \
           ('MERCHANT_WALLET', 'PLATFORM_INCOME', 'PROVIDER_FEE_EXPENSE', 'GATEWAY_FEE_EXPENSE', \
            'GATEWAY_FEE_ACCRUAL', 'AML_HOLD', 'CHARGEBACK_RESERVE', 'SUSPENSE') \
                         THEN -debit_positive ELSE 0 END), 0) AS right_side \
     FROM balances";

/// The 60-second ledger equation, computed from shard balances in O(shards)
/// (`InvariantVerifier.verify`, design chapter 3 §3.7).
///
/// `None` checks the whole platform; `Some(ids)` checks only those GL accounts, which is what a
/// test or an account-scoped drill wants.
pub async fn system_equation(
    conn: &mut PgConnection,
    account_ids: Option<&[uuid::Uuid]>,
) -> Result<SystemEquation, LedgerError> {
    let (left, right) = if let Some(ids) = account_ids {
        let sql = EQUATION_SQL.replace("{scope}", "WHERE g.id = ANY($1::uuid[])");
        sqlx::query_as::<_, (Decimal, Decimal)>(sqlx::AssertSqlSafe(sql))
            .bind(ids)
            .fetch_one(&mut *conn)
            .await?
    } else {
        let sql = EQUATION_SQL.replace("{scope}", "");
        sqlx::query_as::<_, (Decimal, Decimal)>(sqlx::AssertSqlSafe(sql))
            .fetch_one(&mut *conn)
            .await?
    };
    let drift = left - right;
    Ok(SystemEquation {
        left,
        right,
        drift,
        ok: drift.is_zero(),
        checked_at: Utc::now(),
    })
}

// ---------------------------------------------------------------------------------------------
// Shard verification (read-only checkpoint proof)
// ---------------------------------------------------------------------------------------------

/// `ShardCaptureStatus` (`CheckpointService.ts:21`) for a read-only proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShardVerifyStatus {
    /// Every line in the sequence range is present and the balance matches; a capture would advance.
    Advanced,
    /// Proven consistent with nothing to fold in.
    Noop,
    /// The number of lines in the range differs from `line_seq - checkpoint_seq`.
    Gap,
    /// The shard balance differs from `checkpoint_balance + SUM(lines)`.
    Parity,
}

impl ShardVerifyStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Advanced => "ADVANCED",
            Self::Noop => "NOOP",
            Self::Gap => "GAP",
            Self::Parity => "PARITY",
        }
    }

    #[must_use]
    pub fn is_failure(self) -> bool {
        matches!(self, Self::Gap | Self::Parity)
    }
}

/// The verdict of [`verify_shard`] (`ShardCaptureResult`, `CheckpointService.ts:21-42`).
#[derive(Debug, Clone, PartialEq)]
pub struct ShardVerification {
    pub gl_account_id: uuid::Uuid,
    pub shard_id: i32,
    pub status: ShardVerifyStatus,
    /// Shard balance and high-water at the snapshot (debit-positive).
    pub balance: Decimal,
    pub line_seq: i64,
    pub previous_seq: i64,
    pub checkpoint_seq: i64,
    pub checkpoint_balance: Decimal,
    /// Lines the capture would fold in (`line_seq - previous_seq`), 0 unless ADVANCED.
    pub lines_covered: i64,
    /// Lines actually found in `(previous_seq, line_seq]`.
    pub lines_found: i64,
    /// `balance - (checkpoint_balance + found lines)`; zero when they agree.
    pub drift: Decimal,
}

/// The default partition-pruning hint (two days, `CheckpointService.ts:73`).
pub const DEFAULT_CHECKPOINT_MARGIN_SECONDS: i64 = 2 * 86_400;

#[derive(Debug, Clone, FromRow)]
struct SnapshotRow {
    balance: Decimal,
    line_seq: i64,
    cp_balance: Decimal,
    cp_seq: i64,
    found: i64,
    delta: Decimal,
}

fn snapshot_sql(with_hint: bool) -> String {
    let hint = if with_hint {
        "AND (s.cp_at IS NULL OR jl.created_at >= (s.cp_at AT TIME ZONE 'UTC') - make_interval(secs => $3::double precision))"
    } else {
        ""
    };
    format!(
        "WITH s AS (\
           SELECT sh.current_balance AS balance, sh.line_seq AS line_seq, \
                  COALESCE(c.checkpoint_balance, 0) AS cp_balance, COALESCE(c.checkpoint_seq, 0) AS cp_seq, \
                  c.checkpoint_at AS cp_at \
             FROM gl_account_shards sh \
             LEFT JOIN gl_shard_checkpoints c \
               ON c.gl_account_id = sh.gl_account_id AND c.shard_id = sh.shard_id \
            WHERE sh.gl_account_id = $1::uuid AND sh.shard_id = $2::smallint\
         ), d AS (\
           SELECT COUNT(jl.shard_seq)::bigint AS found, \
                  COALESCE(SUM(CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END), 0) AS delta \
             FROM s \
             LEFT JOIN journal_lines jl \
               ON jl.gl_account_id = $1::uuid AND jl.shard_id = $2::smallint \
              AND jl.shard_seq > s.cp_seq AND jl.shard_seq <= s.line_seq \
              {hint}\
         ) \
         SELECT s.balance, s.line_seq, s.cp_balance, s.cp_seq, \
                (CASE WHEN s.line_seq > s.cp_seq THEN d.found ELSE 0 END)::bigint AS found, d.delta \
           FROM s, d"
    )
}

/// Reads and verifies one shard against its checkpoint **without moving it**
/// (`CheckpointService.inspectShard`).
///
/// `ADVANCED` means the proof passed and there were new lines to fold in; `NOOP` means the proof
/// passed with nothing new; `GAP`/`PARITY` are failures. A `GAP` found with the `created_at` hint is
/// retried once without it, so a legitimately old line is not reported as missing.
pub async fn verify_shard(
    conn: &mut PgConnection,
    gl_account_id: uuid::Uuid,
    shard_id: i32,
) -> Result<ShardVerification, LedgerError> {
    let snapshot = read_snapshot(
        conn,
        gl_account_id,
        shard_id,
        true,
        DEFAULT_CHECKPOINT_MARGIN_SECONDS,
    )
    .await?
    .ok_or(LedgerError::ShardNotFound {
        gl_account_id,
        shard_id,
    })?;
    let mut verdict = judge_snapshot(gl_account_id, shard_id, &snapshot);
    if verdict.status == ShardVerifyStatus::Gap {
        if let Some(full) = read_snapshot(conn, gl_account_id, shard_id, false, 0).await? {
            verdict = judge_snapshot(gl_account_id, shard_id, &full);
        }
    }
    Ok(verdict)
}

async fn read_snapshot(
    conn: &mut PgConnection,
    gl_account_id: uuid::Uuid,
    shard_id: i32,
    with_hint: bool,
    margin_seconds: i64,
) -> Result<Option<SnapshotRow>, LedgerError> {
    let sql = snapshot_sql(with_hint);
    let mut query = sqlx::query_as::<_, SnapshotRow>(sqlx::AssertSqlSafe(sql))
        .bind(gl_account_id)
        .bind(shard_id as i16);
    if with_hint {
        query = query.bind(margin_seconds as f64);
    }
    Ok(query.fetch_optional(&mut *conn).await?)
}

/// Port of `CheckpointService.judge` (`CheckpointService.ts:142-170`), pure over one snapshot.
fn judge_snapshot(
    gl_account_id: uuid::Uuid,
    shard_id: i32,
    snapshot: &SnapshotRow,
) -> ShardVerification {
    judge_values(
        gl_account_id,
        shard_id,
        snapshot.balance,
        snapshot.line_seq,
        snapshot.cp_balance,
        snapshot.cp_seq,
        snapshot.found,
        snapshot.delta,
    )
}

#[allow(clippy::too_many_arguments)]
fn judge_values(
    gl_account_id: uuid::Uuid,
    shard_id: i32,
    balance: Decimal,
    line_seq: i64,
    checkpoint_balance: Decimal,
    previous_seq: i64,
    found: i64,
    delta: Decimal,
) -> ShardVerification {
    let expected = line_seq.saturating_sub(previous_seq);
    let drift = balance - (checkpoint_balance + delta);
    let status = if found != expected {
        ShardVerifyStatus::Gap
    } else if !drift.is_zero() {
        ShardVerifyStatus::Parity
    } else if expected == 0 {
        ShardVerifyStatus::Noop
    } else {
        ShardVerifyStatus::Advanced
    };
    ShardVerification {
        gl_account_id,
        shard_id,
        status,
        balance,
        line_seq,
        previous_seq,
        checkpoint_seq: previous_seq,
        checkpoint_balance,
        lines_covered: if status == ShardVerifyStatus::Advanced {
            expected
        } else {
            0
        },
        lines_found: found,
        drift,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use std::str::FromStr;

    fn dec(raw: &str) -> Decimal {
        Decimal::from_str(raw).expect("test decimal")
    }

    fn judged(
        balance: &str,
        line_seq: i64,
        checkpoint_balance: &str,
        previous_seq: i64,
        found: i64,
        delta: &str,
    ) -> ShardVerification {
        judge_values(
            uuid::Uuid::nil(),
            0,
            dec(balance),
            line_seq,
            dec(checkpoint_balance),
            previous_seq,
            found,
            dec(delta),
        )
    }

    #[test]
    fn a_consistent_shard_with_new_lines_would_advance() {
        let verdict = judged("100.0000", 5, "0", 0, 5, "100.0000");
        assert_eq!(verdict.status, ShardVerifyStatus::Advanced);
        assert_eq!(verdict.lines_covered, 5);
        assert_eq!(verdict.lines_found, 5);
        assert!(verdict.drift.is_zero());
    }

    #[test]
    fn nothing_to_fold_is_a_noop() {
        let verdict = judged("100.0000", 5, "100.0000", 5, 0, "0");
        assert_eq!(verdict.status, ShardVerifyStatus::Noop);
        assert_eq!(verdict.lines_covered, 0);
    }

    #[test]
    fn a_missing_line_is_a_gap() {
        let verdict = judged("80.0000", 5, "0", 0, 4, "80.0000");
        assert_eq!(verdict.status, ShardVerifyStatus::Gap);
        assert!(verdict.status.is_failure());
        assert_eq!(verdict.lines_found, 4);
    }

    #[test]
    fn a_balance_mismatch_is_parity() {
        let verdict = judged("100.5000", 5, "0", 0, 5, "100.0000");
        assert_eq!(verdict.status, ShardVerifyStatus::Parity);
        assert!(verdict.status.is_failure());
        assert_eq!(verdict.drift, dec("0.5"));
    }

    #[test]
    fn an_empty_shard_is_a_noop() {
        let verdict = judged("0", 0, "0", 0, 0, "0");
        assert_eq!(verdict.status, ShardVerifyStatus::Noop);
    }

    #[test]
    fn the_page_size_is_clamped() {
        let query = AccountLinesQuery {
            limit: 10_000,
            offset: -3,
            ..AccountLinesQuery::default()
        };
        assert_eq!(query.page(), (MAX_ACCOUNT_LINES_LIMIT, 0));
        let query = AccountLinesQuery {
            limit: 0,
            ..AccountLinesQuery::default()
        };
        assert_eq!(query.page(), (1, 0));
        assert_eq!(AccountLinesQuery::default().page(), (25, 0));
    }

    #[test]
    fn status_text_matches_the_typescript_vocabulary() {
        for (status, text) in [
            (ShardVerifyStatus::Advanced, "ADVANCED"),
            (ShardVerifyStatus::Noop, "NOOP"),
            (ShardVerifyStatus::Gap, "GAP"),
            (ShardVerifyStatus::Parity, "PARITY"),
        ] {
            assert_eq!(status.as_str(), text);
        }
    }
}
