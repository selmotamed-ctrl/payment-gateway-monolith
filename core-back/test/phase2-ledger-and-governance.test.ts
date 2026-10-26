import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Vault } from "../engine/crypto/Vault";
import { buildLedgerTemplate, buildPaymentConfirmationTemplate, decimal, LedgerPoster } from "../engine/ledger/LedgerPoster";
import { CheckpointService } from "../engine/ledger/CheckpointService";
import { InvariantVerifier } from "../engine/ledger/InvariantVerifier";
import { ApprovalService, SYSTEM_AUTOMATION } from "../engine/governance/ApprovalService";
import { DetailChangeService } from "../engine/governance/DetailChangeService";

const masterKey = Buffer.alloc(32, 9);

const buildLedgerClient = () => {
  const entries = new Map<string, Record<string, unknown>>();
  const lines: Record<string, unknown>[] = [];
  const accounts = [
    { id: "treasury", accountType: "TREASURY" },
    { id: "clearing", accountType: "GATEWAY_CLEARING" },
    { id: "wallet", accountType: "MERCHANT_WALLET" },
    { id: "income", accountType: "PLATFORM_INCOME" },
    { id: "provider", accountType: "PROVIDER_FEE_EXPENSE" },
    { id: "fee", accountType: "GATEWAY_FEE_EXPENSE" },
    { id: "accrual", accountType: "GATEWAY_FEE_ACCRUAL" },
    { id: "receivable", accountType: "COMMISSION_RECEIVABLE" },
    { id: "aml", accountType: "AML_HOLD" },
    { id: "reserve", accountType: "CHARGEBACK_RESERVE" },
    { id: "suspense", accountType: "SUSPENSE" },
  ];
  const client = {
    glAccount: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const match = accounts.find((account) => account.accountType === where.accountType);
        return match ? { ...match, ownerId: null, gatewayId: null, credentialSetId: null, env: null, currency: null } : null;
      },
    },
    journalEntry: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        for (const entry of entries.values()) {
          if (entry.ref_type === where.ref_type && entry.ref_id === where.ref_id) {
            return entry;
          }
        }
        return null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const entry = { id: `entry-${entries.size + 1}`, ...data };
        entries.set(entry.id as string, entry);
        return entry;
      },
    },
    journalLine: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const line = { id: `line-${lines.length + 1}`, ...data };
        lines.push(line);
        return line;
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(client),
  };
  return { client, entries, lines };
};

describe("phase 2 vault", () => {
  test("encrypts and decrypts a secret with a versioned key id", async () => {
    const vault = new Vault({ masterKey });
    const payload = await vault.encryptSecret("super-secret", "credential-set");
    expect(payload.split(":")).toHaveLength(4);
    expect(payload.startsWith("credential-set:")).toBe(true);
    expect(await vault.decryptSecret(payload)).toBe("super-secret");
  });

  test("rejects a tampered ciphertext", async () => {
    const vault = new Vault({ masterKey });
    const payload = await vault.encryptSecret("super-secret", "credential-set");
    const parts = payload.split(":");
    const tampered = [parts[0], parts[1], parts[2], Buffer.from("tampered").toString("base64")].join(":");
    await expect(vault.decryptSecret(tampered)).rejects.toThrow();
  });

  test("redacts sensitive field names and literal secrets", () => {
    const vault = new Vault({ masterKey });
    const redacted = vault.redactPayload(
      {
        password: "visible",
        authorization: "Bearer abc",
        nested: { otp: "123456", safe: "keep" },
        note: "the literal abc is secret",
      },
      ["abc"],
    ) as Record<string, unknown>;
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.authorization).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).otp).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).safe).toBe("keep");
    expect(redacted.note).toContain("[REDACTED]");
  });
});

describe("phase 2 ledger", () => {
  const scenarios = [
    ["PLATFORM_HELD_CONFIRMATION", undefined],
    ["PLATFORM_HELD_FEE_ACCRUAL", undefined],
    ["SETTLEMENT_SWEEP", undefined],
    ["FEE_VARIANCE_TRUE_UP", undefined],
    ["PAYER_SURCHARGE_CONFIRMATION", undefined],
    ["MERCHANT_DIRECT_CONFIRMATION", undefined],
    ["AML_HOLD_AND_RELEASE", "RELEASE"],
    ["CASHOUT", undefined],
    ["FULL_REFUND", undefined],
    ["CHARGEBACK_RESERVE_AND_LOST", undefined],
    ["AML_VOID", undefined],
    ["CHARGEBACK_WON", undefined],
    ["INTERNAL_CONFIRMATION", undefined],
    ["INTERNAL_REFUND", undefined],
    ["CHARGEBACK_INSUFFICIENT", undefined],
  ] as const;

  test("covers the fifteen worked journal entries", () => {
    expect(scenarios.length).toBe(15);
  });

  test("every scenario balances with strictly positive lines", () => {
    for (const [scenario, stage] of scenarios) {
      const template = buildLedgerTemplate(scenario, {
        amount: "100.0000",
        commissionAmount: "3.0000",
        merchantAmount: "97.0000",
        stage,
      });
      let debits = decimal(0);
      let credits = decimal(0);
      for (const line of template.lines) {
        const amount = decimal(line.amount);
        expect(amount.gt(0)).toBe(true);
        if (line.direction === "DEBIT") {
          debits = debits.plus(amount);
        } else {
          credits = credits.plus(amount);
        }
      }
      expect(debits.eq(credits)).toBe(true);
      expect(debits.gt(0)).toBe(true);
    }
  });

  test("posts one entry and is idempotent for a repeated reference", async () => {
    const { client, lines } = buildLedgerClient();
    const poster = new LedgerPoster(client as never);
    const template = buildPaymentConfirmationTemplate({
      ownershipMode: "PLATFORM_CLEARING",
      feeBearer: "MERCHANT_ABSORBS",
      amount: "100.0000",
      commissionAmount: "3.0000",
      merchantAmount: "97.0000",
      providerFeeAmount: "1.0000",
      gatewayFeeAmount: "0.8000",
    });
    template.refId = "attempt-1";
    const first = await poster.post(template);
    expect(first.created).toBe(true);
    expect(lines).toHaveLength(first.lines.length);
    const second = await poster.post(template);
    expect(second.idempotent).toBe(true);
    expect(second.created).toBe(false);
  });

  test("rejects an unbalanced template", () => {
    const poster = new LedgerPoster(buildLedgerClient().client as never);
    expect(() =>
      poster.validateTemplate({
        refType: "PAYMENT_ATTEMPT",
        refId: "attempt-2",
        description: "unbalanced",
        lines: [
          { direction: "DEBIT", amount: "10.0000", account: { accountType: "TREASURY" } },
          { direction: "CREDIT", amount: "9.0000", account: { accountType: "PLATFORM_INCOME" } },
        ],
      }),
    ).toThrow();
  });

  test("resolves the live balance from the checkpoint plus the journal lines", async () => {
    const account = {
      id: "wallet",
      accountType: "MERCHANT_WALLET",
      ownerId: "merchant-1",
      gatewayId: null,
      credentialSetId: null,
      env: null,
      currency: "LYD",
      checkpointBalance: decimal("10.0000"),
      checkpointAt: new Date("2026-01-01T00:00:00.000Z"),
      lastCheckpointId: "cp-1",
    };
    const client = {
      glAccount: { findUnique: async () => account },
      journalLine: {
        findMany: async () => [
          { direction: "CREDIT", amount: decimal("5.0000") },
          { direction: "DEBIT", amount: decimal("2.0000") },
        ],
      },
    };
    const service = new CheckpointService(client as never);
    const balance = await service.getLiveBalance("wallet");
    expect(balance.liveBalance.toFixed(4)).toBe("7.0000");
    expect(balance.checkpointBalance.toFixed(4)).toBe("10.0000");
    expect(balance.accountType).toBe("MERCHANT_WALLET");
  });

  test("reports zero drift when the system wide invariant holds", async () => {
    const verifier = new InvariantVerifier(async () => [
      { accountId: "treasury", accountType: "TREASURY", checkpointBalance: decimal(0), delta: decimal("100.0000"), liveBalance: decimal("100.0000") },
      { accountId: "wallet", accountType: "MERCHANT_WALLET", checkpointBalance: decimal(0), delta: decimal("-97.0000"), liveBalance: decimal("-97.0000") },
      { accountId: "income", accountType: "PLATFORM_INCOME", checkpointBalance: decimal(0), delta: decimal("-3.0000"), liveBalance: decimal("-3.0000") },
    ]);
    const result = await verifier.verify();
    expect(result.drift.toFixed(4)).toBe("0.0000");
    expect(result.ok).toBe(true);
  });
});

describe("phase 2 governance", () => {
  const buildApprovalClient = () => {
    const rows = new Map<string, Record<string, unknown>>();
    const client = {
      approvalRequest: {
        findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `approval-${rows.size + 1}`, ...data };
          rows.set(row.id as string, row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = { ...(rows.get(where.id) ?? {}), ...data };
          rows.set(where.id, row);
          return row;
        },
      },
    };
    return { rows, client };
  };

  test("keeps the maker and the checker apart and executes once approved", async () => {
    const { rows, client } = buildApprovalClient();
    const executed: string[] = [];
    const service = new ApprovalService(client as never, {
      execute: async (_tx, request) => {
        executed.push(request.id);
      },
    });
    const proposal = await service.proposeApproval({
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
      payloadDiff: [{ op: "replace", path: "/riskTier", value: "HIGH" }],
    });
    expect(rows.get(proposal.id)?.state).toBe("PENDING_REVIEW");
    await expect(service.approveRequest(proposal.id, "maker-1")).rejects.toThrow();
    await expect(service.approveRequest(proposal.id, SYSTEM_AUTOMATION)).rejects.toThrow();
    const approved = await service.approveRequest(proposal.id, "checker-2");
    expect(approved.state).toBe("EXECUTED");
    expect(executed).toHaveLength(1);
  });

  test("records a field level change history", async () => {
    const changes: Record<string, unknown>[] = [];
    const client = {
      detailChangeLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `change-${changes.length + 1}`, ...data };
          changes.push(row);
          return row;
        },
        findMany: async () => changes,
      },
    };
    const service = new DetailChangeService(client as never);
    await service.recordChange({
      actorId: "user-1",
      merchantId: "merchant-1",
      entityType: "MERCHANT",
      entityId: "merchant-1",
      requestId: randomBytes(8).toString("hex"),
      source: "ADMIN",
      before: { riskTier: "STANDARD", kybStatus: "PENDING" },
      after: { riskTier: "HIGH", kybStatus: "VERIFIED" },
    });
    expect(changes.length).toBe(2);
    const fields = changes.map((change) => change.fieldName).sort();
    expect(fields).toEqual(["kybStatus", "riskTier"]);
  });
});
