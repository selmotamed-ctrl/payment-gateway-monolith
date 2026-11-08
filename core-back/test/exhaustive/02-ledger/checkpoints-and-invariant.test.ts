/**
 * Suite 02.4 — checkpoints and the continuous double-entry invariant against
 * the live database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import {
  assertZeroDrift,
  databaseIsReachable,
  exhaustiveClient,
  verifyInvariant,
} from "../_harness";
import { createRow } from "../_dbFactory";
import { withLedgerMaintenance } from "../../helpers/ledgerMaintenance";
import {
  LedgerPoster,
  type LedgerAccountType,
  type LedgerPostContext,
} from "../../../engine/ledger/LedgerPoster";
import { CheckpointService } from "../../../engine/ledger/CheckpointService";
import { InvariantVerifier } from "../../../engine/ledger/InvariantVerifier";
import { loadAccountCheckpointSummary, loadLiveAccountBalances } from "../../../lib/storageEngine/shardBalances";

const db = exhaustiveClient();
const describeDb = databaseIsReachable ? describe : describe.skip;
const PREFIX = `exh2-${crypto.randomUUID()}`;
const placeholders = (count: number): string =>
  Array.from({ length: count }, (_value, index) => `$${index + 1}`).join(",");

const ACCOUNT_TYPES: readonly LedgerAccountType[] = [
  "TREASURY",
  "GATEWAY_CLEARING",
  "MERCHANT_WALLET",
  "PLATFORM_INCOME",
  "PROVIDER_FEE_EXPENSE",
  "GATEWAY_FEE_EXPENSE",
  "GATEWAY_FEE_ACCRUAL",
  "COMMISSION_RECEIVABLE",
  "AML_HOLD",
  "CHARGEBACK_RESERVE",
  "SUSPENSE",
];

const accounts: Partial<Record<LedgerAccountType, string>> = {};
const accountIds: string[] = [];
let poster: LedgerPoster;
let checkpointTreasury = "";
let checkpointIncome = "";
let wideTreasury = "";

/** Journal truth for one account, debit-positive, straight from the lines (never from shards or checkpoints). */
const journalBalance = async (accountId: string): Promise<Decimal> => {
  const rows = (await db.$queryRawUnsafe(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::text AS total FROM journal_lines WHERE gl_account_id = $1::uuid`,
    accountId,
  )) as Array<{ total: string }>;
  return new Decimal(rows[0]?.total ?? "0");
};

const shardRows = async (accountId: string) =>
  (await db.$queryRawUnsafe(
    `SELECT s.shard_id, s.current_balance::text AS balance, s.line_seq::text AS line_seq,
            COALESCE(c.checkpoint_balance, 0)::text AS cp_balance, COALESCE(c.checkpoint_seq, 0)::text AS cp_seq
     FROM gl_account_shards s LEFT JOIN gl_shard_checkpoints c USING (gl_account_id, shard_id)
     WHERE s.gl_account_id = $1::uuid ORDER BY s.shard_id`,
    accountId,
  )) as Array<{ shard_id: number; balance: string; line_seq: string; cp_balance: string; cp_seq: string }>;

const cleanup = async (): Promise<void> => {
  await withLedgerMaintenance(db as never, async (tx) => {
    await tx.$executeRawUnsafe(
      'DELETE FROM "journal_lines" WHERE "entry_id" IN (SELECT "id" FROM "journal_entries" WHERE "ref_id" LIKE $1)',
      `${PREFIX}%`,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM "journal_entries" WHERE "ref_id" LIKE $1',
      `${PREFIX}%`,
    );
  });
  if (accountIds.length > 0) {
    await db.$executeRawUnsafe(
      `DELETE FROM "gl_shard_checkpoints" WHERE "gl_account_id" IN (${placeholders(accountIds.length)})`,
      ...accountIds,
    );
    await db.$executeRawUnsafe(
      `DELETE FROM "gl_account_shards" WHERE "gl_account_id" IN (${placeholders(accountIds.length)})`,
      ...accountIds,
    ).catch(() => undefined);
    await db.$executeRawUnsafe(
      `DELETE FROM "gl_accounts" WHERE "id" IN (${placeholders(accountIds.length)})`,
      ...accountIds,
    );
  }
};

beforeAll(async () => {
  if (!databaseIsReachable) {
    return;
  }
  for (const accountType of ACCOUNT_TYPES) {
    const row = await createRow("gl_accounts", { account_type: accountType, currency: "LYD" });
    accounts[accountType] = String(row.id);
    accountIds.push(String(row.id));
  }
  const checkpointTreasuryRow = await createRow("gl_accounts", { account_type: "TREASURY", currency: "LYD" });
  const checkpointIncomeRow = await createRow("gl_accounts", { account_type: "PLATFORM_INCOME", currency: "LYD" });
  checkpointTreasury = String(checkpointTreasuryRow.id);
  checkpointIncome = String(checkpointIncomeRow.id);
  // A spread account: routing width 4, so its credits land on several shards (the trigger created shard rows 0..3).
  const wideTreasuryRow = await createRow("gl_accounts", { account_type: "TREASURY", currency: "LYD", shard_count: 4 });
  wideTreasury = String(wideTreasuryRow.id);
  accountIds.push(checkpointTreasury, checkpointIncome, wideTreasury);
  poster = new LedgerPoster(db as never);
});

afterAll(async () => {
  if (!databaseIsReachable) {
    return;
  }
  try {
    await cleanup();
    await assertZeroDrift(db);
  } finally {
    await db.$disconnect();
  }
});

describeDb("Suite 02 · checkpoints", () => {
  test("captureShard snapshots the shard at its sequence and later postings are the delta on top", async () => {
    const treasury = checkpointTreasury;
    const context: LedgerPostContext = {
      accounts: { ...accounts, TREASURY: checkpointTreasury, PLATFORM_INCOME: checkpointIncome },
    };

    await poster.postScenario("CASHOUT", `${PREFIX}-cp-first`, { amount: "10.0000" }, context);
    const service = new CheckpointService(db as never);
    const checkpoint = await service.captureShard(treasury, 0);
    expect(checkpoint.status).toBe("ADVANCED");
    expect(checkpoint.checkpointSeq).toBe(1n);
    expect(checkpoint.checkpointBalance.toFixed(4)).toBe("-10.0000");

    await poster.postScenario("CASHOUT", `${PREFIX}-cp-second`, { amount: "5.0000" }, context);

    // inspect is read-only: it reports checkpoint + delta = live without moving anything
    const inspected = await service.inspectShard(treasury, 0);
    expect(inspected.previousSeq).toBe(1n);
    expect(inspected.lineSeq).toBe(2n);
    expect(inspected.linesFound).toBe(1n);
    expect(inspected.drift.toFixed(4)).toBe("0.0000");
    expect(inspected.balance.toFixed(4)).toBe("-15.0000");
    expect((await shardRows(treasury))[0]!.cp_seq).toBe("1");

    const summary = (await loadAccountCheckpointSummary(db as never, [treasury]))[0]!;
    expect(summary.checkpointBalance).toBe("-10.0000");
    expect(summary.pendingLines).toBe("1");
    expect(summary.shardsBehind).toBe(1);
    const [live] = await loadLiveAccountBalances(db as never, [treasury]);
    expect(live!.source).toBe("shards");
    expect(new Decimal(live!.balance).toFixed(4)).toBe("-15.0000"); // TREASURY is debit-natural: balance == debit-positive total

    const caught = await service.captureShard(treasury, 0);
    expect(caught.status).toBe("ADVANCED");
    expect(caught.checkpointBalance.toFixed(4)).toBe("-15.0000");
    expect((await journalBalance(treasury)).toFixed(4)).toBe("-15.0000");
  });

  test("the live-balance loader enumerates every account from its shards", async () => {
    const balances = await loadLiveAccountBalances(db as never, accountIds);
    expect(balances.length).toBe(accountIds.length);
    expect(new Set(balances.map((entry) => entry.source))).toEqual(new Set(["shards"]));
    expect(balances.length).toBeGreaterThanOrEqual(ACCOUNT_TYPES.length);
    for (const entry of balances) {
      expect(new Decimal(entry.balance).abs().toFixed(4)).toBe((await journalBalance(entry.id)).abs().toFixed(4));
    }
  });

  test("a checkpoint does not double count the window it covers: a second capture is a no-op and the live balance never moves", async () => {
    const account = checkpointIncome;
    const service = new CheckpointService(db as never);
    const before = await journalBalance(account);
    const first = await service.captureAccount(account);
    expect(first.every((result) => result.status === "ADVANCED" || result.status === "NOOP")).toBe(true);
    const second = await service.captureAccount(account);
    expect(second.every((result) => result.status === "NOOP")).toBe(true);
    const rows = await shardRows(account);
    const checkpointSum = rows.reduce((sum, row) => sum.plus(row.cp_balance), new Decimal(0));
    const liveSum = rows.reduce((sum, row) => sum.plus(row.balance), new Decimal(0));
    expect(checkpointSum.toFixed(4)).toBe(before.toFixed(4));
    expect(liveSum.toFixed(4)).toBe(before.toFixed(4));
    expect(rows.every((row) => row.cp_seq === row.line_seq)).toBe(true);
  });

  test("a spread account keeps a gapless sequence per shard and its shard checkpoints add up to the journal", async () => {
    const context: LedgerPostContext = { accounts: { ...accounts, TREASURY: wideTreasury } };
    for (let index = 0; index < 24; index += 1) {
      await poster.postScenario("CASHOUT", `${PREFIX}-wide-${index}`, { amount: "2.0000" }, context);
    }
    const service = new CheckpointService(db as never);
    const results = await service.captureAccount(wideTreasury);
    expect(results.map((result) => result.shardId)).toEqual([0, 1, 2, 3]);
    expect(results.every((result) => result.status === "ADVANCED" || result.status === "NOOP")).toBe(true);
    expect(results.filter((result) => result.status === "ADVANCED").length).toBeGreaterThan(1); // really spread
    const rows = await shardRows(wideTreasury);
    expect(rows.reduce((sum, row) => sum + Number(row.line_seq), 0)).toBe(24);
    for (const row of rows) {
      const lines = (await db.$queryRawUnsafe(
        `SELECT shard_seq::text AS seq FROM journal_lines WHERE gl_account_id = $1::uuid AND shard_id = $2 ORDER BY shard_seq`,
        wideTreasury,
        row.shard_id,
      )) as Array<{ seq: string }>;
      expect(lines.map((line) => line.seq)).toEqual(Array.from({ length: lines.length }, (_value, index) => String(index + 1)));
      expect(row.cp_seq).toBe(row.line_seq);
    }
    const checkpointSum = rows.reduce((sum, row) => sum.plus(row.cp_balance), new Decimal(0));
    expect(checkpointSum.toFixed(4)).toBe("-48.0000");
    expect((await journalBalance(wideTreasury)).toFixed(4)).toBe("-48.0000");
  });

  test("the SQL invariant path reads shard balances and shard checkpoints from the live database", async () => {
    const verifier = new InvariantVerifier(db as never, { sql: true });
    const result = await verifier.verify();
    expect(result.ok).toBe(true);
    for (const id of [checkpointTreasury, wideTreasury, checkpointIncome]) {
      const balance = result.accountBalances.find((entry) => entry.accountId === id);
      expect(balance).toBeDefined();
      const journal = await journalBalance(id);
      expect(balance!.liveBalance.toFixed(4)).toBe(journal.toFixed(4));
      expect(balance!.checkpointBalance.plus(balance!.delta).toFixed(4)).toBe(journal.toFixed(4));
    }
    // fully captured accounts: the checkpoint is the whole balance and nothing is pending
    const wide = result.accountBalances.find((entry) => entry.accountId === wideTreasury)!;
    expect(wide.checkpointBalance.toFixed(4)).toBe("-48.0000");
    expect(wide.delta.toFixed(4)).toBe("0.0000");
    expect(wide.checkpointAt).toBeInstanceOf(Date);
  });
});

describeDb("Suite 02 · continuous invariant", () => {
  test("500 balanced fuzzed entries keep the system-wide drift at 0.0000", async () => {
    const context: LedgerPostContext = { accounts };
    for (let index = 0; index < 500; index += 1) {
      const refId = `${PREFIX}-batch-${index}`;
      if (index % 2 === 0) {
        await poster.postScenario(
          "INTERNAL_CONFIRMATION",
          refId,
          { amount: "10.0000", commissionAmount: "0.3000" },
          context,
        );
      } else {
        await poster.postScenario(
          "PLATFORM_HELD_FEE_ACCRUAL",
          refId,
          {
            amount: "10.0000",
            commissionAmount: "0.3000",
            gatewayFeeAmount: "0.0500",
            merchantAmount: "9.7000",
          },
          context,
        );
      }
      if ((index + 1) % 100 === 0) {
        const snapshot = await verifyInvariant(db);
        expect(snapshot.ok).toBe(true);
        expect(snapshot.drift).toBe("0.0000");
      }
    }
    const final = await assertZeroDrift(db);
    expect(final.drift).toBe("0.0000");
  }, 180_000);

  test("the invariant detects a deliberately imbalanced balance provider", async () => {
    const verifier = new InvariantVerifier(async () => [
      {
        accountId: "treasury",
        accountType: "TREASURY",
        checkpointBalance: new Decimal(0),
        delta: new Decimal("1.0000"),
        liveBalance: new Decimal("1.0000"),
      },
      {
        accountId: "wallet",
        accountType: "MERCHANT_WALLET",
        checkpointBalance: new Decimal(0),
        delta: new Decimal(0),
        liveBalance: new Decimal(0),
      },
    ]);
    const result = await verifier.verify();
    expect(result.ok).toBe(false);
    expect(result.drift.toFixed(4)).toBe("1.0000");
  });

  test("the SQL invariant detects a forged shard balance (inside a transaction that is rolled back)", async () => {
    const outcome = await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE gl_account_shards SET current_balance = current_balance + 1.2500 WHERE gl_account_id = $1::uuid AND shard_id = 0`,
          checkpointTreasury,
        );
        const result = await new InvariantVerifier(tx as never, { sql: true }).verify();
        expect(result.ok).toBe(false);
        expect(result.drift.abs().toFixed(4)).toBe("1.2500");
        await expect(new InvariantVerifier(tx as never, { sql: true }).assertInvariant()).rejects.toThrow("drift is 1.2500");
        throw new Error("rollback");
      })
      .catch((error: Error) => error.message);
    expect(outcome).toBe("rollback");
    expect((await verifyInvariant(db)).ok).toBe(true);
  });

  test("the invariant accepts the live database after the batch", async () => {
    const result = await verifyInvariant(db);
    expect(result.ok).toBe(true);
    expect(result.drift).toBe("0.0000");
  });
});
