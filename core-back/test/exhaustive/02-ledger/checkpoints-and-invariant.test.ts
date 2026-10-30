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
import {
  LedgerPoster,
  type LedgerAccountType,
  type LedgerPostContext,
} from "../../../engine/ledger/LedgerPoster";
import { CheckpointService } from "../../../engine/ledger/CheckpointService";
import { InvariantVerifier } from "../../../engine/ledger/InvariantVerifier";

const db = exhaustiveClient();
const describeDb = databaseIsReachable ? describe : describe.skip;
const PREFIX = `exh2-${crypto.randomUUID()}`;

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

const resetCheckpoints = async (): Promise<void> => {
  if (accountIds.length === 0) {
    return;
  }
  await db.$executeRawUnsafe(
    `UPDATE gl_accounts SET checkpoint_balance = 0, checkpoint_at = NULL WHERE id IN (${accountIds.map(() => "?").join(",")})`,
    ...accountIds,
  );
};

const maxLineDate = async (accountId: string): Promise<Date> => {
  const rows = (await db.$queryRawUnsafe(
    "SELECT MAX(created_at) AS latest FROM journal_lines WHERE gl_account_id = ?",
    accountId,
  )) as Array<{ latest: Date | string | null }>;
  const latest = rows[0]?.latest;
  return latest ? new Date(latest) : new Date();
};

const cleanup = async (): Promise<void> => {
  await resetCheckpoints();
  await db.$executeRawUnsafe(
    "DELETE jl FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.ref_id LIKE ?",
    `${PREFIX}%`,
  );
  await db.$executeRawUnsafe("DELETE FROM journal_entries WHERE ref_id LIKE ?", `${PREFIX}%`);
  if (accountIds.length > 0) {
    await db.$executeRawUnsafe(
      `DELETE FROM gl_accounts WHERE id IN (${accountIds.map(() => "?").join(",")})`,
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
  accountIds.push(checkpointTreasury, checkpointIncome);
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
  test("captureCheckpoint snapshots the balance and getLiveBalance adds later lines", async () => {
    const treasury = checkpointTreasury;
    const context: LedgerPostContext = {
      accounts: { ...accounts, TREASURY: checkpointTreasury, PLATFORM_INCOME: checkpointIncome },
    };

    await poster.postScenario(
      "CASHOUT",
      `${PREFIX}-cp-first`,
      { amount: "10.0000" },
      context,
    );
    await Bun.sleep(15);
    const service = new CheckpointService(db as never);
    const checkpoint = await service.captureCheckpoint(treasury, await maxLineDate(treasury));
    expect(new Decimal(String(checkpoint.balance)).toFixed(4)).toBe("-10.0000");

    await Bun.sleep(15);
    await poster.postScenario(
      "CASHOUT",
      `${PREFIX}-cp-second`,
      { amount: "5.0000" },
      context,
    );

    const live = await service.getLiveBalance(treasury);
    expect(live.checkpointBalance.toFixed(4)).toBe("-10.0000");
    expect(live.delta.toFixed(4)).toBe("-5.0000");
    expect(live.liveBalance.toFixed(4)).toBe("-15.0000");
  });

  test("getLiveBalances enumerates every account", async () => {
    const service = new CheckpointService(db as never);
    const balances = await service.getLiveBalances(accountIds);
    expect(balances.length).toBeGreaterThanOrEqual(ACCOUNT_TYPES.length);
  });

  test("a checkpoint does not double count the window it covers", async () => {
    const account = checkpointIncome;
    const service = new CheckpointService(db as never);
    const before = await service.getLiveBalance(account);
    await Bun.sleep(15);
    const checkpoint = await service.captureCheckpoint(account, await maxLineDate(account));
    const after = await service.getLiveBalance(account);
    expect(new Decimal(String(checkpoint.balance)).toFixed(4)).toBe(before.liveBalance.toFixed(4));
    expect(after.liveBalance.toFixed(4)).toBe(before.liveBalance.toFixed(4));
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

  test("the invariant accepts the live database after the batch", async () => {
    const result = await verifyInvariant(db);
    expect(result.ok).toBe(true);
    expect(result.drift).toBe("0.0000");
  });
});
