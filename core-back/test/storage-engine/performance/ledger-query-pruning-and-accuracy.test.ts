/**
 * Ledger query pruning, Index-Only Scan coverage and edge-case accuracy.
 *
 * This suite is the quality gate of the ledger query/index optimisation
 * (design/02-storage-and-performance/ledger_scaling_partition_pruning_and_archive_anchor_plan.md):
 * every query that addresses the monthly-partitioned `journal_lines` must bound
 * `created_at`, and every derived total must come from the same predicate the
 * page query uses. The cases EC-01..EC-18 below are the failure modes a naive
 * implementation would introduce.
 *
 * The suite uses the real admin router, the real LedgerPoster, the real
 * checkpoint/repair services and a real PostgreSQL 18 database. The two
 * in-memory cases (EC-11 and EC-13) use the governance fake only to observe
 * which queries the production code issues; the SQL itself is exercised by the
 * database cases.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { client } from "../../../prisma/client";
import { adminLedgerRouter } from "../../../api/internal/adminLedger";
import { listAccountLines } from "../../../api/internal/ledgerLines";
import { evaluateCommissionReceivableCeiling } from "../../../engine/governance/GovernanceExecution";
import { PrismaRepositories } from "../../../engine/db/repositories";
import { CheckpointService } from "../../../engine/ledger/CheckpointService";
import { applyShardRepair, planShardRepair } from "../../../engine/ledger/ShardRepair";
import { InvariantVerifier } from "../../../engine/ledger/InvariantVerifier";
import { LedgerPoster } from "../../../engine/ledger/LedgerPoster";
import { executeAmlCaseResolution } from "../../../engine/governance/GovernanceExecution";
import {
  createFakePrisma,
  fakeTable,
  resetFakeDatabase,
  type FakeRow,
} from "../../helpers/governanceFake";
import { withLedgerMaintenance } from "../../helpers/ledgerMaintenance";
import {
  createStaffUser,
  dbAvailable,
  makePrincipal,
  neutraliseLedgerSince,
  postEntry,
  startApp,
  uid,
  type TestApp,
} from "../../admin-slice/harness";

const describeDb = dbAvailable ? describe : describe.skip;

const startedAt = new Date(Date.now() - 2_000);
const rawEntryIds: string[] = [];
const merchantIds: string[] = [];
const attemptIds: string[] = [];
const ownAccountIds: string[] = [];

let app: TestApp;
let userId: string;

const makeAccount = async (
  accountType: "MERCHANT_WALLET" | "TREASURY" | "COMMISSION_RECEIVABLE" | "PLATFORM_INCOME" | "AML_HOLD",
  ownerId: string | null = null,
): Promise<string> => {
  const account = await client.glAccount.create({
    data: { accountType, currency: "LYD", ownerId },
  });
  ownAccountIds.push(account.id);
  return account.id;
};

/**
 * Inserts an entry and its lines directly. Used only where the test must control
 * the timestamp (a partition boundary, a netting entry posted days later): the
 * real poster always stamps `now()`.
 */
const insertRawEntry = async (input: {
  createdAt: Date;
  linesCreatedAt?: Date;
  refType: "ADJUSTMENT" | "PAYMENT_ATTEMPT" | "COMMISSION_NETTING";
  refId: string;
  description: string;
  lines: Array<{ glAccountId: string; direction: "DEBIT" | "CREDIT"; amount: string }>;
}): Promise<string> => {
  const entryId = randomUUID();
  const linesCreatedAt = input.linesCreatedAt ?? input.createdAt;
  await client.$transaction(async (tx) => {
    // The columns are timestamp(3) without time zone; pin the session zone so a
    // Date parameter lands on exactly the intended UTC wall clock.
    await tx.$executeRawUnsafe("SET LOCAL timezone = 'UTC'");
    await tx.$executeRawUnsafe(
      `INSERT INTO "journal_entries" ("id", "created_at", "updated_at", "ref_type", "ref_id", "description")
       VALUES ($1::uuid, $2::timestamptz, $2::timestamptz, $3::"JournalRefType", $4, $5)`,
      entryId,
      input.createdAt,
      input.refType,
      input.refId,
      input.description,
    );
    for (const [index, line] of input.lines.entries()) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "journal_lines"
           ("id", "created_at", "updated_at", "entry_id", "gl_account_id", "direction", "amount", "shard_id", "shard_seq")
         VALUES ($1::uuid, $2::timestamptz, $2::timestamptz, $3::uuid, $4::uuid, $5::"JournalDirection", $6::numeric, 0, $7::bigint)`,
        randomUUID(),
        linesCreatedAt,
        entryId,
        line.glAccountId,
        line.direction,
        line.amount,
        index + 1,
      );
    }
  });
  rawEntryIds.push(entryId);
  return entryId;
};

const deleteRawEntries = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  await withLedgerMaintenance(client as never, async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM "journal_lines" WHERE "entry_id" = ANY($1::uuid[])`, ids);
    await tx.$executeRawUnsafe(`DELETE FROM "journal_entries" WHERE "id" = ANY($1::uuid[])`, ids);
  });
};

const planText = (rows: Array<Record<string, unknown>>): string =>
  rows.map((row) => Object.values(row).map(String).join(" ")).join("\n");

const explain = async (sql: string, ...params: unknown[]): Promise<string> =>
  planText(
    (await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      return (await tx.$queryRawUnsafe(sql, ...params)) as Array<Record<string, unknown>>;
    })) as Array<Record<string, unknown>>,
  );

if (dbAvailable) {
  beforeAll(async () => {
    userId = await createStaffUser("FINANCE");
    app = await startApp([adminLedgerRouter]);
    app.setPrincipal(makePrincipal(userId, ["finance:read", "finance:write"], "FINANCE"));
  });

  afterAll(async () => {
    await deleteRawEntries(rawEntryIds);
    if (attemptIds.length > 0) {
      await client.paymentAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    }
    if (merchantIds.length > 0) {
      await client.merchant.deleteMany({ where: { id: { in: merchantIds } } });
    }
    // The ledger is append-only: leave it system-wide balanced for the invariant suites.
    await neutraliseLedgerSince(startedAt);
    await app.close();
    await client.$disconnect();
  });
}

describeDb("Ledger query pruning, index-only scans & edge-case accuracy", () => {

  test("EC-01 & EC-04: a month-boundary entry returns 100% of its lines (detail and list)", async () => {
    const wallet = await makeAccount("MERCHANT_WALLET", randomUUID());
    const treasury = await makeAccount("TREASURY");
    const refId = uid("ec01-boundary");
    const entryId = await insertRawEntry({
      createdAt: new Date("2026-11-30T23:59:59.950Z"),
      linesCreatedAt: new Date("2026-12-01T00:00:00.050Z"),
      refType: "ADJUSTMENT",
      refId,
      description: "midnight boundary rollover",
      lines: [
        { glAccountId: treasury, direction: "DEBIT", amount: "75.2500" },
        { glAccountId: wallet, direction: "CREDIT", amount: "75.2500" },
      ],
    });

    const detail = await app.request("GET", `/finance/journal-entries/${entryId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.balanced).toBe(true);
    expect(detail.json.totalDebit).toBe("75.2500");
    expect(detail.json.totalCredit).toBe("75.2500");
    expect(detail.json.lines).toHaveLength(2);

    const list = await app.request("GET", `/finance/journal-entries?search=${refId}`);
    expect(list.status).toBe(200);
    expect(list.json.journalEntries).toHaveLength(1);
    expect(list.json.journalEntries[0]).toMatchObject({
      id: entryId,
      balanced: true,
      lineCount: 2,
      totalDebit: "75.2500",
      totalCredit: "75.2500",
    });
  });

  test("EC-02: a list page spanning months keeps the totals of every entry", async () => {
    const wallet = await makeAccount("MERCHANT_WALLET", randomUUID());
    const treasury = await makeAccount("TREASURY");
    const tag = uid("ec02-multimonth");
    const august = await insertRawEntry({
      createdAt: new Date("2026-08-15T10:00:00.000Z"),
      refType: "ADJUSTMENT",
      refId: `${tag}-august`,
      description: `${tag} august entry`,
      lines: [
        { glAccountId: treasury, direction: "DEBIT", amount: "10.0000" },
        { glAccountId: wallet, direction: "CREDIT", amount: "10.0000" },
      ],
    });
    const november = await insertRawEntry({
      createdAt: new Date("2026-11-15T10:00:00.000Z"),
      refType: "ADJUSTMENT",
      refId: `${tag}-november`,
      description: `${tag} november entry`,
      lines: [
        { glAccountId: treasury, direction: "DEBIT", amount: "20.0000" },
        { glAccountId: wallet, direction: "CREDIT", amount: "20.0000" },
      ],
    });

    const list = await app.request("GET", `/finance/journal-entries?search=${tag}`);
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(2);
    const byId = new Map<string, any>(list.json.journalEntries.map((entry: any) => [entry.id, entry]));
    expect(byId.get(august)).toMatchObject({ balanced: true, lineCount: 2, totalDebit: "10.0000", totalCredit: "10.0000" });
    expect(byId.get(november)).toMatchObject({ balanced: true, lineCount: 2, totalDebit: "20.0000", totalCredit: "20.0000" });
  });

  test("EC-03: an empty result page never computes a date range from an empty list", async () => {
    const list = await app.request("GET", `/finance/journal-entries?search=${uid("ec03-nothing")}`);
    expect(list.status).toBe(200);
    expect(list.json.journalEntries).toEqual([]);
    expect(list.json.total).toBe(0);
  });

  test("EC-05: EXPLAIN proves monthly partition pruning on a bounded journal_lines lookup", async () => {
    const text = await explain(
      `EXPLAIN (COSTS OFF)
       SELECT entry_id, direction, amount, gl_account_id
       FROM journal_lines
       WHERE entry_id = '00000000-0000-0000-0000-000000000000'::uuid
         AND created_at >= '2026-11-15T12:00:00Z'::timestamptz
         AND created_at <= '2026-11-15T12:10:00Z'::timestamptz`,
    );
    expect(text).toContain("journal_lines_2026_11");
    expect(text).not.toContain("journal_lines_2023_");
    expect(text).not.toContain("journal_lines_2024_");
    expect(text).not.toContain("journal_lines_2025_");
  });

  test("EC-06: the covering indexes answer entry and statement lookups without heap fetches", async () => {
    const wallet = await makeAccount("MERCHANT_WALLET", randomUUID());
    const treasury = await makeAccount("TREASURY");
    const entries: Array<{ id: string }> = [];
    for (let index = 0; index < 50; index += 1) {
      entries.push(
        await postEntry(
          [
            { glAccountId: wallet, direction: "CREDIT", amount: "1.0000" },
            { glAccountId: treasury, direction: "DEBIT", amount: "1.0000" },
          ],
          "ADJUSTMENT",
          `ec06 entry ${index}`,
          uid("ec06"),
        ),
      );
    }
    // Index-Only Scans can only skip the heap for all-visible pages. VACUUM sets the
    // Visibility Map bits that insert-autovacuum will maintain in production.
    await client.$executeRawUnsafe("VACUUM (ANALYZE) journal_lines");

    const start = new Date(Date.now() - 3_600_000);
    const end = new Date(Date.now() + 3_600_000);
    const entryPlan = await explain(
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
       SELECT id, entry_id, created_at, gl_account_id, direction, amount
       FROM journal_lines
       WHERE entry_id = $1::uuid AND created_at >= $2 AND created_at <= $3`,
      entries[0]!.id,
      start,
      end,
    );
    expect(entryPlan).toContain("Index Only Scan");
    expect(entryPlan).toContain("entry_id_created_at");
    expect(entryPlan).toContain("Heap Fetches: 0");

    const statementPlan = await explain(
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
       SELECT id, entry_id, created_at, direction, amount
       FROM journal_lines
       WHERE gl_account_id = $1::uuid AND created_at >= $2 AND created_at <= $3
       ORDER BY created_at DESC
       LIMIT 25`,
      wallet,
      start,
      end,
    );
    expect(statementPlan).toContain("Index Only Scan");
    expect(statementPlan).toContain("gl_account_id_created_at");
    expect(statementPlan).toContain("Heap Fetches: 0");
  });

  test("EC-07..EC-10: one covered groupBy matches the exact filtered totals", async () => {
    const wallet = await makeAccount("MERCHANT_WALLET", randomUUID());
    const treasury = await makeAccount("TREASURY");
    const tag = uid("ec07-statement");

    // EC-09: empty account.
    const empty = (await listAccountLines(wallet, {})) as any;
    expect(empty.total).toBe(0);
    expect(empty.lines).toEqual([]);
    expect(empty.totals).toEqual({ lineCount: 0, totalDebit: "0.0000", totalCredit: "0.0000", netDebit: "0.0000" });

    // 3 credits (100 + 20 + 50 = 170) and 2 debits (30 + 10.5 = 40.5).
    await postEntry(
      [
        { glAccountId: wallet, direction: "CREDIT", amount: "100.0000" },
        { glAccountId: treasury, direction: "DEBIT", amount: "100.0000" },
      ],
      "ADJUSTMENT",
      `${tag}-credit-1`,
    );
    await postEntry(
      [
        { glAccountId: wallet, direction: "CREDIT", amount: "20.0000" },
        { glAccountId: treasury, direction: "DEBIT", amount: "20.0000" },
      ],
      "ADJUSTMENT",
      `${tag}-credit-2`,
    );
    await postEntry(
      [
        { glAccountId: wallet, direction: "CREDIT", amount: "50.0000" },
        { glAccountId: treasury, direction: "DEBIT", amount: "50.0000" },
      ],
      "SETTLEMENT_SWEEP",
      `${tag}-credit-3`,
    );
    await postEntry(
      [
        { glAccountId: wallet, direction: "DEBIT", amount: "30.0000" },
        { glAccountId: treasury, direction: "CREDIT", amount: "30.0000" },
      ],
      "ADJUSTMENT",
      `${tag}-debit-1`,
    );
    await postEntry(
      [
        { glAccountId: wallet, direction: "DEBIT", amount: "10.5000" },
        { glAccountId: treasury, direction: "CREDIT", amount: "10.5000" },
      ],
      "SETTLEMENT_SWEEP",
      `${tag}-debit-2`,
    );

    // EC-07: page 1 shows 2 lines but totals describe all 5.
    const page1 = (await listAccountLines(wallet, { pageSize: "2", page: "1" })) as any;
    expect(page1.lines).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.totals).toEqual({ lineCount: 5, totalDebit: "40.5000", totalCredit: "170.0000", netDebit: "-129.5000" });

    // EC-08: a direction-only filter produces a one-row groupBy; the missing side is 0.
    const debits = (await listAccountLines(wallet, { direction: "DEBIT" })) as any;
    expect(debits.total).toBe(2);
    expect(debits.totals).toEqual({ lineCount: 2, totalDebit: "40.5000", totalCredit: "0.0000", netDebit: "40.5000" });
    const credits = (await listAccountLines(wallet, { direction: "CREDIT" })) as any;
    expect(credits.total).toBe(3);
    expect(credits.totals).toEqual({ lineCount: 3, totalDebit: "0.0000", totalCredit: "170.0000", netDebit: "-170.0000" });

    // EC-10: the relational refType + search filters are shared by findMany and groupBy.
    const combined = (await listAccountLines(wallet, { refType: "SETTLEMENT_SWEEP", search: "debit-2" })) as any;
    expect(combined.total).toBe(1);
    expect(combined.totals).toEqual({ lineCount: 1, totalDebit: "10.5000", totalCredit: "0.0000", netDebit: "10.5000" });
  });

  test("EC-11: a null receivable ceiling makes zero merchant and journal_lines calls", async () => {
    let receivableCalls = 0;
    let findMerchantCalls = 0;
    const baseRepos = new PrismaRepositories(client as never);

    const spyRepos = {
      ...baseRepos,
      merchants: {
        ...baseRepos.merchants,
        findMerchantById: async (tx: any, id: string) => {
          findMerchantCalls += 1;
          return baseRepos.merchants.findMerchantById(tx, id);
        },
        getCommissionReceivableBalance: async (tx: any, id: string) => {
          receivableCalls += 1;
          return baseRepos.merchants.getCommissionReceivableBalance!(tx, id);
        },
      },
    };

    const result = await evaluateCommissionReceivableCeiling(
      { repositories: spyRepos as never },
      client as never,
      randomUUID(),
      "PLATFORM_CLEARING",
      { id: randomUUID(), commissionReceivableCeiling: null } as never,
    );
    expect(result.decision).toBe("ALLOW");
    expect(result.reason).toBe("NO_CEILING");
    expect(findMerchantCalls).toBe(0);
    expect(receivableCalls).toBe(0);
  });

  test("EC-12: a delayed COMMISSION_NETTING entry is netted and the ceiling pauses/nets correctly", async () => {
    const merchant = await client.merchant.create({
      data: {
        legalName: `EC12 Merchant ${uid("m")}`,
        tradeName: `EC12 Merchant ${uid("m")}`,
        status: "ACTIVE",
        kybStatus: "VERIFIED",
        riskTier: "STANDARD",
        onboardingChannel: "DIRECT",
        country: "LY",
        negativeBalanceCeiling: new Decimal(0),
        commissionReceivableCeiling: new Decimal(100),
        activatedAt: new Date(),
      },
    });
    merchantIds.push(merchant.id);

    const attemptId = randomUUID();
    const attemptCreatedAt = new Date(Date.now() - 5 * 24 * 3600 * 1000);
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.paymentAttempt.create({
        data: {
          id: attemptId,
          reference: uid("EC12-PA"),
          linkId: randomUUID(),
          attemptGroupId: randomUUID(),
          applicationId: randomUUID(),
          merchantId: merchant.id,
          railId: randomUUID(),
          routeId: randomUUID(),
          credentialSetId: randomUUID(),
          gatewayVersionId: randomUUID(),
          commissionProfileId: randomUUID(),
          env: "LIVE",
          mode: "OTP_PULL",
          status: "SUCCEEDED",
          requestedAmount: new Decimal(150),
          totalChargedAmount: new Decimal(150),
          platformCommissionAmount: new Decimal(0),
          netMerchantAmount: new Decimal(150),
          feeBearer: "MERCHANT_ABSORBS",
          currency: "LYD",
          customerFieldsMasked: {},
          contextCiphertext: "x",
          createdAt: attemptCreatedAt,
          expiresAt: new Date(attemptCreatedAt.getTime() + 3_600_000),
          graceExpiresAt: new Date(attemptCreatedAt.getTime() + 7_200_000),
          terminalAt: new Date(attemptCreatedAt.getTime() + 60_000),
        },
      });
    });
    attemptIds.push(attemptId);

    const receivable = await makeAccount("COMMISSION_RECEIVABLE");
    const income = await makeAccount("PLATFORM_INCOME");
    const recognition = await insertRawEntry({
      createdAt: attemptCreatedAt,
      refType: "PAYMENT_ATTEMPT",
      refId: attemptId,
      description: "EC-12 commission recognition",
      lines: [
        { glAccountId: receivable, direction: "DEBIT", amount: "150.0000" },
        { glAccountId: income, direction: "CREDIT", amount: "150.0000" },
      ],
    });
    // The netting is posted three days after the attempt: bounding by pa.created_at
    // instead of je.created_at would miss it and report 150 instead of 130.
    const netting = await insertRawEntry({
      createdAt: new Date(attemptCreatedAt.getTime() + 3 * 24 * 3600 * 1000),
      refType: "COMMISSION_NETTING",
      refId: attemptId,
      description: "EC-12 delayed commission netting",
      lines: [
        { glAccountId: receivable, direction: "CREDIT", amount: "20.0000" },
        { glAccountId: income, direction: "DEBIT", amount: "20.0000" },
      ],
    });

    const repositories = new PrismaRepositories(client as never);
    const balance = await repositories.merchants.getCommissionReceivableBalance!(client as never, merchant.id);
    expect(balance).toBe(130n * 10_000n);

    const loadedMerchant = {
      ...merchant,
      commissionReceivableCeiling: new Decimal(100),
    } as never;
    const pause = await evaluateCommissionReceivableCeiling(
      { repositories },
      client as never,
      merchant.id,
      "PLATFORM_CLEARING",
      loadedMerchant,
    );
    expect(pause.receivable.toFixed(4)).toBe("130.0000");
    expect(pause.decision).toBe("PAUSE");
    expect(pause.reason).toBe("CEILING_EXCEEDED_PAUSE");

    const nettingDecision = await evaluateCommissionReceivableCeiling(
      { repositories },
      client as never,
      merchant.id,
      "MERCHANT_DIRECT",
      loadedMerchant,
    );
    expect(nettingDecision.decision).toBe("NETTING");
    expect(nettingDecision.reason).toBe("CEILING_EXCEEDED_NETTING");

    await deleteRawEntries([recognition, netting]);
    await client.paymentAttempt.deleteMany({ where: { id: attemptId } });
    attemptIds.splice(attemptIds.indexOf(attemptId), 1);
  });

  test("EC-13: an AML hold captured a day later is found by the ENTRY's timestamp, not the attempt's", async () => {
    resetFakeDatabase();
    const fake = createFakePrisma();
    // The governance release path updates the link slot through this delegate.
    fake.paymentLink = {
      async findUnique(args: { where: { id: string } }): Promise<FakeRow | null> {
        return fakeTable("paymentLink").find((row) => row.id === args.where.id) ?? null;
      },
      async update(args: { where: { id: string }; data: FakeRow }): Promise<FakeRow> {
        const row = fakeTable("paymentLink").find((entry) => entry.id === args.where.id);
        if (!row) throw new Error("Fake 'paymentLink' row not found");
        Object.assign(row, args.data);
        return row;
      },
    };
    const repositories = new PrismaRepositories(fake as never);
    const ledgerPoster = new LedgerPoster(fake as never);

    for (const [id, accountType, ownerId] of [
      ["acc-treasury", "TREASURY", null],
      ["acc-clearing", "GATEWAY_CLEARING", null],
      ["acc-wallet", "MERCHANT_WALLET", "merchant-1"],
      ["acc-income", "PLATFORM_INCOME", null],
      ["acc-aml-hold", "AML_HOLD", null],
    ] as const) {
      fakeTable("glAccount").push({ id, accountType, currency: "LYD", ownerId });
    }
    fakeTable("merchant").push({
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
    });
    fakeTable("wallet").push({ id: "wallet-1", merchantId: "merchant-1", glAccountId: "acc-wallet", currency: "LYD", status: "ACTIVE" });
    const attemptCreatedAt = new Date("2026-11-01T09:00:00.000Z");
    fakeTable("paymentAttempt").push({
      id: "attempt-1",
      reference: "PA-EC13",
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
      createdAt: attemptCreatedAt,
      terminalAt: null,
      nextCheckAt: new Date("2026-11-01T10:00:00.000Z"),
    });
    fakeTable("paymentLink").push({
      id: "link-1",
      infiniteUse: false,
      useCount: 1,
      confirmedCount: 0,
      activeLockedCount: 1,
      state: "PENDING",
    });
    // The capture (escrow) entry is stamped a day after the attempt.
    const captureCreatedAt = new Date("2026-11-02T09:00:00.000Z");
    fakeTable("journalEntry").push({
      id: "hold-entry",
      refType: "PAYMENT_ATTEMPT",
      refId: "attempt-1",
      description: "AML threshold hold",
      createdAt: captureCreatedAt,
    });
    fakeTable("journalLine").push({
      id: "hold-line",
      entryId: "hold-entry",
      glAccountId: "acc-aml-hold",
      direction: "CREDIT",
      amount: new Decimal(100),
    });
    fakeTable("amlCase").push({
      id: "aml-case-1",
      subjectType: "PAYMENT_ATTEMPT",
      subjectId: "attempt-1",
      triggerReason: "AML_RULE:AML-SINGLE-AMOUNT",
      severity: "HIGH",
      severityInputsJson: {},
      status: "OPEN",
      holdJournalEntryId: null,
      confidential: true,
    });

    const captured: Array<Record<string, any>> = [];
    const originalFindMany = fake.journalLine.findMany.bind(fake.journalLine);
    fake.journalLine.findMany = async (args: Record<string, any>) => {
      captured.push(args);
      const { createdAt, ...rest } = args.where ?? {};
      void createdAt;
      // The fake has no range matcher; strip the window after asserting it exists.
      return originalFindMany({ ...args, where: rest });
    };

    const context = { ledgerPoster, repositories };
    const result = await fake.$transaction(async (tx) =>
      executeAmlCaseResolution(context as never, tx as never, {
        amlCaseId: "aml-case-1",
        action: "RELEASE",
        checkerUserId: "user-checker",
        checkerRole: "MLRO",
      }),
    );
    expect(result.status).toBe("EXECUTED");

    const holdLookup = captured.find((args) => args.where?.entryId === "hold-entry");
    expect(holdLookup).toBeDefined();
    const window = holdLookup!.where.createdAt;
    expect(window).toBeDefined();
    expect((window.gte as Date).getTime()).toBe(captureCreatedAt.getTime() - 5 * 60 * 1000);
    expect((window.lte as Date).getTime()).toBe(captureCreatedAt.getTime() + 5 * 60 * 1000);
    // The attempt is a day older: bounding by it would miss the escrow.
    expect((window.gte as Date).getTime()).not.toBe(attemptCreatedAt.getTime() - 5 * 60 * 1000);
    resetFakeDatabase();
  });

  test("EC-14: journal_entries uses the created_at index and the trigram index", async () => {
    const sortPlan = await explain(
      `EXPLAIN (COSTS OFF)
       SELECT id, created_at, ref_type, ref_id
       FROM journal_entries
       WHERE created_at >= now() - interval '24 hours'
       ORDER BY created_at DESC
       LIMIT 25`,
    );
    expect(sortPlan).not.toContain("Seq Scan");
    expect(sortPlan).toContain("journal_entries_created_at_idx");

    // A GIN index is a bitmap source: disable the plain index scan so the planner must
    // choose the trigram bitmap (on a nearly empty table it would otherwise scan the
    // created_at index and filter).
    const searchPlan = planText(
      (await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        await tx.$executeRawUnsafe("SET LOCAL enable_indexscan = off");
        // The created_at index can answer this predicate as an index-only scan plus a
        // filter; disabling that path leaves the trigram bitmap as the only index source.
        await tx.$executeRawUnsafe("SET LOCAL enable_indexonlyscan = off");
        return (await tx.$queryRawUnsafe(
          `EXPLAIN (COSTS OFF)
           SELECT id
           FROM journal_entries
           WHERE ref_id ILIKE '%needle%'`,
        )) as Array<Record<string, unknown>>;
      })) as Array<Record<string, unknown>>,
    );
    expect(searchPlan).not.toContain("Seq Scan");
    expect(searchPlan).toContain("journal_entries_trgm_search_idx");
  });

  test("EC-15: future partitions keep fillfactor, insert autovacuum, the truncate guard and app privileges", async () => {
    await client.$executeRawUnsafe("SELECT ensure_journal_line_partitions(24)");
    const rows = (await client.$queryRawUnsafe(
      `SELECT c.relname AS name,
              c.reloptions AS options,
              EXISTS (
                SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = c.oid AND t.tgname = 'pgw_journal_lines_no_truncate' AND NOT t.tgisinternal
              ) AS has_no_truncate
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'journal_lines'::regclass
         AND c.relname <> 'journal_lines_default'
       ORDER BY c.relname DESC
       LIMIT 3`,
    )) as Array<{ name: string; options: string[] | null; has_no_truncate: boolean }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const options = (row.options ?? []).join(",");
      expect(options).toContain("fillfactor=100");
      expect(options).toContain("autovacuum_vacuum_insert_scale_factor=0.01");
      expect(row.has_no_truncate).toBe(true);
      const privileges = (await client.$queryRawUnsafe(
        `SELECT has_table_privilege('pgw_app', $1::regclass, 'UPDATE') AS can_update,
                has_table_privilege('pgw_app', $1::regclass, 'DELETE') AS can_delete,
                has_table_privilege('pgw_app', $1::regclass, 'TRUNCATE') AS can_truncate,
                has_table_privilege('pgw_app', $1::regclass, 'INSERT') AS can_insert`,
        `"${row.name}"`,
      )) as Array<{ can_update: boolean; can_delete: boolean; can_truncate: boolean; can_insert: boolean }>;
      expect(privileges[0]).toEqual({ can_update: false, can_delete: false, can_truncate: false, can_insert: true });
    }
  });

  test("EC-17: checkpoints advance every shard, repair recomputes drift and the invariant stays at zero", async () => {
    const wallet = await makeAccount("MERCHANT_WALLET", randomUUID());
    const treasury = await makeAccount("TREASURY");
    for (let index = 0; index < 10; index += 1) {
      await postEntry(
        [
          { glAccountId: wallet, direction: "CREDIT", amount: "2.0000" },
          { glAccountId: treasury, direction: "DEBIT", amount: "2.0000" },
        ],
        "ADJUSTMENT",
        `ec17 entry ${index}`,
        uid("ec17"),
      );
    }

    const checkpoint = new CheckpointService(client as never);
    const captured = await checkpoint.captureAccount(wallet);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((shard) => shard.status === "ADVANCED")).toBe(true);

    // Simulate a parity drift on shard 0 (the wallet's only shard).
    await client.$executeRawUnsafe(
      `UPDATE gl_account_shards SET current_balance = current_balance + 5
       WHERE gl_account_id = $1::uuid AND shard_id = 0`,
      wallet,
    );
    const plan = await planShardRepair(client as never, wallet, 0);
    expect(plan.needsRepair).toBe(true);
    expect(plan.kind).toBe("RECOMPUTE");
    expect(plan.delta.toFixed(4)).toBe("-5.0000");

    const applied = await applyShardRepair(client as never, {
      glAccountId: wallet,
      shardId: 0,
      mode: "MANUAL",
      allowedKinds: ["RECOMPUTE"],
      expectedPlanHash: plan.planHash,
      reason: "EC-17 test repair",
      actor: { actorId: userId, role: "FINANCE" },
    });
    expect(applied.repaired).toBe(true);

    const repaired = await planShardRepair(client as never, wallet, 0);
    expect(repaired.needsRepair).toBe(false);
    const invariant = await new InvariantVerifier(client as never, { sql: true }).verify();
    expect(invariant.drift.toFixed(4)).toBe("0.0000");
  });
  test("EC-18: the restore-drill double-entry and shard-parity queries accept the optimised schema", async () => {
    // Remove the raw (shard-unprojected) entries created by EC-01/EC-02 first; the
    // production poster entries remain and are the real parity evidence.
    await deleteRawEntries([...rawEntryIds]);
    const doubleEntry = (await client.$queryRawUnsafe(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)::text AS drift
       FROM journal_lines`,
    )) as Array<{ drift: string }>;
    expect(new Decimal(doubleEntry[0]?.drift ?? "0").isZero()).toBe(true);

    // The same predicate the backup daemon runs, scoped to this suite's accounts so a
    // shared test database cannot make the assertion flaky.
    const parity = (await client.$queryRawUnsafe(
      `SELECT COUNT(*)::text AS mismatches
       FROM gl_account_shards s
       LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(x.signed), 0) AS total,
                COALESCE(SUM(x.signed) FILTER (WHERE x.shard_seq <= COALESCE(c.checkpoint_seq, 0)), 0) AS upto_checkpoint,
                COUNT(*) FILTER (WHERE x.shard_seq > COALESCE(c.baseline_seq, 0)) AS sequenced
         FROM (SELECT CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END AS signed, l.shard_seq
               FROM journal_lines l
               WHERE l.gl_account_id = s.gl_account_id AND l.shard_id = s.shard_id) x
       ) j
       WHERE s.gl_account_id = ANY($1::uuid[])
         AND (s.current_balance <> j.total
           OR COALESCE(c.checkpoint_balance, 0) <> j.upto_checkpoint
           OR j.sequenced <> s.line_seq - COALESCE(c.baseline_seq, 0))`,
      ownAccountIds,
    )) as Array<{ mismatches: string }>;
    expect(Number(parity[0]?.mismatches ?? -1)).toBe(0);
  });
});
