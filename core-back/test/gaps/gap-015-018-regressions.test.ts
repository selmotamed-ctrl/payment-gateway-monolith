import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Decimal } from "decimal.js";
import { PrismaRepositories } from "../../engine/db/repositories";
import { LedgerPoster } from "../../engine/ledger/LedgerPoster";
import { executeMerchantPatch, type GovernanceExecutionContext } from "../../engine/governance/GovernanceExecution";
import type { CallbackVerifier } from "../../engine/flow/DynamicRailEngine";
import { createHarness, type EngineHarness } from "../exhaustive/04-rail-engine/_engineHarness";
import { createFakePrisma, fakeTable, resetFakeDatabase } from "../helpers/governanceFake";
import {
  createFakePrisma as createJobFakePrisma,
  resetFakeDatabase as resetJobFakeDatabase,
} from "../helpers/backgroundJobFake";

const verifierFor = (getHarness: () => EngineHarness, mode: () => "success" | "failure"): CallbackVerifier => ({
  async verify() {
    const { attempt } = getHarness();
    return {
      verified: true,
      attemptId: attempt.id,
      evidence: {
        status: mode() === "success" ? "SUCCESS" : "FAILED",
        reference: attempt.gatewayReference,
        amount: attempt.totalChargedAmount,
        currency: attempt.currency,
        environment: attempt.env,
      },
    };
  },
});

const callback = (harness: EngineHarness, key: string) =>
  harness.engine.verifyCallback("WEBHOOK", { attemptId: harness.attempt.id, dedupeKey: key });

describe("GAP-016: re-finalize guard", () => {
  const build = (status: string, substatus?: string) => {
    let harness!: EngineHarness;
    harness = createHarness("sadad", { callbackVerifier: verifierFor(() => harness, () => "success") });
    harness.attempt.status = status as never;
    if (substatus) harness.attempt.substatus = substatus;
    return harness;
  };

  test("a second trusted callback (new event id) on a SUCCEEDED attempt is an idempotent no-op", async () => {
    const harness = build("AWAITING_CUSTOMER");
    await callback(harness, "evt-1");
    const again = await callback(harness, "evt-2");
    expect(again.status).toBe("SUCCEEDED");
    expect(harness.calls.ledgerConfirmation).toHaveLength(1);
    expect(harness.calls.commit).toHaveLength(1);
  });

  test("a callback for a CANCELLED or BLOCKED attempt is refused with ATTEMPT_TERMINAL and posts nothing", async () => {
    for (const status of ["CANCELLED", "BLOCKED"]) {
      const harness = build(status);
      await expect(callback(harness, "evt-1")).rejects.toMatchObject({ code: "ATTEMPT_TERMINAL", statusCode: 409 });
      expect(String(harness.attempt.status)).toBe(status);
      expect(harness.calls.ledgerConfirmation).toHaveLength(0);
      expect(harness.calls.commit).toHaveLength(0);
    }
  });

  test("a legitimate late success on a FAILED attempt is still recovered", async () => {
    const harness = build("FAILED");
    const result = await callback(harness, "evt-1");
    expect(result.status).toBe("SUCCEEDED");
    expect(harness.calls.ledgerConfirmation).toHaveLength(1);
    expect(harness.calls.operatorCases.some((entry) => entry.kind === "LATE_SUCCESS")).toBe(true);
  });
});

describe("GAP-015: AML-held capture is escrowed, never settled", () => {
  test("a verified capture of a held attempt books the escrow, not the payment confirmation", async () => {
    let harness!: EngineHarness;
    harness = createHarness("sadad", { callbackVerifier: verifierFor(() => harness, () => "success") });
    harness.attempt.status = "AWAITING_CUSTOMER";
    harness.attempt.substatus = "AML_HOLD";

    const result = await callback(harness, "evt-1");

    expect(result.status).toBe("AWAITING_CUSTOMER");
    expect(result.substatus).toBe("AML_HOLD");
    expect(harness.calls.ledgerScenario).toEqual([harness.attempt.id]);
    expect(harness.calls.ledgerConfirmation).toHaveLength(0);
    expect(harness.calls.commit).toHaveLength(0);
    expect(String(harness.attempt.status)).not.toBe("SUCCEEDED");
  });

  test("the guard no longer books an escrow before capture", () => {
    const source = readFileSync("engine/guards/AttemptGuardPipeline.ts", "utf8");
    expect(source).not.toContain("postAmlHoldEscrow");
    expect(source).toContain("AML_HOLD_PENDING_CAPTURE");
  });
});

describe("GAP-017: payout account maker-checker and mandatory hash", () => {
  const ctx = (client: unknown): GovernanceExecutionContext => ({
    ledgerPoster: new LedgerPoster(client as never),
    repositories: new PrismaRepositories(client as never),
  }) as never;

  const patchWith = (value: unknown) => {
    resetFakeDatabase();
    const client = createFakePrisma();
    (client as Record<string, unknown>).detailChangeLog = { create: async () => ({}) };
    client.merchant.create({
      data: {
        id: "merchant-1", legalName: "M", tradeName: "M", status: "ACTIVE", kybStatus: "VERIFIED", riskTier: "STANDARD",
        onboardingChannel: "DIRECT", country: "LY", negativeBalanceCeiling: new Decimal(0), version: 1,
        payoutBankDetailsJson: { bank: "Old", iban: "LY00OLD" }, payoutAccountHash: "old-hash",
      },
    });
    const run = () => client.$transaction(async (tx) =>
      executeMerchantPatch(ctx(client), tx as never, {
        approvalId: "approval-1",
        merchantId: "merchant-1",
        patch: { kind: "EDIT", baseVersion: 1, patch: [{ op: "replace", path: "/payoutBankDetailsJson", value }] },
        checkerUserId: "checker",
        checkerRole: "COMPLIANCE",
      }));
    return { run, merchant: () => fakeTable("merchant")[0] };
  };

  test("an approved payout-account edit re-derives the KYB payout hash", async () => {
    const { run, merchant } = patchWith({ bank: "New Bank", iban: "LY11NEW" });
    await run();
    expect(merchant()?.payoutAccountHash).toMatch(/^[0-9a-f]{64}$/);
    expect(merchant()?.payoutAccountHash).not.toBe("old-hash");
  });

  test("an approved edit that leaves no derivable hash is refused and the old binding stays", async () => {
    const { run, merchant } = patchWith({ note: "no account" });
    await expect(run()).rejects.toMatchObject({ code: "PAYOUT_ACCOUNT_HASH_REQUIRED" });
    expect(merchant()?.payoutAccountHash).toBe("old-hash");
  });

  test("cash-out intake rejects a merchant without a KYB hash instead of flagging payoutVerified:false", () => {
    const merchant = readFileSync("api/internal/merchant.ts", "utf8");
    const start = merchant.indexOf('router.post("/cashouts"');
    const body = merchant.slice(start, merchant.indexOf('router.get("/tokens"', start));
    expect(body).toContain("CASHOUT_PAYOUT_ACCOUNT_NOT_VERIFIED");
    // A null hash with derivable payout details is backfilled; only a merchant
    // with no derivable account is refused.
    expect(body).toContain("payoutAccountHash(merchant.payoutBankDetailsJson)");
    expect(body).toContain("if (!verifiedPayoutHash)");
    expect(body).not.toContain("payoutVerified: Boolean(");
    expect(body).toContain("payoutVerified: true");
  });

  test("the edit request refuses a payout account without hash material, and join submission requires the hash", () => {
    const admin = readFileSync("api/internal/admin.ts", "utf8");
    expect(admin).toContain("PAYOUT_ACCOUNT_HASH_REQUIRED");
    expect(admin).toContain("JOIN_REQUEST_PAYOUT_HASH_REQUIRED");
  });
});

describe("GAP-018: statement file hash is unique per (source, file_hash)", () => {
  test("the schema and the migration carry the composite unique key", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const model = schema.slice(schema.indexOf("model ReconciliationRun {"), schema.indexOf("/// The durable job queue"));
    expect(model).toMatch(/@@unique\(\[statementSourceId, fileHash\]\)/);
    expect(model).not.toMatch(/fileHash\s+String\s+@unique/);
    const sql = readFileSync("prisma/migrations/20261105130000_statement_unique_source_file_hash/migration.sql", "utf8");
    expect(sql).toContain('DROP INDEX IF EXISTS "reconciliation_runs_file_hash_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "reconciliation_runs_statement_source_id_file_hash_key"');
  });

  test("the repository looks runs up per source, so the same bytes may exist for two sources", async () => {
    resetJobFakeDatabase();
    const client = createJobFakePrisma();
    const repositories = new PrismaRepositories(client as never);
    const base = { windowStart: new Date(), windowEnd: new Date(), fileHash: "h".repeat(64), statsJson: {} };
    const a = await repositories.reconciliation.createRun(client as never, { ...base, statementSourceId: "src-a" });
    const b = await repositories.reconciliation.createRun(client as never, { ...base, statementSourceId: "src-b" });

    const foundA = await repositories.reconciliation.findRunByFileHash(client as never, base.fileHash, "src-a");
    const foundB = await repositories.reconciliation.findRunByFileHash(client as never, base.fileHash, "src-b");
    const none = await repositories.reconciliation.findRunByFileHash(client as never, base.fileHash, "src-c");

    expect(foundA?.id).toBe(a.id);
    expect(foundB?.id).toBe(b.id);
    expect(none).toBeNull();
  });
});
