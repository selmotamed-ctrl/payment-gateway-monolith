import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Decimal } from "decimal.js";
import { PrismaRepositories } from "../../engine/db/repositories";
import { LedgerPoster } from "../../engine/ledger/LedgerPoster";
import { executeCashout, type GovernanceExecutionContext } from "../../engine/governance/GovernanceExecution";
import { createFakePrisma, fakeTable, resetFakeDatabase, type FakePrisma } from "../helpers/governanceFake";

let client: FakePrisma;
let ctx: GovernanceExecutionContext;

const seed = (walletBalance: number | null, over: { walletStatus?: string; merchantStatus?: string } = {}) => {
  resetFakeDatabase();
  client = createFakePrisma();
  for (const [id, accountType, ownerId] of [["acc-treasury", "TREASURY", undefined], ["acc-wallet", "MERCHANT_WALLET", "merchant-1"]] as const) {
    client.glAccount.create({ data: { id, accountType, ...(ownerId ? { ownerId } : {}), currency: "LYD" } });
  }
  client.merchant.create({
    data: {
      id: "merchant-1", legalName: "M", tradeName: "M", status: over.merchantStatus ?? "ACTIVE", kybStatus: "VERIFIED",
      riskTier: "STANDARD", onboardingChannel: "DIRECT", country: "LY", negativeBalanceCeiling: new Decimal(0), activatedAt: new Date(),
    },
  });
  client.wallet.create({
    data: { id: "wallet-1", merchantId: "merchant-1", glAccountId: "acc-wallet", currency: "LYD", status: over.walletStatus ?? "ACTIVE" },
  });
  if (walletBalance) {
    client.journalEntry.create({ data: { id: "se", refType: "PAYMENT_ATTEMPT", refId: "a0", description: "seed" } });
    client.journalLine.create({ data: { id: "sl", entryId: "se", glAccountId: "acc-wallet", direction: "CREDIT", amount: new Decimal(walletBalance) } });
  }
  ctx = {
    ledgerPoster: new LedgerPoster(client as never),
    repositories: new PrismaRepositories(client as never),
    slots: { commitSlot: async () => ({ outcome: "COMMITTED" as const }), releaseSlot: async () => {} },
  } as never;
};

const mkCashout = (id: string, state: string, amount = 100) =>
  client.cashoutRequest.create({
    data: { id, merchantId: "merchant-1", walletId: "wallet-1", amount: new Decimal(amount), destinationBankJson: {}, state },
  });
const run = (cashoutId: string, decision: "APPROVE" | "REJECT") =>
  client.$transaction(async (tx) => executeCashout(ctx, tx as never, { cashoutId, decision, actorUserId: "u", actorRole: "FINANCE" }));
const failure = async (promise: Promise<unknown>): Promise<{ code?: string }> =>
  promise.then(
    () => ({}),
    (error: { code?: string }) => error,
  );
const state = (id: string) => fakeTable("cashoutRequest").find((row) => row.id === id)?.state;
const payouts = () => fakeTable("journalEntry").filter((entry) => entry.refType === "ADJUSTMENT");

describe("H4 executeCashout state machine and ledger guards", () => {
  beforeEach(() => seed(1000));

  test("approving twice pays out once and the journal references the cash-out id", async () => {
    await mkCashout("c1", "PENDING");
    const first = await run("c1", "APPROVE");
    const second = await run("c1", "APPROVE");
    expect(first.status).toBe("EXECUTED");
    expect(second.status).toBe("SKIPPED");
    expect(second.idempotent).toBe(true);
    expect(payouts()).toHaveLength(1);
    expect(payouts()[0]!.refId).toBe("c1");
    expect(state("c1")).toBe("COMPLETE");
  });

  test("approving a REJECTED request is refused and pays nothing", async () => {
    await mkCashout("c2", "REJECTED");
    expect((await failure(run("c2", "APPROVE"))).code).toBe("CASHOUT_STATE_INVALID");
    expect(payouts()).toHaveLength(0);
    expect(state("c2")).toBe("REJECTED");
  });

  test("rejecting a COMPLETE request is refused and the terminal state is immutable", async () => {
    await mkCashout("c3", "PENDING");
    await run("c3", "APPROVE");
    expect((await failure(run("c3", "REJECT"))).code).toBe("CASHOUT_STATE_INVALID");
    expect(state("c3")).toBe("COMPLETE");
  });

  test("rejecting is only possible from PENDING and repeating a rejection is an idempotent no-op", async () => {
    await mkCashout("c6", "PENDING");
    expect((await run("c6", "REJECT")).status).toBe("EXECUTED");
    const again = await run("c6", "REJECT");
    expect(again.status).toBe("SKIPPED");
    expect(again.idempotent).toBe(true);
    expect(state("c6")).toBe("REJECTED");
    expect(payouts()).toHaveLength(0);
  });

  test("a cash-out larger than the wallet balance is refused and the request stays PENDING", async () => {
    await mkCashout("c4", "PENDING", 5000);
    expect((await failure(run("c4", "APPROVE"))).code).toBe("CASHOUT_INSUFFICIENT_BALANCE");
    expect(state("c4")).toBe("PENDING");
    expect(payouts()).toHaveLength(0);
  });

  test("a cash-out from a wallet with no balance is refused", async () => {
    seed(null);
    await mkCashout("c5", "PENDING", 100);
    expect((await failure(run("c5", "APPROVE"))).code).toBe("CASHOUT_INSUFFICIENT_BALANCE");
    expect(state("c5")).toBe("PENDING");
  });

  test("two approvals in a row cannot overdraw: the second request no longer fits the balance", async () => {
    await mkCashout("d1", "PENDING", 700);
    await mkCashout("d2", "PENDING", 700);
    await run("d1", "APPROVE");
    expect((await failure(run("d2", "APPROVE"))).code).toBe("CASHOUT_INSUFFICIENT_BALANCE");
    expect(state("d2")).toBe("PENDING");
    expect(payouts()).toHaveLength(1);
  });

  test("a frozen wallet or a suspended merchant cannot be paid out, but a rejection still releases the request", async () => {
    seed(1000, { walletStatus: "FROZEN" });
    await mkCashout("w1", "PENDING");
    expect((await failure(run("w1", "APPROVE"))).code).toBe("WALLET_NOT_ACTIVE");
    expect((await run("w1", "REJECT")).status).toBe("EXECUTED");

    seed(1000, { merchantStatus: "SUSPENDED" });
    await mkCashout("w2", "PENDING");
    expect((await failure(run("w2", "APPROVE"))).code).toBe("MERCHANT_NOT_ACTIVE");
    expect(state("w2")).toBe("PENDING");
  });

  test("the state transition is a conditional update that claims the request first", () => {
    const source = readFileSync("engine/governance/GovernanceExecution.ts", "utf8");
    const body = source.slice(source.indexOf("export async function executeCashout("), source.indexOf("const executeRegulatoryReportApproval"));
    expect(body).toContain("updateMany");
    expect(body).toContain('state: { in: OPEN_STATES }');
    expect(body).toContain("journal.refId = String(cashout.id)");
    expect(body).not.toContain("journal.refId = String(adjustment.id)");
  });
});

describe("H4 intake and ordering", () => {
  test("the shard lock ordering uses byte order, not locale order", () => {
    const source = readFileSync("lib/storageEngine/uowAdapter.ts", "utf8");
    expect(source).not.toContain("localeCompare");
  });

  test("the merchant intake requires an idempotency key, an active merchant and wallet, a typed bound destination and a balance check", () => {
    const merchant = readFileSync("api/internal/merchant.ts", "utf8");
    const start = merchant.indexOf('router.post("/cashouts"');
    const body = merchant.slice(start, merchant.indexOf('router.get("/tokens"', start));
    expect(body).toContain("IDEMPOTENCY_KEY_REQUIRED");
    expect(body).toContain("MERCHANT_NOT_ACTIVE");
    expect(body).toContain("WALLET_NOT_ACTIVE");
    expect(body).toContain("CASHOUT_DESTINATION_NOT_VERIFIED");
    expect(body).toContain("lockWalletLedgerBalance(");
    expect(body).toContain("openCashoutTotal(");
    expect(body).toContain("INSUFFICIENT_BALANCE");
    expect(body).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(body).toContain("cashoutDestinationSchema");
    expect(body).not.toMatch(/destinationBank: z\.record/);
  });

  test("the staff cash-out decision needs the checker authority cashout:review", () => {
    const admin = readFileSync("api/internal/admin.ts", "utf8");
    const start = admin.indexOf('router.post("/cashouts/:id/process"');
    expect(admin.slice(start, start + 700)).toContain('requireAuthorities(request, ["cashout:review"])');
  });
});
