import { beforeEach, describe, expect, test } from "bun:test";
import express, { type Request, type Response } from "express";
import { Decimal } from "decimal.js";
import { PrismaRepositories } from "../engine/db/repositories";
import { LedgerPoster, decimal } from "../engine/ledger/LedgerPoster";
import {
  BackgroundJobWorker,
  type BackgroundJobHandler,
} from "../engine/workers/BackgroundJobWorker";
import {
  createAdjustmentJobHandler,
  createFeeVariancePoster,
  createReconciliationJobHandler,
} from "../engine/workers/BackgroundJobHandlers";
import { createReconciliationUploadHandler } from "../api/internal/reconciliationUpload";
import { isApiError, toErrorEnvelope } from "../lib/error";
import {
  createFakePrisma,
  fakeTable,
  resetFakeDatabase,
  type FakePrisma,
  type FakeRow,
} from "./helpers/backgroundJobFake";

/**
 * The durable job queue of `core-back`.
 *
 * The suite never touches a database: the worker, the routes and the
 * governance execution run against the in-memory client of
 * `test/helpers/backgroundJobFake.ts`.
 */

const clockStart = new Date("2026-10-28T09:00:00.000Z");

let now = clockStart;
const clock = (): Date => now;
const advance = (ms: number): void => {
  now = new Date(now.getTime() + ms);
};

const jobRows = (): FakeRow[] => fakeTable("backgroundJob");
const jobRow = (id: string): FakeRow | undefined =>
  jobRows().find((row) => row.id === id);

const enqueueJob = (overrides: Partial<FakeRow> = {}): FakeRow => {
  const job: FakeRow = {
    id: `job-${jobRows().length + 1}`,
    createdAt: now,
    updatedAt: now,
    jobType: "RECONCILIATION_RUN",
    referenceType: "RECONCILIATION_RUN",
    referenceId: "reference-1",
    payloadJson: {},
    state: "QUEUED",
    attempts: 0,
    maxAttempts: 3,
    availableAt: now,
    lockedAt: null,
    lastError: null,
    completedAt: null,
    ...overrides,
  };
  jobRows().push(job);
  return job;
};

const buildWorker = (
  client: FakePrisma,
  handlers: Record<string, BackgroundJobHandler>,
  options: { leaseSeconds?: number; baseBackoffMs?: number } = {},
): BackgroundJobWorker =>
  new BackgroundJobWorker({
    db: client as never,
    repositories: new PrismaRepositories(client as never),
    clock,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    handlers,
    leaseSeconds: options.leaseSeconds ?? 300,
    baseBackoffMs: options.baseBackoffMs ?? 1000,
    maxBackoffMs: options.baseBackoffMs ?? 1000,
  });

beforeEach(() => {
  resetFakeDatabase();
  now = clockStart;
});

describe("the durable background job queue", () => {
  test("a due job is claimed exactly once", async () => {
    const client = createFakePrisma();
    const job = enqueueJob();
    let handled = 0;
    const worker = buildWorker(client, {
      RECONCILIATION_RUN: {
        handle: async () => {
          handled += 1;
        },
      },
    });

    await worker.runOnce();
    expect(handled).toBe(1);
    expect(jobRow(String(job.id))?.state).toBe("SUCCEEDED");
    expect(jobRow(String(job.id))?.completedAt).not.toBeNull();

    // The job is not queued anymore, so a second drain never runs it again.
    await worker.runOnce();
    expect(handled).toBe(1);
  });

  test("a second node never claims the job of the first one", async () => {
    const client = createFakePrisma();
    enqueueJob();
    const handled: string[] = [];
    const first = buildWorker(client, {
      RECONCILIATION_RUN: {
        handle: async () => {
          handled.push("first");
        },
      },
    });
    const second = buildWorker(client, {
      RECONCILIATION_RUN: {
        handle: async () => {
          handled.push("second");
        },
      },
    });

    await first.runOnce();
    await second.runOnce();
    expect(handled).toEqual(["first"]);
  });

  test("a failing job is retried with a backoff and finally marked FAILED", async () => {
    const client = createFakePrisma();
    const job = enqueueJob({ maxAttempts: 3 });
    const worker = buildWorker(client, {
      RECONCILIATION_RUN: {
        handle: async () => {
          throw new Error("the statement source is unreachable");
        },
      },
    });

    await worker.runOnce();
    const afterFirst = jobRow(String(job.id));
    expect(afterFirst?.state).toBe("QUEUED");
    expect(afterFirst?.attempts).toBe(1);
    expect(afterFirst?.lastError).toContain("the statement source is unreachable");
    // The backoff moved the durable timer into the future.
    expect((afterFirst?.availableAt as Date).getTime()).toBe(now.getTime() + 1000);

    // The job is not due yet, so the next drain leaves it alone.
    await worker.runOnce();
    expect(jobRow(String(job.id))?.attempts).toBe(1);

    advance(1000);
    await worker.runOnce();
    expect(jobRow(String(job.id))?.attempts).toBe(2);
    expect(jobRow(String(job.id))?.state).toBe("QUEUED");

    advance(1000);
    await worker.runOnce();
    const failed = jobRow(String(job.id));
    expect(failed?.state).toBe("FAILED");
    expect(failed?.attempts).toBe(3);
    expect(failed?.completedAt).not.toBeNull();
    expect(failed?.lastError).toContain("the statement source is unreachable");

    // A failed job is never picked up again.
    advance(60_000);
    await worker.runOnce();
    expect(jobRow(String(job.id))?.attempts).toBe(3);
  });

  test("a job that a crashed node left RUNNING is recovered when its lease expired", async () => {
    const client = createFakePrisma();
    const stale = enqueueJob({
      state: "RUNNING",
      lockedAt: new Date(now.getTime() - 10 * 60 * 1000),
    });
    const running = enqueueJob({
      state: "RUNNING",
      lockedAt: new Date(now.getTime() - 1000),
    });
    const handled: string[] = [];
    const worker = buildWorker(client, {
      RECONCILIATION_RUN: {
        handle: async (job) => {
          handled.push(String(job.id));
        },
      },
    }, { leaseSeconds: 60 });

    await worker.runOnce();
    // The stale job was re-queued and executed, the fresh lease is untouched.
    expect(handled).toEqual([String(stale.id)]);
    expect(jobRow(String(stale.id))?.state).toBe("SUCCEEDED");
    expect(jobRow(String(running.id))?.state).toBe("RUNNING");
  });
});

describe("the statement reconciliation upload", () => {
  const statement = [
    "our_ref,amount,fee",
    "PA-0001,100.0000,2.0000",
  ].join("\n");

  const prepare = (client: FakePrisma): void => {
    client.statementSource.create({
      data: {
        id: "source-1",
        gatewayId: "gateway-1",
        type: "UPLOAD",
        parserConfig: {
          format: "CSV",
          headerRow: true,
          columnsMap: { ourReference: "our_ref", amount: "amount", fee: "fee" },
        },
        settlementLagDays: 0,
      },
    });
  };

  const upload = async (client: FakePrisma, body: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const app = express();
    app.use(express.raw({ type: () => true, limit: "25mb" }));
    app.post(
      "/internal/admin/reconciliation/upload",
      createReconciliationUploadHandler({
        db: client as never,
        repositories: new PrismaRepositories(client as never),
        clock,
      }),
    );
    app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
      response.status(isApiError(error) ? error.statusCode : 500).json(toErrorEnvelope(error));
    });
    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/internal/admin/reconciliation/upload`, {
      method: "POST",
      headers: {
        "content-type": "text/csv",
        "x-statement-source-id": "source-1",
        "x-upload-filename": "statement.csv",
      },
      body: Buffer.from(body, "utf8"),
    });
    const text = await response.text();
    server.close();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  };

  test("the upload answers 202 and queues exactly one job", async () => {
    const client = createFakePrisma();
    prepare(client);

    const response = await upload(client, statement);
    expect(response.status).toBe(202);
    expect(typeof response.body.runId).toBe("string");
    expect(typeof response.body.jobId).toBe("string");
    expect(response.body.state).toBe("QUEUED");

    // Exactly one job was queued, and the request did not parse the file.
    expect(jobRows()).toHaveLength(1);
    expect(jobRows()[0]?.jobType).toBe("RECONCILIATION_RUN");
    expect(jobRows()[0]?.state).toBe("QUEUED");
    expect(jobRows()[0]?.referenceId).toBe(response.body.runId);
    expect(fakeTable("reconciliationItem")).toHaveLength(0);

    // The uploaded file is stored in the run record.
    const runs = fakeTable("reconciliationRun");
    expect(runs).toHaveLength(1);
    expect((runs[0]?.fileContent as Buffer).toString("utf8")).toBe(statement);
    expect(runs[0]?.ingestedAt).toBeNull();
  });

  test("a repeated upload never queues the same work twice", async () => {
    const client = createFakePrisma();
    prepare(client);

    const first = await upload(client, statement);
    const second = await upload(client, statement);
    expect(second.status).toBe(202);
    expect(second.body.runId).toBe(first.body.runId);
    expect(jobRows()).toHaveLength(1);
  });

  test("the worker parses and matches the statement exactly once", async () => {
    const client = createFakePrisma();
    prepare(client);
    client.paymentAttempt.create({
      data: {
        id: "attempt-1",
        reference: "PA-0001",
        merchantId: "merchant-1",
        applicationId: "application-1",
        currency: "LYD",
        env: "LIVE",
        status: "SUCCEEDED",
        settledAmount: new Decimal(100),
        gatewayFeeAmount: new Decimal(1),
        settlementTarget: "PLATFORM_CLEARING",
      },
    });

    const response = await upload(client, statement);
    const variances: string[] = [];
    const worker = buildWorker(client, {
      RECONCILIATION_RUN: createReconciliationJobHandler({
        db: client as never,
        repositories: new PrismaRepositories(client as never),
        clock,
        feeVariancePoster: {
          postFeeVariance: async (posting) => {
            variances.push(posting.attemptId ?? "");
            return { journalEntryId: "entry-1" };
          },
        },
      }),
    });

    await worker.runOnce();
    const items = fakeTable("reconciliationItem");
    expect(items).toHaveLength(1);
    expect(items[0]?.result).toBe("MATCHED");
    expect(decimal(items[0]?.statementAmount as never).toFixed(4)).toBe("100.0000");
    expect(variances).toEqual(["attempt-1"]);
    expect(fakeTable("reconciliationRun")[0]?.ingestedAt).not.toBeNull();
    expect(jobRow(String(response.body.jobId))?.state).toBe("SUCCEEDED");

    // A retried job never matches the statement twice.
    const job = jobRow(String(response.body.jobId));
    if (job) {
      job.state = "QUEUED";
      job.availableAt = now;
    }
    await worker.runOnce();
    expect(fakeTable("reconciliationItem")).toHaveLength(1);
    expect(variances).toEqual(["attempt-1"]);
  });
});

describe("the dispute and the adjustment execution", () => {
  const prepare = (client: FakePrisma): void => {
    client.glAccount.create({
      data: { id: "acc-treasury", accountType: "TREASURY", currency: "LYD" },
    });
    client.glAccount.create({
      data: { id: "acc-wallet", accountType: "MERCHANT_WALLET", ownerId: "merchant-1", currency: "LYD" },
    });
    client.glAccount.create({
      data: { id: "acc-income", accountType: "PLATFORM_INCOME", currency: "LYD" },
    });
    client.glAccount.create({
      data: { id: "acc-chargeback", accountType: "CHARGEBACK_RESERVE", currency: "LYD" },
    });
    client.user.create({
      data: {
        id: "user-finance",
        email: "finance@payment-gateway.internal",
        role: "FINANCE",
        authoritiesMap: {},
        appScopeIds: [],
        isMaker: false,
        isChecker: true,
        mfaRequired: false,
        status: "ACTIVE",
      },
    });
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
      data: { id: "wallet-1", merchantId: "merchant-1", glAccountId: "acc-wallet", currency: "LYD", status: "ACTIVE" },
    });
    client.paymentAttempt.create({
      data: {
        id: "attempt-1",
        reference: "PA-0001",
        merchantId: "merchant-1",
        applicationId: "application-1",
        currency: "LYD",
        env: "LIVE",
        status: "SUCCEEDED",
        totalChargedAmount: new Decimal(100),
        platformCommissionAmount: new Decimal(3),
        netMerchantAmount: new Decimal(97),
        settlementTarget: "PLATFORM_CLEARING",
      },
    });
    // The balance the merchant wallet holds after a settled payment.
    client.journalEntry.create({
      data: { id: "settlement-entry", refType: "PAYMENT_ATTEMPT", refId: "attempt-0", description: "Settled payment" },
    });
    client.journalLine.create({
      data: {
        id: "settlement-line",
        entryId: "settlement-entry",
        glAccountId: "acc-wallet",
        direction: "CREDIT",
        amount: new Decimal(1000),
      },
    });
  };

  const worker = (client: FakePrisma): BackgroundJobWorker =>
    buildWorker(client, {
      ADJUSTMENT_EXECUTION: createAdjustmentJobHandler({
        db: client as never,
        ledgerPoster: new LedgerPoster(client as never),
        repositories: new PrismaRepositories(client as never),
        clock,
      }),
    });

  const journalEntriesOf = (refId: string): FakeRow[] =>
    fakeTable("journalEntry").filter((row) => row.refId === refId);

  test("the dispute intake is executed by the worker", async () => {
    const client = createFakePrisma();
    prepare(client);
    const job = enqueueJob({
      jobType: "ADJUSTMENT_EXECUTION",
      referenceType: "DISPUTE_INTAKE",
      referenceId: "gateway-1:DSP-1",
      payloadJson: {
        kind: "DISPUTE_INTAKE",
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-1",
        source: "WEBHOOK",
        reasonCode: "FRAUD",
        amount: "100.0000",
        currency: "LYD",
        actorUserId: null,
        actorRole: "SYSTEM",
      },
    });

    await worker(client).runOnce();

    expect(jobRow(String(job.id))?.state).toBe("SUCCEEDED");
    const disputes = fakeTable("dispute");
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.status).toBe("OPENED");
    // The reserve was posted for the dispute.
    expect(journalEntriesOf(String(disputes[0]?.id))).toHaveLength(1);
    // The adjustment was drafted and waits for a human checker.
    const adjustments = fakeTable("adjustment");
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.state).toBe("PENDING_REVIEW");
    expect(adjustments[0]?.draftedBySystem).toBe(true);
    const approvals = fakeTable("approvalRequest");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.checkerUserId ?? null).toBeNull();
  });

  test("running the adjustment job twice posts exactly one journal entry", async () => {
    const client = createFakePrisma();
    prepare(client);
    const instance = worker(client);

    // The dispute intake runs first.
    enqueueJob({
      jobType: "ADJUSTMENT_EXECUTION",
      referenceType: "DISPUTE_INTAKE",
      referenceId: "gateway-1:DSP-1",
      payloadJson: {
        kind: "DISPUTE_INTAKE",
        attemptId: "attempt-1",
        gatewayId: "gateway-1",
        railId: "rail-1",
        externalDisputeRef: "DSP-1",
        source: "WEBHOOK",
        reasonCode: "FRAUD",
        amount: "100.0000",
        currency: "LYD",
        actorUserId: null,
        actorRole: "SYSTEM",
      },
    });
    await instance.runOnce();

    const dispute = fakeTable("dispute")[0] as FakeRow;
    const adjustment = fakeTable("adjustment")[0] as FakeRow;
    const approval = fakeTable("approvalRequest")[0] as FakeRow;
    // The dispute is lost, so the reserve is booked against the treasury.
    client.dispute.update({
      where: { id: String(dispute.id) },
      data: { status: "LOST" },
    });
    // The request that approved the adjustment recorded the human checker.
    client.approvalRequest.update({
      where: { id: String(approval.id) },
      data: { checkerUserId: "user-finance", state: "APPROVED" },
    });

    const execution = enqueueJob({
      jobType: "ADJUSTMENT_EXECUTION",
      referenceType: "APPROVAL_REQUEST",
      referenceId: String(approval.id),
      payloadJson: {
        kind: "ADJUSTMENT_EXECUTION",
        approvalRequestId: String(approval.id),
        outcome: "LOST",
        notes: "the evidence was lost",
        checkerRole: "FINANCE",
      },
    });

    await instance.runOnce();
    expect(jobRow(String(execution.id))?.state).toBe("SUCCEEDED");
    const posted = journalEntriesOf(String(adjustment.id));
    expect(posted).toHaveLength(1);
    expect(posted[0]?.refType).toBe("DISPUTE_OUTCOME");
    expect(fakeTable("adjustment")[0]?.state).toBe("EXECUTED");
    expect(fakeTable("dispute")[0]?.status).toBe("LOST");
    expect(fakeTable("approvalRequest")[0]?.state).toBe("EXECUTED");

    // The retried job never posts a second time.
    const job = jobRow(String(execution.id));
    if (job) {
      job.state = "QUEUED";
      job.availableAt = now;
    }
    await instance.runOnce();
    expect(journalEntriesOf(String(adjustment.id))).toHaveLength(1);
    expect(fakeTable("journalEntry")).toHaveLength(3);
  });

  test("the job never invents a checker", async () => {
    const client = createFakePrisma();
    prepare(client);
    const approval = await client.approvalRequest.create({
      data: {
        id: "approval-1",
        subjectType: "ADJUSTMENT",
        subjectId: "adjustment-1",
        payloadDiffJson: {},
        mode: "STANDARD",
        makerUserId: "SYSTEM_AUTOMATION",
        state: "APPROVED",
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
    });
    const job = enqueueJob({
      jobType: "ADJUSTMENT_EXECUTION",
      referenceType: "APPROVAL_REQUEST",
      referenceId: "approval-1",
      payloadJson: { kind: "ADJUSTMENT_EXECUTION", approvalRequestId: "approval-1" },
    });

    await worker(client).runOnce();

    // The job failed: there is no checker to execute with.
    expect(jobRow(String(job.id))?.state).toBe("QUEUED");
    expect(String(jobRow(String(job.id))?.lastError)).toContain("checker");
    expect(fakeTable("approvalRequest")[0]?.state).toBe(approval.state);
    expect(fakeTable("journalEntry")).toHaveLength(1);
  });
});

describe("the fee variance true-up", () => {
  test("books the variance of a statement through the ledger", async () => {
    const client = createFakePrisma();
    client.glAccount.create({
      data: {
        id: "acc-fee-expense",
        accountType: "GATEWAY_FEE_EXPENSE",
        gatewayId: "gateway-1",
        currency: "LYD",
      },
    });
    client.glAccount.create({
      data: {
        id: "acc-fee-accrual",
        accountType: "GATEWAY_FEE_ACCRUAL",
        gatewayId: "gateway-1",
        currency: "LYD",
      },
    });
    const poster = createFeeVariancePoster(new LedgerPoster(client as never));
    const posted = await poster.postFeeVariance({
      gatewayId: "gateway-1",
      statementSourceId: "source-1",
      attemptId: "attempt-1",
      statementFee: 2n,
      accruedFee: 1n,
      variance: 1n,
      occurredAt: null,
    });
    expect(posted.journalEntryId).not.toBeNull();
    expect(fakeTable("journalEntry")).toHaveLength(1);
    // The posting is keyed by the attempt, so it is posted only once.
    const again = await poster.postFeeVariance({
      gatewayId: "gateway-1",
      statementSourceId: "source-1",
      attemptId: "attempt-1",
      statementFee: 2n,
      accruedFee: 1n,
      variance: 1n,
      occurredAt: null,
    });
    expect(again.journalEntryId).toBe(posted.journalEntryId);
    expect(fakeTable("journalEntry")).toHaveLength(1);
  });
});
