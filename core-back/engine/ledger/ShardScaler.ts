import { BALANCE_GUARDED_ACCOUNT_TYPES, MAX_SHARD_WIDTH, clampShardWidth } from "../../lib/storageEngine/shardRouting";

/**
 * Decides when a hot GL account should be routed over more shards. Pure (no clock, no database), so the policy
 * is tested exhaustively; `LedgerShardScalerWorker` feeds it measured rates and applies the answer.
 *
 * Signal. Every posting bumps the shard's `line_seq` under the row lock, so the lines per second of a shard is
 * the rate at which that row is being serialized. A single row sustains only as many updates per second as one
 * transaction is long, so a shard whose rate stays above `upLinesPerSec` is a bottleneck. We look at the HOTTEST
 * shard of the account (smoothed with an EWMA), not the average.
 *
 * Action. Scale up when the hottest shard stays over the threshold for `consecutive` samples and the cooldown
 * since the last scaling has passed. The new width aims at half the threshold per shard, grows at most
 * `maxStep`-fold per step, and never exceeds `maxWidth`. Scaling down is not automatic.
 */

export interface ScalerConfig {
  /** Lines per second per shard above which the account is considered hot. */
  upLinesPerSec: number;
  maxWidth: number;
  /** Minimum time between two scalings of the same account. */
  cooldownMs: number;
  /** Consecutive over-threshold samples required. */
  consecutive: number;
  /** Largest growth factor of one step. */
  maxStep: number;
  /** EWMA weight of the newest sample (0..1). */
  alpha: number;
}

export const DEFAULT_SCALER_CONFIG: ScalerConfig = {
  upLinesPerSec: 150,
  // Decision D6 (AUTO-10): the hot system accounts are provisioned at 128 and may grow to the schema maximum.
  maxWidth: 256,
  cooldownMs: 10 * 60 * 1000,
  consecutive: 2,
  maxStep: 4,
  alpha: 0.5,
};

export interface ScalerState {
  /** Smoothed rate of the hottest shard and of the whole account (lines per second). */
  hotRate: number;
  totalRate: number;
  /** Consecutive samples over the threshold. */
  over: number;
}

export const INITIAL_SCALER_STATE: ScalerState = { hotRate: 0, totalRate: 0, over: 0 };

export interface ScalerInput {
  accountType: string;
  width: number;
  /** Measured rates of this sample (lines per second). */
  hotRate: number;
  totalRate: number;
  /** Rate of shard 0 and the mean of the other shards (for the debit-pinning guard). */
  shard0Rate: number;
  otherShardsMeanRate: number;
  /** When the account was last scaled, if ever. */
  lastScaledAtMs: number | null;
  nowMs: number;
}

export type ScalerAction = "HOLD" | "SCALE_UP";

export interface ScalerDecision {
  action: ScalerAction;
  newWidth: number;
  reason: string;
  state: ScalerState;
}

export const decideShardWidth = (
  input: ScalerInput,
  previous: ScalerState,
  config: ScalerConfig = DEFAULT_SCALER_CONFIG,
): ScalerDecision => {
  const hotRate = config.alpha * input.hotRate + (1 - config.alpha) * previous.hotRate;
  const totalRate = config.alpha * input.totalRate + (1 - config.alpha) * previous.totalRate;
  const over = hotRate > config.upLinesPerSec ? previous.over + 1 : 0;
  const state: ScalerState = { hotRate, totalRate, over };
  const hold = (reason: string): ScalerDecision => ({ action: "HOLD", newWidth: input.width, reason, state });

  const maxWidth = Math.min(MAX_SHARD_WIDTH, Math.max(1, Math.trunc(config.maxWidth)));
  if (over < config.consecutive) return hold(over === 0 ? "below threshold" : "waiting for a sustained overload");
  if (input.width >= maxWidth) return hold("already at the maximum width");
  if (input.lastScaledAtMs !== null && input.nowMs - input.lastScaledAtMs < config.cooldownMs) return hold("cooling down after the last scaling");

  // A guarded account (a wallet) pins its balance-reducing lines to shard 0. When shard 0 is the bottleneck while
  // the other shards are quiet, more shards cannot help: the load is debit-bound.
  if (
    BALANCE_GUARDED_ACCOUNT_TYPES.has(input.accountType) &&
    input.width > 1 &&
    input.shard0Rate > config.upLinesPerSec &&
    input.shard0Rate > 2 * input.otherShardsMeanRate
  ) {
    return hold("shard 0 is pinned by balance-reducing lines; more shards would not relieve it");
  }

  const target = Math.ceil(totalRate / (config.upLinesPerSec / 2));
  const newWidth = clampShardWidth(Math.min(maxWidth, input.width * Math.max(2, config.maxStep), Math.max(input.width + 1, target)));
  if (newWidth <= input.width) return hold("no wider width would help");
  return {
    action: "SCALE_UP",
    newWidth,
    reason: `hottest shard ${hotRate.toFixed(0)} lines/s over ${config.upLinesPerSec} for ${over} samples`,
    state: { ...state, over: 0 },
  };
};
