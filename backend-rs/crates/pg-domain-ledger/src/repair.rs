//! Shard repair: a shard is a projection of the immutable journal, never fixed by a posting.
//!
//! Ports: `core-back/engine/ledger/ShardRepair.ts:9-47` (the rule) and `:245-304`
//! (`buildPlan`, the pure decision this module implements).
//!
//! The rule (verbatim from the TypeScript module docs): a shard (`gl_account_shards`) is a
//! *projection* of the immutable journal. When the projection disagrees with the journal, the
//! journal is right by definition, so the repair recomputes the projection from the journal. It
//! must **never** post a ledger entry to "fix" a shard: an adjusting entry changes the journal too,
//! which leaves the shard exactly as wrong as before and records a false economic event. A real
//! money error is a business correction through the Adjustments flow, not a projection repair.
//!
//! Two outcomes, decided by whether the shard's sequence is intact:
//!
//! - [`ShardRepairKind::Recompute`] — every line is present exactly once; only the stored balance
//!   (or checkpoint) disagrees. The balance becomes the journal sum and the checkpoint moves to
//!   `(sum, line_seq)`. Safe to automate.
//! - [`ShardRepairKind::Rebaseline`] — the sequence is damaged (a line is missing or a number is
//!   used twice). Recomputing could drop money the shard held if the journal lost a line, so a
//!   person decides. The balance becomes the journal sum, `line_seq` becomes
//!   `max(line_seq, highest sequence found)` (a number is never reused) and `baseline_seq` moves
//!   with it, so the damaged history before the baseline is exempt from the gapless proof.
//!
//! Input reduction (recorded deviation, design chapter 2 §14): the SQL planner also reads the
//! shard checkpoint, the checkpoint status (`OK`/`GAP`/`PARITY`), the line count above the baseline
//! and the *distinct* sequence count above it. The last two are what detect a duplicated or missing
//! middle number; they stay with the database adapter, which calls this function once it has them.
//! Here, "intact" is proven from the highest sequence found versus the stored sequence.

use std::cmp::Ordering;

use rust_decimal::Decimal;

use crate::shard::fnv1a32_utf16;

/// Port of `ShardRepairKind` (`ShardRepair.ts:49`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ShardRepairKind {
    /// Sequence intact: recompute the projection. Safe to automate.
    Recompute,
    /// Sequence damaged: re-baseline it. A person must decide (maker-checker).
    Rebaseline,
}

impl ShardRepairKind {
    /// The wire/database text (`"RECOMPUTE"` / `"REBASELINE"`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recompute => "RECOMPUTE",
            Self::Rebaseline => "REBASELINE",
        }
    }
}

impl std::fmt::Display for ShardRepairKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One side of a repair (`before` = what the shard stores now, `after` = what it becomes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShardRepairState {
    /// Signed (debit-positive) balance.
    pub balance: Decimal,
    /// The shard's gapless high-water mark (`gl_account_shards.line_seq`).
    pub line_seq: i64,
    /// Sequence numbers at or below this are exempt from the gapless proof
    /// (`gl_shard_checkpoints.baseline_seq`).
    pub baseline_seq: i64,
}

/// Port of `ShardRepairPlan` (`ShardRepair.ts:52-81`), reduced to the fields the pure decision owns.
#[derive(Debug, Clone, PartialEq)]
pub struct ShardRepairPlan {
    /// Nothing to do when the sequence is intact and the balance already equals the journal sum.
    pub needs_repair: bool,
    /// `None` when no repair is needed.
    pub kind: Option<ShardRepairKind>,
    /// Whether the journal sequence above the baseline is intact.
    pub sequence_intact: bool,
    /// Signed sum of every journal line of the shard (the truth the projection must match).
    pub journal_sum: Decimal,
    /// Highest sequence number found in the journal, `None` when the shard has no lines.
    pub journal_max_seq: Option<i64>,
    pub before: ShardRepairState,
    pub after: ShardRepairState,
    /// Stable change-detection token over the five inputs.
    ///
    /// The TypeScript hashes the full aggregate set with SHA-256; this crate deliberately does not
    /// depend on `sha2`, so the token is FNV-1a 32 over a canonical string (`fnv1a32:<8 hex>`). Both
    /// the preview and the apply compute it with this same function, so an equality check between
    /// them keeps the TypeScript guarantee (it refuses a plan that changed). Do not treat it as a
    /// security digest. Facts the reduced input set does not carry (the checkpoint, the status, the
    /// per-baseline counts) are not part of the token; the database adapter compares those itself.
    pub plan_hash: String,
}

impl ShardRepairPlan {
    /// `after.balance - before.balance`: how far the stored balance moves
    /// (port of `plan.delta`, `ShardRepair.ts:301`). Negative when the projection overstates it.
    #[must_use]
    pub fn correction(&self) -> Decimal {
        self.after.balance - self.before.balance
    }
}

/// Port of `buildPlan` (`ShardRepair.ts:246-304`): decides the repair from the journal truth and the
/// shard projection.
///
/// ```text
/// needs_repair = !(sequence_intact && shard_balance == journal_sum)
/// kind         = None if healthy, else RECOMPUTE when intact, REBASELINE when damaged
/// after.balance    = journal_sum
/// after.line_seq   = line_seq                                  (intact)
///                  = max(line_seq, journal_max_seq, baseline)   (damaged; never reuse a number)
/// after.baseline   = baseline_seq                              (intact)
///                  = after.line_seq                            (damaged; exempt the damaged history)
/// ```
///
/// The TypeScript additionally requires the checkpoint to be proven and the failure kind to be
/// `OK`; those are not inputs here (see the module docs). A negative `shard_line_seq` or a
/// `line_seq` below the baseline is treated as damaged, exactly like the TS count comparison
/// rejects it.
#[must_use]
pub fn plan_shard_repair(
    journal_sum: Decimal,
    journal_max_seq: Option<i64>,
    shard_balance: Decimal,
    shard_line_seq: i64,
    baseline_seq: i64,
) -> ShardRepairPlan {
    let sequence_intact = match journal_max_seq {
        Some(max_seq) => match shard_line_seq.cmp(&baseline_seq) {
            // A sequence below its baseline is corrupt: treat it as damaged.
            Ordering::Less => false,
            // No line is expected above the baseline; one found above it is damage.
            Ordering::Equal => max_seq <= baseline_seq,
            // Every line up to the high-water mark must be present, so the highest number
            // found is exactly the high-water mark.
            Ordering::Greater => max_seq == shard_line_seq,
        },
        // No lines at all: only intact when none is expected above the baseline.
        None => shard_line_seq <= baseline_seq,
    };

    let needs_repair = !(sequence_intact && shard_balance == journal_sum);
    let kind = if needs_repair {
        Some(if sequence_intact {
            ShardRepairKind::Recompute
        } else {
            ShardRepairKind::Rebaseline
        })
    } else {
        None
    };

    let highest = journal_max_seq.unwrap_or(0);
    let new_line_seq = if sequence_intact {
        shard_line_seq
    } else {
        // `baseline_seq` is included so a corrupt baseline can never move backwards; in every
        // reachable state it is already at or below `line_seq`.
        shard_line_seq.max(highest).max(baseline_seq).max(0)
    };
    let after = ShardRepairState {
        balance: journal_sum,
        line_seq: new_line_seq,
        baseline_seq: if sequence_intact {
            baseline_seq
        } else {
            new_line_seq
        },
    };

    let plan_hash = hash_plan(
        journal_sum,
        journal_max_seq,
        shard_balance,
        shard_line_seq,
        baseline_seq,
    );

    ShardRepairPlan {
        needs_repair,
        kind,
        sequence_intact,
        journal_sum,
        journal_max_seq,
        before: ShardRepairState {
            balance: shard_balance,
            line_seq: shard_line_seq,
            baseline_seq,
        },
        after,
        plan_hash,
    }
}

/// Canonical, deterministic change-detection token (`ShardRepair.ts:270-288` hashes the same
/// dimensions with SHA-256; see [`ShardRepairPlan::plan_hash`]).
fn hash_plan(
    journal_sum: Decimal,
    journal_max_seq: Option<i64>,
    shard_balance: Decimal,
    shard_line_seq: i64,
    baseline_seq: i64,
) -> String {
    let max_seq = match journal_max_seq {
        Some(seq) => seq.to_string(),
        None => "none".to_owned(),
    };
    let canonical = format!(
        "pg-shard-repair/v1|sum={}|max={}|balance={}|line_seq={}|baseline={}",
        money_for_hash(journal_sum),
        max_seq,
        money_for_hash(shard_balance),
        shard_line_seq,
        baseline_seq,
    );
    format!("fnv1a32:{:08x}", fnv1a32_utf16(&canonical))
}

/// Money in the canonical 4-decimal form the TS `toFixed(4)` uses, so the token does not depend on
/// the decimal scale a caller happened to use (`100` and `100.0000` hash the same).
fn money_for_hash(value: Decimal) -> String {
    // `round_dp` keeps a value that already has fewer decimals as it is, so the explicit
    // precision formatting below is what pads it to exactly four places.
    let rounded = value.round_dp(4);
    let canonical = if rounded.is_zero() {
        Decimal::ZERO
    } else {
        rounded
    };
    format!("{canonical:.4}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use std::str::FromStr;

    fn dec(raw: &str) -> Decimal {
        Decimal::from_str(raw).expect("test decimal")
    }

    #[test]
    fn a_healthy_shard_needs_no_repair() {
        let plan = plan_shard_repair(dec("100.0000"), Some(5), dec("100.0000"), 5, 0);
        assert!(!plan.needs_repair);
        assert_eq!(plan.kind, None);
        assert!(plan.sequence_intact);
        assert!(plan.correction().is_zero());
        assert_eq!(plan.after, plan.before);
        assert_eq!(plan.after.balance, dec("100"));
        assert_eq!(plan.after.line_seq, 5);
        assert_eq!(plan.after.baseline_seq, 0);
    }

    #[test]
    fn parity_drift_with_an_intact_sequence_is_recomputed() {
        let plan = plan_shard_repair(dec("100.0000"), Some(5), dec("99.5000"), 5, 0);
        assert!(plan.needs_repair);
        assert_eq!(plan.kind, Some(ShardRepairKind::Recompute));
        assert!(plan.sequence_intact);
        assert_eq!(plan.after.balance, dec("100.0000"));
        assert_eq!(plan.after.line_seq, 5);
        assert_eq!(plan.after.baseline_seq, 0);
        assert_eq!(plan.correction(), dec("0.5000"));
    }

    #[test]
    fn a_missing_line_forces_a_rebaseline() {
        // The shard says it has five lines, the journal only reaches sequence 4.
        let plan = plan_shard_repair(dec("90.0000"), Some(4), dec("100.0000"), 5, 0);
        assert!(plan.needs_repair);
        assert_eq!(plan.kind, Some(ShardRepairKind::Rebaseline));
        assert!(!plan.sequence_intact);
        assert_eq!(plan.after.balance, dec("90.0000"));
        // The stored high-water mark is kept: a number is never reused.
        assert_eq!(plan.after.line_seq, 5);
        // The damaged history is exempt from the gapless proof.
        assert_eq!(plan.after.baseline_seq, 5);
        assert_eq!(plan.correction(), dec("-10.0000"));
    }

    #[test]
    fn a_line_above_the_high_water_mark_moves_the_baseline() {
        let plan = plan_shard_repair(dec("120.0000"), Some(7), dec("100.0000"), 5, 0);
        assert_eq!(plan.kind, Some(ShardRepairKind::Rebaseline));
        assert_eq!(plan.after.line_seq, 7);
        assert_eq!(plan.after.baseline_seq, 7);
        assert_eq!(plan.correction(), dec("20.0000"));
    }

    #[test]
    fn a_baseline_exempts_the_damaged_history() {
        // Baseline 9, high-water 10: exactly one line is expected above it, and sequence 10 exists.
        let plan = plan_shard_repair(dec("50.0000"), Some(10), dec("50.0000"), 10, 9);
        assert!(plan.sequence_intact);
        assert!(!plan.needs_repair);
        assert_eq!(plan.after.baseline_seq, 9);
    }

    #[test]
    fn an_empty_shard_is_healthy() {
        let plan = plan_shard_repair(Decimal::ZERO, None, Decimal::ZERO, 0, 0);
        assert!(plan.sequence_intact);
        assert!(!plan.needs_repair);
        assert_eq!(plan.kind, None);
        assert!(plan.correction().is_zero());
    }

    #[test]
    fn an_empty_journal_against_an_expected_sequence_is_damaged() {
        let plan = plan_shard_repair(Decimal::ZERO, None, Decimal::ZERO, 3, 0);
        assert!(!plan.sequence_intact);
        assert_eq!(plan.kind, Some(ShardRepairKind::Rebaseline));
        assert_eq!(plan.after.line_seq, 3);
        assert_eq!(plan.after.baseline_seq, 3);
    }

    #[test]
    fn a_sequence_below_the_baseline_is_damaged() {
        let plan = plan_shard_repair(dec("10.0000"), Some(4), dec("10.0000"), 3, 9);
        assert!(!plan.sequence_intact);
        assert_eq!(plan.kind, Some(ShardRepairKind::Rebaseline));
        assert_eq!(plan.after.line_seq, 9);
        assert_eq!(plan.after.baseline_seq, 9);
        assert!(plan.correction().is_zero());
    }

    #[test]
    fn a_sequence_equal_to_the_baseline_with_a_line_above_it_is_damaged() {
        let plan = plan_shard_repair(dec("10.0000"), Some(10), dec("10.0000"), 9, 9);
        assert!(!plan.sequence_intact);
        assert_eq!(plan.kind, Some(ShardRepairKind::Rebaseline));
        assert_eq!(plan.after.line_seq, 10);
    }

    #[test]
    fn the_plan_hash_is_deterministic_and_sensitive_to_every_input() {
        let base = plan_shard_repair(dec("100.0000"), Some(5), dec("99.5000"), 5, 0);
        let same = plan_shard_repair(dec("100"), Some(5), dec("99.5"), 5, 0);
        assert_eq!(base.plan_hash, same.plan_hash);
        assert!(base.plan_hash.starts_with("fnv1a32:"));
        assert_eq!(base.plan_hash.len(), "fnv1a32:".len() + 8);

        let changed_sum = plan_shard_repair(dec("100.0001"), Some(5), dec("99.5000"), 5, 0);
        let changed_max = plan_shard_repair(dec("100.0000"), Some(6), dec("99.5000"), 5, 0);
        let changed_balance = plan_shard_repair(dec("100.0000"), Some(5), dec("99.5001"), 5, 0);
        let changed_seq = plan_shard_repair(dec("100.0000"), Some(5), dec("99.5000"), 6, 0);
        let changed_baseline = plan_shard_repair(dec("100.0000"), Some(5), dec("99.5000"), 5, 1);
        for other in [
            changed_sum,
            changed_max,
            changed_balance,
            changed_seq,
            changed_baseline,
        ] {
            assert_ne!(base.plan_hash, other.plan_hash);
        }

        let no_max = plan_shard_repair(dec("100.0000"), None, dec("99.5000"), 5, 0);
        assert_ne!(base.plan_hash, no_max.plan_hash);
    }

    #[test]
    fn repair_kind_text_matches_the_database_enum() {
        assert_eq!(ShardRepairKind::Recompute.as_str(), "RECOMPUTE");
        assert_eq!(ShardRepairKind::Rebaseline.as_str(), "REBASELINE");
        assert_eq!(ShardRepairKind::Recompute.to_string(), "RECOMPUTE");
    }
}
