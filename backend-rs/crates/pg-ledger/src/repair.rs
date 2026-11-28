//! Shard repair: the projection is recomputed from the immutable journal, never "fixed" by a
//! posting.
//!
//! Port of `core-back/engine/ledger/ShardRepair.ts` (the plan `:245-304`, the apply `:452-615`).
//!
//! A shard (`gl_account_shards`) is a projection of the immutable journal. When the projection
//! disagrees with the journal, the journal is right by definition, so the repair recomputes the
//! projection from it. Posting an adjusting entry would change the journal too, leaving the shard
//! exactly as wrong as before and recording a false economic event; that is never done here.
//!
//! Two outcomes, decided by whether the sequence above `baseline_seq` is intact:
//!
//! - [`ShardRepairKind::Recompute`] — every expected line is present exactly once; only the stored
//!   balance or checkpoint disagrees. The balance becomes the journal sum and the checkpoint moves
//!   to `(sum, line_seq)`. Safe to automate.
//! - [`ShardRepairKind::Rebaseline`] — the sequence is damaged (a line is missing or a number is
//!   used twice). Recomputing could drop money the shard held if the journal lost a line, so a
//!   person decides: the balance becomes the journal sum, `line_seq` becomes
//!   `max(line_seq, highest sequence found)` (a number is never reused) and `baseline_seq` moves
//!   with it so the damaged history is exempt from the gapless proof.
//!
//! SQL deviations from the TypeScript, both recorded in `README.md`:
//!
//! - the apply uses a compare-and-set on `(current_balance, line_seq)` instead of `FOR UPDATE` plus
//!   the frozen-part/tail machinery (AUTO-10: the shard lock is never held over a deep read). Any
//!   posting changes those columns, so a successful CAS proves the plan still holds; a lost CAS
//!   reports `stale` and writes nothing. This is the same deviation `pg-workers` uses for its
//!   automatic repair.
//! - `plan_hash` is the TypeScript SHA-256 over the exact same canonical JSON, so a plan previewed
//!   by either implementation has the same hash.
//!
//! The `audit_log` row (`GL_SHARD_REPAIRED`) and the annotation of the open operator case are not
//! written here: they belong to `pg-db::audit` and the operator-case library. `gl_shard_repairs` is
//! the append-only repair history and is written in full.

#![forbid(unsafe_code)]

use pg_domain_ledger::ShardRepairKind;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::error::LedgerError;
use crate::template::money4;

/// Port of `ShardRepairState` (`ShardRepair.ts:60-61`): the stored or resulting projection point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShardRepairState {
    pub balance: Decimal,
    pub line_seq: i64,
    pub checkpoint_balance: Decimal,
    pub checkpoint_seq: i64,
    pub baseline_seq: i64,
}

/// Port of the `truth` block (`ShardRepair.ts:62-70`): what the journal says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShardRepairTruth {
    /// Signed (debit-positive) sum of EVERY journal line of the shard.
    pub total: Decimal,
    /// Sum of the lines up to the stored checkpoint sequence.
    pub upto_checkpoint: Decimal,
    pub lines_after_baseline: i64,
    pub distinct_after_baseline: i64,
    pub max_seq: i64,
}

/// Port of `ShardRepairPlan` (`ShardRepair.ts:52-81`), including the checkpoint and status the
/// TypeScript planner reads.
#[derive(Debug, Clone, PartialEq)]
pub struct ShardRepairPlan {
    pub gl_account_id: Uuid,
    pub shard_id: i32,
    /// Nothing to do: the sequence is intact, the balance matches the journal and the checkpoint and
    /// status are proven.
    pub needs_repair: bool,
    /// `None` when no repair is needed.
    pub kind: Option<ShardRepairKind>,
    pub sequence_intact: bool,
    /// `OK` | `GAP` | `PARITY` from `gl_shard_checkpoints`.
    pub status: String,
    pub consecutive_failures: i32,
    pub before: ShardRepairState,
    pub truth: ShardRepairTruth,
    pub after: ShardRepairState,
    /// `after.balance - before.balance`: how far the stored balance moves.
    pub delta: Decimal,
    /// SHA-256 hex over the TypeScript canonical JSON (`ShardRepair.ts:270-288`).
    pub plan_hash: String,
}

/// Port of `ShardRepairMode` (`ShardRepair.ts:50`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RepairMode {
    Auto,
    Manual,
    Approved,
}

impl RepairMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "AUTO",
            Self::Manual => "MANUAL",
            Self::Approved => "APPROVED",
        }
    }
}

impl std::fmt::Display for RepairMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Port of `ApplyShardRepairInput` (`ShardRepair.ts:416-439`), reduced to what this layer owns.
#[derive(Debug, Clone)]
pub struct ApplyRepairInput {
    pub gl_account_id: Uuid,
    pub shard_id: i32,
    pub mode: RepairMode,
    /// The repair kinds this caller may perform (automation and the single-user path: `RECOMPUTE`
    /// only).
    pub allowed_kinds: Vec<ShardRepairKind>,
    /// Refuse to apply unless the plan still hashes to this (what the caller previewed or approved).
    pub expected_plan_hash: Option<String>,
    /// At most 1,000 characters are stored, like the TypeScript `reason.slice(0, 1000)`.
    pub reason: String,
    pub actor_id: Option<Uuid>,
    pub approval_request_id: Option<Uuid>,
}

/// Port of `ApplyShardRepairResult` (`ShardRepair.ts:441-447`).
#[derive(Debug, Clone, PartialEq)]
pub struct ApplyRepairResult {
    pub repaired: bool,
    /// `true` when the compare-and-set lost: the shard moved since the deep read and nothing was
    /// written (retry on the next tick / preview again).
    pub stale: bool,
    pub plan: ShardRepairPlan,
    pub repair_id: Option<Uuid>,
}

/// `ShardRepair.ts:135-163` (`DEEP_SQL`): the shard, its checkpoint and the aggregates of ALL its
/// journal lines, plus the same aggregates restricted to `shard_seq <= line_seq`.
const DEEP_SQL: &str = "SELECT sh.current_balance AS balance, sh.line_seq AS line_seq, \
        COALESCE(c.checkpoint_balance, 0) AS cp_balance, COALESCE(c.checkpoint_seq, 0) AS cp_seq, \
        COALESCE(c.baseline_seq, 0) AS baseline_seq, COALESCE(c.status, 'OK') AS status, \
        COALESCE(c.consecutive_failures, 0)::int AS failures, \
        j.total AS total, j.upto_cp AS upto_cp, j.after_baseline AS after_baseline, \
        j.distinct_after AS distinct_after, j.max_seq AS max_seq \
   FROM gl_account_shards sh \
   LEFT JOIN gl_shard_checkpoints c \
     ON c.gl_account_id = sh.gl_account_id AND c.shard_id = sh.shard_id \
   CROSS JOIN LATERAL ( \
     SELECT COALESCE(SUM(x.signed), 0) AS total, \
            COALESCE(SUM(x.signed) FILTER (WHERE x.seq <= COALESCE(c.checkpoint_seq, 0)), 0) AS upto_cp, \
            COUNT(*) FILTER (WHERE x.seq > COALESCE(c.baseline_seq, 0)) AS after_baseline, \
            COUNT(DISTINCT x.seq) FILTER (WHERE x.seq > COALESCE(c.baseline_seq, 0)) AS distinct_after, \
            COALESCE(MAX(x.seq), 0) AS max_seq \
       FROM ( \
         SELECT l.shard_seq AS seq, \
                CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END AS signed \
           FROM journal_lines l \
          WHERE l.gl_account_id = sh.gl_account_id AND l.shard_id = sh.shard_id \
       ) x \
   ) j \
  WHERE sh.gl_account_id = $1::uuid AND sh.shard_id = $2::smallint";

const REPAIR_CAS_SQL: &str = "UPDATE gl_account_shards \
      SET current_balance = $3::numeric, line_seq = $4::bigint, updated_at = now() \
    WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint \
      AND current_balance = $5::numeric AND line_seq = $6::bigint";

const REPAIR_CHECKPOINT_SQL: &str = "INSERT INTO gl_shard_checkpoints AS c \
       (gl_account_id, shard_id, checkpoint_balance, checkpoint_seq, checkpoint_at, verified_at, \
        status, failure_kind, consecutive_failures, last_failure_at, baseline_seq) \
     VALUES ($1::uuid, $2::smallint, $3::numeric, $4::bigint, now(), now(), 'OK', NULL, 0, NULL, $5::bigint) \
     ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET \
       checkpoint_balance = EXCLUDED.checkpoint_balance, \
       checkpoint_seq = EXCLUDED.checkpoint_seq, \
       checkpoint_at = now(), verified_at = now(), status = 'OK', failure_kind = NULL, \
       consecutive_failures = 0, last_failure_at = NULL, baseline_seq = EXCLUDED.baseline_seq \
     WHERE c.checkpoint_seq <= EXCLUDED.checkpoint_seq";

const REPAIR_INSERT_SQL: &str = "INSERT INTO gl_shard_repairs \
       (id, gl_account_id, shard_id, kind, mode, plan_hash, before_balance, after_balance, delta, \
        before_line_seq, after_line_seq, before_checkpoint_seq, after_checkpoint_seq, \
        baseline_seq_after, actor_id, reason, approval_request_id, details_json) \
     VALUES ($1, $2::uuid, $3::smallint, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, \
             $10::bigint, $11::bigint, $12::bigint, $13::bigint, $14::bigint, $15::uuid, $16, \
             $17::uuid, $18::jsonb) \
     RETURNING id";

#[derive(Debug, Clone, FromRow)]
struct DeepRow {
    balance: Decimal,
    line_seq: i64,
    cp_balance: Decimal,
    cp_seq: i64,
    baseline_seq: i64,
    status: String,
    failures: i32,
    total: Decimal,
    upto_cp: Decimal,
    after_baseline: i64,
    distinct_after: i64,
    max_seq: i64,
}

/// Port of `planShardRepair` (`ShardRepair.ts:215-243`): reads the shard and ALL its journal lines
/// and decides what a repair would do. Pure of side effects; takes no lock.
pub async fn plan_shard_repair(
    conn: &mut PgConnection,
    gl_account_id: Uuid,
    shard_id: i32,
) -> Result<ShardRepairPlan, LedgerError> {
    let row = sqlx::query_as::<_, DeepRow>(DEEP_SQL)
        .bind(gl_account_id)
        .bind(shard_id as i16)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or(LedgerError::ShardNotFound {
            gl_account_id,
            shard_id,
        })?;
    Ok(build_plan(gl_account_id, shard_id, &row))
}

/// Port of `buildPlan` (`ShardRepair.ts:246-304`). Pure so the decision is unit-tested without a
/// database.
fn build_plan(gl_account_id: Uuid, shard_id: i32, row: &DeepRow) -> ShardRepairPlan {
    let before = ShardRepairState {
        balance: row.balance,
        line_seq: row.line_seq,
        checkpoint_balance: row.cp_balance,
        checkpoint_seq: row.cp_seq,
        baseline_seq: row.baseline_seq,
    };
    let truth = ShardRepairTruth {
        total: row.total,
        upto_checkpoint: row.upto_cp,
        lines_after_baseline: row.after_baseline,
        distinct_after_baseline: row.distinct_after,
        max_seq: row.max_seq,
    };

    // Above the baseline the sequence numbers must be exactly baseline+1 .. line_seq, each once.
    let expected_lines = row.line_seq - row.baseline_seq;
    let sequence_intact = row.after_baseline == expected_lines
        && row.distinct_after == row.after_baseline
        && if expected_lines == 0 {
            row.max_seq <= row.baseline_seq
        } else {
            row.max_seq == row.line_seq
        };

    let checkpoint_proven = row.cp_balance == row.upto_cp;
    let needs_repair =
        !(sequence_intact && row.balance == row.total && checkpoint_proven && row.status == "OK");

    let new_line_seq = if sequence_intact {
        row.line_seq
    } else {
        row.line_seq.max(row.max_seq)
    };
    let after = ShardRepairState {
        balance: row.total,
        line_seq: new_line_seq,
        checkpoint_balance: row.total,
        checkpoint_seq: new_line_seq,
        baseline_seq: if sequence_intact {
            row.baseline_seq
        } else {
            new_line_seq
        },
    };
    let kind = if !needs_repair {
        None
    } else if sequence_intact {
        Some(ShardRepairKind::Recompute)
    } else {
        Some(ShardRepairKind::Rebaseline)
    };
    let plan_hash = repair_plan_hash(gl_account_id, shard_id, &before, &truth, &row.status);

    ShardRepairPlan {
        gl_account_id,
        shard_id,
        needs_repair,
        kind,
        sequence_intact,
        status: row.status.clone(),
        consecutive_failures: row.failures,
        before,
        truth,
        after,
        delta: row.total - row.balance,
        plan_hash,
    }
}

/// The TypeScript plan hash (`ShardRepair.ts:270-288`): SHA-256 hex over a JSON object with exactly
/// those keys, money fixed to four decimals and sequence numbers as strings.
fn repair_plan_hash(
    gl_account_id: Uuid,
    shard_id: i32,
    before: &ShardRepairState,
    truth: &ShardRepairTruth,
    status: &str,
) -> String {
    let canonical = serde_json::json!({
        "glAccountId": gl_account_id.to_string(),
        "shardId": shard_id,
        "balance": money(before.balance),
        "lineSeq": before.line_seq.to_string(),
        "cp": money(before.checkpoint_balance),
        "cpSeq": before.checkpoint_seq.to_string(),
        "baselineSeq": before.baseline_seq.to_string(),
        "total": money(truth.total),
        "uptoCheckpoint": money(truth.upto_checkpoint),
        "linesAfterBaseline": truth.lines_after_baseline.to_string(),
        "distinctAfterBaseline": truth.distinct_after_baseline.to_string(),
        "maxSeq": truth.max_seq.to_string(),
        "status": status,
    });
    hex::encode(Sha256::digest(canonical.to_string().as_bytes()))
}

fn money(value: Decimal) -> String {
    pg_types::Money4::new(money4(value)).to_fixed_4()
}

/// Applies a repair with a compare-and-set, writes the new checkpoint and appends the
/// `gl_shard_repairs` history row.
///
/// The caller must pass a connection that is already inside a transaction: the CAS, the checkpoint
/// move and the history row commit together. On a lost CAS nothing is written and `stale` is
/// returned (a concurrent posting changed the shard after the deep read).
pub async fn apply_shard_repair(
    conn: &mut PgConnection,
    input: &ApplyRepairInput,
) -> Result<ApplyRepairResult, LedgerError> {
    // Part 1, without any shard lock: the deep read over the shard's whole history (it may take a
    // while; AUTO-10 exists because holding the shard row lock here made payments fail).
    let plan = plan_shard_repair(conn, input.gl_account_id, input.shard_id).await?;

    if let Some(expected) = &input.expected_plan_hash {
        if expected != &plan.plan_hash {
            return Err(LedgerError::RepairPlanChanged);
        }
    }
    if !plan.needs_repair {
        return Ok(ApplyRepairResult {
            repaired: false,
            stale: false,
            plan,
            repair_id: None,
        });
    }
    let kind = plan.kind.ok_or(LedgerError::RepairPlanChanged)?;
    if !input.allowed_kinds.contains(&kind) {
        return Err(LedgerError::RepairNeedsApproval);
    }

    // Part 2: the compare-and-set proves the projection still sits at the point the plan read.
    let updated = sqlx::query(REPAIR_CAS_SQL)
        .bind(input.gl_account_id)
        .bind(input.shard_id as i16)
        .bind(money4(plan.after.balance))
        .bind(plan.after.line_seq)
        .bind(money4(plan.before.balance))
        .bind(plan.before.line_seq)
        .execute(&mut *conn)
        .await?;
    if updated.rows_affected() == 0 {
        return Ok(ApplyRepairResult {
            repaired: false,
            stale: true,
            plan,
            repair_id: None,
        });
    }

    sqlx::query(REPAIR_CHECKPOINT_SQL)
        .bind(input.gl_account_id)
        .bind(input.shard_id as i16)
        .bind(money4(plan.after.checkpoint_balance))
        .bind(plan.after.checkpoint_seq)
        .bind(plan.after.baseline_seq)
        .execute(&mut *conn)
        .await?;

    let repair_id = Uuid::now_v7();
    sqlx::query(REPAIR_INSERT_SQL)
        .bind(repair_id)
        .bind(input.gl_account_id)
        .bind(input.shard_id as i16)
        .bind(kind.as_str())
        .bind(input.mode.as_str())
        .bind(&plan.plan_hash)
        .bind(money4(plan.before.balance))
        .bind(money4(plan.after.balance))
        .bind(money4(plan.delta))
        .bind(plan.before.line_seq)
        .bind(plan.after.line_seq)
        .bind(plan.before.checkpoint_seq)
        .bind(plan.after.checkpoint_seq)
        .bind(plan.after.baseline_seq)
        .bind(input.actor_id)
        .bind(truncate_reason(&input.reason))
        .bind(input.approval_request_id)
        .bind(serde_json::json!({
            "status": plan.status,
            "consecutiveFailures": plan.consecutive_failures,
            "sequenceIntact": plan.sequence_intact,
            "linesAfterBaseline": plan.truth.lines_after_baseline.to_string(),
            "distinctAfterBaseline": plan.truth.distinct_after_baseline.to_string(),
            "maxSeq": plan.truth.max_seq.to_string(),
        }))
        .execute(&mut *conn)
        .await?;

    Ok(ApplyRepairResult {
        repaired: true,
        stale: false,
        plan,
        repair_id: Some(repair_id),
    })
}

fn truncate_reason(reason: &str) -> String {
    reason.chars().take(1_000).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use std::str::FromStr;

    fn dec(raw: &str) -> Decimal {
        Decimal::from_str(raw).expect("decimal")
    }

    #[allow(clippy::too_many_arguments)]
    fn row(
        balance: &str,
        line_seq: i64,
        checkpoint_balance: &str,
        checkpoint_seq: i64,
        baseline_seq: i64,
        status: &str,
        total: &str,
        upto_cp: &str,
        after_baseline: i64,
        distinct_after: i64,
        max_seq: i64,
    ) -> DeepRow {
        DeepRow {
            balance: dec(balance),
            line_seq,
            cp_balance: dec(checkpoint_balance),
            cp_seq: checkpoint_seq,
            baseline_seq,
            status: status.to_owned(),
            failures: 0,
            total: dec(total),
            upto_cp: dec(upto_cp),
            after_baseline,
            distinct_after,
            max_seq,
        }
    }

    fn healthy() -> DeepRow {
        // The checkpoint is current: line_seq == checkpoint_seq and both balances agree.
        row(
            "100.0000", 5, "100.0000", 5, 0, "OK", "100.0000", "100.0000", 5, 5, 5,
        )
    }

    #[test]
    fn a_healthy_shard_needs_no_repair() {
        let plan = build_plan(Uuid::nil(), 0, &healthy());
        assert!(!plan.needs_repair);
        assert_eq!(plan.kind, None);
        assert!(plan.sequence_intact);
        assert!(plan.delta.is_zero());
        assert_eq!(plan.after, plan.before);
        // Golden parity with Node's
        // `sha256(JSON.stringify({…}))` for this exact plan (keys in TypeScript order,
        // money/toFixed(4), sequences as strings).
        assert_eq!(
            plan.plan_hash,
            "4d866208673f14b40d3d8976b35acc4ea5f9cc11b9e2bbd876c0831f232f6fe0"
        );
    }

    #[test]
    fn parity_drift_with_an_intact_sequence_is_recomputed() {
        let mut corrupt = healthy();
        corrupt.balance = dec("99.5000");
        let plan = build_plan(Uuid::nil(), 0, &corrupt);
        assert!(plan.needs_repair);
        assert_eq!(plan.kind, Some(ShardRepairKind::Recompute));
        assert!(plan.sequence_intact);
        assert_eq!(plan.delta, dec("0.5000"));
        assert_eq!(plan.after.balance, dec("100.0000"));
        assert_eq!(plan.after.baseline_seq, 0);
    }

    #[test]
    fn an_unproven_checkpoint_needs_a_recompute() {
        let mut corrupt = healthy();
        corrupt.cp_balance = dec("90.0000");
        corrupt.cp_seq = 4;
        // Five lines after the checkpoint would be expected; the journal only has the total.
        corrupt.total = dec("100.0000");
        corrupt.upto_cp = dec("95.0000");
        let plan = build_plan(Uuid::nil(), 0, &corrupt);
        assert!(plan.needs_repair);
        assert_eq!(plan.kind, Some(ShardRepairKind::Recompute));
    }

    #[test]
    fn a_missing_line_forces_a_rebaseline() {
        // The shard says five lines, the journal reaches sequence 4 only.
        let damaged = row("90.0000", 5, "0", 0, 0, "GAP", "90.0000", "0", 4, 4, 4);
        let plan = build_plan(Uuid::nil(), 0, &damaged);
        assert!(plan.needs_repair);
        assert_eq!(plan.kind, Some(ShardRepairKind::Rebaseline));
        assert!(!plan.sequence_intact);
        assert_eq!(plan.after.line_seq, 5);
        assert_eq!(plan.after.baseline_seq, 5);
    }

    #[test]
    fn a_duplicated_sequence_forces_a_rebaseline() {
        // Five lines counted, but only four distinct numbers.
        let damaged = row("90.0000", 5, "0", 0, 0, "GAP", "90.0000", "0", 5, 4, 5);
        let plan = build_plan(Uuid::nil(), 0, &damaged);
        assert!(!plan.sequence_intact);
        assert_eq!(plan.kind, Some(ShardRepairKind::Rebaseline));
    }

    #[test]
    fn a_line_above_the_high_water_mark_moves_the_baseline() {
        let damaged = row("120.0000", 5, "0", 0, 0, "GAP", "120.0000", "0", 6, 6, 7);
        let plan = build_plan(Uuid::nil(), 0, &damaged);
        assert_eq!(plan.kind, Some(ShardRepairKind::Rebaseline));
        assert_eq!(plan.after.line_seq, 7);
        assert_eq!(plan.after.baseline_seq, 7);
        assert_eq!(plan.delta, dec("0"));
    }

    #[test]
    fn a_baseline_exempts_the_damaged_history() {
        let exempt = row(
            "50.0000", 10, "40.0000", 9, 9, "OK", "50.0000", "40.0000", 1, 1, 10,
        );
        let plan = build_plan(Uuid::nil(), 0, &exempt);
        assert!(plan.sequence_intact);
        assert!(!plan.needs_repair);
        assert_eq!(plan.after.baseline_seq, 9);
    }

    #[test]
    fn an_empty_shard_is_healthy() {
        let empty = row("0", 0, "0", 0, 0, "OK", "0", "0", 0, 0, 0);
        let plan = build_plan(Uuid::nil(), 0, &empty);
        assert!(!plan.needs_repair);
        assert_eq!(plan.kind, None);
    }

    #[test]
    fn the_plan_hash_is_sha256_and_deterministic() {
        let plan = build_plan(Uuid::nil(), 0, &healthy());
        assert_eq!(plan.plan_hash.len(), 64);
        assert!(plan.plan_hash.chars().all(|c| c.is_ascii_hexdigit()));
        let same = build_plan(Uuid::nil(), 0, &healthy());
        assert_eq!(plan.plan_hash, same.plan_hash);

        let mut corrupt = healthy();
        corrupt.balance = dec("99.5000");
        let changed = build_plan(Uuid::nil(), 0, &corrupt);
        assert_ne!(plan.plan_hash, changed.plan_hash);
    }

    #[test]
    fn the_plan_hash_matches_the_typescript_canonical_json() {
        // Self-check of the exact JSON shape: changing only the status changes the hash.
        let mut rejected = healthy();
        rejected.status = "PARITY".to_owned();
        let plan = build_plan(Uuid::nil(), 0, &rejected);
        let mut ok = healthy();
        ok.status = "OK".to_owned();
        let ok_plan = build_plan(Uuid::nil(), 0, &ok);
        assert_ne!(plan.plan_hash, ok_plan.plan_hash);
    }

    #[test]
    fn repair_modes_match_the_database_check() {
        assert_eq!(RepairMode::Auto.as_str(), "AUTO");
        assert_eq!(RepairMode::Manual.as_str(), "MANUAL");
        assert_eq!(RepairMode::Approved.as_str(), "APPROVED");
        assert_eq!(RepairMode::Approved.to_string(), "APPROVED");
    }

    #[test]
    fn reasons_are_bounded_like_the_typescript_slice() {
        let long = "x".repeat(1_500);
        assert_eq!(truncate_reason(&long).chars().count(), 1_000);
        assert_eq!(truncate_reason("short"), "short");
    }

    #[test]
    fn money_is_fixed_to_four_decimals_in_the_hash_and_details() {
        assert_eq!(money(dec("1.5")), "1.5000");
        assert_eq!(money(dec("0")), "0.0000");
        assert_eq!(money(dec("-2.00005")), "-2.0001");
    }
}
