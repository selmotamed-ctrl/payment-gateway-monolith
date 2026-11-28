//! Ledger checkpoint worker and the per-shard checkpoint service.
//!
//! Ports `core-back/engine/ledger/CheckpointService.ts` and
//! `core-back/engine/workers/LedgerCheckpointWorker.ts`.
//!
//! A checkpoint is a `(balance, sequence)` pair of ONE shard (`gl_shard_checkpoints`). Capturing a
//! shard is one snapshot statement that reads the shard, its checkpoint and the lines in
//! `(checkpoint_seq, line_seq]`, proves GAPLESS and PARITY, and only then moves the checkpoint with a
//! monotonic upsert. No lock is taken on the shard or the account, so payments are never delayed.
//!
//! Automatic repair is deliberately narrow (`shouldAutoRepair`): only a persistent `PARITY` failure
//! whose sequence is intact and whose correction is within the amount cap is recomputed from the
//! journal — never a `GAP`, never a `REBASELINE`, never without the consecutive-failure threshold.
//! The decision reuses the pure planner of `pg-domain-ledger`. Deviation: the apply uses a
//! compare-and-set on `(current_balance, line_seq)` instead of `FOR UPDATE` plus a tail read; any
//! concurrent posting changes those columns, so the CAS proves the plan still holds and the shard
//! lock is never held over a heavy read (the AUTO-10 goal, without the frozen-part machinery).

#![forbid(unsafe_code)]

use std::collections::BTreeSet;
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDateTime;
use pg_domain_ledger::{plan_shard_repair, ShardRepairKind, ShardRepairPlan};
use rust_decimal::Decimal;
use sqlx::{PgPool, Row};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::cases::{
    annotate_open_case, ensure_system_actor, ledger_shard_subject_key, raise_ledger_case,
    write_system_audit, CaseKind, SystemAudit,
};
use crate::db::now_utc;
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

pub const DEFAULT_MIN_LINES: i64 = 5_000;
pub const DEFAULT_MAX_AGE_MS: i64 = 15 * 60 * 1000;
pub const DEFAULT_RETRY_FAILED_MS: i64 = 10 * 60 * 1000;
pub const DEFAULT_SWEEP_AUDIT_EVERY_MS: i64 = 60 * 60 * 1000;
pub const DEFAULT_AUTO_REPAIR_MAX_LINES_OUTSIDE_WINDOW: i64 = 500_000;

/// `ShardCaptureStatus` (`CheckpointService.ts:21`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShardCaptureStatus {
    Advanced,
    Noop,
    Gap,
    Parity,
}

impl ShardCaptureStatus {
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

#[derive(Debug, Clone, PartialEq)]
pub struct ShardCaptureResult {
    pub gl_account_id: Uuid,
    pub shard_id: i32,
    pub status: ShardCaptureStatus,
    pub balance: Decimal,
    pub line_seq: i64,
    pub previous_seq: i64,
    pub checkpoint_seq: i64,
    pub checkpoint_balance: Decimal,
    pub lines_covered: i64,
    pub lines_found: i64,
    pub drift: Decimal,
    pub first_failure: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointCandidate {
    pub gl_account_id: Uuid,
    pub shard_id: i32,
    pub pending_lines: i64,
}

/// One capture snapshot (`CheckpointService.ts` `ShardSnapshotRow`), exposed for the pure judge.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SnapshotRow {
    pub balance: Decimal,
    pub line_seq: i64,
    pub cp_balance: Decimal,
    pub cp_seq: i64,
    pub found: i64,
    pub delta: Decimal,
}

/// The capture snapshot (`CheckpointService.ts:84-103`).
#[must_use]
pub fn snapshot_sql(with_hint: bool) -> String {
    let hint = if with_hint {
        "AND (s.cp_at IS NULL OR jl.created_at >= (s.cp_at AT TIME ZONE 'UTC') - make_interval(secs => $3::double precision))"
    } else {
        ""
    };
    format!(
        "WITH s AS (
        SELECT sh.current_balance AS balance, sh.line_seq AS line_seq,
               COALESCE(c.checkpoint_balance, 0) AS cp_balance, COALESCE(c.checkpoint_seq, 0) AS cp_seq,
               c.checkpoint_at AS cp_at
          FROM gl_account_shards sh
          LEFT JOIN gl_shard_checkpoints c
            ON c.gl_account_id = sh.gl_account_id AND c.shard_id = sh.shard_id
         WHERE sh.gl_account_id = $1::uuid AND sh.shard_id = $2::smallint
    ), d AS (
        SELECT COUNT(jl.shard_seq)::bigint AS found,
               COALESCE(SUM(CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END), 0) AS delta
          FROM s
          LEFT JOIN journal_lines jl
            ON jl.gl_account_id = $1::uuid AND jl.shard_id = $2::smallint
           AND jl.shard_seq > s.cp_seq AND jl.shard_seq <= s.line_seq
           {hint}
    )
    SELECT s.balance::numeric AS balance, s.line_seq::bigint AS line_seq,
           s.cp_balance::numeric AS cp_balance, s.cp_seq::bigint AS cp_seq,
           (CASE WHEN s.line_seq > s.cp_seq THEN d.found ELSE 0 END)::bigint AS found,
           d.delta::numeric AS delta
      FROM s, d"
    )
}

/// The monotonic advance (`CheckpointService.ts:180-195`).
pub const ADVANCE_SQL: &str = "INSERT INTO gl_shard_checkpoints AS c
     (gl_account_id, shard_id, checkpoint_balance, checkpoint_seq, checkpoint_at, verified_at,
      status, failure_kind, consecutive_failures)
   VALUES ($1::uuid, $2::smallint, $3::numeric, $4::bigint, now(), now(), 'OK', NULL, 0)
   ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET
     checkpoint_balance = EXCLUDED.checkpoint_balance,
     checkpoint_seq = EXCLUDED.checkpoint_seq,
     checkpoint_at = now(), verified_at = now(),
     status = 'OK', failure_kind = NULL, consecutive_failures = 0
   WHERE c.checkpoint_seq < EXCLUDED.checkpoint_seq
   RETURNING 1 AS moved";

/// A proven-consistent checkpoint with nothing to fold in.
pub const NOOP_REFRESH_SQL: &str = "UPDATE gl_shard_checkpoints
   SET verified_at = now(), status = 'OK', failure_kind = NULL, consecutive_failures = 0
 WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint
   AND (status <> 'OK' OR verified_at IS NULL OR verified_at < now() - interval '1 minute')";

/// Records a refused capture and its consecutive-failure count (`CheckpointService.ts:211-225`).
pub const RECORD_FAILURE_SQL: &str = "INSERT INTO gl_shard_checkpoints AS c
     (gl_account_id, shard_id, status, failure_kind, consecutive_failures, last_failure_at)
   VALUES ($1::uuid, $2::smallint, $3, $4, 1, now())
   ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET
     status = EXCLUDED.status, failure_kind = EXCLUDED.failure_kind,
     consecutive_failures = c.consecutive_failures + 1, last_failure_at = now()
   RETURNING consecutive_failures";

/// `findCandidates` (`CheckpointService.ts:252-269`).
pub const FIND_CANDIDATES_SQL: &str = "SELECT s.gl_account_id AS id, s.shard_id,
        (s.line_seq - COALESCE(c.checkpoint_seq, 0))::bigint AS pending
   FROM gl_account_shards s
   LEFT JOIN gl_shard_checkpoints c
     ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
  WHERE s.line_seq > COALESCE(c.checkpoint_seq, 0)
    AND (s.line_seq - COALESCE(c.checkpoint_seq, 0) >= $1::bigint
         OR c.checkpoint_at IS NULL
         OR c.checkpoint_at < now() - make_interval(secs => $2::double precision))
    AND (COALESCE(c.status, 'OK') = 'OK'
         OR c.last_failure_at IS NULL
         OR c.last_failure_at < now() - make_interval(secs => $3::double precision))
  ORDER BY (s.line_seq - COALESCE(c.checkpoint_seq, 0)) DESC
  LIMIT $4::int";

/// The failing shards one automatic-repair pass may look at (`LedgerCheckpointWorker.ts:143-151`).
pub const FAILING_SHARDS_SQL: &str = "SELECT c.gl_account_id AS id, c.shard_id,
        GREATEST(COALESCE(sh.line_seq, 0) - COALESCE(c.baseline_seq, 0), 0)::bigint AS approx_lines
   FROM gl_shard_checkpoints c
   LEFT JOIN gl_account_shards sh
     ON sh.gl_account_id = c.gl_account_id AND sh.shard_id = c.shard_id
  WHERE c.status = 'PARITY' AND c.consecutive_failures >= $1::int
  ORDER BY c.last_failure_at ASC NULLS FIRST
  LIMIT $2::int";

/// The deep read of one shard (`ShardRepair.ts` `DEEP_SQL`, totals only for the reduced planner).
pub const DEEP_READ_SQL: &str = "SELECT sh.current_balance AS balance, sh.line_seq AS line_seq,
        COALESCE(c.checkpoint_seq, 0) AS cp_seq,
        COALESCE(c.baseline_seq, 0) AS baseline_seq, COALESCE(c.status, 'OK') AS status,
        COALESCE(c.consecutive_failures, 0) AS failures,
        COALESCE(j.total, 0) AS total, COALESCE(j.max_seq, 0) AS max_seq
   FROM gl_account_shards sh
   LEFT JOIN gl_shard_checkpoints c
     ON c.gl_account_id = sh.gl_account_id AND c.shard_id = sh.shard_id
   CROSS JOIN LATERAL (
     SELECT SUM(x.signed) AS total, MAX(x.seq) AS max_seq
       FROM (
         SELECT l.shard_seq AS seq,
                CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END AS signed
           FROM journal_lines l
          WHERE l.gl_account_id = sh.gl_account_id AND l.shard_id = sh.shard_id
       ) x
   ) j
  WHERE sh.gl_account_id = $1::uuid AND sh.shard_id = $2::smallint";

/// Compare-and-set on the projection (`current_balance`, `line_seq`). Any posting changes them.
pub const REPAIR_CAS_SQL: &str = "UPDATE gl_account_shards
   SET current_balance = $3::numeric, line_seq = $4::bigint, updated_at = now()
 WHERE gl_account_id = $1::uuid AND shard_id = $2::smallint
   AND current_balance = $5::numeric AND line_seq = $6::bigint";

pub const REPAIR_CHECKPOINT_SQL: &str = "INSERT INTO gl_shard_checkpoints AS c
     (gl_account_id, shard_id, checkpoint_balance, checkpoint_seq, checkpoint_at, verified_at,
      status, failure_kind, consecutive_failures, last_failure_at, baseline_seq)
   VALUES ($1::uuid, $2::smallint, $3::numeric, $4::bigint, now(), now(), 'OK', NULL, 0, NULL, $5::bigint)
   ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET
     checkpoint_balance = EXCLUDED.checkpoint_balance,
     checkpoint_seq = EXCLUDED.checkpoint_seq,
     checkpoint_at = now(), verified_at = now(), status = 'OK', failure_kind = NULL,
     consecutive_failures = 0, last_failure_at = NULL, baseline_seq = EXCLUDED.baseline_seq";

pub const REPAIR_INSERT_SQL: &str = "INSERT INTO gl_shard_repairs
     (id, gl_account_id, shard_id, kind, mode, plan_hash, before_balance, after_balance, delta,
      before_line_seq, after_line_seq, before_checkpoint_seq, after_checkpoint_seq,
      baseline_seq_after, actor_id, reason, approval_request_id, details_json)
   VALUES ($1, $2::uuid, $3::smallint, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric,
           $10::bigint, $11::bigint, $12::bigint, $13::bigint, $14::bigint, $15::uuid, $16,
           NULL, $17::jsonb)
   RETURNING id";

#[derive(Debug, Clone)]
pub struct CheckpointService {
    pool: PgPool,
    margin_seconds: i64,
}

impl CheckpointService {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            margin_seconds: 2 * 86_400,
        }
    }

    #[must_use]
    pub fn with_margin(pool: PgPool, margin_seconds: i64) -> Self {
        Self {
            pool,
            margin_seconds,
        }
    }

    /// Reads and verifies one shard WITHOUT moving it (`inspectShard`).
    pub async fn inspect_shard(
        &self,
        gl_account_id: Uuid,
        shard_id: i32,
    ) -> Result<ShardCaptureResult, WorkerError> {
        let row = self.read_snapshot(gl_account_id, shard_id, true).await?;
        let Some(snapshot) = row else {
            return Err(WorkerError::Failed(format!(
                "GL account '{gl_account_id}' has no shard {shard_id}"
            )));
        };
        let mut verdict = judge(gl_account_id, shard_id, &snapshot);
        if verdict.status == ShardCaptureStatus::Gap {
            // The hint may have hidden a legitimately old line; look at the whole range first.
            if let Some(full) = self.read_snapshot(gl_account_id, shard_id, false).await? {
                verdict = judge(gl_account_id, shard_id, &full);
            }
        }
        Ok(verdict)
    }

    async fn read_snapshot(
        &self,
        gl_account_id: Uuid,
        shard_id: i32,
        with_hint: bool,
    ) -> Result<Option<SnapshotRow>, WorkerError> {
        let sql = snapshot_sql(with_hint);
        let mut query = sqlx::query_as::<_, SnapshotRow>(sqlx::AssertSqlSafe(sql))
            .bind(gl_account_id)
            .bind(shard_id);
        if with_hint {
            query = query.bind(self.margin_seconds as f64);
        }
        query
            .fetch_optional(&self.pool)
            .await
            .map_err(checkpoint_error)
    }

    /// Captures one shard (`captureShard`): ADVANCED moves the checkpoint, failures are recorded.
    pub async fn capture_shard(
        &self,
        gl_account_id: Uuid,
        shard_id: i32,
    ) -> Result<ShardCaptureResult, WorkerError> {
        let verdict = self.inspect_shard(gl_account_id, shard_id).await?;
        match verdict.status {
            ShardCaptureStatus::Advanced => {
                let moved = sqlx::query(ADVANCE_SQL)
                    .bind(gl_account_id)
                    .bind(shard_id)
                    .bind(verdict.checkpoint_balance)
                    .bind(verdict.checkpoint_seq)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(checkpoint_error)?;
                if moved.is_none() {
                    return Ok(ShardCaptureResult {
                        status: ShardCaptureStatus::Noop,
                        checkpoint_seq: verdict.previous_seq,
                        lines_covered: 0,
                        checkpoint_balance: verdict.checkpoint_balance,
                        ..verdict
                    });
                }
                Ok(verdict)
            }
            ShardCaptureStatus::Noop => {
                sqlx::query(NOOP_REFRESH_SQL)
                    .bind(gl_account_id)
                    .bind(shard_id)
                    .execute(&self.pool)
                    .await
                    .map_err(checkpoint_error)?;
                Ok(verdict)
            }
            ShardCaptureStatus::Gap | ShardCaptureStatus::Parity => {
                let failure_kind = if verdict.status == ShardCaptureStatus::Gap {
                    format!(
                        "found {} of {} lines",
                        verdict.lines_found,
                        verdict.line_seq - verdict.previous_seq
                    )
                } else {
                    format!("drift {}", verdict.drift)
                };
                let failures: i32 = sqlx::query(RECORD_FAILURE_SQL)
                    .bind(gl_account_id)
                    .bind(shard_id)
                    .bind(verdict.status.as_str())
                    .bind(failure_kind)
                    .fetch_one(&self.pool)
                    .await
                    .map_err(checkpoint_error)?
                    .try_get("consecutive_failures")
                    .map_err(checkpoint_error)?;
                Ok(ShardCaptureResult {
                    first_failure: failures == 1,
                    ..verdict
                })
            }
        }
    }

    /// Captures every shard row of one account (the manual "checkpoint now" action).
    pub async fn capture_account(
        &self,
        gl_account_id: Uuid,
    ) -> Result<Vec<ShardCaptureResult>, WorkerError> {
        let shards: Vec<i32> =
            sqlx::query_scalar("SELECT shard_id FROM gl_account_shards WHERE gl_account_id = $1::uuid ORDER BY shard_id")
                .bind(gl_account_id)
                .fetch_all(&self.pool)
                .await
                .map_err(checkpoint_error)?;
        let mut results = Vec::with_capacity(shards.len());
        for shard_id in shards {
            results.push(self.capture_shard(gl_account_id, shard_id).await?);
        }
        Ok(results)
    }

    /// Shards that deserve a checkpoint (`findCandidates`).
    pub async fn find_candidates(
        &self,
        min_lines: i64,
        max_age_seconds: i64,
        retry_failed_seconds: i64,
        limit: i64,
    ) -> Result<Vec<CheckpointCandidate>, WorkerError> {
        let rows = sqlx::query(FIND_CANDIDATES_SQL)
            .bind(min_lines)
            .bind(max_age_seconds as f64)
            .bind(retry_failed_seconds as f64)
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .map_err(checkpoint_error)?;
        Ok(rows
            .into_iter()
            .map(|row| CheckpointCandidate {
                gl_account_id: row.get("id"),
                shard_id: i32::from(row.get::<i16, _>("shard_id")),
                pending_lines: row.get("pending"),
            })
            .collect())
    }
}

/// `judge` (`CheckpointService.ts:142-170`).
#[must_use]
pub fn judge(gl_account_id: Uuid, shard_id: i32, row: &SnapshotRow) -> ShardCaptureResult {
    let expected_lines = row.line_seq - row.cp_seq;
    let expected_balance = row.cp_balance + row.delta;
    let drift = row.balance - expected_balance;
    let base = ShardCaptureResult {
        gl_account_id,
        shard_id,
        status: ShardCaptureStatus::Noop,
        balance: row.balance,
        line_seq: row.line_seq,
        previous_seq: row.cp_seq,
        checkpoint_seq: row.cp_seq,
        checkpoint_balance: row.cp_balance,
        lines_covered: 0,
        lines_found: row.found,
        drift,
        first_failure: false,
    };
    if row.found != expected_lines {
        return ShardCaptureResult {
            status: ShardCaptureStatus::Gap,
            ..base
        };
    }
    if !drift.is_zero() {
        return ShardCaptureResult {
            status: ShardCaptureStatus::Parity,
            ..base
        };
    }
    if expected_lines == 0 {
        return base;
    }
    ShardCaptureResult {
        status: ShardCaptureStatus::Advanced,
        checkpoint_seq: row.line_seq,
        checkpoint_balance: row.balance,
        lines_covered: expected_lines,
        ..base
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoRepairPolicy {
    pub enabled: bool,
    pub min_consecutive_failures: i32,
    pub max_abs_delta: Decimal,
    pub max_lines_outside_window: Option<i64>,
    /// `[start, end)` UTC hours; a full-day window when start == end.
    pub maintenance_window_utc: Option<(u32, u32)>,
}

impl Default for AutoRepairPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            min_consecutive_failures: 3,
            max_abs_delta: Decimal::from(100),
            max_lines_outside_window: Some(DEFAULT_AUTO_REPAIR_MAX_LINES_OUTSIDE_WINDOW),
            maintenance_window_utc: None,
        }
    }
}

/// `inMaintenanceWindow` (`ShardRepair.ts:381-388`).
#[must_use]
pub fn in_maintenance_window(now: NaiveDateTime, window: Option<(u32, u32)>) -> bool {
    use chrono::Timelike;
    let Some((start, end)) = window else {
        return false;
    };
    let hour = now.hour();
    let start = start % 24;
    let end = end % 24;
    if start == end {
        return true;
    }
    if start < end {
        hour >= start && hour < end
    } else {
        hour >= start || hour < end
    }
}

/// `repairSizeAllowed` (`ShardRepair.ts:391`).
#[must_use]
pub fn repair_size_allowed(lines: i64, policy: &AutoRepairPolicy, now: NaiveDateTime) -> bool {
    match policy.max_lines_outside_window {
        None => true,
        Some(limit) => {
            lines <= limit.max(0) || in_maintenance_window(now, policy.maintenance_window_utc)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoRepairVerdict {
    pub allowed: bool,
    pub reason: String,
}

/// `shouldAutoRepair` (`ShardRepair.ts:392-418`).
#[must_use]
pub fn should_auto_repair(
    plan: &ShardRepairPlan,
    checkpoint_status: &str,
    consecutive_failures: i32,
    policy: &AutoRepairPolicy,
    now: NaiveDateTime,
) -> AutoRepairVerdict {
    let denied = |reason: &str| AutoRepairVerdict {
        allowed: false,
        reason: reason.to_owned(),
    };
    if !policy.enabled {
        return denied("automatic repair is disabled");
    }
    if !plan.needs_repair || plan.kind.is_none() {
        return denied("the shard needs no repair");
    }
    if plan.kind != Some(ShardRepairKind::Recompute) {
        return denied(
            "the sequence is damaged: a person must decide (re-baseline needs approval)",
        );
    }
    if checkpoint_status != "PARITY" {
        return denied(&format!(
            "the failure kind is {checkpoint_status}, not PARITY"
        ));
    }
    if consecutive_failures < policy.min_consecutive_failures {
        return denied(&format!(
            "only {consecutive_failures} of {} consecutive failures seen",
            policy.min_consecutive_failures
        ));
    }
    if plan.correction().abs() > policy.max_abs_delta {
        return denied(&format!(
            "the correction {} exceeds the automatic limit {}",
            plan.correction(),
            policy.max_abs_delta
        ));
    }
    if !repair_size_allowed(plan.after.line_seq - plan.after.baseline_seq, policy, now) {
        return denied("the shard holds more lines than the automatic repair allows outside the maintenance window");
    }
    AutoRepairVerdict {
        allowed: true,
        reason: "persistent PARITY drift within the automatic limit, sequence intact".to_owned(),
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct DeepRow {
    balance: Decimal,
    line_seq: i64,
    cp_seq: i64,
    baseline_seq: i64,
    status: String,
    failures: i32,
    total: Decimal,
    max_seq: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct FailingShard {
    id: Uuid,
    shard_id: i16,
    approx_lines: i64,
}

#[derive(Debug, Clone)]
pub struct CheckpointConfig {
    pub interval_ms: u64,
    pub batch_size: i64,
    pub min_lines: i64,
    pub max_age_ms: i64,
    pub retry_failed_ms: i64,
    pub sweep_audit_every_ms: i64,
    pub auto_repair: Option<AutoRepairPolicy>,
    pub auto_repair_per_tick: i64,
}

impl Default for CheckpointConfig {
    fn default() -> Self {
        Self {
            interval_ms: 30_000,
            batch_size: 50,
            min_lines: DEFAULT_MIN_LINES,
            max_age_ms: DEFAULT_MAX_AGE_MS,
            retry_failed_ms: DEFAULT_RETRY_FAILED_MS,
            sweep_audit_every_ms: DEFAULT_SWEEP_AUDIT_EVERY_MS,
            auto_repair: Some(AutoRepairPolicy::default()),
            auto_repair_per_tick: 5,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct SweepTotals {
    shards: u64,
    lines: i64,
    failures: u64,
}

pub struct LedgerCheckpointWorker {
    service: CheckpointService,
    config: CheckpointConfig,
    state: parking_lot::Mutex<RepairState>,
}

#[derive(Debug, Default)]
struct RepairState {
    sweep: SweepTotals,
    last_sweep_ms: i64,
    declined: BTreeSet<String>,
}

impl LedgerCheckpointWorker {
    #[must_use]
    pub fn new(pool: PgPool, config: CheckpointConfig) -> Self {
        Self {
            service: CheckpointService::new(pool),
            config,
            state: parking_lot::Mutex::new(RepairState::default()),
        }
    }

    pub async fn tick_once(&self) -> Result<u64, WorkerError> {
        let candidates = self
            .service
            .find_candidates(
                self.config.min_lines,
                (self.config.max_age_ms / 1000).max(1),
                (self.config.retry_failed_ms / 1000).max(1),
                self.config.batch_size,
            )
            .await?;
        for candidate in &candidates {
            let result = self
                .service
                .capture_shard(candidate.gl_account_id, candidate.shard_id)
                .await?;
            match result.status {
                ShardCaptureStatus::Advanced => {
                    let mut state = self.state.lock();
                    state.sweep.shards += 1;
                    state.sweep.lines += result.lines_covered;
                }
                ShardCaptureStatus::Gap | ShardCaptureStatus::Parity => {
                    self.state.lock().sweep.failures += 1;
                    error!(
                        gl_account_id = %result.gl_account_id,
                        shard_id = result.shard_id,
                        kind = result.status.as_str(),
                        drift = %result.drift,
                        found = result.lines_found,
                        expected = result.line_seq - result.previous_seq,
                        "ledger shard checkpoint refused"
                    );
                    if result.first_failure {
                        self.alert_first_failure(&result).await;
                    }
                }
                ShardCaptureStatus::Noop => {}
            }
        }
        self.repair_persistent_failures().await?;
        self.flush_sweep_audit().await?;
        Ok(candidates.len() as u64)
    }

    async fn alert_first_failure(&self, result: &ShardCaptureResult) {
        let subject_key =
            ledger_shard_subject_key(&result.gl_account_id.to_string(), result.shard_id);
        let notes = format!(
            "Shard {} of GL account {} failed its checkpoint proof ({}): {} of {} lines found, drift {}. \
             The checkpoint was not moved.",
            result.shard_id,
            result.gl_account_id,
            result.status.as_str(),
            result.lines_found,
            result.line_seq - result.previous_seq,
            result.drift
        );
        let mut tx = match self.service.pool.begin().await {
            Ok(tx) => tx,
            Err(error) => {
                error!(%error, "ledger checkpoint: cannot open the alert transaction");
                return;
            }
        };
        let raised = raise_ledger_case(&mut tx, &subject_key, &notes, now_utc()).await;
        if raised.is_err() {
            error!("ledger checkpoint: cannot raise the shard case");
            return;
        }
        let audit = SystemAudit::new(
            "LEDGER_SHARD_CHECKPOINT_FAILED",
            "GL_ACCOUNT",
            &result.gl_account_id.to_string(),
            serde_json::json!({}),
            serde_json::json!({
                "shardId": result.shard_id,
                "kind": result.status.as_str(),
                "drift": result.drift.to_string(),
                "linesFound": result.lines_found,
                "linesExpected": result.line_seq - result.previous_seq,
            }),
        );
        if let Err(error) = write_system_audit(&mut tx, &audit).await {
            error!(%error, "ledger checkpoint: cannot audit the refused checkpoint");
            return;
        }
        if let Err(error) = tx.commit().await {
            error!(%error, "ledger checkpoint: cannot commit the alert");
        }
    }

    async fn repair_persistent_failures(&self) -> Result<(), WorkerError> {
        let Some(policy) = self.config.auto_repair.clone() else {
            return Ok(());
        };
        if !policy.enabled {
            return Ok(());
        }
        let failing = sqlx::query_as::<_, FailingShard>(FAILING_SHARDS_SQL)
            .bind(policy.min_consecutive_failures)
            .bind(self.config.auto_repair_per_tick)
            .fetch_all(&self.service.pool)
            .await
            .map_err(checkpoint_error)?;
        for shard in failing {
            let now = now_utc();
            if !repair_size_allowed(shard.approx_lines, &policy, now) {
                let shard_id = i32::from(shard.shard_id);
                let key = format!("{}:{shard_id}:size", shard.id);
                let mut state = self.state.lock();
                if !state.declined.contains(&key) {
                    state.declined.insert(key);
                    warn!(
                        gl_account_id = %shard.id,
                        shard_id = i32::from(shard.shard_id),
                        lines = shard.approx_lines,
                        limit = policy.max_lines_outside_window.unwrap_or_default(),
                        "ledger shard repair deferred to the maintenance window"
                    );
                }
                continue;
            }
            let deep = sqlx::query_as::<_, DeepRow>(DEEP_READ_SQL)
                .bind(shard.id)
                .bind(shard.shard_id)
                .fetch_optional(&self.service.pool)
                .await
                .map_err(checkpoint_error)?;
            let shard_id = i32::from(shard.shard_id);
            let Some(deep) = deep else {
                continue;
            };
            let plan = plan_shard_repair(
                deep.total,
                if deep.max_seq > 0 {
                    Some(deep.max_seq)
                } else {
                    None
                },
                deep.balance,
                deep.line_seq,
                deep.baseline_seq,
            );
            let verdict = should_auto_repair(&plan, &deep.status, deep.failures, &policy, now);
            if !verdict.allowed {
                let key = format!("{}:{shard_id}:{}", shard.id, plan.plan_hash);
                let mut state = self.state.lock();
                if !state.declined.contains(&key) {
                    state.declined.insert(key);
                    warn!(
                        gl_account_id = %shard.id,
                        shard_id,
                        reason = %verdict.reason,
                        delta = %plan.correction(),
                        "ledger shard repair left to a person"
                    );
                }
                continue;
            }
            match self
                .apply_repair(&shard, &deep, &plan, &verdict.reason)
                .await?
            {
                RepairApply::Stale => {
                    info!(
                        gl_account_id = %shard.id,
                        shard_id,
                        "ledger shard repair postponed: the shard moved while it was planned"
                    );
                }
                RepairApply::Applied(repair_id) => {
                    warn!(
                        gl_account_id = %shard.id,
                        shard_id,
                        delta = %plan.correction(),
                        %repair_id,
                        "ledger shard repaired automatically from the journal"
                    );
                    // Prove it: the next capture must pass.
                    let _ = self.service.capture_shard(shard.id, shard_id).await;
                }
            }
        }
        Ok(())
    }

    async fn apply_repair(
        &self,
        shard: &FailingShard,
        deep: &DeepRow,
        plan: &ShardRepairPlan,
        reason: &str,
    ) -> Result<RepairApply, WorkerError> {
        let mut tx = self.service.pool.begin().await.map_err(checkpoint_error)?;
        let shard_id = i32::from(shard.shard_id);
        let cas = sqlx::query(REPAIR_CAS_SQL)
            .bind(shard.id)
            .bind(shard_id)
            .bind(plan.after.balance)
            .bind(plan.after.line_seq)
            .bind(plan.before.balance)
            .bind(plan.before.line_seq)
            .execute(&mut *tx)
            .await
            .map_err(checkpoint_error)?;
        if cas.rows_affected() == 0 {
            tx.rollback().await.map_err(checkpoint_error)?;
            return Ok(RepairApply::Stale);
        }
        sqlx::query(REPAIR_CHECKPOINT_SQL)
            .bind(shard.id)
            .bind(shard_id)
            .bind(plan.after.balance)
            .bind(plan.after.line_seq)
            .bind(plan.after.baseline_seq)
            .execute(&mut *tx)
            .await
            .map_err(checkpoint_error)?;
        let actor_id = ensure_system_actor(&mut tx).await?;
        let repair_id: Uuid = sqlx::query_scalar(REPAIR_INSERT_SQL)
            .bind(Uuid::now_v7())
            .bind(shard.id)
            .bind(shard_id)
            .bind(ShardRepairKind::Recompute.as_str())
            .bind("AUTO")
            .bind(&plan.plan_hash)
            .bind(plan.before.balance)
            .bind(plan.after.balance)
            .bind(plan.correction())
            .bind(plan.before.line_seq)
            .bind(plan.after.line_seq)
            .bind(deep.cp_seq)
            .bind(plan.after.line_seq)
            .bind(plan.after.baseline_seq)
            .bind(actor_id)
            .bind(reason.chars().take(1000).collect::<String>())
            .bind(serde_json::json!({
                "sequenceIntact": plan.sequence_intact,
                "journalSum": plan.journal_sum.to_string(),
                "journalMaxSeq": plan.journal_max_seq,
                "planHash": plan.plan_hash,
            }))
            .fetch_one(&mut *tx)
            .await
            .map_err(checkpoint_error)?;
        let audit = SystemAudit::new(
            "GL_SHARD_REPAIRED",
            "GL_ACCOUNT",
            &shard.id.to_string(),
            serde_json::json!({
                "shardId": shard_id,
                "balance": plan.before.balance.to_string(),
                "lineSeq": plan.before.line_seq,
            }),
            serde_json::json!({
                "shardId": shard_id,
                "kind": ShardRepairKind::Recompute.as_str(),
                "mode": "AUTO",
                "balance": plan.after.balance.to_string(),
                "delta": plan.correction().to_string(),
                "lineSeq": plan.after.line_seq,
                "baselineSeq": plan.after.baseline_seq,
                "planHash": plan.plan_hash,
                "repairId": repair_id,
                "reason": reason,
            }),
        );
        write_system_audit(&mut tx, &audit).await?;
        let note = format!(
            "[AUTO] RECOMPUTE applied: balance {} -> {} (delta {}). Review and resolve this case.",
            plan.before.balance,
            plan.after.balance,
            plan.correction()
        );
        let subject_key = ledger_shard_subject_key(&shard.id.to_string(), shard_id);
        let _ =
            annotate_open_case(&mut tx, CaseKind::Mismatch, &subject_key, &note, now_utc()).await;
        tx.commit().await.map_err(checkpoint_error)?;
        Ok(RepairApply::Applied(repair_id))
    }

    async fn flush_sweep_audit(&self) -> Result<(), WorkerError> {
        let now = chrono::Utc::now().timestamp_millis();
        let (shards, lines, failures) = {
            let mut state = self.state.lock();
            if state.last_sweep_ms == 0 {
                state.last_sweep_ms = now;
            }
            if now - state.last_sweep_ms < self.config.sweep_audit_every_ms.max(1) {
                return Ok(());
            }
            state.last_sweep_ms = now;
            let sweep = std::mem::take(&mut state.sweep);
            (sweep.shards, sweep.lines, sweep.failures)
        };
        if shards == 0 && failures == 0 {
            return Ok(());
        }
        let audit = SystemAudit::new(
            "LEDGER_CHECKPOINT_SWEEP",
            "LEDGER",
            "checkpoint-worker",
            serde_json::json!({}),
            serde_json::json!({
                "shardsCheckpointed": shards,
                "linesCovered": lines,
                "failures": failures,
                "windowMs": self.config.sweep_audit_every_ms,
            }),
        );
        crate::cases::write_system_audit_pool(&self.service.pool, &audit).await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RepairApply {
    Applied(Uuid),
    Stale,
}

#[async_trait]
impl Worker for LedgerCheckpointWorker {
    fn name(&self) -> &'static str {
        "LedgerCheckpoint"
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.config.interval_ms.max(1))
    }

    fn singleton(&self) -> bool {
        true
    }

    async fn tick(&self, ctx: &WorkerContext) -> Result<WorkerOutcome, WorkerError> {
        if ctx.shutting_down() {
            return Ok(WorkerOutcome::Deferred);
        }
        let count = self.tick_once().await?;
        if count == 0 {
            Ok(WorkerOutcome::Skipped)
        } else {
            Ok(WorkerOutcome::Processed(count))
        }
    }
}

fn checkpoint_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("ledger checkpoint: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn dec(raw: &str) -> Decimal {
        Decimal::from_str(raw).expect("decimal")
    }

    fn snapshot(
        balance: &str,
        line_seq: i64,
        cp_balance: &str,
        cp_seq: i64,
        found: i64,
        delta: &str,
    ) -> SnapshotRow {
        SnapshotRow {
            balance: dec(balance),
            line_seq,
            cp_balance: dec(cp_balance),
            cp_seq,
            found,
            delta: dec(delta),
        }
    }

    #[test]
    fn a_consistent_capture_advances() {
        let row = snapshot("100", 5, "90", 4, 1, "10");
        let result = judge(Uuid::nil(), 0, &row);
        assert_eq!(result.status, ShardCaptureStatus::Advanced);
        assert_eq!(result.checkpoint_seq, 5);
        assert_eq!(result.checkpoint_balance, dec("100"));
        assert_eq!(result.lines_covered, 1);
        assert!(result.drift.is_zero());
    }

    #[test]
    fn nothing_to_fold_in_is_a_noop() {
        let row = snapshot("100", 5, "100", 5, 0, "0");
        let result = judge(Uuid::nil(), 0, &row);
        assert_eq!(result.status, ShardCaptureStatus::Noop);
        assert_eq!(result.lines_covered, 0);
    }

    #[test]
    fn a_missing_line_is_a_gap_not_a_parity_failure() {
        let row = snapshot("100", 5, "90", 4, 0, "10");
        let result = judge(Uuid::nil(), 0, &row);
        assert_eq!(result.status, ShardCaptureStatus::Gap);
        assert_eq!(result.lines_found, 0);
    }

    #[test]
    fn a_balanced_but_wrong_projection_is_parity() {
        let row = snapshot("99.5", 5, "90", 4, 1, "10");
        let result = judge(Uuid::nil(), 0, &row);
        assert_eq!(result.status, ShardCaptureStatus::Parity);
        assert_eq!(result.drift, dec("-0.5"));
        assert!(!result.first_failure);
    }

    #[test]
    fn a_zero_line_shard_with_equal_balance_is_a_noop() {
        let row = snapshot("0", 0, "0", 0, 0, "0");
        assert_eq!(judge(Uuid::nil(), 0, &row).status, ShardCaptureStatus::Noop);
    }

    #[test]
    fn maintenance_windows_wrap_midnight() {
        use chrono::TimeZone;
        let at = |hour, minute| {
            chrono::Utc
                .with_ymd_and_hms(2026, 11, 28, hour, minute, 0)
                .single()
                .expect("datetime")
                .naive_utc()
        };
        assert!(!in_maintenance_window(at(3, 0), None));
        assert!(in_maintenance_window(at(3, 0), Some((2, 5))));
        assert!(!in_maintenance_window(at(5, 0), Some((2, 5))));
        assert!(in_maintenance_window(at(23, 30), Some((22, 2))));
        assert!(in_maintenance_window(at(1, 30), Some((22, 2))));
        assert!(!in_maintenance_window(at(12, 0), Some((22, 2))));
        assert!(in_maintenance_window(at(12, 0), Some((7, 7))));
    }

    #[test]
    fn repair_size_policy_allows_small_shards_and_windowed_large_ones() {
        use chrono::TimeZone;
        let night = chrono::Utc
            .with_ymd_and_hms(2026, 11, 28, 1, 0, 0)
            .single()
            .expect("datetime")
            .naive_utc();
        let day = chrono::Utc
            .with_ymd_and_hms(2026, 11, 28, 13, 0, 0)
            .single()
            .expect("datetime")
            .naive_utc();
        let mut policy = AutoRepairPolicy {
            max_lines_outside_window: Some(1_000),
            maintenance_window_utc: Some((0, 4)),
            ..AutoRepairPolicy::default()
        };
        assert!(repair_size_allowed(1_000, &policy, day));
        assert!(!repair_size_allowed(1_001, &policy, day));
        assert!(repair_size_allowed(1_001, &policy, night));
        policy.max_lines_outside_window = None;
        assert!(repair_size_allowed(i64::MAX, &policy, day));
    }

    fn plan(
        status: &'static str,
        failures: i32,
        correction: &str,
    ) -> (ShardRepairPlan, &'static str, i32) {
        let total = dec("100") + dec(correction);
        let plan = plan_shard_repair(total, Some(5), dec("100"), 5, 0);
        (plan, status, failures)
    }

    #[test]
    fn auto_repair_only_for_persistent_parity_with_intact_sequence() {
        let now = now_utc();
        let policy = AutoRepairPolicy::default();
        let (recompute, status, failures) = plan("PARITY", 3, "1.0000");
        assert_eq!(recompute.kind, Some(ShardRepairKind::Recompute));
        assert!(should_auto_repair(&recompute, status, failures, &policy, now).allowed);

        let (gap, _, _) = plan("GAP", 3, "1.0000");
        assert!(!should_auto_repair(&gap, "GAP", 3, &policy, now).allowed);

        assert!(!should_auto_repair(&recompute, "PARITY", 2, &policy, now).allowed);
        assert!(!should_auto_repair(&recompute, "GAP", 10, &policy, now).allowed);
        assert!(
            !should_auto_repair(
                &recompute,
                "PARITY",
                3,
                &AutoRepairPolicy {
                    enabled: false,
                    ..AutoRepairPolicy::default()
                },
                now
            )
            .allowed
        );

        // A damaged sequence (the journal lost a line) is never automatic.
        let damaged = plan_shard_repair(dec("90"), Some(4), dec("100"), 5, 0);
        assert_eq!(damaged.kind, Some(ShardRepairKind::Rebaseline));
        assert!(!should_auto_repair(&damaged, "PARITY", 10, &policy, now).allowed);
    }

    #[test]
    fn auto_repair_respects_the_amount_cap() {
        let now = now_utc();
        let policy = AutoRepairPolicy {
            max_abs_delta: dec("100"),
            ..AutoRepairPolicy::default()
        };
        let (ok, _, _) = plan("PARITY", 3, "100.0000");
        assert!(should_auto_repair(&ok, "PARITY", 3, &policy, now).allowed);
        let (too_big, _, _) = plan("PARITY", 3, "100.0001");
        assert!(!should_auto_repair(&too_big, "PARITY", 3, &policy, now).allowed);
        let (negative, _, _) = plan("PARITY", 3, "-100.0000");
        assert!(should_auto_repair(&negative, "PARITY", 3, &policy, now).allowed);
        let (negative_big, _, _) = plan("PARITY", 3, "-100.0001");
        assert!(!should_auto_repair(&negative_big, "PARITY", 3, &policy, now).allowed);
    }

    #[test]
    fn healthy_shards_and_missing_kinds_are_never_repaired() {
        let now = now_utc();
        let policy = AutoRepairPolicy::default();
        let healthy = plan_shard_repair(dec("100"), Some(5), dec("100"), 5, 0);
        assert!(!should_auto_repair(&healthy, "OK", 0, &policy, now).allowed);
    }

    #[test]
    fn the_snapshot_sql_has_the_optional_pruning_hint() {
        let with_hint = snapshot_sql(true);
        let without = snapshot_sql(false);
        assert!(with_hint.contains("make_interval(secs => $3"));
        assert!(!without.contains("$3"));
        assert!(without.contains("jl.shard_seq > s.cp_seq AND jl.shard_seq <= s.line_seq"));
        assert!(without.contains("COUNT(jl.shard_seq)"));
    }

    #[test]
    fn candidate_and_failure_sql_match_the_typescript_predicates() {
        assert!(FIND_CANDIDATES_SQL.contains("s.line_seq > COALESCE(c.checkpoint_seq, 0)"));
        assert!(FIND_CANDIDATES_SQL.contains("c.checkpoint_at IS NULL"));
        assert!(FIND_CANDIDATES_SQL.contains("COALESCE(c.status, 'OK') = 'OK'"));
        assert!(FAILING_SHARDS_SQL.contains("c.status = 'PARITY'"));
        assert!(FAILING_SHARDS_SQL.contains("consecutive_failures >= $1"));
        assert!(ADVANCE_SQL.contains("WHERE c.checkpoint_seq < EXCLUDED.checkpoint_seq"));
        assert!(RECORD_FAILURE_SQL.contains("consecutive_failures + 1"));
    }

    #[test]
    fn repair_sql_is_lock_free_and_compare_and_set() {
        assert!(REPAIR_CAS_SQL.contains("current_balance = $5::numeric"));
        assert!(REPAIR_CAS_SQL.contains("line_seq = $6::bigint"));
        assert!(!REPAIR_CAS_SQL.contains("FOR UPDATE"));
        assert!(REPAIR_CHECKPOINT_SQL.contains("baseline_seq = EXCLUDED.baseline_seq"));
        assert!(REPAIR_INSERT_SQL.contains("'AUTO'") || REPAIR_INSERT_SQL.contains("$5"));
    }
}
