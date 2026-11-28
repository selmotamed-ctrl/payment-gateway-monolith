//! Pure ledger domain logic for the Rust/ntex port.
//!
//! Scope: the rules that decide *what* a posting is and *where* its lines land, with no database,
//! HTTP or runtime types:
//!
//! - [`template`] — journal templates, direction/account/scenario vocabulary and
//!   `validateTemplate` (`core-back/engine/ledger/LedgerPoster.ts:1054-1076`).
//! - [`shard`] — FNV-1a UTF-16 routing and shard widths
//!   (`core-back/lib/storageEngine/{shardRouting,shardBalances}.ts`).
//! - [`fold`] — folding lines per `(account, shard)` and the gapless `high_water - n + j`
//!   sequence arithmetic (`shardRouting.ts:84-153`).
//! - [`repair`] — the pure `ShardRepair.buildPlan` projection repair decision
//!   (`core-back/engine/ledger/ShardRepair.ts:245-304`).
//! - [`rounding`] — commission rounding modes and the split fee-bearer breakdown
//!   (`core-back/api/internal/checkout.ts:364-521`).
//!
//! Design: `design/14-rust-port/02_contracts_reference.md` §12 and §14; tasks P5-T04/P6-T06 in
//! `design/14-rust-port/09_task_catalog.md`.
//!
//! Deliberate scoping notes (all parity-preserving):
//!
//! - `LedgerPoster.ts` declares **18** scenarios (17 base + `SUSPENSE_REFUND`, which was added
//!   after `project-design/parts/01-core-back/03-ledger.md` §3.3 was written; that table lists 17).
//!   The TypeScript list wins under Track P, so [`LedgerScenario`] has 18 variants.
//! - [`plan_shard_repair`] takes the reduced input set this crate needs so far. The SQL planner
//!   also reads the shard checkpoint, the checkpoint status and the per-baseline line counts (to
//!   detect a duplicated or missing sequence number); those stay with the database adapter. See
//!   [`repair`].
//! - [`fnv1a32_utf16`] is re-implemented here because `pg-crypto` (which already has the identical
//!   function) is not a dependency of this crate yet.
//! - The repair [`ShardRepairPlan::plan_hash`] is FNV-1a 32 over a canonical string, not SHA-256:
//!   `sha2` is not a dependency of this crate, and the value is only a change-detection token
//!   between preview and apply (both computed by this crate).
//!
//! Money is [`rust_decimal::Decimal`] throughout; no floating point type appears anywhere.

#![forbid(unsafe_code)]

pub mod fold;
pub mod repair;
pub mod rounding;
pub mod shard;
pub mod template;

pub use fold::assign_sequences;
pub use fold::fold_lines;
pub use fold::ShardFold;
pub use repair::plan_shard_repair;
pub use repair::ShardRepairKind;
pub use repair::ShardRepairPlan;
pub use repair::ShardRepairState;
pub use rounding::commission_for_percentage;
pub use rounding::default_split_platform_share;
pub use rounding::round_money_4;
pub use rounding::split_commission;
pub use rounding::split_commission_breakdown;
pub use rounding::split_commission_with_share;
pub use rounding::CommissionRounding;
pub use rounding::MoneyError;
pub use rounding::MoneyField;
pub use rounding::SplitCommission;
pub use rounding::MONEY_SCALE;
pub use shard::clamp_shard_width;
pub use shard::fnv1a32_utf16;
pub use shard::initial_shard_width;
pub use shard::initial_shard_width_with;
pub use shard::natural_balance;
pub use shard::reduces_balance;
pub use shard::route_line;
pub use shard::route_validated_lines;
pub use shard::shard_for_reference;
pub use shard::LineRoute;
pub use shard::ShardRouteError;
pub use shard::DEFAULT_SHARD_COUNT;
pub use shard::HOT_SYSTEM_SHARD_WIDTH;
pub use shard::INITIAL_SYSTEM_SHARD_WIDTH;
pub use shard::MAX_SHARD_WIDTH;
pub use shard::MIN_SHARD_WIDTH;
pub use template::validate_template;
pub use template::AccountType;
pub use template::Direction;
pub use template::JournalTemplate;
pub use template::LedgerLineInput;
pub use template::LedgerScenario;
pub use template::LedgerScenarioStage;
pub use template::TemplateError;
pub use template::ValidatedLine;
pub use template::ValidatedTemplate;
