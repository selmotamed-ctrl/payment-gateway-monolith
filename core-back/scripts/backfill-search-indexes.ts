/**
 * One-off backfill for the materialized KYB hash stats and the unified
 * entity_search_tokens index.
 *
 *   bun ./scripts/backfill-search-indexes.ts
 *   bun ./scripts/backfill-search-indexes.ts --stats-only
 *   bun ./scripts/backfill-search-indexes.ts --tokens-only
 */
import { client } from "../prisma/client";
import { buildEntitySearchTokenRows } from "../lib/search/tokenIndex";

const CHUNK_SIZE = 1_000;
const args = new Set(process.argv.slice(2));
const runStats = !args.has("--tokens-only");
const runTokens = !args.has("--stats-only");

interface HashStatRow {
  sha256: string;
  doc_count: number | bigint;
  merchant_count: number | bigint;
  first_seen_at: Date | string | null;
}

const chunks = <T>(values: T[], size = CHUNK_SIZE): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
};

const backfillKybHashStats = async (): Promise<void> => {
  const rows = await client.$queryRawUnsafe<HashStatRow[]>(
    `SELECT sha256,
            COUNT(*) AS doc_count,
            COUNT(DISTINCT merchant_id) AS merchant_count,
            MIN(created_at) AS first_seen_at
       FROM kyb_documents
      GROUP BY sha256`,
  );

  await client.kybDocumentHashStat.deleteMany({});
  for (const batch of chunks(rows)) {
    await client.kybDocumentHashStat.createMany({
      data: batch.map((row) => ({
        sha256: row.sha256,
        docCount: Number(row.doc_count),
        merchantCount: Number(row.merchant_count),
        firstSeenAt: row.first_seen_at ? new Date(row.first_seen_at) : new Date(),
      })),
      skipDuplicates: true,
    });
  }
  console.log(`kyb_document_hash_stats: rebuilt ${rows.length} hash rows`);
};

interface TokenBackfillSource {
  entityType: string;
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  select: Record<string, unknown>;
}

const sources: TokenBackfillSource[] = [
  {
    entityType: "merchant",
    findMany: (args) => client.merchant.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      displayName: true,
      tradeName: true,
      legalName: true,
      contactEmail: true,
      contactPhone: true,
      supportEmail: true,
      supportPhone: true,
      taxId: true,
      registrationNo: true,
      payoutAccountHash: true,
      businessCategory: true,
      country: true,
      riskTier: true,
      status: true,
      kybStatus: true,
    },
  },
  {
    entityType: "payment_attempt",
    findMany: (args) => client.paymentAttempt.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      reference: true,
      providerReference: true,
      networkReference: true,
      gatewayReference: true,
      idempotencyKey: true,
      merchantId: true,
      status: true,
      currency: true,
      totalChargedAmount: true,
      requestedAmount: true,
      merchant: { select: { tradeName: true, legalName: true } },
      rail: { select: { code: true } },
    },
  },
  {
    entityType: "join_request",
    findMany: (args) => client.joinRequest.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      merchantId: true,
      status: true,
      onboardingChannel: true,
      proposedRiskTier: true,
      approvalRequestId: true,
      merchant: { select: { tradeName: true, legalName: true, displayName: true } },
    },
  },
  {
    entityType: "kyb_document",
    findMany: (args) => client.kybDocument.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      sha256: true,
      merchantId: true,
      joinRequestId: true,
      uploadedById: true,
      reviewedById: true,
      originalFileName: true,
      docType: true,
      mime: true,
      status: true,
      avStatus: true,
      subjectType: true,
      merchant: { select: { tradeName: true, legalName: true } },
    },
  },
  {
    entityType: "operator_case",
    findMany: (args) => client.operatorCase.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      attemptId: true,
      approvalRequestId: true,
      reconciliationItemId: true,
      kind: true,
      priority: true,
      state: true,
      assigneeUserId: true,
      attempt: { select: { reference: true, merchantId: true } },
      assignee: { select: { email: true } },
    },
  },
  {
    entityType: "user",
    findMany: (args) => client.user.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      email: true,
      phone: true,
      role: true,
      status: true,
      merchantId: true,
      merchant: { select: { tradeName: true, legalName: true } },
    },
  },
  {
    entityType: "approval",
    findMany: (args) => client.approvalRequest.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      subjectType: true,
      subjectId: true,
      state: true,
      mode: true,
      makerReason: true,
      maker: { select: { email: true } },
      checker: { select: { email: true } },
    },
  },
  {
    entityType: "gateway",
    findMany: (args) => client.gateway.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      code: true,
      name: true,
      operator: true,
      status: true,
    },
  },
  {
    entityType: "rail",
    findMany: (args) => client.rail.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      code: true,
      nameEn: true,
      nameAr: true,
      collectionMode: true,
      currency: true,
      blocked: true,
    },
  },
  {
    entityType: "route",
    findMany: (args) => client.railRoute.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      railId: true,
      gatewayId: true,
      priority: true,
      healthState: true,
      rail: { select: { code: true, nameEn: true, nameAr: true } },
      gateway: { select: { code: true, name: true } },
    },
  },
  {
    entityType: "audit_log",
    findMany: (args) => client.auditLog.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      action: true,
      entityType: true,
      entityId: true,
      role: true,
      actorId: true,
      actor: { select: { email: true } },
    },
  },
  {
    entityType: "gateway_inquiry",
    findMany: (args) => client.gatewayInquirySchedule.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      operatorCaseId: true,
      source: true,
      status: true,
      reason: true,
      attempt: { select: { reference: true, merchantId: true } },
    },
  },
  {
    entityType: "dispute",
    findMany: (args) => client.dispute.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      externalDisputeRef: true,
      reasonCode: true,
      status: true,
      attempt: { select: { reference: true, merchantId: true } },
    },
  },
  {
    entityType: "adjustment",
    findMany: (args) => client.adjustment.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      type: true,
      state: true,
      reason: true,
      externalDisputeRef: true,
      providerRefundRef: true,
      sourceAttempt: { select: { reference: true, merchantId: true } },
    },
  },
  {
    entityType: "cashout",
    findMany: (args) => client.cashoutRequest.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      state: true,
      merchantId: true,
      wallet: { select: { currency: true } },
      merchant: { select: { tradeName: true, legalName: true } },
    },
  },
  {
    entityType: "aml_case",
    findMany: (args) => client.amlCase.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      subjectType: true,
      subjectId: true,
      triggerReason: true,
      severity: true,
      status: true,
      rule: { select: { code: true, name: true } },
    },
  },
  {
    entityType: "aml_screening",
    findMany: (args) => client.amlScreening.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      subjectType: true,
      subjectId: true,
      providerCode: true,
      providerRequestRef: true,
      result: true,
    },
  },
  {
    entityType: "aml_rule",
    findMany: (args) => client.amlRule.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      code: true,
      name: true,
      ruleType: true,
      action: true,
      active: true,
    },
  },
  {
    entityType: "aml_report",
    findMany: (args) => client.regulatoryReport.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      reportType: true,
      subjectType: true,
      subjectId: true,
      status: true,
      submissionRef: true,
      authority: true,
    },
  },
  {
    entityType: "reconciliation_run",
    findMany: (args) => client.reconciliationRun.findMany(args as never) as unknown as Promise<Array<Record<string, unknown>>>,
    select: {
      id: true,
      createdAt: true,
      fileName: true,
      ingestedAt: true,
      statementSource: { select: { gateway: { select: { code: true, name: true } } } },
    },
  },
];

const backfillEntityTokens = async (): Promise<void> => {
  let total = 0;
  for (const source of sources) {
    await client.entitySearchToken.deleteMany({ where: { entityType: source.entityType } });
    let cursor: string | undefined;
    let entityCount = 0;
    let tokenCount = 0;

    for (;;) {
      const rows = await source.findMany({
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: "asc" },
        take: CHUNK_SIZE,
        select: source.select,
      });
      if (rows.length === 0) {
        break;
      }

      const tokenRows = rows.flatMap((row) =>
        buildEntitySearchTokenRows(source.entityType, row),
      );
      for (const batch of chunks(tokenRows)) {
        await client.entitySearchToken.createMany({
          data: batch,
          skipDuplicates: true,
        });
      }
      entityCount += rows.length;
      tokenCount += tokenRows.length;
      cursor = String(rows[rows.length - 1]?.id ?? "");
      if (!cursor || rows.length < CHUNK_SIZE) {
        break;
      }
    }

    total += tokenCount;
    console.log(`${source.entityType}: indexed ${entityCount} rows / ${tokenCount} tokens`);
  }
  console.log(`entity_search_tokens: wrote ${total} tokens`);
};

const main = async (): Promise<void> => {
  if (runStats) {
    await backfillKybHashStats();
  }
  if (runTokens) {
    await backfillEntityTokens();
  }
};

if (import.meta.main) {
  main()
    .catch((error: unknown) => {
      console.error(`backfill-search-indexes failed: ${(error as Error).message}`);
      process.exit(1);
    })
    .finally(() => client.$disconnect().catch(() => undefined));
}
