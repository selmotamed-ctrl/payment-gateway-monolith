/**
 * DB-free proof that the synthetic history is a faithful, relationally
 * complete picture of platform operation: the nine generators run against a
 * baseline-seed lookalike and the whole invariant suite must find nothing.
 * Nothing here needs PostgreSQL, Redis or Fake Rails.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAuthorities } from "../api/middleware/authDoubleCheck";
import { loadSeederConfig, PROFILES } from "../prisma/syntheticSeeder/config";
import { createIdFactory } from "../prisma/syntheticSeeder/context";
import { initialShardWidth, routeLine } from "../lib/storageEngine/shardRouting";
import { ATTEMPT_TRANSITIONS, invalidPathStep } from "../prisma/syntheticSeeder/lifecycle";
import { buildBreakdown, commissionForProfile, gatewayFeeForRoute, wireAmount } from "../prisma/syntheticSeeder/money";
import { encryptPendingSecrets } from "../prisma/syntheticSeeder/sync/encryptSecrets";
import { fakeRailsBulkSync } from "../prisma/syntheticSeeder/sync/fakeRailsBulkSyncClient";
import { WRITE_ORDER } from "../prisma/syntheticSeeder/sync/bulkDataWriter";
import {
  businessHour, buildTimeline, dayVolumeMultiplier, isEidHoliday, isRamadan, tripoliDateTime, tripoliHour,
} from "../prisma/syntheticSeeder/timelineClock";
import { Prng } from "../prisma/syntheticSeeder/prng";
import { auditInMemory } from "../prisma/syntheticSeeder/verify/postSeedAudit";
import { checkInvariants } from "../prisma/syntheticSeeder/verify/invariants";
import { buildFixtureContext, runAllGenerators, smallVolumes } from "./helpers/seederFixture";

const run = (seed = "realism", volumes = {}) => runAllGenerators(buildFixtureContext(seed, volumes));

describe("regressions found by the first DB-backed STANDARD seed run", () => {
  test("inbound events may reference channels the baseline already owns, and the audit accepts them", () => {
    const ctx = run("baseline-channels");
    const baselineIds = new Set((ctx.refs.confirmationChannels ?? []).map((channel) => String(channel.id)));
    expect(baselineIds.size).toBeGreaterThan(0);
    const usingBaseline = ctx.dataset.inboundEvents.filter((event) => baselineIds.has(String(event.channelId)));
    expect(usingBaseline.length).toBeGreaterThan(0);
    expect(auditInMemory(ctx).operatorCases.inboundEventViolations).toBe(0);
  });

  test("the audit still rejects an inbound event that points at a channel nobody owns", () => {
    const ctx = run("unknown-channel");
    const event = ctx.dataset.inboundEvents[0];
    expect(event).toBeDefined();
    event!.channelId = "00000000-0000-0000-0000-00000000dead";
    expect(auditInMemory(ctx).operatorCases.inboundEventViolations).toBeGreaterThan(0);
  });

  test("an attempt group never records two successes (DB CHECK attempt_groups_single_success)", () => {
    for (const seed of ["g1", "g2", "g3"]) {
      const ctx = run(seed, { paymentAttempts: 5000, paymentLinks: 400, merchants: 30 });
      const worst = Math.max(0, ...ctx.dataset.attemptGroups.map((group) => Number(group.successCount)));
      expect(worst).toBeLessThanOrEqual(1);
      expect(checkInvariants(ctx).total).toBe(0);
    }
  });

  test("the invariant suite flags a group with two successes", () => {
    const ctx = run("tamper-group");
    const group = ctx.dataset.attemptGroups[0]!;
    group.successCount = 2;
    expect(checkInvariants(ctx).byRule["group.single-success"]).toBeGreaterThan(0);
  });
});

describe("the generated history satisfies every invariant", () => {
  for (const seed of ["alpha", "beta", "libya-pg-2023-2026"]) {
    test(`seed '${seed}': zero violations across relations, lifecycle, ledger and governance`, () => {
      const ctx = run(seed);
      const report = auditInMemory(ctx);
      expect(report.invariants.samples).toEqual([]);
      expect(report.invariants.byRule).toEqual({});
      expect(report.ledgerDrift).toBe("0.0000");
      expect(report.unbalancedEntries).toBe(0);
      expect(report.operatorCaseViolations).toBe(0);
      expect(report.ok).toBe(true);
    });
  }

  test("every attempt status the platform can be in is generated and reachable", () => {
    const ctx = run("coverage", { paymentAttempts: 6000, paymentLinks: 3000, merchants: 40 });
    const seen = new Set(ctx.dataset.paymentAttempts.map((attempt) => String(attempt.status)));
    for (const status of Object.keys(ATTEMPT_TRANSITIONS)) expect(seen.has(status)).toBe(true);
    for (const info of ctx.meta!.attempts.values()) expect(invalidPathStep(info.path)).toBeNull();
    expect(checkInvariants(ctx).total).toBe(0);
  });

  test("the ledger is double-entry, uses decimal strings and never dates an entry in the future", () => {
    const ctx = run();
    expect(ctx.dataset.journalLines.length).toBeGreaterThan(500);
    for (const line of ctx.dataset.journalLines) {
      expect(typeof line.amount).toBe("string");
      expect(line.amount).toMatch(/^\d+\.\d{4}$/);
      expect(Number(line.amount)).toBeGreaterThan(0);
      expect(line.createdAt.getTime()).toBeLessThanOrEqual(ctx.timeline.end.getTime());
    }
    const keys = ctx.dataset.journalEntries.map((entry) => `${entry.refType}:${entry.refId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every shard has its checkpoint and the shard proofs hold", () => {
    const ctx = run();
    const report = checkInvariants(ctx);
    expect(ctx.checkpoints.size).toBe(ctx.dataset.glAccountShards.length);
    // every account (seeder-created or baseline) owns shard rows 0..width-1
    const widths = new Map<string, number>();
    for (const account of ctx.refs.glAccounts) widths.set(account.id, account.shardCount ?? initialShardWidth(account.accountType));
    for (const account of ctx.dataset.glAccounts) widths.set(String(account.id), Number(account.shardCount));
    const shardsByAccount = new Map<string, number[]>();
    for (const shard of ctx.dataset.glAccountShards) shardsByAccount.set(shard.glAccountId, [...(shardsByAccount.get(shard.glAccountId) ?? []), shard.shardId]);
    for (const [id, width] of widths) expect((shardsByAccount.get(id) ?? []).sort((a, b) => a - b)).toEqual(Array.from({ length: width }, (_v, i) => i));
    expect(report.byRule["shard.checkpoint-live"]).toBeUndefined();
    expect(report.byRule["shard.seq-gapless"]).toBeUndefined();
    expect(report.byRule["shard.sum"]).toBeUndefined();
  });

  test("lines are routed by the engine's routeLine and sequenced gaplessly in posting order", () => {
    const ctx = run("sequencing", { paymentAttempts: 1500, paymentLinks: 600 });
    const types = new Map<string, string>();
    for (const account of ctx.refs.glAccounts) types.set(account.id, account.accountType);
    for (const account of ctx.dataset.glAccounts) types.set(String(account.id), String(account.accountType));
    const widths = new Map<string, number>();
    for (const account of ctx.refs.glAccounts) widths.set(account.id, account.shardCount ?? initialShardWidth(account.accountType));
    for (const account of ctx.dataset.glAccounts) widths.set(String(account.id), Number(account.shardCount));
    const refIdByEntry = new Map(ctx.dataset.journalEntries.map((entry) => [String(entry.id), String(entry.refId)]));
    const perShard = new Map<string, Array<{ seq: number; at: number; index: number }>>();
    ctx.dataset.journalLines.forEach((line, index) => {
      const id = String(line.glAccountId);
      expect(line.shardId).toBe(routeLine(types.get(id)!, line.direction, refIdByEntry.get(String(line.entryId))!, widths.get(id)!));
      expect(Number.isInteger(line.shardSeq) && line.shardSeq >= 1).toBe(true);
      const key = `${id}:${line.shardId}`;
      perShard.set(key, [...(perShard.get(key) ?? []), { seq: line.shardSeq, at: line.createdAt.getTime(), index }]);
    });
    let widest = 0;
    for (const [key, lines] of perShard) {
      const bySeq = [...lines].sort((a, b) => a.seq - b.seq);
      // seq is 1..n, and follows (createdAt, generation index)
      bySeq.forEach((line, i) => {
        expect(line.seq).toBe(i + 1);
        if (i > 0) expect(line.at > bySeq[i - 1]!.at || (line.at === bySeq[i - 1]!.at && line.index > bySeq[i - 1]!.index)).toBe(true);
      });
      const row = ctx.dataset.glAccountShards.find((shard) => `${shard.glAccountId}:${shard.shardId}` === key)!;
      expect(row.lineSeq).toBe(lines.length);
      const checkpoint = ctx.checkpoints.get(key)!;
      expect(checkpoint.seq).toBe(lines.filter((line) => line.at <= checkpoint.at.getTime()).length);
      widest = Math.max(widest, Number(key.split(":")[1]));
    }
    expect(widest).toBeGreaterThan(0); // system accounts really spread over several shards
    // wallets are one shard wide: all of their lines sit on shard 0
    for (const wallet of ctx.dataset.wallets) {
      expect(widths.get(String(wallet.glAccountId))).toBe(1);
      expect(ctx.dataset.journalLines.filter((line) => line.glAccountId === wallet.glAccountId).every((line) => line.shardId === 0)).toBe(true);
    }
    // a checkpoint covers a non-trivial prefix for some shard
    expect([...ctx.checkpoints.values()].some((checkpoint) => checkpoint.seq > 0 && checkpoint.seq < ctx.dataset.glAccountShards.find((s) => s.glAccountId === checkpoint.glAccountId && s.shardId === checkpoint.shardId)!.lineSeq)).toBe(true);
  });

  test("sequencing is deterministic", () => {
    const shape = (ctx: ReturnType<typeof run>) => ctx.dataset.journalLines.map((line) => `${line.id}:${line.shardId}:${line.shardSeq}`).join("|")
      + [...ctx.checkpoints.values()].map((checkpoint) => `${checkpoint.glAccountId}:${checkpoint.shardId}:${checkpoint.seq}:${checkpoint.balance}`).join("|");
    expect(shape(run("det-seq"))).toBe(shape(run("det-seq")));
  });

  test("a refunded attempt carries an executed refund whose amount fits the charge", () => {
    const ctx = run("refunds", { paymentAttempts: 4000, paymentLinks: 2000 });
    const refunded = ctx.dataset.paymentAttempts.filter((attempt) => attempt.status === "REFUNDED" || attempt.status === "PARTIALLY_REFUNDED");
    expect(refunded.length).toBeGreaterThan(5);
    for (const attempt of refunded) {
      const refunds = ctx.dataset.adjustments.filter((a) => a.sourceAttemptId === attempt.id && a.type === "REFUND" && a.state === "EXECUTED");
      expect(refunds.length).toBeGreaterThan(0);
      for (const refund of refunds) {
        expect(refund.journalEntryId).toBeTruthy();
        expect(Number(refund.amount)).toBeLessThanOrEqual(Number(attempt.totalChargedAmount));
      }
    }
  });
});

describe("profile volumes drive generation (formerly unused fields)", () => {
  test("joinRequests, kybDocuments, beneficialOwners, users, wallets and applications follow the profile", () => {
    for (const volumes of [
      smallVolumes(),
      smallVolumes({ joinRequests: 55, wallets: 60, applications: 90, beneficialOwners: 80, kybDocuments: 260, users: 130 }),
    ]) {
      const ctx = runAllGenerators(buildFixtureContext("volumes", volumes));
      expect(ctx.dataset.merchants.length).toBe(volumes.merchants!);
      expect(ctx.dataset.joinRequests.length).toBe(volumes.joinRequests!);
      expect(ctx.dataset.wallets.length).toBe(volumes.wallets!);
      expect(ctx.dataset.applications.length).toBe(volumes.applications!);
      expect(ctx.dataset.beneficialOwners.length).toBe(volumes.beneficialOwners!);
      expect(ctx.dataset.kybDocuments.length).toBe(volumes.kybDocuments!);
      expect(ctx.dataset.users.length).toBe(volumes.users!);
    }
  });

  test("the three real profiles are feasible for the per-merchant bounds", () => {
    for (const volumes of Object.values(PROFILES)) {
      expect(volumes.joinRequests).toBeGreaterThanOrEqual(volumes.merchants);
      expect(volumes.joinRequests).toBeLessThanOrEqual(volumes.merchants * 3);
      expect(volumes.wallets).toBeLessThanOrEqual(volumes.merchants * 3);
      expect(volumes.applications).toBeLessThanOrEqual(volumes.merchants * 5);
      expect(volumes.beneficialOwners).toBeLessThanOrEqual(volumes.merchants * 6);
    }
  });
});

describe("determinism and id isolation", () => {
  const strip = (ctx: ReturnType<typeof run>) => JSON.stringify(ctx.dataset, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  test("the same seed key reproduces the dataset byte for byte", () => {
    expect(strip(run("same"))).toBe(strip(run("same")));
  });
  test("different seed keys never share an id", () => {
    const a = new Set(run("one").dataset.paymentAttempts.map((row) => row.id));
    const b = run("two").dataset.paymentAttempts.map((row) => row.id);
    expect(b.some((id) => a.has(id))).toBe(false);
  });
  test("the id factory is namespaced and well formed", () => {
    const a = createIdFactory("synthv1", "k")("x");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createIdFactory("synthv2", "k")("x")).not.toBe(a);
    expect(createIdFactory("synthv1", "k2")("x")).not.toBe(a);
  });
});

describe("Tripoli time, seasonality and distributions", () => {
  test("a Tripoli wall-clock hour is stored as UTC+2 (hour - 2)", () => {
    const day = new Date(Date.UTC(2025, 5, 10));
    const at = tripoliDateTime(day, 14, 30, 0);
    expect(at.getUTCHours()).toBe(12);
    expect(tripoliHour(at)).toBe(14);
    expect(tripoliHour(tripoliDateTime(day, 0, 5, 0))).toBe(0);
  });
  test("traffic concentrates in business hours and avoids the Friday prayer window", () => {
    const rng = new Prng("hours");
    const friday = new Date(Date.UTC(2025, 5, 13));
    let business = 0;
    let prayer = 0;
    for (let index = 0; index < 20_000; index += 1) {
      if (businessHour(rng) >= 8) business += 1;
      const hour = businessHour(rng, friday);
      if (hour >= 11 && hour <= 14) prayer += 1;
    }
    expect(business / 20_000).toBeGreaterThan(0.93);
    expect(prayer / 20_000).toBeLessThan(0.07);
  });
  test("Ramadan lifts volume, the Eid holiday cuts it, Friday dips and salary days spike", () => {
    expect(isRamadan(new Date(Date.UTC(2025, 2, 10)))).toBe(true);
    expect(isEidHoliday(new Date(Date.UTC(2025, 2, 30)))).toBe(true);
    const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, 10));
    expect(dayVolumeMultiplier(at(2025, 2, 10), 20, 42)).toBeGreaterThan(dayVolumeMultiplier(at(2025, 4, 12), 20, 42));
    expect(dayVolumeMultiplier(at(2025, 2, 31), 20, 42)).toBeLessThan(dayVolumeMultiplier(at(2025, 4, 12), 20, 42));
    expect(dayVolumeMultiplier(at(2025, 4, 9), 20, 42)).toBeLessThan(dayVolumeMultiplier(at(2025, 4, 10), 20, 42)); // Friday < Saturday
    expect(dayVolumeMultiplier(at(2025, 4, 27), 20, 42)).toBeGreaterThan(dayVolumeMultiplier(at(2025, 4, 14), 20, 42));
  });
  test("the generated attempts follow the business-hour rhythm and the adoption curve", () => {
    const ctx = run("rhythm", { paymentAttempts: 6000, paymentLinks: 3000 });
    const hours = ctx.dataset.paymentAttempts.map((attempt) => tripoliHour(attempt.createdAt));
    expect(hours.filter((hour) => hour >= 8).length / hours.length).toBeGreaterThan(0.85);
    const mid = ctx.timeline.start.getTime() + (ctx.timeline.end.getTime() - ctx.timeline.start.getTime()) / 2;
    const late = ctx.dataset.paymentAttempts.filter((attempt) => attempt.createdAt.getTime() > mid).length;
    expect(late).toBeGreaterThan(ctx.dataset.paymentAttempts.length - late);
  });
  test("amounts follow the merchant category ticket band and the decline rate varies by rail", () => {
    const ctx = run("amounts", { paymentAttempts: 6000, paymentLinks: 3000 });
    const info = ctx.meta!.merchants;
    for (const link of ctx.dataset.paymentLinks) {
      const app = ctx.dataset.applications.find((a) => a.id === link.applicationId)!;
      const merchant = info.get(String(app.merchantId))!;
      expect(Number(link.amount)).toBeGreaterThanOrEqual(Math.min(merchant.ticketMin, 20000));
    }
    const failureShare = (railId: string) => {
      const attempts = ctx.dataset.paymentAttempts.filter((attempt) => attempt.railId === railId && attempt.status !== "BLOCKED");
      return attempts.filter((attempt) => attempt.status === "FAILED").length / Math.max(1, attempts.length);
    };
    const shares = ctx.refs.rails.map((rail) => failureShare(rail.id));
    expect(Math.max(...shares)).toBeGreaterThan(Math.min(...shares));
  });
  test("the PRNG yields a uniform [0,1) stream", () => {
    const rng = new Prng("uniform");
    let sum = 0;
    for (let index = 0; index < 50_000; index += 1) sum += rng.next();
    expect(sum / 50_000).toBeGreaterThan(0.49);
    expect(sum / 50_000).toBeLessThan(0.51);
  });
});

describe("the generators reuse the engine, not a private copy of its rules", () => {
  test("ATTEMPT_TRANSITIONS equals the engine's ALLOWED_TRANSITIONS", () => {
    const source = readFileSync(join(import.meta.dir, "../engine/flow/DynamicRailEngine.ts"), "utf8");
    const block = source.slice(source.indexOf("const ALLOWED_TRANSITIONS"), source.indexOf("function engineError"));
    for (const [from, targets] of Object.entries(ATTEMPT_TRANSITIONS)) {
      const line = block.split("\n").find((entry) => new RegExp(`^\\s+${from}:`).test(entry));
      expect(line).toBeDefined();
      const parsed = [...line!.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]);
      expect(parsed.sort()).toEqual([...targets].sort());
    }
  });
  test("pricing mirrors the checkout (commission, fee bearer, route fee, wire rounding)", () => {
    const profile = { calcType: "PERCENTAGE", flatFee: "0", percentageRate: "0.030000", minFee: "0.25", maxFee: null, tiersJson: null };
    expect(commissionForProfile(profile, "100").toFixed(4)).toBe("3.0000");
    expect(commissionForProfile(profile, "1").toFixed(4)).toBe("0.2500"); // min fee
    expect(buildBreakdown({ amount: "100", feeBearer: "PAYER_SURCHARGE" }, profile)).toMatchObject({ payerSurcharge: "3.0000", totalCharged: "103.0000", merchantCredited: "100.0000" });
    expect(buildBreakdown({ amount: "100", feeBearer: "SPLIT", splitRatioJson: { platformShare: "0.5" } }, profile)).toMatchObject({ payerSurcharge: "1.5000", totalCharged: "101.5000", merchantCredited: "98.5000" });
    expect(gatewayFeeForRoute({ calc_type: "PERCENTAGE", flat: "0", percent: "1.2", min: "0.1", max: "25" }, "200")).toBe("2.4000");
    expect(gatewayFeeForRoute({ calc_type: "PERCENTAGE", percent: "1.2", min: "0.1", max: "25" }, "5000")).toBe("25.0000");
    expect(wireAmount("moamalat", "12.3456")).toEqual({ wire: "12346", settled: "12.3460" });
    expect(wireAmount("edfali", "10.005").wire).toBe("10.01");
  });
  test("every confirmation entry reproduces the engine's wallet/commission/fee legs", () => {
    const ctx = run("math", { paymentAttempts: 3000, paymentLinks: 1500 });
    const report = checkInvariants(ctx);
    for (const rule of ["settlement.wallet-credit", "settlement.commission-credit", "settlement.fee-accrual", "settlement.wrong-wallet"]) {
      expect(report.byRule[rule]).toBeUndefined();
    }
  });
});

describe("the audit really detects each class of defect", () => {
  const tamper = (mutate: (ctx: ReturnType<typeof run>) => void): Record<string, number> => {
    const ctx = run("tamper");
    mutate(ctx);
    return checkInvariants(ctx).byRule;
  };
  test("an unbalanced journal line", () => {
    expect(Object.keys(tamper((ctx) => { ctx.dataset.journalLines[0]!.amount = "999.0000"; }))).toContain("ledger.unbalanced-entry");
  });
  test("a dangling foreign key", () => {
    expect(tamper((ctx) => { ctx.dataset.paymentAttempts[0]!.merchantId = "00000000-0000-0000-0000-000000000000"; }).fk).toBeGreaterThan(0);
  });
  test("an attempt dated in the future", () => {
    const rules = tamper((ctx) => { ctx.dataset.paymentAttempts[0]!.createdAt = new Date(ctx.timeline.end.getTime() + 3_600_000); });
    expect(rules["attempt.future"]).toBeGreaterThan(0);
  });
  test("an impossible status path", () => {
    const rules = tamper((ctx) => { const info = [...ctx.meta!.attempts.values()][0]!; info.path = ["SUCCEEDED", "CREATED"]; });
    expect(rules["attempt.lifecycle"]).toBeGreaterThan(0);
  });
  test("maker equal to checker", () => {
    const rules = tamper((ctx) => { const row = ctx.dataset.approvalRequests.find((a) => a.checkerUserId)!; row.checkerUserId = row.makerUserId; });
    expect(rules["approval.maker-is-checker"]).toBeGreaterThan(0);
  });
  test("a wrong link counter and a succeeded attempt without ledger", () => {
    const rules = tamper((ctx) => {
      ctx.dataset.paymentLinks[0]!.confirmedCount = 99;
      const attempt = ctx.dataset.paymentAttempts.find((a) => a.status === "SUCCEEDED")!;
      attempt.ledgerEntryId = null;
    });
    expect(rules["link.confirmed-count"]).toBeGreaterThan(0);
    expect(rules["attempt.settled-without-ledger"]).toBeGreaterThan(0);
  });
  test("a stale checkpoint and a float amount", () => {
    const rules = tamper((ctx) => { ctx.checkpoints.values().next().value!.balance = "1.0000"; ctx.dataset.journalLines[1]!.amount = 1.5 as never; });
    expect(rules["shard.checkpoint-live"]).toBeGreaterThan(0);
    expect(rules["ledger.not-decimal-string"]).toBeGreaterThan(0);
  });
  test("a checkpoint sequence that is not the cut prefix", () => {
    const rules = tamper((ctx) => {
      const checkpoint = [...ctx.checkpoints.values()].find((candidate) => candidate.seq > 1)!;
      checkpoint.seq -= 1;
    });
    expect(rules["shard.checkpoint-live"]).toBeGreaterThan(0);
  });
  test("a gap or a duplicate in a shard sequence", () => {
    const gap = tamper((ctx) => { ctx.dataset.journalLines.find((line) => line.shardSeq === 2)!.shardSeq = 5; });
    expect(gap["shard.seq-gapless"]).toBeGreaterThan(0);
    const duplicate = tamper((ctx) => { ctx.dataset.journalLines.find((line) => line.shardSeq === 2)!.shardSeq = 1; });
    expect(duplicate["shard.seq-gapless"]).toBeGreaterThan(0);
    const stale = tamper((ctx) => { ctx.dataset.glAccountShards.find((shard) => shard.lineSeq > 0)!.lineSeq += 1; });
    expect(stale["shard.seq-gapless"]).toBeGreaterThan(0);
  });
  test("a shard balance that is not the sum of its lines", () => {
    const rules = tamper((ctx) => { ctx.dataset.glAccountShards.find((shard) => shard.lineSeq > 0)!.currentBalance = "123456.0000"; });
    expect(rules["shard.sum"]).toBeGreaterThan(0);
    expect(rules["shard.checkpoint-live"]).toBeGreaterThan(0);
  });

});

describe("staff, secrets, configuration and the writer", () => {
  test("seeded staff resolve to real authorities with the engine flags", () => {
    const ctx = run();
    const staff = ctx.dataset.users.filter((user) => user.merchantId === null && user.role !== "SUPPORT" && user.email.indexOf("system-drafter") < 0);
    for (const user of staff) expect(parseAuthorities(user.authoritiesMap).length).toBeGreaterThan(0);
    expect(ctx.dataset.users.find((u) => u.role === "FINANCE")!.isChecker).toBe(true);
    expect(ctx.dataset.users.find((u) => u.role === "OPERATOR" && u.status === "ACTIVE")!.isMaker).toBe(true);
  });
  test("an attempt that reached the gateway carries the state variables its inquiry URL needs (no `URL parameter is missing`)", () => {
    const ctx = run("inquiry-state", { paymentAttempts: 2500, paymentLinks: 1200 });
    const keys = ctx.refs.gatewayStateKeys!;
    let checked = 0;
    for (const secret of ctx.meta!.pendingSecrets.filter((entry) => entry.field === "contextCiphertext")) {
      const meta = ctx.meta!.attempts.get(String(secret.row.id))!;
      const state = JSON.parse(secret.plaintext) as Record<string, string>;
      const required = keys[meta.gatewayCode] ?? [];
      if (!meta.reachedGateway || Object.keys(state).length === 0) {
        for (const key of required) expect(state[key]).toBeUndefined(); // never reached the gateway / blocked: nothing to inquire about
        continue;
      }
      for (const key of required) expect(typeof state[key]).toBe("string");
      if (meta.gatewayCode === "moamalat") {
        expect(state.MerchantReference).toBe(String(secret.row.reference));
        expect(state.AmountTrxn).toBe(String(secret.row.gatewayAmountWire));
        expect(state.SecureHash).toMatch(/^[0-9a-f]{16,}$/);
      }
      if (meta.gatewayCode === "neompay") expect(state.request_id).toBe(String(secret.row.providerReference)); // Fake Rails resolves it by provider reference
      checked += required.length > 0 ? 1 : 0;
    }
    expect(checked).toBeGreaterThan(50);
  });
  test("sensitive columns are encrypted through the Vault, never plain base64", async () => {
    const ctx = run();
    const pending = ctx.meta!.pendingSecrets.length;
    expect(pending).toBeGreaterThan(100);
    const calls: string[] = [];
    const vault = { encryptSecret: async (plain: string, keyId: string) => { calls.push(keyId); return `vault:v1:${keyId}:${plain.length}`; } };
    expect(await encryptPendingSecrets(ctx, vault as never)).toBe(pending);
    expect(new Set(calls)).toContain("kyb-national-id");
    expect(ctx.dataset.beneficialOwners.every((owner) => String(owner.nationalIdCiphertext).startsWith("vault:v1:"))).toBe(true);
    expect(ctx.dataset.paymentAttempts.every((attempt) => String(attempt.contextCiphertext).startsWith("vault:v1:"))).toBe(true);
  });
  test("an unknown seed profile is refused instead of silently becoming STANDARD", () => {
    const saved = { profile: process.env.SYNTHETIC_SEED_PROFILE, data: process.env.SYNTHETIC_DATA_PROFILE };
    try {
      delete process.env.SYNTHETIC_DATA_PROFILE;
      process.env.SYNTHETIC_SEED_PROFILE = "COMPAKT";
      expect(() => loadSeederConfig()).toThrow(/Unknown synthetic seed profile "COMPAKT"/);
      process.env.SYNTHETIC_SEED_PROFILE = "compact";
      expect(loadSeederConfig().volumes.yearsSpan).toBe(PROFILES.COMPACT.yearsSpan);
      process.env.SYNTHETIC_SEED_PROFILE = "";
      expect(loadSeederConfig().volumes.yearsSpan).toBe(PROFILES.STANDARD.yearsSpan);
      delete process.env.SYNTHETIC_SEED_PROFILE;
      expect(loadSeederConfig().volumes.yearsSpan).toBe(PROFILES.STANDARD.yearsSpan);
    } finally {
      if (saved.profile === undefined) delete process.env.SYNTHETIC_SEED_PROFILE; else process.env.SYNTHETIC_SEED_PROFILE = saved.profile;
      if (saved.data === undefined) delete process.env.SYNTHETIC_DATA_PROFILE; else process.env.SYNTHETIC_DATA_PROFILE = saved.data;
    }
  });
  test("the deployed years-span key is honoured", () => {
    const saved = { ...process.env };
    try {
      delete process.env.SYNTHETIC_YEARS_SPAN;
      process.env.SYNTHETIC_SEED_YEARS_SPAN = "2.25";
      expect(loadSeederConfig(new Date("2026-11-04T00:00:00Z")).volumes.yearsSpan).toBe(2.25);
      process.env.SYNTHETIC_SEED_YEARS_SPAN = "-3";
      expect(loadSeederConfig().volumes.yearsSpan).toBe(PROFILES.STANDARD.yearsSpan);
    } finally {
      process.env.SYNTHETIC_SEED_YEARS_SPAN = saved.SYNTHETIC_SEED_YEARS_SPAN;
      if (saved.SYNTHETIC_SEED_YEARS_SPAN === undefined) delete process.env.SYNTHETIC_SEED_YEARS_SPAN;
    }
  });
  test("the writer inserts parents before children", () => {
    const at = (model: string) => WRITE_ORDER.indexOf(model);
    for (const [parent, child] of [
      ["merchant", "user"], ["user", "approvalRequest"], ["approvalRequest", "joinRequest"], ["amlScreening", "joinRequest"],
      ["glAccount", "wallet"], ["wallet", "application"], ["journalEntry", "paymentAttempt"], ["paymentLink", "paymentAttempt"],
      ["paymentAttempt", "dispute"], ["dispute", "adjustment"], ["adjustment", "cashoutRequest"], ["amlRule", "amlCase"],
      ["journalEntry", "amlCase"], ["journalLine", "glAccountShard"], ["amlCase", "regulatoryReport"], ["reconciliationItem", "operatorCase"], ["gatewayVersion", "confirmationChannel"],
    ] as const) {
      expect(at(parent)).toBeGreaterThanOrEqual(0);
      expect(at(parent)).toBeLessThan(at(child));
    }
  });
  test("Fake Rails sync skips never-dispatched attempts and gives UNKNOWN attempts their truth", async () => {
    const ctx = run("sync", { paymentAttempts: 2500, paymentLinks: 1200 });
    const posted: Array<{ transactions: any[]; events: any[] }> = [];
    const saved = { fetch: globalThis.fetch, base: process.env.FAKE_RAILS_PUBLIC_BASE_URL, token: process.env.FAKE_RAILS_SEEDER_TOKEN };
    process.env.FAKE_RAILS_PUBLIC_BASE_URL = "http://127.0.0.1:8444";
    process.env.FAKE_RAILS_SEEDER_TOKEN = "0123456789abcdef0123456789abcdef";
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => { posted.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }) as never;
    try {
      const result = await fakeRailsBulkSync(ctx);
      const transactions = posted.flatMap((batch) => batch.transactions);
      expect(result.transactions).toBe(transactions.length);
      const blocked = new Set(ctx.dataset.paymentAttempts.filter((a) => a.status === "BLOCKED").map((a) => a.id));
      expect(transactions.some((t) => blocked.has(t.id))).toBe(false);
      const unknown = transactions.filter((t) => ctx.dataset.paymentAttempts.find((a) => a.id === t.id)?.status === "UNKNOWN");
      expect(unknown.length).toBeGreaterThan(0);
      for (const t of unknown) expect(["PAID", "FAILED"]).toContain(t.inquiry_override_status);
      for (const t of transactions) expect(t.status).not.toBe("UNKNOWN_SIMULATED");
    } finally {
      globalThis.fetch = saved.fetch;
      if (saved.base === undefined) delete process.env.FAKE_RAILS_PUBLIC_BASE_URL; else process.env.FAKE_RAILS_PUBLIC_BASE_URL = saved.base;
      if (saved.token === undefined) delete process.env.FAKE_RAILS_SEEDER_TOKEN; else process.env.FAKE_RAILS_SEEDER_TOKEN = saved.token;
    }
  });
  test("the timeline starts at 08:00 Tripoli", () => {
    const timeline = buildTimeline(new Date("2026-11-04T12:00:00Z"), 1);
    expect(tripoliHour(timeline.start)).toBe(8);
  });
});

describe("CQRS read models", () => {
  test("the projection totals equal the attempt totals", async () => {
    const { buildReadModels } = await import("../prisma/syntheticSeeder/sync/readModels");
    const ctx = run("rm", { paymentAttempts: 2000, paymentLinks: 900 });
    const { merchants, routes } = buildReadModels(ctx);
    expect(merchants.reduce((sum, row) => sum + row.attemptCount, 0)).toBe(ctx.dataset.paymentAttempts.length);
    expect(routes.reduce((sum, row) => sum + row.attemptCount, 0)).toBe(ctx.dataset.paymentAttempts.length);
    const settled = ctx.dataset.paymentAttempts.filter((a) => ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"].includes(String(a.status))).length;
    expect(merchants.reduce((sum, row) => sum + row.successCount, 0)).toBe(settled);
    expect(routes.reduce((sum, row) => sum + row.successCount, 0)).toBe(settled);
    const gross = ctx.dataset.paymentAttempts.reduce((sum, a) => sum + Number(a.totalChargedAmount) * 10_000, 0);
    expect(Number(merchants.reduce((sum, row) => sum + row.gross, 0n))).toBe(Math.round(gross));
  });
});
