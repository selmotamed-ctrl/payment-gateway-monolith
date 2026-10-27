import { beforeEach, describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { PrismaRepositories } from "../engine/db/repositories";
import { LedgerPoster } from "../engine/ledger/LedgerPoster";
import {
  executeAmlCaseResolution,
  type GovernanceExecutionContext,
} from "../engine/governance/GovernanceExecution";
import {
  createFakePrisma,
  fakeTable,
  resetFakeDatabase,
  type FakePrisma,
  type FakeRow,
} from "./helpers/governanceFake";

const attachPaymentLinkModel = (client: FakePrisma): void => {
  const rows = (): FakeRow[] => fakeTable("paymentLink");
  client.paymentLink = {
    async findUnique(args: { where: { id: string } }): Promise<FakeRow | null> {
      return rows().find((row) => row.id === args.where.id) ?? null;
    },
    async update(args: { where: { id: string }; data: FakeRow }): Promise<FakeRow> {
      const row = rows().find((entry) => entry.id === args.where.id);
      if (!row) {
        throw new Error("Fake 'paymentLink' row not found");
      }
      Object.assign(row, args.data);
      return row;
    },
  };
};

interface Fixture {
  client: FakePrisma;
  context: GovernanceExecutionContext;
  events: Array<{ topic: string; payload: unknown }>;
}

const buildFixture = (link: {
  infiniteUse?: boolean;
  useCount?: number;
  confirmedCount?: number;
  activeLockedCount?: number;
} = {}): Fixture => {
  resetFakeDatabase();
  const client = createFakePrisma();
  attachPaymentLinkModel(client);
  const repositories = new PrismaRepositories(client as never);
  const ledgerPoster = new LedgerPoster(client as never);
  const events: Array<{ topic: string; payload: unknown }> = [];

  for (const [id, accountType, extra] of [
    ["acc-treasury", "TREASURY", {}],
    ["acc-clearing", "GATEWAY_CLEARING", {}],
    ["acc-wallet", "MERCHANT_WALLET", { ownerId: "merchant-1" }],
    ["acc-income", "PLATFORM_INCOME", {}],
    ["acc-aml-hold", "AML_HOLD", {}],
  ] as const) {
    client.glAccount.create({ data: { id, accountType, currency: "LYD", ...extra } });
  }
  client.merchant.create({
    data: {
      id: "merchant-1",
      legalName: "Merchant One",
      tradeName: "Merchant One",
      status: "ACTIVE",
      kybStatus: "VERIFIED",
      riskTier: "STANDARD",
      onboardingChannel: "DIRECT",
      country: "LY",
      negativeBalanceCeiling: new Decimal(0),
      activatedAt: new Date(),
    },
  });
  client.wallet.create({
    data: {
      id: "wallet-1",
      merchantId: "merchant-1",
      glAccountId: "acc-wallet",
      currency: "LYD",
      status: "ACTIVE",
    },
  });
  client.paymentAttempt.create({
    data: {
      id: "attempt-1",
      reference: "PA-0001",
      linkId: "link-1",
      merchantId: "merchant-1",
      applicationId: "app-1",
      currency: "LYD",
      env: "LIVE",
      status: "CREATED",
      totalChargedAmount: new Decimal(100),
      platformCommissionAmount: new Decimal(3),
      netMerchantAmount: new Decimal(97),
      settlementTarget: "PLATFORM_CLEARING",
      terminalAt: null,
      nextCheckAt: new Date("2026-10-01T00:00:00.000Z"),
    },
  });
  fakeTable("paymentLink").push({
    id: "link-1",
    infiniteUse: link.infiniteUse ?? false,
    useCount: link.useCount ?? 1,
    confirmedCount: link.confirmedCount ?? 0,
    activeLockedCount: link.activeLockedCount ?? 1,
    state: "PENDING",
  });
  client.journalEntry.create({
    data: { id: "hold-entry", refType: "PAYMENT_ATTEMPT", refId: "attempt-1", description: "AML threshold hold" },
  });
  client.journalLine.create({
    data: {
      id: "hold-line",
      entryId: "hold-entry",
      glAccountId: "acc-aml-hold",
      direction: "CREDIT",
      amount: new Decimal(100),
    },
  });
  client.amlCase.create({
    data: {
      id: "aml-case-1",
      subjectType: "PAYMENT_ATTEMPT",
      subjectId: "attempt-1",
      triggerReason: "AML_RULE:AML-SINGLE-AMOUNT",
      severity: "HIGH",
      severityInputsJson: {},
      status: "OPEN",
      holdJournalEntryId: "hold-entry",
      confidential: true,
    },
  });

  return {
    client,
    events,
    context: {
      ledgerPoster,
      repositories,
      transitionBus: {
        publish: async (topic, payload) => {
          events.push({ topic, payload });
          return {
            id: "event",
            namespace: "test",
            topic,
            payload,
            publishedAt: new Date().toISOString(),
          };
        },
      },
    },
  };
};

const resolve = async (fixture: Fixture, action: "RELEASE" | "REJECT") =>
  fixture.client.$transaction(async (tx) =>
    executeAmlCaseResolution(fixture.context, tx as never, {
      amlCaseId: "aml-case-1",
      action,
      checkerUserId: "user-checker",
      checkerRole: "MLRO",
    }),
  );

const attemptRow = (): FakeRow | undefined =>
  fakeTable("paymentAttempt").find((row) => row.id === "attempt-1");

const linkRow = (): FakeRow | undefined =>
  fakeTable("paymentLink").find((row) => row.id === "link-1");

const entryOf = (refType: string): FakeRow | undefined =>
  fakeTable("journalEntry").find((row) => row.refType === refType && row.refId === "attempt-1");

describe("F-NEW-3: an AML resolution finalises the attempt and the link slot", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  test("RELEASE succeeds the attempt, commits the slot and posts the release", async () => {
    const result = await resolve(fixture, "RELEASE");

    expect(result.status).toBe("EXECUTED");
    const entry = entryOf("AML_RELEASE");
    expect(entry).toBeDefined();

    const attempt = attemptRow();
    expect(attempt?.status).toBe("SUCCEEDED");
    expect(attempt?.terminalAt).toBeInstanceOf(Date);
    expect(attempt?.nextCheckAt).toBeNull();
    expect(attempt?.ledgerEntryId).toBe(String(entry?.id));

    const link = linkRow();
    expect(link?.confirmedCount).toBe(1);
    expect(link?.activeLockedCount).toBe(0);
    expect(link?.state).toBe("COMPLETED");

    expect(fixture.events).toHaveLength(1);
    const transition = fixture.events[0];
    expect(transition?.topic).toBe("attempt:transition");
    expect(transition ? (transition.payload as { status?: string }).status : undefined).toBe("SUCCEEDED");
  });

  test("REJECT fails the attempt, releases the slot and posts AML_VOID", async () => {
    fixture = buildFixture({ useCount: 5 });

    const result = await resolve(fixture, "REJECT");

    expect(result.status).toBe("EXECUTED");
    expect(entryOf("AML_VOID")).toBeDefined();

    const attempt = attemptRow();
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.terminalAt).toBeInstanceOf(Date);
    expect(attempt?.nextCheckAt).toBeNull();

    const link = linkRow();
    expect(link?.confirmedCount).toBe(0);
    expect(link?.activeLockedCount).toBe(0);
    expect(link?.state).toBe("PENDING");

    const transition = fixture.events[0];
    expect(transition ? (transition.payload as { status?: string }).status : undefined).toBe("FAILED");
  });

  test("a second resolution is a no-op and never double counts the slot", async () => {
    await resolve(fixture, "RELEASE");
    const firstTerminalAt = attemptRow()?.terminalAt;
    const journalCount = fakeTable("journalEntry").length;

    const second = await resolve(fixture, "RELEASE");

    expect(second.status).toBe("SKIPPED");
    expect(attemptRow()?.terminalAt).toBe(firstTerminalAt);
    expect(linkRow()?.confirmedCount).toBe(1);
    expect(linkRow()?.activeLockedCount).toBe(0);
    expect(fakeTable("journalEntry")).toHaveLength(journalCount);
  });

  test("an infinite-use link is never completed by a release", async () => {
    fixture = buildFixture({ infiniteUse: true, useCount: 1 });

    await resolve(fixture, "RELEASE");

    const link = linkRow();
    expect(link?.confirmedCount).toBe(1);
    expect(link?.activeLockedCount).toBe(0);
    expect(link?.state).toBe("PENDING");
  });
});
