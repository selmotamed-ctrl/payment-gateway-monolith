import { createHash } from "node:crypto";
import express, { type Request, type Response } from "express";
import { client } from "../../prisma/client";
import { ApiError } from "../../lib/error";
import { buildListQuery, countUnlessSkipped, listResponse } from "../../lib/listQuery";
import { requireAuthorities, principalOf } from "../middleware/authDoubleCheck";
import { vault } from "../../engine/crypto/Vault";
import { AttemptStatus } from "../../generated/prisma/enums";
import {
  andWhere,
  assertDecimalQuery,
  booleanFilter,
  enumListFilter,
  money4,
  money4OrNull,
  queryString,
  queryWithout,
  requireUuidParam,
  searchClause,
  uuidListFilter,
} from "./adminSliceHelpers";

/**
 * Operations views of the admin console: the global transaction list, inbound
 * provider events, the upgraded attempt detail and per-gateway route health.
 * Mounted under `/internal/admin` (see admin.ts).
 */
const router = express.Router();

const ATTEMPT_STATUSES = Object.values(AttemptStatus) as AttemptStatus[];
const SETTLED_STATUSES: AttemptStatus[] = ["SUCCEEDED"];
const IN_FLIGHT_STATUSES: AttemptStatus[] = ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN"];
const FAILED_STATUSES: AttemptStatus[] = ["FAILED", "EXPIRED", "CANCELLED", "BLOCKED"];

const isSupportRole = (request: Request): boolean => principalOf(request).role === "SUPPORT";

const merchantRef = { select: { id: true, legalName: true, tradeName: true } } as const;
const gatewayRef = { select: { id: true, code: true, name: true } } as const;

const ATTEMPT_REDACTED_FIELDS = [
  "amounts",
  "providerReference",
  "networkReference",
  "gatewayReference",
  "ledgerEntryId",
];

router.get("/transactions/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:read", "merchant:read", "finance:read"]);
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [groups, escalated24h] = await Promise.all([
    client.paymentAttempt.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    client.paymentAttempt.count({
      where: { createdAt: { gte: since }, operatorCases: { some: { state: { not: "RESOLVED" } } } },
    }),
  ]);
  const countOf = (statuses: readonly AttemptStatus[]): number =>
    groups.filter((group) => statuses.includes(group.status)).reduce((sum, group) => sum + group._count._all, 0);
  response.json({
    total24h: groups.reduce((sum, group) => sum + group._count._all, 0),
    settled24h: countOf(SETTLED_STATUSES),
    inFlight24h: countOf(IN_FLIGHT_STATUSES),
    failed24h: countOf(FAILED_STATUSES),
    escalated24h,
  });
});

router.get("/transactions", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:read", "merchant:read", "finance:read"]);
  const support = isSupportRole(request);
  const query = request.query as Record<string, unknown>;
  const statuses = enumListFilter(query, "status", ATTEMPT_STATUSES);
  const railIds = uuidListFilter(query, "railId");
  const gatewayIds = uuidListFilter(query, "gatewayId");
  const merchantIds = uuidListFilter(query, "merchantId");
  const applicationIds = uuidListFilter(query, "applicationId");
  const currency = queryString(query, "currency");
  if (currency !== undefined && !/^[A-Za-z]{3}$/.test(currency)) {
    throw new ApiError(400, "INVALID_FILTER", "The 'currency' filter is invalid");
  }
  assertDecimalQuery(query, "amountMin", "amountMax");
  const built = buildListQuery(
    queryWithout(query, "search", "status", "railId", "gatewayId", "merchantId", "applicationId", "currency"),
    {
      dates: { createdAt: { path: "createdAt" } },
      ranges: { amount: { path: "requestedAmount", kind: "decimal" } },
      sortable: { createdAt: "createdAt", status: "status", requestedAmount: "requestedAmount" },
      defaultSort: { createdAt: "desc" },
      defaultPageSize: 25,
    },
  );
  const where = andWhere(
    built.where,
    statuses ? { status: { in: statuses } } : undefined,
    railIds ? { railId: { in: railIds } } : undefined,
    gatewayIds ? { route: { gatewayId: { in: gatewayIds } } } : undefined,
    merchantIds ? { merchantId: { in: merchantIds } } : undefined,
    applicationIds ? { applicationId: { in: applicationIds } } : undefined,
    currency ? { currency: currency.toUpperCase() } : undefined,
    searchClause(queryString(query, "search"), {
      text: support ? ["reference"] : ["reference", "gatewayReference", "providerReference", "networkReference"],
      uuid: ["id"],
    }),
  );
  const [attempts, total] = await Promise.all([
    client.paymentAttempt.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        createdAt: true,
        status: true,
        requestedAmount: true,
        currency: true,
        reference: true,
        gatewayReference: true,
        providerReference: true,
        networkReference: true,
        merchantId: true,
        applicationId: true,
        railId: true,
        ledgerEntryId: true,
        merchant: merchantRef,
        application: { select: { id: true, name: true } },
        rail: { select: { id: true, code: true, nameEn: true } },
        route: { select: { gatewayId: true, gateway: gatewayRef } },
        operatorCases: { where: { state: { not: "RESOLVED" } }, select: { id: true }, take: 1 },
      },
    }),
    countUnlessSkipped(built, () => client.paymentAttempt.count({ where: where as never })),
  ]);
  response.json({
    ...listResponse(
      "transactions",
      attempts.map((attempt) => ({
        id: attempt.id,
        createdAt: attempt.createdAt,
        status: attempt.status,
        requestedAmount: support ? null : money4(attempt.requestedAmount),
        currency: attempt.currency,
        merchantId: attempt.merchantId,
        merchant: attempt.merchant,
        applicationId: attempt.applicationId,
        application: attempt.application,
        railId: attempt.railId,
        rail: attempt.rail,
        gatewayId: attempt.route.gatewayId,
        gateway: attempt.route.gateway,
        reference: attempt.reference,
        gatewayReference: support ? null : attempt.gatewayReference,
        providerReference: support ? null : attempt.providerReference,
        networkReference: support ? null : attempt.networkReference,
        ledgerEntryId: support ? null : attempt.ledgerEntryId,
        hasOpenCase: attempt.operatorCases.length > 0,
        redactedFields: support ? ATTEMPT_REDACTED_FIELDS : [],
      })),
      total,
      built,
    ),
    redactedFields: support ? ATTEMPT_REDACTED_FIELDS : [],
  });
});

// ---------------------------------------------------------------- inbound events

type InboundListRow = {
  id: string;
  receivedAt: Date;
  gatewayId: string;
  gateway: { id: string; code: string; name: string };
  channelId: string;
  env: string;
  sourceIp: string;
  verified: boolean;
  verificationError: string | null;
  attemptId: string | null;
  processedAt: Date | null;
  processingResult: string | null;
  dedupeKey: string;
};

/** `rawBodyBytes` is never selected: only these columns ever leave the database. */
const inboundListSelect = {
  id: true,
  receivedAt: true,
  gatewayId: true,
  gateway: gatewayRef,
  channelId: true,
  env: true,
  sourceIp: true,
  verified: true,
  verificationError: true,
  attemptId: true,
  processedAt: true,
  processingResult: true,
  dedupeKey: true,
} as const;

const inboundItem = (row: InboundListRow): Record<string, unknown> => ({
  id: row.id,
  receivedAt: row.receivedAt,
  gatewayId: row.gatewayId,
  gateway: row.gateway,
  channelId: row.channelId,
  env: row.env,
  sourceIp: row.sourceIp,
  verified: row.verified,
  verificationError: row.verificationError,
  attemptId: row.attemptId,
  processedAt: row.processedAt,
  processingResult: row.processingResult,
  dedupeKey: row.dedupeKey,
});

router.get("/inbound-events", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:read", "case:read"]);
  const query = request.query as Record<string, unknown>;
  const gatewayIds = uuidListFilter(query, "gatewayId");
  const verified = booleanFilter(query, "verified");
  const unmatchedOnly = booleanFilter(query, "unmatchedOnly");
  const built = buildListQuery(queryWithout(query, "search", "gatewayId", "verified", "unmatchedOnly"), {
    dates: { receivedAt: { path: "receivedAt", fromKey: "from", toKey: "to" } },
    sortable: { receivedAt: "receivedAt", verified: "verified", gatewayId: "gatewayId" },
    defaultSort: { receivedAt: "desc" },
    defaultPageSize: 25,
    keysetFields: ["receivedAt"],
  });
  const where = andWhere(
    built.where,
    gatewayIds ? { gatewayId: { in: gatewayIds } } : undefined,
    verified !== undefined ? { verified } : undefined,
    unmatchedOnly === true ? { attemptId: null } : undefined,
    searchClause(queryString(query, "search"), {
      text: ["sourceIp", "verificationError", "processingResult", "dedupeKey"],
      uuid: ["id", "attemptId", "gatewayId"],
    }),
  );
  const [events, total] = await Promise.all([
    client.inboundEvent.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: inboundListSelect,
    }),
    countUnlessSkipped(built, () => client.inboundEvent.count({ where: where as never })),
  ]);
  response.json(listResponse("inboundEvents", events.map(inboundItem), total, built, events));
});

const BODY_PREVIEW_BYTES = 2048;
const BODY_PARSE_LIMIT = 256 * 1024;

/**
 * First 2 KB of the body, redacted with the vault redaction used for step
 * logs. JSON and form-encoded bodies are redacted field by field (so `token`,
 * `signature`, card numbers etc. disappear); anything else only goes through
 * the text redaction.
 */
const redactedBodyPreview = (raw: Uint8Array): string => {
  const buffer = Buffer.from(raw);
  const text = buffer.subarray(0, BODY_PARSE_LIMIT).toString("utf8");
  const trimmed = text.trimStart();
  let rendered: string | undefined;
  if (buffer.length <= BODY_PARSE_LIMIT && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      rendered = JSON.stringify(vault.redactPayload(JSON.parse(text) as unknown));
    } catch {
      rendered = undefined;
    }
  }
  if (rendered === undefined && buffer.length <= BODY_PARSE_LIMIT && /^[^\s{<][^\n]*=/.test(trimmed) && !trimmed.includes("\n")) {
    const fields: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(text)) {
      fields[key] = value;
    }
    rendered = JSON.stringify(vault.redactPayload(fields));
  }
  if (rendered === undefined) {
    rendered = vault.redactText(buffer.subarray(0, BODY_PREVIEW_BYTES).toString("utf8"));
  }
  return Buffer.from(rendered, "utf8").subarray(0, BODY_PREVIEW_BYTES).toString("utf8");
};

router.get("/inbound-events/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:read", "case:read"]);
  const id = requireUuidParam(request.params.id, "INBOUND_EVENT_NOT_FOUND", "The inbound event does not exist");
  const event = await client.inboundEvent.findUnique({
    where: { id },
    select: { ...inboundListSelect, redactedHeadersJson: true, rawBodyBytes: true },
  });
  if (!event) {
    throw new ApiError(404, "INBOUND_EVENT_NOT_FOUND", "The inbound event does not exist");
  }
  const body = Buffer.from(event.rawBodyBytes);
  response.json({
    ...inboundItem(event),
    redactedHeaders: vault.redactPayload(event.redactedHeadersJson),
    bodyPreview: redactedBodyPreview(body),
    bodySize: body.length,
    bodySha256: createHash("sha256").update(body).digest("hex"),
  });
});

// ---------------------------------------------------------------- attempt detail

const ATTEMPT_SECRET_COLUMNS = ["contextCiphertext"] as const;
const STEP_RESPONSE_LIMIT = 16 * 1024;
const MONEY_COLUMNS = [
  "requestedAmount",
  "surchargeAmount",
  "totalChargedAmount",
  "settledAmount",
  "gatewayFeeAmount",
  "platformCommissionAmount",
  "netMerchantAmount",
] as const;
const SUPPORT_HIDDEN_ATTEMPT_COLUMNS = [
  ...MONEY_COLUMNS,
  "providerReference",
  "networkReference",
  "gatewayReference",
  "gatewayAmountWire",
  "ledgerEntryId",
] as const;

/**
 * The attempt detail served by `GET /attempts/:id` (it replaces the old raw-row handler of admin.ts).
 * The legacy `attempt` key is kept; its ciphertext column is stripped. Every
 * other section only exposes already-redacted columns.
 */
const buildAttemptDetail = async (id: string, request: Request): Promise<Record<string, unknown>> => {
  const support = isSupportRole(request);
  const row = await client.paymentAttempt.findUnique({
    where: { id },
    include: {
      merchant: merchantRef,
      application: { select: { id: true, name: true, status: true } },
      rail: { select: { id: true, code: true, nameEn: true, nameAr: true } },
      route: { select: { id: true, gatewayId: true, gateway: gatewayRef } },
      link: { select: { id: true, key: true } },
    },
  });
  if (!row) {
    throw new ApiError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "The payment attempt does not exist");
  }
  const [stepLogs, inboundEvents, group, operatorCases, disputes, adjustments] = await Promise.all([
    client.attemptStepLog.findMany({
      where: { attemptId: id },
      orderBy: [{ stepOrder: "asc" }, { createdAt: "asc" }],
      take: 500,
      select: {
        id: true,
        createdAt: true,
        phase: true,
        stepId: true,
        stepOrder: true,
        redactedRequestJson: true,
        redactedResponseText: true,
        httpStatus: true,
        durationMs: true,
        outcome: true,
      },
    }),
    client.inboundEvent.findMany({
      where: { attemptId: id },
      orderBy: { receivedAt: "desc" },
      take: 50,
      select: inboundListSelect,
    }),
    client.attemptGroup.findUnique({
      where: { id: row.attemptGroupId },
      select: {
        id: true,
        successCount: true,
        paymentAttempts: {
          orderBy: { createdAt: "desc" },
          take: 25,
          select: { id: true, status: true, railId: true, route: { select: { gatewayId: true } }, requestedAmount: true, createdAt: true },
        },
      },
    }),
    client.operatorCase.findMany({
      where: { attemptId: id },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, kind: true, state: true, priority: true, slaDueAt: true },
    }),
    client.dispute.findMany({
      where: { attemptId: id },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, status: true, amount: true, reasonCode: true, createdAt: true },
    }),
    client.adjustment.findMany({
      where: { sourceAttemptId: id },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, type: true, state: true, amount: true, createdAt: true, journalEntryId: true },
    }),
  ]);

  const {
    merchant,
    application,
    rail,
    route,
    link,
    ...columns
  } = row as typeof row & Record<string, unknown>;
  const attempt: Record<string, unknown> = { ...columns, link };
  for (const column of ATTEMPT_SECRET_COLUMNS) {
    delete attempt[column];
  }
  for (const column of MONEY_COLUMNS) {
    if (column in attempt) {
      attempt[column] = money4OrNull(attempt[column]);
    }
  }
  if (support) {
    for (const column of SUPPORT_HIDDEN_ATTEMPT_COLUMNS) {
      if (column in attempt) {
        attempt[column] = null;
      }
    }
  }

  return {
    attempt,
    merchant,
    application,
    rail,
    gateway: route.gateway,
    stepLogs: stepLogs.map((log) => ({
      ...log,
      // Defence in depth: the columns are redacted at write time, but the
      // same vault redaction runs again before anything leaves the API.
      redactedRequestJson: vault.redactPayload(log.redactedRequestJson),
      redactedResponseText: vault.redactText(log.redactedResponseText.slice(0, STEP_RESPONSE_LIMIT)),
    })),
    inboundEvents: inboundEvents.map(inboundItem),
    attemptGroup: group
      ? {
          id: group.id,
          successCount: group.successCount,
          attempts: group.paymentAttempts.map((entry) => ({
            id: entry.id,
            status: entry.status,
            railId: entry.railId,
            gatewayId: entry.route.gatewayId,
            requestedAmount: support ? null : money4(entry.requestedAmount),
            createdAt: entry.createdAt,
          })),
        }
      : null,
    operatorCases,
    disputes: disputes.map((dispute) => ({
      id: dispute.id,
      status: dispute.status,
      disputedAmount: support ? null : money4(dispute.amount),
      reasonCode: dispute.reasonCode,
      createdAt: dispute.createdAt,
    })),
    adjustments: adjustments.map((adjustment) => ({
      id: adjustment.id,
      type: adjustment.type,
      state: adjustment.state,
      amount: support ? null : money4(adjustment.amount),
      createdAt: adjustment.createdAt,
      journalEntryId: support ? null : adjustment.journalEntryId,
    })),
    redactedFields: support ? ATTEMPT_REDACTED_FIELDS : [],
  };
};

router.get("/attempts/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["attempt:read"]);
  const id = requireUuidParam(request.params.id, "PAYMENT_ATTEMPT_NOT_FOUND", "The payment attempt does not exist");
  response.json(await buildAttemptDetail(id, request));
});

// ---------------------------------------------------------------- gateway route health

const HEALTH_SAMPLES = 100;
const HEALTH_VOLUME_DAYS = 30;

const successRateOf = (successes: number, failures: number, unknowns: number): number | null => {
  const denominator = successes + failures + unknowns;
  return denominator === 0 ? null : successes / denominator;
};

router.get("/gateways/:id/health", async (request: Request, response: Response) => {
  requireAuthorities(request, ["gateway:read"]);
  const id = requireUuidParam(request.params.id, "GATEWAY_NOT_FOUND", "The gateway does not exist");
  const gateway = await client.gateway.findUnique({ where: { id }, select: { id: true } });
  if (!gateway) {
    throw new ApiError(404, "GATEWAY_NOT_FOUND", "The gateway does not exist");
  }
  const routes = await client.railRoute.findMany({
    where: { gatewayId: id },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    select: { id: true, rail: { select: { code: true } } },
  });
  const now = Date.now();
  const since24h = new Date(now - 24 * 3600 * 1000);
  const volumeSince = new Date(now - HEALTH_VOLUME_DAYS * 24 * 3600 * 1000);
  volumeSince.setUTCHours(0, 0, 0, 0);

  let successes24h = 0;
  let failures24h = 0;
  let unknowns24h = 0;
  let p95Weighted = 0;
  let p95Weight = 0;

  const result = [];
  for (const route of routes) {
    const [recentDesc, volumes] = await Promise.all([
      client.gatewayHealthSample.findMany({
        where: { routeId: route.id },
        orderBy: { windowStart: "desc" },
        take: HEALTH_SAMPLES,
      }),
      client.rmRouteDailyVolume.findMany({
        where: { routeId: route.id, day: { gte: volumeSince } },
        orderBy: [{ day: "asc" }, { currency: "asc" }],
      }),
    ]);
    for (const sample of recentDesc) {
      if (sample.windowStart >= since24h) {
        successes24h += sample.successes;
        failures24h += sample.definitiveFailures;
        unknowns24h += sample.ambiguousUnknowns;
        const weight = sample.successes + sample.definitiveFailures + sample.ambiguousUnknowns;
        if (sample.p95Ms !== null && weight > 0) {
          p95Weighted += sample.p95Ms * weight;
          p95Weight += weight;
        }
      }
    }
    result.push({
      routeId: route.id,
      railCode: route.rail.code,
      samples: [...recentDesc].reverse().map((sample) => ({
        windowStart: sample.windowStart,
        successes: sample.successes,
        definitiveFailures: sample.definitiveFailures,
        ambiguousUnknowns: sample.ambiguousUnknowns,
        rateLimits429: sample.rateLimits429,
        p50Ms: sample.p50Ms,
        p95Ms: sample.p95Ms,
        p99Ms: sample.p99Ms,
        successRate: successRateOf(sample.successes, sample.definitiveFailures, sample.ambiguousUnknowns),
      })),
      dailyVolume: volumes.map((volume) => ({
        day: volume.day.toISOString().slice(0, 10),
        currency: volume.currency,
        attemptCount: volume.attemptCount,
        successCount: volume.successCount,
        volumeAmount: money4(volume.volumeAmount),
      })),
    });
  }
  response.json({
    routes: result,
    summary: {
      successRate24h: successRateOf(successes24h, failures24h, unknowns24h),
      // Percentiles cannot be merged exactly: the volume-weighted mean of the window p95 values.
      p95Ms24h: p95Weight > 0 ? Math.round(p95Weighted / p95Weight) : null,
    },
  });
});

export const adminOperationsRouter = router;
