import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import {
  LedgerPoster,
  buildLedgerTemplate,
  buildPaymentConfirmationTemplate,
  decimal,
  type JournalEntryRecord,
  type JournalLineRecord,
  type LedgerPrismaClient,
  type LedgerScenario,
} from "../../engine/ledger/LedgerPoster";
import { CheckpointService } from "../../engine/ledger/CheckpointService";
import { InvariantVerifier } from "../../engine/ledger/InvariantVerifier";

interface FakeState {
  entries: JournalEntryRecord[];
  lines: JournalLineRecord[];
  accounts: Array<{
    id: string;
    accountType: string;
    ownerId?: string | null;
    gatewayId?: string | null;
    credentialSetId?: string | null;
    env?: string | null;
    currency?: string | null;
    checkpointBalance?: unknown;
    checkpointAt?: Date | null;
    lastCheckpointId?: string | null;
  }>;
}

const ACCOUNT_IDS: Record<string, string> = {
  TREASURY: "acc-treasury",
  GATEWAY_CLEARING: "acc-clearing",
  MERCHANT_WALLET: "acc-wallet",
  PLATFORM_INCOME: "acc-income",
  PROVIDER_FEE_EXPENSE: "acc-provider-fee",
  GATEWAY_FEE_EXPENSE: "acc-gateway-fee",
  GATEWAY_FEE_ACCRUAL: "acc-accrual",
  COMMISSION_RECEIVABLE: "acc-receivable",
  AML_HOLD: "acc-aml-hold",
  CHARGEBACK_RESERVE: "acc-chargeback",
  SUSPENSE: "acc-suspense",
};

const createFakeClient = (): { client: LedgerPrismaClient; state: FakeState } => {
  const state: FakeState = { entries: [], lines: [], accounts: [] };
  const client: LedgerPrismaClient = {
    glAccount: {
      findFirst: async ({ where }) => {
        const record = state.accounts.find((account) => {
          for (const [key, value] of Object.entries(where)) {
            if (value === undefined) {
              continue;
            }
            if ((account as Record<string, unknown>)[key] !== value) {
              return false;
            }
          }
          return true;
        });
        return (record as never) ?? null;
      },
      findUnique: async ({ where }) =>
        (state.accounts.find((account) => account.id === where.id) as never) ?? null,
    },
    journalEntry: {
      findFirst: async ({ where }) =>
        (state.entries.find((entry) =>
          entry.refType === where.refType && entry.refId === where.refId) as never) ?? null,
      create: async ({ data }) => {
        const entry: JournalEntryRecord = {
          id: `entry-${state.entries.length + 1}`,
          refType: String(data.refType),
          refId: String(data.refId),
          description: String(data.description ?? ""),
        };
        state.entries.push(entry);
        return entry;
      },
    },
    journalLine: {
      create: async ({ data }) => {
        const line: JournalLineRecord = {
          id: `line-${state.lines.length + 1}`,
          entryId: String(data.entryId),
          glAccountId: String(data.glAccountId),
          direction: data.direction as "DEBIT" | "CREDIT",
          amount: data.amount as never,
        };
        state.lines.push(line);
        return line;
      },
    },
  };
  return { client, state };
};

const debitTotal = (lines: readonly JournalLineRecord[]): Decimal =>
  lines
    .filter((line) => line.direction === "DEBIT")
    .reduce((total, line) => total.plus(decimal(line.amount)), new Decimal(0));

const creditTotal = (lines: readonly JournalLineRecord[]): Decimal =>
  lines
    .filter((line) => line.direction === "CREDIT")
    .reduce((total, line) => total.plus(decimal(line.amount)), new Decimal(0));

const SCENARIOS: readonly LedgerScenario[] = [
  "PLATFORM_HELD_CONFIRMATION",
  "PLATFORM_HELD_FEE_ACCRUAL",
  "SETTLEMENT_SWEEP",
  "FEE_VARIANCE_TRUE_UP",
  "PAYER_SURCHARGE_CONFIRMATION",
  "MERCHANT_DIRECT_CONFIRMATION",
  "AML_HOLD_AND_RELEASE",
  "CASHOUT",
  "FULL_REFUND",
  "CHARGEBACK_RESERVE_AND_LOST",
  "AML_VOID",
  "CHARGEBACK_WON",
  "INTERNAL_CONFIRMATION",
  "INTERNAL_REFUND",
  "CHARGEBACK_INSUFFICIENT",
  "SUSPENSE_SETTLEMENT",
];

describe("all 16 journal entry templates", () => {
  test("every scenario builds a balanced entry with strictly positive lines", () => {
    for (const scenario of SCENARIOS) {
      const template = buildLedgerTemplate(scenario, { amount: "100" });
      expect(template.lines.length).toBeGreaterThanOrEqual(2);
      const debits = template.lines
        .filter((line) => line.direction === "DEBIT")
        .reduce((total, line) => total.plus(decimal(line.amount)), new Decimal(0));
      const credits = template.lines
        .filter((line) => line.direction === "CREDIT")
        .reduce((total, line) => total.plus(decimal(line.amount)), new Decimal(0));
      expect(debits.equals(credits)).toBe(true);
      expect(debits.gt(0)).toBe(true);
      for (const line of template.lines) {
        expect(decimal(line.amount).gt(0)).toBe(true);
      }
    }
  });

  test("scenario 1 platform held confirmation deducts the provider fee at source", () => {
    const template = buildLedgerTemplate("PLATFORM_HELD_CONFIRMATION", {
      amount: "100",
      commissionAmount: "3",
      providerFeeAmount: "1",
    });
    expect(template.lines).toHaveLength(4);
    const byAccount = new Map(template.lines.map((line) => [line.account.accountType, line]));
    expect(String(byAccount.get("TREASURY")?.amount)).toBe("99");
    expect(String(byAccount.get("PROVIDER_FEE_EXPENSE")?.amount)).toBe("1");
    expect(String(byAccount.get("MERCHANT_WALLET")?.amount)).toBe("97");
    expect(String(byAccount.get("PLATFORM_INCOME")?.amount)).toBe("3");
  });

  test("scenario 2 platform held confirmation accrues the gateway fee", () => {
    const template = buildLedgerTemplate("PLATFORM_HELD_FEE_ACCRUAL", {
      amount: "100",
      commissionAmount: "3",
      gatewayFeeAmount: "0.8",
    });
    const byAccount = new Map(template.lines.map((line) => [line.account.accountType, line]));
    expect(String(byAccount.get("GATEWAY_CLEARING")?.amount)).toBe("100");
    expect(String(byAccount.get("GATEWAY_FEE_EXPENSE")?.amount)).toBe("0.8");
    expect(String(byAccount.get("GATEWAY_FEE_ACCRUAL")?.amount)).toBe("0.8");
  });

  test("scenario 3 settlement sweep clears the accrual into treasury", () => {
    const template = buildLedgerTemplate("SETTLEMENT_SWEEP", {
      amount: "100",
      gatewayFeeAmount: "0.8",
      settledAmount: "99.2",
    });
    const byAccount = new Map(template.lines.map((line) => [line.account.accountType, line]));
    expect(String(byAccount.get("TREASURY")?.amount)).toBe("99.2");
    expect(String(byAccount.get("GATEWAY_FEE_ACCRUAL")?.amount)).toBe("0.8");
    expect(String(byAccount.get("GATEWAY_CLEARING")?.amount)).toBe("100");
  });

  test("scenario 4 fee variance true-up moves the accrual to the expense account", () => {
    const template = buildLedgerTemplate("FEE_VARIANCE_TRUE_UP", { amount: "100", varianceAmount: "0.1" });
    expect(template.lines).toHaveLength(2);
    expect(template.lines[0]?.account.accountType).toBe("GATEWAY_FEE_EXPENSE");
    expect(template.lines[1]?.account.accountType).toBe("GATEWAY_FEE_ACCRUAL");
  });

  test("scenario 5 payer surcharge charges the surcharge on top of the link amount", () => {
    const template = buildLedgerTemplate("PAYER_SURCHARGE_CONFIRMATION", {
      amount: "100",
      commissionAmount: "3",
      surchargeAmount: "3",
      gatewayFeeAmount: "0.8",
    });
    const byAccount = new Map(template.lines.map((line) => [line.account.accountType, line]));
    expect(String(byAccount.get("GATEWAY_CLEARING")?.amount)).toBe("103");
    expect(String(byAccount.get("MERCHANT_WALLET")?.amount)).toBe("100");
  });

  test("scenario 6 merchant direct settlement books commission receivable", () => {
    const confirm = buildLedgerTemplate("MERCHANT_DIRECT_CONFIRMATION", {
      amount: "100",
      commissionAmount: "3",
    });
    expect(confirm.lines).toHaveLength(2);
    expect(confirm.lines[0]?.account.accountType).toBe("COMMISSION_RECEIVABLE");
    expect(confirm.lines[1]?.account.accountType).toBe("PLATFORM_INCOME");
    const netting = buildLedgerTemplate("MERCHANT_DIRECT_CONFIRMATION", {
      amount: "100",
      commissionAmount: "3",
      stage: "NETTING",
    });
    expect(netting.lines[0]?.account.accountType).toBe("MERCHANT_WALLET");
    expect(netting.lines[1]?.account.accountType).toBe("COMMISSION_RECEIVABLE");
  });

  test("scenario 7 AML hold and release", () => {
    const hold = buildLedgerTemplate("AML_HOLD_AND_RELEASE", { amount: "100", commissionAmount: "3" });
    expect(hold.lines[0]?.account.accountType).toBe("GATEWAY_CLEARING");
    expect(hold.lines[1]?.account.accountType).toBe("AML_HOLD");
    const release = buildLedgerTemplate("AML_HOLD_AND_RELEASE", {
      amount: "100",
      commissionAmount: "3",
      stage: "RELEASE",
    });
    expect(release.lines[0]?.account.accountType).toBe("AML_HOLD");
    expect(release.lines.map((line) => line.account.accountType)).toContain("PLATFORM_INCOME");
  });

  test("scenario 8 cash-out subtracts from the merchant wallet", () => {
    const template = buildLedgerTemplate("CASHOUT", { amount: "100" });
    expect(template.lines[0]?.account.accountType).toBe("MERCHANT_WALLET");
    expect(template.lines[1]?.account.accountType).toBe("TREASURY");
  });

  test("scenario 9 full refund reverses commission", () => {
    const template = buildLedgerTemplate("FULL_REFUND", { amount: "100", commissionAmount: "3" });
    const byAccount = new Map(template.lines.map((line) => [line.account.accountType, line]));
    expect(String(byAccount.get("MERCHANT_WALLET")?.amount)).toBe("97");
    expect(String(byAccount.get("PLATFORM_INCOME")?.amount)).toBe("3");
    expect(String(byAccount.get("TREASURY")?.amount)).toBe("100");
  });

  test("scenario 10 chargeback reserve and loss", () => {
    const reserve = buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", {
      amount: "100",
      commissionAmount: "3",
    });
    expect(reserve.lines[2]?.account.accountType).toBe("CHARGEBACK_RESERVE");
    const lost = buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", {
      amount: "100",
      commissionAmount: "3",
      stage: "LOST",
    });
    expect(lost.lines[0]?.account.accountType).toBe("CHARGEBACK_RESERVE");
    expect(lost.lines[1]?.account.accountType).toBe("TREASURY");
  });

  test("scenario 11 AML void returns the funds", () => {
    const template = buildLedgerTemplate("AML_VOID", { amount: "100" });
    expect(template.refType).toBe("AML_VOID");
    expect(template.lines[0]?.account.accountType).toBe("AML_HOLD");
    expect(template.lines[1]?.account.accountType).toBe("TREASURY");
  });

  test("scenario 12 chargeback won releases the reserve", () => {
    const template = buildLedgerTemplate("CHARGEBACK_WON", { amount: "100", commissionAmount: "3" });
    expect(template.lines[0]?.account.accountType).toBe("CHARGEBACK_RESERVE");
    expect(template.lines.map((line) => line.account.accountType)).toContain("MERCHANT_WALLET");
  });

  test("scenario 13 internal confirmation posts straight to treasury with no clearing leg", () => {
    const template = buildLedgerTemplate("INTERNAL_CONFIRMATION", {
      amount: "100",
      commissionAmount: "3",
    });
    expect(template.lines.map((line) => line.account.accountType)).not.toContain("GATEWAY_CLEARING");
    expect(template.lines[0]?.account.accountType).toBe("TREASURY");
  });

  test("scenario 14 internal refund returns funds to treasury", () => {
    const template = buildLedgerTemplate("INTERNAL_REFUND", { amount: "100", commissionAmount: "3" });
    expect(template.lines.map((line) => line.account.accountType)).toContain("TREASURY");
    expect(template.lines.map((line) => line.account.accountType)).toContain("PLATFORM_INCOME");
  });

  test("scenario 15 chargeback against an insufficient wallet still posts in full", () => {
    const template = buildLedgerTemplate("CHARGEBACK_INSUFFICIENT", {
      amount: "100",
      commissionAmount: "3",
    });
    expect(template.lines.map((line) => line.account.accountType)).toContain("CHARGEBACK_RESERVE");
    const debits = template.lines
      .filter((line) => line.direction === "DEBIT")
      .reduce((total, line) => total.plus(decimal(line.amount)), new Decimal(0));
    const credits = template.lines
      .filter((line) => line.direction === "CREDIT")
      .reduce((total, line) => total.plus(decimal(line.amount)), new Decimal(0));
    expect(debits.toFixed(4)).toBe(credits.toFixed(4));
  });
});

describe("payment confirmation ownership modes", () => {
  test("INTERNAL mode applies ledger rule INTERNAL-1", () => {
    const template = buildPaymentConfirmationTemplate({
      ownershipMode: "INTERNAL",
      amount: "100",
      commissionAmount: "3",
    });
    expect(template.lines.map((line) => line.account.accountType)).not.toContain("GATEWAY_CLEARING");
    expect(template.lines.map((line) => line.account.accountType)).toContain("TREASURY");
  });

  test("PLATFORM_CLEARING mode uses the clearing account", () => {
    const template = buildPaymentConfirmationTemplate({
      ownershipMode: "PLATFORM_CLEARING",
      feeAccrual: true,
      amount: "100",
      commissionAmount: "3",
      gatewayFeeAmount: "0.8",
    });
    expect(template.lines.map((line) => line.account.accountType)).toContain("GATEWAY_CLEARING");
  });

  test("MERCHANT_DIRECT mode books commission receivable", () => {
    const template = buildPaymentConfirmationTemplate({
      ownershipMode: "MERCHANT_DIRECT",
      amount: "100",
      commissionAmount: "3",
    });
    expect(template.lines.map((line) => line.account.accountType)).toContain("COMMISSION_RECEIVABLE");
  });

  test("PAYER_SURCHARGE fee bearer charges the surcharge", () => {
    const template = buildPaymentConfirmationTemplate({
      ownershipMode: "PLATFORM_CLEARING",
      feeBearer: "PAYER_SURCHARGE",
      amount: "100",
      commissionAmount: "3",
      surchargeAmount: "3",
      gatewayFeeAmount: "0.8",
    });
    expect(template.lines.map((line) => line.account.accountType)).toContain("GATEWAY_CLEARING");
  });
});

describe("LedgerPoster posting behaviour", () => {
  test("posts a balanced entry and resolves accounts from the context", async () => {
    const { client, state } = createFakeClient();
    const poster = new LedgerPoster(client);
    const template = buildLedgerTemplate("INTERNAL_CONFIRMATION", {
      amount: "100",
      commissionAmount: "3",
    });
    template.refId = "attempt-1";
    const result = await poster.post(template, {
      accounts: { ...ACCOUNT_IDS } as never,
    });
    expect(result.created).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(result.lines).toHaveLength(3);
    expect(debitTotal(result.lines).equals(creditTotal(result.lines))).toBe(true);
    expect(state.lines).toHaveLength(3);
  });

  test("is idempotent for a repeated reference", async () => {
    const { client, state } = createFakeClient();
    const poster = new LedgerPoster(client);
    const template = buildLedgerTemplate("INTERNAL_CONFIRMATION", {
      amount: "100",
      commissionAmount: "3",
    });
    template.refId = "attempt-1";
    const first = await poster.post(template, { accounts: { ...ACCOUNT_IDS } as never });
    const second = await poster.post(template, { accounts: { ...ACCOUNT_IDS } as never });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(state.entries).toHaveLength(1);
    expect(state.lines).toHaveLength(3);
  });

  test("rejects an unbalanced template", async () => {
    const { client } = createFakeClient();
    const poster = new LedgerPoster(client);
    await expect(
      poster.post({
        refType: "PAYMENT_ATTEMPT",
        refId: "bad",
        description: "unbalanced",
        lines: [
          { direction: "DEBIT", amount: "10", account: { accountType: "TREASURY" } },
          { direction: "CREDIT", amount: "9", account: { accountType: "PLATFORM_INCOME" } },
        ],
      }),
    ).rejects.toThrow();
  });

  test("rejects a non positive line amount", async () => {
    const { client } = createFakeClient();
    const poster = new LedgerPoster(client);
    expect(() =>
      poster.validateTemplate({
        refType: "PAYMENT_ATTEMPT",
        refId: "bad",
        description: "zero",
        lines: [
          { direction: "DEBIT", amount: "0", account: { accountType: "TREASURY" } },
          { direction: "CREDIT", amount: "0", account: { accountType: "PLATFORM_INCOME" } },
        ],
      }),
    ).toThrow();
  });
});

describe("checkpoint service and live balances", () => {
  const buildClient = () => {
    const accounts = [
      { id: "acc-treasury", accountType: "TREASURY" as const, checkpointBalance: 0, checkpointAt: null },
    ];
    const lines: JournalLineRecord[] = [
      {
        id: "l1",
        entryId: "e1",
        glAccountId: "acc-treasury",
        direction: "DEBIT" as const,
        amount: "100",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      } as unknown as JournalLineRecord,
      {
        id: "l2",
        entryId: "e2",
        glAccountId: "acc-treasury",
        direction: "CREDIT" as const,
        amount: "30",
        createdAt: new Date("2026-02-01T00:00:00Z"),
      } as unknown as JournalLineRecord,
    ];
    return {
      accounts,
      lines,
      client: {
        glAccount: {
          findUnique: async ({ where }: { where: { id: string } }) =>
            accounts.find((account) => account.id === where.id) ?? null,
          findMany: async () => accounts,
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const account = accounts.find((entry) => entry.id === where.id);
            if (!account) {
              throw new Error("account not found");
            }
            Object.assign(account, data);
            return account;
          },
        },
        journalLine: {
          findMany: async ({ where }: { where: { glAccountId: string } }) =>
            lines.filter((line) => line.glAccountId === where.glAccountId),
        },
      },
    };
  };

  test("captures a checkpoint and resolves the live balance", async () => {
    const { client, accounts } = buildClient();
    const service = new CheckpointService(client);
    const checkpoint = await service.captureCheckpoint("acc-treasury", new Date("2026-01-15T00:00:00Z"));
    expect(decimal(checkpoint.balance).toFixed(4)).toBe("100.0000");
    expect(accounts[0]?.checkpointBalance).toBeDefined();
    const live = await service.getLiveBalance("acc-treasury");
    expect(live.liveBalance.toFixed(4)).toBe("70.0000");
  });
});

describe("system wide ledger invariant", () => {
  test("reports zero drift for a consistent posting", async () => {
    const balances = [
      { accountId: "a1", accountType: "TREASURY" as const, checkpointBalance: new Decimal(0), delta: new Decimal(0), liveBalance: new Decimal("100") },
      { accountId: "a2", accountType: "MERCHANT_WALLET" as const, checkpointBalance: new Decimal(0), delta: new Decimal(0), liveBalance: new Decimal("-97") },
      { accountId: "a3", accountType: "PLATFORM_INCOME" as const, checkpointBalance: new Decimal(0), delta: new Decimal(0), liveBalance: new Decimal("-3") },
    ];
    const verifier = new InvariantVerifier(async () => balances);
    const result = await verifier.verify();
    expect(result.drift.toFixed(4)).toBe("0.0000");
    expect(result.ok).toBe(true);
  });

  test("reports the drift when the ledger is inconsistent", async () => {
    const balances = [
      { accountId: "a1", accountType: "TREASURY" as const, checkpointBalance: new Decimal(0), delta: new Decimal(0), liveBalance: new Decimal("100") },
      { accountId: "a2", accountType: "MERCHANT_WALLET" as const, checkpointBalance: new Decimal(0), delta: new Decimal(0), liveBalance: new Decimal("-90") },
      { accountId: "a3", accountType: "PLATFORM_INCOME" as const, checkpointBalance: new Decimal(0), delta: new Decimal(0), liveBalance: new Decimal("-3") },
    ];
    const verifier = new InvariantVerifier(async () => balances);
    const result = await verifier.verify();
    expect(result.ok).toBe(false);
    expect(result.drift.toFixed(4)).toBe("7.0000");
    await expect(verifier.assertInvariant()).rejects.toThrow();
  });

  test("computes balances from journal lines when no provider is supplied", async () => {
    const client = {
      glAccount: {
        findMany: async () => [
          { id: "a1", accountType: "TREASURY" as const },
          { id: "a2", accountType: "MERCHANT_WALLET" as const },
          { id: "a3", accountType: "PLATFORM_INCOME" as const },
        ],
      },
      journalLine: {
        findMany: async () => [
          { id: "l1", entryId: "e1", glAccountId: "a1", direction: "DEBIT" as const, amount: "100" },
          { id: "l2", entryId: "e1", glAccountId: "a2", direction: "CREDIT" as const, amount: "97" },
          { id: "l3", entryId: "e1", glAccountId: "a3", direction: "CREDIT" as const, amount: "3" },
        ],
      },
    };
    const verifier = new InvariantVerifier(client);
    const result = await verifier.verify();
    expect(result.ok).toBe(true);
    expect(result.drift.toFixed(4)).toBe("0.0000");
  });
});
