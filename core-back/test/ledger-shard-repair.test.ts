/**
 * Shard repair (live PostgreSQL). The journal is the truth and a shard is a projection of it: a repair recomputes the
 * projection. RECOMPUTE (intact sequence) may be automatic; REBASELINE (damaged sequence) is never automatic.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import { LedgerPoster, type JournalTemplate } from "../engine/ledger/LedgerPoster";
import { CheckpointService } from "../engine/ledger/CheckpointService";
import { applyShardRepair, planShardRepair, shouldAutoRepair, type AutoRepairPolicy, type ShardRepairPlan } from "../engine/ledger/ShardRepair";
import { clearShardWidthCache } from "../lib/storageEngine/shardRouting";
import { withLedgerMaintenance } from "./helpers/ledgerMaintenance";
import { cleanupLedger, createPrisma, databaseIsReachable, seedActorUser, seedGlAccount, uniqueId } from "./storage-engine/helpers/db";

const client = createPrisma({ max: 40 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const created: string[] = [];
const refPrefix = uniqueId("repair");

afterAll(async () => {
  if (created.length > 0) await cleanupLedger(client, created, refPrefix);
  await client.$disconnect();
});

const template = (refId: string, treasury: string, wallet: string): JournalTemplate => ({
  refType: "PAYMENT_ATTEMPT",
  refId,
  description: "repair test",
  lines: [
    { direction: "DEBIT", amount: "2.0000", account: { accountType: "TREASURY", accountId: treasury } },
    { direction: "CREDIT", amount: "2.0000", account: { accountType: "MERCHANT_WALLET", accountId: wallet } },
  ],
});

const seed = async () => {
  const treasury = (await seedGlAccount(client, { accountType: "TREASURY", shardCount: 1 })).id;
  const wallet = (await seedGlAccount(client, { accountType: "MERCHANT_WALLET", shardCount: 1 })).id;
  created.push(treasury, wallet);
  clearShardWidthCache();
  const poster = new LedgerPoster(client as never);
  const post = (n: number) => poster.post(template(`${refPrefix}-${randomUUID()}-${n}`, treasury, wallet), { accounts: { TREASURY: treasury, MERCHANT_WALLET: wallet }, currency: "LYD" });
  return { treasury, wallet, post };
};

const journalTotal = async (account: string): Promise<Decimal> => {
  const rows = await client.$queryRawUnsafe<Array<{ total: string }>>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::text AS total FROM journal_lines WHERE gl_account_id = $1::uuid`,
    account,
  );
  return new Decimal(rows[0]!.total);
};
const shardBalance = async (account: string): Promise<Decimal> =>
  new Decimal((await client.glAccountShard.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: account, shardId: 0 } } })).currentBalance.toString());

const policy = (overrides: Partial<AutoRepairPolicy> = {}): AutoRepairPolicy => ({ enabled: true, minConsecutiveFailures: 3, maxAbsDelta: new Decimal(100), ...overrides });

describeDb("shard repair", () => {
  test("a healthy shard needs no repair", async () => {
    const { treasury, post } = await seed();
    for (let i = 0; i < 5; i += 1) await post(i);
    await new CheckpointService(client as never).captureShard(treasury, 0);
    const plan = await planShardRepair(client, treasury, 0);
    expect(plan.needsRepair).toBe(false);
    expect(plan.kind).toBeNull();
    expect(plan.sequenceIntact).toBe(true);
  });

  test("PARITY drift with an intact sequence is repaired by recomputing from the journal, audited and recorded", async () => {
    const { treasury, post } = await seed();
    const actor = await seedActorUser(client);
    for (let i = 0; i < 8; i += 1) await post(i);
    const service = new CheckpointService(client as never);
    await service.captureShard(treasury, 0);
    for (let i = 0; i < 4; i += 1) await post(100 + i);
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET current_balance = current_balance + 0.5 WHERE gl_account_id = $1::uuid AND shard_id = 0`, treasury);
    expect((await service.captureShard(treasury, 0)).status).toBe("PARITY");

    const plan = await planShardRepair(client, treasury, 0);
    expect(plan.needsRepair).toBe(true);
    expect(plan.kind).toBe("RECOMPUTE");
    expect(plan.sequenceIntact).toBe(true);
    expect(plan.delta.toFixed(4)).toBe("-0.5000");
    expect(plan.after.balance.toFixed(4)).toBe((await journalTotal(treasury)).toFixed(4));

    const result = await applyShardRepair(client, {
      glAccountId: treasury,
      shardId: 0,
      mode: "MANUAL",
      allowedKinds: ["RECOMPUTE"],
      expectedPlanHash: plan.planHash,
      reason: "recompute after a forged drift",
      actor: { actorId: actor, role: "FINANCE" },
    });
    expect(result.repaired).toBe(true);
    expect((await shardBalance(treasury)).toFixed(4)).toBe((await journalTotal(treasury)).toFixed(4));
    expect((await service.captureShard(treasury, 0)).status).not.toBe("PARITY");
    expect((await service.captureShard(treasury, 0)).status).toBe("NOOP");
    const row = await client.glShardCheckpoint.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: treasury, shardId: 0 } } });
    expect(row.status).toBe("OK");
    expect(row.consecutiveFailures).toBe(0);
    expect(row.baselineSeq).toBe(0n);
    const history = await client.glShardRepair.findMany({ where: { glAccountId: treasury } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: "RECOMPUTE", mode: "MANUAL", actorId: actor });
    expect(history[0]!.delta.toFixed(4)).toBe("-0.5000");
    const audits = await client.auditLog.findMany({ where: { entityId: treasury, action: "GL_SHARD_REPAIRED" } });
    expect(audits).toHaveLength(1);
    // idempotent: a second repair finds nothing to do
    const again = await applyShardRepair(client, { glAccountId: treasury, shardId: 0, mode: "MANUAL", allowedKinds: ["RECOMPUTE"], reason: "again", actor: { actorId: actor, role: "FINANCE" } });
    expect(again.repaired).toBe(false);
  });

  test("a plan hash that no longer matches (the shard moved since the preview) is refused", async () => {
    const { treasury, post } = await seed();
    const actor = await seedActorUser(client);
    for (let i = 0; i < 3; i += 1) await post(i);
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET current_balance = current_balance + 1 WHERE gl_account_id = $1::uuid AND shard_id = 0`, treasury);
    const plan = await planShardRepair(client, treasury, 0);
    await post(99); // the shard moves after the preview
    await expect(
      applyShardRepair(client, { glAccountId: treasury, shardId: 0, mode: "MANUAL", allowedKinds: ["RECOMPUTE"], expectedPlanHash: plan.planHash, reason: "stale preview", actor: { actorId: actor, role: "FINANCE" } }),
    ).rejects.toMatchObject({ code: "SHARD_REPAIR_PLAN_CHANGED" });
    expect(await client.glShardRepair.count({ where: { glAccountId: treasury } })).toBe(0);
  });

  test("a damaged sequence (a lost line) is a REBASELINE that the single-user path refuses and an approved one performs", async () => {
    const { treasury, wallet, post } = await seed();
    const actor = await seedActorUser(client);
    for (let i = 0; i < 6; i += 1) await post(i);
    const service = new CheckpointService(client as never);
    await service.captureShard(treasury, 0);
    for (let i = 0; i < 4; i += 1) await post(50 + i);
    // lose the line with sequence 8 of the treasury shard (the journal "lost" a line the shard still counts)
    await withLedgerMaintenance(client, (tx) => tx.journalLine.deleteMany({ where: { glAccountId: treasury, shardId: 0, shardSeq: 8n } }));
    expect((await service.captureShard(treasury, 0)).status).toBe("GAP");

    const plan = await planShardRepair(client, treasury, 0);
    expect(plan.sequenceIntact).toBe(false);
    expect(plan.kind).toBe("REBASELINE");
    expect(plan.after.lineSeq).toBe(plan.before.lineSeq); // a number is never reused
    expect(plan.after.baselineSeq).toBe(plan.before.lineSeq);

    await expect(
      applyShardRepair(client, { glAccountId: treasury, shardId: 0, mode: "MANUAL", allowedKinds: ["RECOMPUTE"], expectedPlanHash: plan.planHash, reason: "single user", actor: { actorId: actor, role: "FINANCE" } }),
    ).rejects.toMatchObject({ code: "SHARD_REPAIR_NEEDS_APPROVAL" });
    expect(shouldAutoRepair(plan, policy({ minConsecutiveFailures: 0 })).allowed).toBe(false);

    const approvalId = randomUUID();
    const result = await applyShardRepair(client, {
      glAccountId: treasury,
      shardId: 0,
      mode: "APPROVED",
      allowedKinds: ["RECOMPUTE", "REBASELINE"],
      expectedPlanHash: plan.planHash,
      reason: "approved re-baseline after a lost journal line",
      actor: { actorId: actor, role: "SECURITY_ADMIN" },
      approvalRequestId: null,
    });
    void approvalId;
    expect(result.repaired).toBe(true);
    expect((await shardBalance(treasury)).toFixed(4)).toBe((await journalTotal(treasury)).toFixed(4));
    const row = await client.glShardCheckpoint.findUniqueOrThrow({ where: { glAccountId_shardId: { glAccountId: treasury, shardId: 0 } } });
    expect(row.baselineSeq).toBe(plan.before.lineSeq);
    expect(row.checkpointSeq).toBe(plan.before.lineSeq);
    // the shard is healthy again, new postings continue above the baseline and are proven incrementally
    expect((await planShardRepair(client, treasury, 0)).needsRepair).toBe(false);
    for (let i = 0; i < 5; i += 1) await post(200 + i);
    expect((await service.captureShard(treasury, 0)).status).toBe("ADVANCED");
    expect((await planShardRepair(client, treasury, 0)).needsRepair).toBe(false);
    void wallet;
  });

  test("repairing while postings run leaves the shard equal to the journal and never deadlocks", async () => {
    const { treasury, post } = await seed();
    const actor = await seedActorUser(client);
    for (let i = 0; i < 10; i += 1) await post(i);
    await client.$executeRawUnsafe(`UPDATE gl_account_shards SET current_balance = current_balance - 3 WHERE gl_account_id = $1::uuid AND shard_id = 0`, treasury);
    const errors: string[] = [];
    const posters = Promise.all(
      Array.from({ length: 6 }, async (_, w) => {
        for (let i = 0; i < 15; i += 1) {
          try {
            await post(1000 + w * 100 + i);
          } catch (error) {
            errors.push(String((error as Error).message));
          }
        }
      }),
    );
    const repair = applyShardRepair(client, { glAccountId: treasury, shardId: 0, mode: "MANUAL", allowedKinds: ["RECOMPUTE"], reason: "repair under load", actor: { actorId: actor, role: "FINANCE" } });
    await Promise.all([posters, repair]);
    expect(errors).toEqual([]);
    expect((await repair).repaired).toBe(true);
    expect((await shardBalance(treasury)).toFixed(4)).toBe((await journalTotal(treasury)).toFixed(4));
    expect((await new CheckpointService(client as never).captureShard(treasury, 0)).status).not.toBe("PARITY");
  });
});

describe("automatic repair policy", () => {
  const plan = (overrides: Partial<ShardRepairPlan> = {}): ShardRepairPlan => ({
    glAccountId: "a",
    shardId: 0,
    needsRepair: true,
    kind: "RECOMPUTE",
    sequenceIntact: true,
    status: "PARITY",
    consecutiveFailures: 3,
    before: { balance: new Decimal(10), lineSeq: 5n, checkpointBalance: new Decimal(0), checkpointSeq: 0n, baselineSeq: 0n },
    truth: { total: new Decimal(9), uptoCheckpoint: new Decimal(0), linesAfterBaseline: 5n, distinctAfterBaseline: 5n, maxSeq: 5n },
    after: { balance: new Decimal(9), lineSeq: 5n, checkpointBalance: new Decimal(9), checkpointSeq: 5n, baselineSeq: 0n },
    delta: new Decimal(-1),
    planHash: "h",
    ...overrides,
  });

  test("repairs only a persistent PARITY RECOMPUTE within the amount limit", () => {
    expect(shouldAutoRepair(plan(), policy()).allowed).toBe(true);
    expect(shouldAutoRepair(plan(), policy({ enabled: false })).allowed).toBe(false);
    expect(shouldAutoRepair(plan({ consecutiveFailures: 2 }), policy()).allowed).toBe(false);
    expect(shouldAutoRepair(plan({ delta: new Decimal(-100.0001) }), policy()).allowed).toBe(false);
    expect(shouldAutoRepair(plan({ delta: new Decimal(-100) }), policy()).allowed).toBe(true);
    expect(shouldAutoRepair(plan({ status: "GAP" }), policy()).allowed).toBe(false);
    expect(shouldAutoRepair(plan({ kind: "REBASELINE", sequenceIntact: false }), policy()).allowed).toBe(false);
    expect(shouldAutoRepair(plan({ needsRepair: false, kind: null }), policy()).allowed).toBe(false);
  });
});
