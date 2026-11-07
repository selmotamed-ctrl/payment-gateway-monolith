/**
 * Pure unit tests (no database) of the shard-scaling policy (`decideShardWidth`) and of the shard routing / sequencing
 * arithmetic (`lib/storageEngine/shardRouting.ts`).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import {
  DEFAULT_SCALER_CONFIG,
  INITIAL_SCALER_STATE,
  decideShardWidth,
  type ScalerConfig,
  type ScalerInput,
  type ScalerState,
} from "../../engine/ledger/ShardScaler";
import {
  INITIAL_SYSTEM_SHARD_WIDTH,
  MAX_SHARD_WIDTH,
  MIN_SHARD_WIDTH,
  assignShardSeqs,
  clampShardWidth,
  clearShardWidthCache,
  foldShardBumps,
  initialShardWidth,
  loadShardWidths,
  reducesBalance,
  routeLine,
  shardKey,
} from "../../lib/storageEngine/shardRouting";
import { fnv1aHash } from "../../lib/storageEngine/shardBalances";

/* -------------------------------------------------------------------------- */
/* decideShardWidth                                                            */
/* -------------------------------------------------------------------------- */

const config = (over: Partial<ScalerConfig> = {}): ScalerConfig => ({
  upLinesPerSec: 100,
  maxWidth: 64,
  cooldownMs: 60_000,
  consecutive: 2,
  maxStep: 4,
  alpha: 1, // no smoothing unless a test asks for it
  ...over,
});

const NOW = 10_000_000;
const sample = (over: Partial<ScalerInput> = {}): ScalerInput => ({
  accountType: "TREASURY",
  width: 1,
  hotRate: 0,
  totalRate: 0,
  shard0Rate: 0,
  otherShardsMeanRate: 0,
  lastScaledAtMs: null,
  nowMs: NOW,
  ...over,
});
const hot = (rate: number, over: Partial<ScalerInput> = {}): ScalerInput =>
  sample({ hotRate: rate, totalRate: rate, shard0Rate: rate, ...over });

/** Feeds the same sample `times` times, threading the state like the worker does. */
const run = (input: ScalerInput, times: number, cfg: ScalerConfig, from: ScalerState = INITIAL_SCALER_STATE) => {
  let state = from;
  const decisions = [] as ReturnType<typeof decideShardWidth>[];
  for (let index = 0; index < times; index += 1) {
    const decision = decideShardWidth(input, state, cfg);
    decisions.push(decision);
    state = decision.state;
  }
  return decisions;
};

describe("decideShardWidth: threshold and sustained overload", () => {
  test("the shipped defaults", () => {
    expect(DEFAULT_SCALER_CONFIG).toEqual({ upLinesPerSec: 150, maxWidth: 64, cooldownMs: 600_000, consecutive: 2, maxStep: 4, alpha: 0.5 });
    expect(INITIAL_SCALER_STATE).toEqual({ hotRate: 0, totalRate: 0, over: 0 });
  });

  test("below the threshold nothing happens and the counter stays at zero", () => {
    const decision = decideShardWidth(hot(99), INITIAL_SCALER_STATE, config());
    expect(decision.action).toBe("HOLD");
    expect(decision.reason).toBe("below threshold");
    expect(decision.newWidth).toBe(1);
    expect(decision.state.over).toBe(0);
  });

  test("exactly at the threshold is not over it (the comparison is strict)", () => {
    const decisions = run(hot(100), 5, config());
    expect(decisions.every((decision) => decision.action === "HOLD" && decision.state.over === 0)).toBe(true);
  });

  test("an idle account holds with zero rates", () => {
    const decision = decideShardWidth(sample(), INITIAL_SCALER_STATE, config());
    expect(decision).toMatchObject({ action: "HOLD", newWidth: 1, state: { hotRate: 0, totalRate: 0, over: 0 } });
  });

  test("a single over-threshold sample is not enough: it needs `consecutive` samples in a row", () => {
    const [first, second, third] = run(hot(500), 3, config({ consecutive: 3 }));
    expect(first).toMatchObject({ action: "HOLD", reason: "waiting for a sustained overload" });
    expect(first!.state.over).toBe(1);
    expect(second).toMatchObject({ action: "HOLD" });
    expect(second!.state.over).toBe(2);
    expect(third!.action).toBe("SCALE_UP");
  });

  test("consecutive = 1 scales on the first hot sample", () => {
    expect(decideShardWidth(hot(500), INITIAL_SCALER_STATE, config({ consecutive: 1 })).action).toBe("SCALE_UP");
  });

  test("a dip below the threshold resets the streak", () => {
    const cfg = config({ consecutive: 3 });
    let state = INITIAL_SCALER_STATE;
    for (const rate of [500, 500, 50, 500, 500]) {
      const decision = decideShardWidth(hot(rate), state, cfg);
      expect(decision.action).toBe("HOLD");
      state = decision.state;
    }
    expect(state.over).toBe(2);
    expect(decideShardWidth(hot(500), state, cfg).action).toBe("SCALE_UP");
  });

  test("on SCALE_UP the streak counter is reset, so the next scaling needs a new streak", () => {
    const decisions = run(hot(500), 2, config());
    expect(decisions[1]!.action).toBe("SCALE_UP");
    expect(decisions[1]!.state.over).toBe(0);
    expect(decisions[1]!.reason).toContain("over 100 for 2 samples");
    // the cooldown (and the worker applying the new width) would normally intervene; without them a new streak is needed
    expect(decideShardWidth(hot(500), decisions[1]!.state, config()).action).toBe("HOLD");
  });
});

describe("decideShardWidth: EWMA smoothing", () => {
  test("the newest sample has weight alpha: a one-sample spike is smoothed away", () => {
    const cfg = config({ alpha: 0.5 });
    const spike = decideShardWidth(hot(180), INITIAL_SCALER_STATE, cfg);
    expect(spike.state.hotRate).toBe(90); // 0.5 * 180
    expect(spike.state.over).toBe(0);
    const calm = decideShardWidth(hot(0), spike.state, cfg);
    expect(calm.state.hotRate).toBe(45);
  });

  test("smoothing delays the signal: a steady 300 lines/s needs two samples to cross a threshold of 100 at alpha 0.5", () => {
    const decisions = run(hot(300), 4, config({ alpha: 0.5, consecutive: 1 }));
    expect(decisions[0]!.state.hotRate).toBe(150); // 150 > 100 already
    expect(decisions[0]!.action).toBe("SCALE_UP");
    const slower = run(hot(180), 4, config({ alpha: 0.5, consecutive: 1 }));
    expect(slower[0]!.state.hotRate).toBe(90);
    expect(slower[0]!.action).toBe("HOLD");
    expect(slower[1]!.state.hotRate).toBe(135);
    expect(slower[1]!.action).toBe("SCALE_UP");
  });

  test("the account total rate is smoothed with the same weight (and drives the target width)", () => {
    const decision = decideShardWidth(sample({ hotRate: 400, totalRate: 800 }), { hotRate: 0, totalRate: 400, over: 1 }, config({ alpha: 0.25 }));
    expect(decision.state.totalRate).toBe(0.25 * 800 + 0.75 * 400);
    expect(decision.state.hotRate).toBe(100);
  });

  test("alpha = 1 follows the sample, alpha = 0 ignores it", () => {
    expect(decideShardWidth(hot(300), { hotRate: 7, totalRate: 7, over: 0 }, config({ alpha: 1 })).state.hotRate).toBe(300);
    expect(decideShardWidth(hot(300), { hotRate: 7, totalRate: 7, over: 0 }, config({ alpha: 0 })).state.hotRate).toBe(7);
  });
});

describe("decideShardWidth: cooldown and maximum width", () => {
  const scaled = (agoMs: number | null, cfg = config()) => decideShardWidth(hot(500, { lastScaledAtMs: agoMs === null ? null : NOW - agoMs }), { hotRate: 500, totalRate: 500, over: 5 }, cfg);

  test("never scaled before: allowed", () => {
    expect(scaled(null).action).toBe("SCALE_UP");
  });

  test("inside the cooldown window it holds (the streak is kept)", () => {
    const decision = scaled(59_999);
    expect(decision).toMatchObject({ action: "HOLD", reason: "cooling down after the last scaling", newWidth: 1 });
    expect(decision.state.over).toBe(6);
  });

  test("exactly one cooldown after the last scaling it is allowed again", () => {
    expect(scaled(60_000).action).toBe("SCALE_UP");
    expect(scaled(10 * 60_000).action).toBe("SCALE_UP");
  });

  test("a future `lastScaledAt` (clock skew) is treated as cooling down", () => {
    expect(scaled(-5_000).action).toBe("HOLD");
  });

  test("at the maximum width it holds, whatever the load", () => {
    const decision = decideShardWidth(hot(10_000, { width: 64 }), { hotRate: 10_000, totalRate: 10_000, over: 9 }, config());
    expect(decision).toMatchObject({ action: "HOLD", reason: "already at the maximum width", newWidth: 64 });
    expect(decideShardWidth(hot(10_000, { width: 100 }), { hotRate: 10_000, totalRate: 10_000, over: 9 }, config()).action).toBe("HOLD");
  });

  test("the maximum is clamped to the schema range 1..256 and the cap applies to the new width", () => {
    const huge = decideShardWidth(hot(1_000_000, { width: 200 }), { hotRate: 1e6, totalRate: 1e6, over: 9 }, config({ maxWidth: 10_000 }));
    expect(huge.action).toBe("SCALE_UP");
    expect(huge.newWidth).toBe(256);
    expect(decideShardWidth(hot(1_000_000, { width: 256 }), { hotRate: 1e6, totalRate: 1e6, over: 9 }, config({ maxWidth: 10_000 })).action).toBe("HOLD");
    // a maxWidth below 1 behaves like 1: nothing can be widened
    expect(decideShardWidth(hot(500), { hotRate: 500, totalRate: 500, over: 9 }, config({ maxWidth: 0 })).action).toBe("HOLD");
    const capped = decideShardWidth(hot(100_000, { width: 3 }), { hotRate: 1e5, totalRate: 1e5, over: 9 }, config({ maxWidth: 5 }));
    expect(capped.newWidth).toBe(5);
  });
});

describe("decideShardWidth: the new width", () => {
  const scale = (input: ScalerInput, cfg = config()) => decideShardWidth(input, { hotRate: input.hotRate, totalRate: input.totalRate, over: cfg.consecutive }, cfg);

  test("aims at about half the threshold per shard (target = ceil(totalRate / (threshold / 2)))", () => {
    // 120 lines/s with a threshold of 100: ceil(120 / 50) = 3 shards
    expect(scale(sample({ width: 1, hotRate: 120, totalRate: 120 })).newWidth).toBe(3);
    // 260 lines/s: ceil(260/50) = 6, but a step is capped at x4
    expect(scale(sample({ width: 1, hotRate: 260, totalRate: 260 })).newWidth).toBe(4);
    // from width 2 the same load gives min(2*4, 6) = 6
    expect(scale(sample({ width: 2, hotRate: 130, totalRate: 260 })).newWidth).toBe(6);
  });

  test("growth is capped at maxStep-fold per step", () => {
    expect(scale(sample({ width: 1, hotRate: 5_000, totalRate: 5_000 })).newWidth).toBe(4);
    expect(scale(sample({ width: 4, hotRate: 5_000, totalRate: 5_000 })).newWidth).toBe(16);
    expect(scale(sample({ width: 16, hotRate: 5_000, totalRate: 5_000 })).newWidth).toBe(64);
    expect(scale(sample({ width: 1, hotRate: 5_000, totalRate: 5_000 }), config({ maxStep: 8 })).newWidth).toBe(8);
    // a step of less than x2 is raised to x2 (the minimum useful growth)
    expect(scale(sample({ width: 3, hotRate: 5_000, totalRate: 5_000 }), config({ maxStep: 1 })).newWidth).toBe(6);
  });

  test("it never widens by less than one shard, even when the formula says the account is already wide enough", () => {
    const decision = scale(sample({ width: 4, hotRate: 150, totalRate: 10 }));
    expect(decision.action).toBe("SCALE_UP");
    expect(decision.newWidth).toBe(5); // target 1, but width + 1
    expect(scale(sample({ width: 10, hotRate: 101, totalRate: 101 })).newWidth).toBe(11); // target 3 < width + 1
  });

  test("the result is always strictly wider than the current width and within the cap", () => {
    for (const width of [1, 2, 3, 7, 16, 33, 63]) {
      for (const total of [101, 400, 3_000, 90_000]) {
        const decision = scale(sample({ width, hotRate: 150, totalRate: total }));
        expect(decision.action).toBe("SCALE_UP");
        expect(decision.newWidth).toBeGreaterThan(width);
        expect(decision.newWidth).toBeLessThanOrEqual(64);
      }
    }
  });

  test("a sustained load grows the account step by step until it is wide enough, then stops asking", () => {
    // 1,000 lines/s of total load spread evenly: the per-shard rate falls as the account widens.
    const cfg = config({ consecutive: 1, cooldownMs: 0 });
    let width = 1;
    let state = INITIAL_SCALER_STATE;
    const widths = [width];
    for (let tick = 0; tick < 12; tick += 1) {
      const decision = decideShardWidth(sample({ width, hotRate: 1_000 / width, totalRate: 1_000, shard0Rate: 1_000 / width, otherShardsMeanRate: 1_000 / width }), state, cfg);
      state = decision.state;
      if (decision.action === "SCALE_UP") {
        width = decision.newWidth;
        widths.push(width);
      }
    }
    expect(widths).toEqual([1, 4, 16]); // at 16 shards the hottest shard carries 62.5 lines/s < 100
    expect(width).toBe(16);
  });
});

describe("decideShardWidth: wallets pinned by balance-reducing lines", () => {
  const wallet = (over: Partial<ScalerInput>): ScalerInput =>
    sample({ accountType: "MERCHANT_WALLET", width: 4, hotRate: 400, totalRate: 700, shard0Rate: 400, otherShardsMeanRate: 100, ...over });
  const decide = (input: ScalerInput) => decideShardWidth(input, { hotRate: input.hotRate, totalRate: input.totalRate, over: 2 }, config());

  test("shard 0 is the bottleneck while the other shards are quiet: more shards cannot help, so it holds", () => {
    const decision = decide(wallet({}));
    expect(decision.action).toBe("HOLD");
    expect(decision.reason).toContain("pinned by balance-reducing lines");
    expect(decision.newWidth).toBe(4);
    expect(decision.state.over).toBeGreaterThan(0); // the overload is still tracked
  });

  test("the boundary: shard 0 must exceed BOTH the threshold and twice the others' mean", () => {
    expect(decide(wallet({ shard0Rate: 400, otherShardsMeanRate: 200 })).action).toBe("SCALE_UP"); // not > 2x
    expect(decide(wallet({ shard0Rate: 400, otherShardsMeanRate: 199.9 })).action).toBe("HOLD");
    expect(decide(wallet({ shard0Rate: 100, otherShardsMeanRate: 0, hotRate: 150 })).action).toBe("SCALE_UP"); // shard 0 at (not over) the threshold
    expect(decide(wallet({ shard0Rate: 100.1, otherShardsMeanRate: 0, hotRate: 150 })).action).toBe("HOLD");
  });

  test("a wallet that is still ONE shard wide is widened: credits would move off the hot shard", () => {
    const decision = decide(wallet({ width: 1, shard0Rate: 400, otherShardsMeanRate: 0 }));
    expect(decision.action).toBe("SCALE_UP");
    expect(decision.newWidth).toBeGreaterThan(1);
  });

  test("the hold only applies to wallets: a system account with the same numbers scales", () => {
    expect(decide(wallet({ accountType: "TREASURY" })).action).toBe("SCALE_UP");
    expect(decide(wallet({ accountType: "PLATFORM_INCOME" })).action).toBe("SCALE_UP");
  });

  test("the wallet hold is checked after the cooldown and the maximum (they hold first)", () => {
    expect(decide(wallet({ width: 64 })).reason).toBe("already at the maximum width");
    expect(decide(wallet({ lastScaledAtMs: NOW - 1 })).reason).toBe("cooling down after the last scaling");
  });
});

describe("decideShardWidth: purity", () => {
  test("it does not mutate its inputs and is deterministic", () => {
    const input = hot(500, { width: 2 });
    const previous: ScalerState = { hotRate: 300, totalRate: 300, over: 1 };
    const frozenInput = JSON.stringify(input);
    const frozenState = JSON.stringify(previous);
    const cfg = config();
    const a = decideShardWidth(input, previous, cfg);
    const b = decideShardWidth(input, previous, cfg);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(frozenInput);
    expect(JSON.stringify(previous)).toBe(frozenState);
    expect(a.state).not.toBe(previous);
  });
});

/* -------------------------------------------------------------------------- */
/* routing                                                                     */
/* -------------------------------------------------------------------------- */

describe("shard routing: clampShardWidth / initialShardWidth", () => {
  test("clampShardWidth", () => {
    expect(MIN_SHARD_WIDTH).toBe(1);
    expect(MAX_SHARD_WIDTH).toBe(256);
    expect(clampShardWidth(1)).toBe(1);
    expect(clampShardWidth(16)).toBe(16);
    expect(clampShardWidth(256)).toBe(256);
    expect(clampShardWidth(257)).toBe(256);
    expect(clampShardWidth(1_000_000)).toBe(256);
    expect(clampShardWidth(0)).toBe(1);
    expect(clampShardWidth(-7)).toBe(1);
    expect(clampShardWidth(2.9)).toBe(2);
    expect(clampShardWidth(Number.NaN)).toBe(1);
    expect(clampShardWidth(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampShardWidth(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  test("initialShardWidth: wallets start at one shard, every other account type is spread", () => {
    expect(INITIAL_SYSTEM_SHARD_WIDTH).toBe(16);
    expect(initialShardWidth("MERCHANT_WALLET")).toBe(1);
    expect(initialShardWidth("MERCHANT_WALLET", 64)).toBe(1);
    for (const type of ["TREASURY", "GATEWAY_CLEARING", "PLATFORM_INCOME", "PROVIDER_FEE_EXPENSE", "AML_HOLD", "SUSPENSE"]) {
      expect(initialShardWidth(type)).toBe(16);
      expect(initialShardWidth(type, 32)).toBe(32);
    }
    expect(initialShardWidth("TREASURY", 0)).toBe(1);
    expect(initialShardWidth("TREASURY", 9_999)).toBe(256);
    expect(initialShardWidth("TREASURY", Number.NaN)).toBe(1);
  });
});

describe("shard routing: routeLine", () => {
  const refs = Array.from({ length: 600 }, (_, index) => `attempt-${index}-ref`);

  test("reducesBalance follows the natural sign of the account type", () => {
    expect(reducesBalance("MERCHANT_WALLET", "DEBIT")).toBe(true);
    expect(reducesBalance("MERCHANT_WALLET", "CREDIT")).toBe(false);
    expect(reducesBalance("PLATFORM_INCOME", "DEBIT")).toBe(true);
    expect(reducesBalance("TREASURY", "CREDIT")).toBe(true);
    expect(reducesBalance("TREASURY", "DEBIT")).toBe(false);
    expect(reducesBalance("GATEWAY_CLEARING", "CREDIT")).toBe(true);
    expect(reducesBalance("PROVIDER_FEE_EXPENSE", "DEBIT")).toBe(false);
  });

  test("width 1 routes everything to shard 0", () => {
    for (const type of ["TREASURY", "MERCHANT_WALLET", "PLATFORM_INCOME"]) {
      for (const direction of ["DEBIT", "CREDIT"] as const) {
        for (const ref of refs.slice(0, 50)) expect(routeLine(type, direction, ref, 1)).toBe(0);
      }
    }
  });

  test("an invalid width (0, negative, NaN) behaves like width 1; an enormous one is clamped to 256", () => {
    for (const width of [0, -3, Number.NaN]) {
      expect(routeLine("TREASURY", "CREDIT", "any-ref", width)).toBe(0);
    }
    const shards = new Set(refs.map((ref) => routeLine("TREASURY", "CREDIT", ref, 1_000_000)));
    expect(Math.max(...shards)).toBeLessThan(256);
    expect(Math.max(...shards)).toBeGreaterThan(16);
  });

  test("a wallet DEBIT (balance-reducing) goes to shard 0 at ANY width", () => {
    for (const width of [2, 4, 16, 64, 256]) {
      for (const ref of refs) expect(routeLine("MERCHANT_WALLET", "DEBIT", ref, width)).toBe(0);
    }
  });

  test("wallet credits spread over the shards by hash and are deterministic", () => {
    for (const width of [2, 4, 16]) {
      const used = new Set<number>();
      for (const ref of refs) {
        const shard = routeLine("MERCHANT_WALLET", "CREDIT", ref, width);
        expect(shard).toBe(fnv1aHash(ref) % width);
        expect(routeLine("MERCHANT_WALLET", "CREDIT", ref, width)).toBe(shard);
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThan(width);
        used.add(shard);
      }
      expect(used.size).toBe(width);
    }
  });

  test("system accounts spread both directions over the hash (their guard does not use shard 0)", () => {
    for (const type of ["TREASURY", "GATEWAY_CLEARING", "PLATFORM_INCOME", "AML_HOLD"]) {
      for (const direction of ["DEBIT", "CREDIT"] as const) {
        const used = new Set<number>();
        for (const ref of refs) {
          const shard = routeLine(type, direction, ref, 8);
          expect(shard).toBe(fnv1aHash(ref) % 8);
          used.add(shard);
        }
        expect(used.size).toBe(8);
      }
    }
  });

  test("a retry of the same reference always lands on the same shard; the direction does not move a non-wallet line", () => {
    expect(routeLine("TREASURY", "DEBIT", "attempt-42", 16)).toBe(routeLine("TREASURY", "DEBIT", "attempt-42", 16));
    expect(routeLine("TREASURY", "DEBIT", "attempt-42", 16)).toBe(routeLine("TREASURY", "CREDIT", "attempt-42", 16));
  });

  test("the distribution over 16 shards is reasonably even (chi-square, df = 15)", () => {
    const buckets = Array.from({ length: 16 }, () => 0);
    for (let index = 0; index < 8_000; index += 1) buckets[routeLine("TREASURY", "CREDIT", `ref-${index}-${index * 7919}`, 16)]! += 1;
    const expected = 8_000 / 16;
    const chi = buckets.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(60);
  });
});

describe("shard routing: foldShardBumps", () => {
  test("no lines, no bumps", () => {
    expect(foldShardBumps([])).toEqual([]);
  });

  test("lines of one (account, shard) fold into one signed delta (debit +, credit -) and a count", () => {
    const [bump] = foldShardBumps([
      { glAccountId: "a", shardId: 3, direction: "DEBIT", amount: "10.5000" },
      { glAccountId: "a", shardId: 3, direction: "CREDIT", amount: "0.5000" },
      { glAccountId: "a", shardId: 3, direction: "DEBIT", amount: "1.0000" },
    ]);
    expect(bump).toMatchObject({ glAccountId: "a", shardId: 3, count: 3 });
    expect(bump!.delta.toFixed(4)).toBe("11.0000");
  });

  test("the same account on different shards stays separate; rows are sorted by (account, shard)", () => {
    const bumps = foldShardBumps([
      { glAccountId: "b", shardId: 1, direction: "DEBIT", amount: "1" },
      { glAccountId: "a", shardId: 9, direction: "CREDIT", amount: "2" },
      { glAccountId: "b", shardId: 0, direction: "DEBIT", amount: "3" },
      { glAccountId: "a", shardId: 2, direction: "DEBIT", amount: "4" },
      { glAccountId: "b", shardId: 1, direction: "CREDIT", amount: "1" },
    ]);
    expect(bumps.map((bump) => [bump.glAccountId, bump.shardId, bump.count])).toEqual([["a", 2, 1], ["a", 9, 1], ["b", 0, 1], ["b", 1, 2]]);
    expect(bumps.map((bump) => bump.delta.toFixed(4))).toEqual(["4.0000", "-2.0000", "3.0000", "0.0000"]);
  });

  test("the sort is lexicographic on the account id (one global lock order) and independent of the input order", () => {
    const lines = [
      { glAccountId: "m", shardId: 0, direction: "DEBIT" as const, amount: "1" },
      { glAccountId: "c", shardId: 5, direction: "DEBIT" as const, amount: "1" },
      { glAccountId: "z", shardId: 0, direction: "DEBIT" as const, amount: "1" },
      { glAccountId: "c", shardId: 1, direction: "DEBIT" as const, amount: "1" },
    ];
    const keys = (input: typeof lines) => foldShardBumps(input).map((bump) => shardKey(bump.glAccountId, bump.shardId));
    expect(keys(lines)).toEqual(["c:1", "c:5", "m:0", "z:0"]);
    expect(keys([...lines].reverse())).toEqual(["c:1", "c:5", "m:0", "z:0"]);
  });

  test("amounts keep exact decimal precision and accept strings, numbers and Decimals", () => {
    const [bump] = foldShardBumps([
      { glAccountId: "a", shardId: 0, direction: "DEBIT", amount: "0.1" },
      { glAccountId: "a", shardId: 0, direction: "DEBIT", amount: new Decimal("0.2") },
      { glAccountId: "a", shardId: 0, direction: "CREDIT", amount: 0.3 },
    ]);
    expect(bump!.delta.toFixed(4)).toBe("0.0000");
    expect(bump!.count).toBe(3);
  });

  test("a balanced posting folds to deltas that sum to zero", () => {
    const bumps = foldShardBumps([
      { glAccountId: "t", shardId: 4, direction: "DEBIT", amount: "100.0000" },
      { glAccountId: "w", shardId: 0, direction: "CREDIT", amount: "97.0000" },
      { glAccountId: "i", shardId: 7, direction: "CREDIT", amount: "3.0000" },
    ]);
    expect(bumps.reduce((sum, bump) => sum.plus(bump.delta), new Decimal(0)).isZero()).toBe(true);
  });
});

describe("shard routing: assignShardSeqs", () => {
  const bumpsOf = (lines: Array<{ glAccountId: string; shardId: number }>) =>
    foldShardBumps(lines.map((line) => ({ ...line, direction: "DEBIT" as const, amount: "1" })));
  const key = shardKey;

  test("one line on a shard gets exactly the returned high-water", () => {
    const lines = [{ glAccountId: "a", shardId: 0 }];
    expect(assignShardSeqs(lines, bumpsOf(lines), new Map([[key("a", 0), 42n]]))).toEqual([42n]);
  });

  test("n lines on one shard get the n numbers ending at the high-water, in template order", () => {
    const lines = [
      { glAccountId: "a", shardId: 0 },
      { glAccountId: "a", shardId: 0 },
      { glAccountId: "a", shardId: 0 },
    ];
    expect(assignShardSeqs(lines, bumpsOf(lines), new Map([[key("a", 0), 10n]]))).toEqual([8n, 9n, 10n]);
  });

  test("a fresh shard (high-water == count) starts at 1", () => {
    const lines = [{ glAccountId: "a", shardId: 1 }, { glAccountId: "a", shardId: 1 }];
    expect(assignShardSeqs(lines, bumpsOf(lines), new Map([[key("a", 1), 2n]]))).toEqual([1n, 2n]);
  });

  test("lines interleaved over several shards are numbered per shard, preserving the template order", () => {
    const lines = [
      { glAccountId: "a", shardId: 0 },
      { glAccountId: "b", shardId: 2 },
      { glAccountId: "a", shardId: 0 },
      { glAccountId: "a", shardId: 1 },
      { glAccountId: "b", shardId: 2 },
      { glAccountId: "b", shardId: 2 },
    ];
    const highWater = new Map([[key("a", 0), 100n], [key("a", 1), 7n], [key("b", 2), 53n]]);
    expect(assignShardSeqs(lines, bumpsOf(lines), highWater)).toEqual([99n, 51n, 100n, 7n, 52n, 53n]);
  });

  test("handles sequences beyond 2^53 (bigint arithmetic)", () => {
    const lines = [{ glAccountId: "a", shardId: 0 }, { glAccountId: "a", shardId: 0 }];
    expect(assignShardSeqs(lines, bumpsOf(lines), new Map([[key("a", 0), 9_007_199_254_740_993n]]))).toEqual([9_007_199_254_740_992n, 9_007_199_254_740_993n]);
  });

  test("an unreserved shard is refused: a line without a sequence must never be written", () => {
    const lines = [{ glAccountId: "a", shardId: 0 }];
    expect(() => assignShardSeqs(lines, bumpsOf(lines), new Map())).toThrow("was not reserved");
    expect(() => assignShardSeqs(lines, [], new Map([[key("a", 0), 1n]]))).toThrow("was not reserved");
  });

  test("the sequences of one posting never collide: every (account, shard, seq) is unique", () => {
    const lines = Array.from({ length: 40 }, (_, index) => ({ glAccountId: `acc-${index % 3}`, shardId: index % 4 }));
    const bumps = bumpsOf(lines);
    const highWater = new Map(bumps.map((bump) => [key(bump.glAccountId, bump.shardId), 1_000n + BigInt(bump.count)]));
    const seqs = assignShardSeqs(lines, bumps, highWater);
    const seen = new Set(lines.map((line, index) => `${key(line.glAccountId, line.shardId)}#${seqs[index]}`));
    expect(seen.size).toBe(lines.length);
    for (const bump of bumps) {
      const own = lines.map((line, index) => ({ line, seq: seqs[index]! })).filter((entry) => key(entry.line.glAccountId, entry.line.shardId) === key(bump.glAccountId, bump.shardId));
      expect(own.map((entry) => entry.seq)).toEqual(Array.from({ length: bump.count }, (_, offset) => 1_001n + BigInt(offset)));
    }
  });
});

describe("shard routing: loadShardWidths cache", () => {
  beforeEach(() => clearShardWidthCache());

  const executor = (widths: Record<string, number>) => {
    const calls: string[][] = [];
    return {
      calls,
      $queryRawUnsafe: async <T = unknown>(_query: string, ...values: unknown[]): Promise<T> => {
        const ids = values[0] as string[];
        calls.push(ids);
        return ids.filter((id) => id in widths).map((id) => ({ id, shard_count: widths[id] })) as T;
      },
    };
  };

  test("misses are read in ONE batched query, deduplicated; hits come from the cache", async () => {
    const db = executor({ a: 4, b: 1 });
    const first = await loadShardWidths(db, ["a", "b", "a"], 1_000);
    expect(first).toEqual(new Map([["a", 4], ["b", 1]]));
    expect(db.calls).toEqual([["a", "b"]]);
    await loadShardWidths(db, ["a", "b"], 2_000);
    expect(db.calls).toHaveLength(1);
    await loadShardWidths(db, ["a", "c"], 2_500);
    expect(db.calls[1]).toEqual(["c"]); // only the miss; `c` does not exist, so it is simply absent
  });

  test("an entry expires after the TTL and clearShardWidthCache drops everything", async () => {
    const db = executor({ a: 4 });
    await loadShardWidths(db, ["a"], 1_000);
    await loadShardWidths(db, ["a"], 3_999); // 3 s TTL: still cached
    expect(db.calls).toHaveLength(1);
    await loadShardWidths(db, ["a"], 4_001);
    expect(db.calls).toHaveLength(2);
    clearShardWidthCache();
    await loadShardWidths(db, ["a"], 4_002);
    expect(db.calls).toHaveLength(3);
  });

  test("widths are clamped and an unknown account is absent (the writer then routes it to shard 0)", async () => {
    const db = executor({ big: 9_999, zero: 0 });
    const widths = await loadShardWidths(db, ["big", "zero", "none"], 1_000);
    expect(widths.get("big")).toBe(256);
    expect(widths.get("zero")).toBe(1);
    expect(widths.has("none")).toBe(false);
    expect(await loadShardWidths(db, [], 1_000)).toEqual(new Map());
  });
});
