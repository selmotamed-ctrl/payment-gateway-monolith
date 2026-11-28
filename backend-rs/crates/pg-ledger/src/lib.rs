//! Ledger persistence: posting, account/shards, read helpers and shard repair.
//!
//! This crate is the database half of the ledger. The pure rules (template validation, FNV-1a
//! routing, folding, sequence arithmetic, the reduced repair decision) live in
//! [`pg_domain_ledger`]; this crate owns every SQL statement, transaction boundary and lock order.
//!
//! | Module | TypeScript source |
//! | :--- | :--- |
//! | [`poster`] | `engine/ledger/LedgerPoster.ts`, `lib/storageEngine/ledgerShardWriter.ts`, `lib/cashoutBalance.ts` |
//! | [`accounts`] | `LedgerPoster.resolveAccountIds` / `accountPredicates` (`LedgerPoster.ts:1086-1299`) |
//! | [`reads`] | `lib/storageEngine/shardBalances.ts`, `engine/ledger/InvariantVerifier.ts`, `CheckpointService.ts` (inspect half), `api/internal/ledgerLines.ts` |
//! | [`repair`] | `engine/ledger/ShardRepair.ts` |
//!
//! Design: `design/14-rust-port/02_contracts_reference.md` §12/§14/§17 and
//! `project-design/parts/01-core-back/03-ledger.md` §3.3-§3.10.
//!
//! Deliberate shapes:
//!
//! - [`JournalTemplate`] still carries account *selectors*; [`pg_domain_ledger::JournalTemplate`]
//!   is the resolved form the pure validator/routing functions take.
//! - The Rust port implements the raw-SQL path only. `LEDGER_RAW_SQL=false` is refused with
//!   [`LedgerError::RawSqlDisabled`] instead of pretending to run the Prisma/ORM fallback.
//! - Money is [`rust_decimal::Decimal`] everywhere; no floating point type appears.
//! - Every write joins the caller's transaction. Nothing here begins or commits a transaction.
//!
//! See `README.md` for the ported/missing list and the recorded deviations.

#![forbid(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod poster;
pub mod reads;
pub mod repair;
pub mod template;

pub use accounts::{AccountCache, ACCOUNT_CACHE_MAX_ENTRIES, ACCOUNT_CACHE_TTL};
pub use error::LedgerError;
pub use poster::{
    acquire_wallet_advisory_lock, entry_created_at, lock_shards_for, lock_shards_for_many,
    lock_wallet_ledger_balance, post_entry, wallet_ledger_balance, JournalEntry, JournalLine,
    PostResult,
};
pub use reads::{
    account_lines, entry_lines, live_balances, system_equation, verify_shard, AccountLineRow,
    AccountLinesPage, AccountLinesQuery, AccountLinesTotals, LiveBalance, ShardVerification,
    ShardVerifyStatus, SystemEquation, DEFAULT_ACCOUNT_LINES_LIMIT,
    DEFAULT_CHECKPOINT_MARGIN_SECONDS, ENTRY_LINE_MARGIN_MINUTES, MAX_ACCOUNT_LINES_LIMIT,
};
pub use repair::{
    apply_shard_repair, plan_shard_repair, ApplyRepairInput, ApplyRepairResult, RepairMode,
    ShardRepairPlan, ShardRepairState, ShardRepairTruth,
};
pub use template::{
    check_ledger_raw_sql, AccountSelector, JournalTemplate, LedgerLineTemplate, PostContext,
    PostOptions,
};

/// The oldest schema generation these statements work against: sequenced per-shard checkpoints and
/// repair history (`gl_account_shards.line_seq`, `gl_shard_checkpoints`, `gl_shard_repairs`).
/// Schema 46 is the current project version, so any supported database satisfies it.
pub const MIN_LEDGER_SCHEMA_VERSION: u32 = 14;
