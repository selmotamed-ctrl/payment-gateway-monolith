import { describe, expect, test } from "bun:test";
import type { Prisma } from "../../generated/prisma/client";
import { PrismaRepositories } from "../../engine/db/repositories";
import { toCamelRow, toCamelRows } from "../../engine/db/rawRows";

interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
}

interface RecordingDelegate {
  [method: string]: (...args: unknown[]) => unknown;
}

const createRecordingClient = () => {
  const calls: RecordedCall[] = [];
  const makeDelegate = (name: string): RecordingDelegate =>
    new Proxy({} as RecordingDelegate, {
      get(_target, property) {
        return (...args: unknown[]) => {
          calls.push({ method: `${name}.${String(property)}`, args: args[0] as Record<string, unknown> });
          return Promise.resolve(null);
        };
      },
    });

  const client: Record<string, unknown> = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(client),
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    $queryRawUnsafe: async () => [],
    $executeRawUnsafe: async () => 0,
  };
  for (const name of [
    "user",
    "userIdentity",
    "merchant",
    "application",
    "paymentLink",
    "paymentAttempt",
    "glAccount",
    "journalEntry",
    "journalLine",
    "approvalRequest",
    "auditLog",
    "platformSetting",
    "notification",
    "notificationTemplate",
    "statementSource",
    "reconciliationRun",
    "reconciliationItem",
    "dispute",
    "adjustment",
    "operatorCase",
    "amlCase",
    "amlScreening",
    "amlScreeningMatch",
    "amlRule",
    "reportingRule",
    "regulatoryReport",
    "velocityRule",
    "joinRequest",
    "kybDocument",
    "beneficialOwner",
    "railRoute",
    "pollPolicy",
    "gatewaySetting",
    "detailChangeLog",
    "credentialSet",
  ]) {
    client[name] = makeDelegate(name);
  }
  return { client, calls };
};

describe("PrismaRepositories field mapping", () => {
  test("queries the payment link by key with the camelCase where clause", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.payments.findLinkByKey(client as never, "link-key");
    const call = calls.find((entry) => entry.method === "paymentLink.findUnique");
    expect(call?.args.where).toEqual({ key: "link-key" });
  });

  test("finds an attempt by idempotency key with the camelCase where clause", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.payments.findAttemptByIdempotencyKey(client as never, "idem-1");
    const call = calls.find((entry) => entry.method === "paymentAttempt.findFirst");
    expect(call?.args.where).toEqual({ idempotencyKey: "idem-1" });
  });

  test("lists approval requests with the camelCase where and orderBy clauses", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.governance.listApprovalRequests(client as never, {
      state: "PENDING_REVIEW",
      subjectType: "MERCHANT",
      limit: 10,
      offset: 0,
    });
    const call = calls.find((entry) => entry.method === "approvalRequest.findMany");
    expect(call?.args.where).toEqual({ state: "PENDING_REVIEW", subjectType: "MERCHANT" });
    expect(call?.args.orderBy).toEqual({ createdAt: "desc" });
  });

  test("creates an approval request with the camelCase data payload", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.governance.createApprovalRequest(client as never, {
      subjectType: "MERCHANT",
      subjectId: "merchant-1",
      makerUserId: "maker-1",
      payloadDiffJson: [{ op: "replace", path: "/riskTier", value: "HIGH" }],
      baseVersion: 2,
      mode: "STANDARD",
      state: "PENDING_REVIEW",
    });
    const call = calls.find((entry) => entry.method === "approvalRequest.create");
    const data = call?.args.data as Record<string, unknown>;
    expect(data.subjectType).toBe("MERCHANT");
    expect(data.subjectId).toBe("merchant-1");
    expect(data.makerUserId).toBe("maker-1");
    expect(data.baseVersion).toBe(2);
    expect(data.payloadDiffJson).toBeDefined();
  });

  test("updates a detail change log with the schema column names", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.governance.writeAuditLog(client as never, {
      actorId: "actor-1",
      role: "OPERATOR",
      action: "TEST",
      entityType: "PAYMENT_ATTEMPT",
      entityId: "attempt-1",
      afterJson: { a: 1 },
    });
    const call = calls.find((entry) => entry.method === "auditLog.create");
    const data = call?.args.data as Record<string, unknown>;
    expect(data.actorId).toBe("actor-1");
    expect(data.entityType).toBe("PAYMENT_ATTEMPT");
    expect(data.entityId).toBe("attempt-1");
    expect(data.action).toBe("TEST");
  });

  test("selects poll policies with the camelCase route mapping", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.payments.listPollPolicies(client as never);
    const call = calls.find((entry) => entry.method === "pollPolicy.findMany");
    expect(call).toBeDefined();
  });

  test("uses the camelCase select clause for gateway inquiry support", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.payments.listRouteInquirySupport(client as never);
    const call = calls.find((entry) => entry.method === "gatewaySetting.findMany");
    expect(call?.args.select).toEqual({ gatewayVersionId: true, supportsStatusCheck: true });
  });

  test("lists screenings with the camelCase orderBy clause", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.risk.listScreenings(client as never, { limit: 5, offset: 0 });
    const call = calls.find((entry) => entry.method === "amlScreening.findMany");
    expect(call?.args.orderBy).toEqual({ requestedAt: "desc" });
  });

  test("lists disputes with the camelCase orderBy clause", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.disputes.listDisputes(client as never, { limit: 5, offset: 0 });
    const call = calls.find((entry) => entry.method === "dispute.findMany");
    expect(call?.args.orderBy).toEqual({ openedAt: "desc" });
  });

  test("finds a dispute by gateway reference with the camelCase where clause", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.disputes.findDisputeByGatewayRef(client as never, "gw-1", "ext-1");
    const call = calls.find((entry) => entry.method === "dispute.findFirst");
    expect(call?.args.where).toEqual({ gatewayId: "gw-1", externalDisputeRef: "ext-1" });
  });

  test("sums executed refunds with the camelCase where clause", async () => {
    const { client, calls } = createRecordingClient();
    const repositories = new PrismaRepositories(client as never);
    await repositories.disputes.sumExecutedRefundsForAttempt(client as never, "attempt-1");
    const call = calls.find((entry) => entry.method === "adjustment.aggregate");
    expect(call?.args.where).toEqual({
      sourceAttemptId: "attempt-1",
      type: "REFUND",
      state: "EXECUTED",
    });
  });
});

describe("raw row mapping", () => {
  test("maps a snake_case raw row to camelCase", () => {
    const now = new Date();
    const mapped = toCamelRow<Record<string, unknown>>({
      id: "1",
      total_charged_amount: "10",
      created_at: now,
    });
    expect(mapped).toEqual({
      id: "1",
      totalChargedAmount: "10",
      createdAt: now,
    });
    expect(toCamelRows<Record<string, unknown>>([{ rail_id: "r" }])).toEqual([{ railId: "r" }]);
    expect(toCamelRow<Record<string, unknown> | null>(null)).toBeNull();
  });
});

describe("generated client type compatibility", () => {
  test("the engine where clauses type check against the generated Prisma types", () => {
    const attemptWhere: Prisma.PaymentAttemptWhereInput = {
      idempotencyKey: "idem-1",
      createdAt: { gte: new Date() },
      status: { in: ["CREATED", "INITIATING"] },
    };
    const approvalWhere: Prisma.ApprovalRequestWhereInput = {
      state: "PENDING_REVIEW",
      subjectType: "MERCHANT",
    };
    const auditData: Prisma.AuditLogUncheckedCreateInput = {
      actorId: "actor-1",
      role: "OPERATOR",
      action: "TEST",
      entityType: "PAYMENT_ATTEMPT",
      entityId: "attempt-1",
      beforeJson: {},
      afterJson: {},
    };
    const settingData: Prisma.PlatformSettingCreateInput = {
      key: "onboarding.sandbox_before_approval",
      scope: "PLATFORM",
      valueJson: true,
      version: 1,
      effectiveFrom: new Date(),
    };
    expect(attemptWhere.idempotencyKey).toBe("idem-1");
    expect(approvalWhere.state).toBe("PENDING_REVIEW");
    expect(auditData.actorId).toBe("actor-1");
    expect(settingData.scope).toBe("PLATFORM");
  });
});
