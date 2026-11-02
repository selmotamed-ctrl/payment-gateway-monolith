import type { PrismaClient } from "../../../generated/prisma/client";
import type { SeederContext } from "../context";
import {
  DEFAULT_COUNTER_TIMEZONE,
  VELOCITY_BUCKET_RETENTION_SECONDS,
  counterDayBucket,
  velocityBucketEpoch,
  velocityScopesForAttempt,
} from "../../../lib/counters/materializedCounters";
import { buildEntitySearchTokenRows } from "../../../lib/search/tokenIndex";

/**
 * Topological FK-ordered, chunked `createMany` writer.
 *
 * 120k attempts and ~490k journal lines must not be written one row at a time.
 * The writer streams 2,500-row chunks and keeps the insert order consistent
 * with the foreign keys. `skipDuplicates` makes a re-run idempotent.
 */

type ModelName = keyof PrismaClient & string;

interface Step {
  model: ModelName;
  key: keyof SeederContext["dataset"];
  transform?: (rows: any[]) => any[];
}

const CHUNK = 2500;

const STEPS: Step[] = [
  // Merchants precede users because a merchant user carries merchant_id.
  { model: "merchant", key: "merchants" },
  { model: "user", key: "users" },
  { model: "userIdentity", key: "userIdentities" },
  { model: "joinRequest", key: "joinRequests" },
  { model: "kybDocument", key: "kybDocuments" },
  { model: "beneficialOwner", key: "beneficialOwners" },
  { model: "glAccount", key: "glAccounts" },
  { model: "wallet", key: "wallets" },
  { model: "application", key: "applications" },
  { model: "accessToken", key: "accessTokens" },
  { model: "accessTokenIp", key: "accessTokenIps" },
  { model: "posTerminal", key: "posTerminals" },
  { model: "posScreen", key: "posScreens" },
  { model: "commissionProfile", key: "commissionProfiles" },
  { model: "credentialSet", key: "credentialSets" },
  { model: "gatewayVersion", key: "gatewayVersions" },
  { model: "gatewayEnvironment", key: "gatewayEnvironments" },
  { model: "gatewayAuth", key: "gatewayAuths" },
  { model: "gatewaySetting", key: "gatewaySettings" },
  { model: "confirmationChannel", key: "confirmationChannels" },
  { model: "gatewayVersionEvidence", key: "gatewayVersionEvidence" },
  { model: "gatewayHealthSample", key: "gatewayHealthSamples" },
  { model: "statementSource", key: "statementSources" },
  { model: "paymentLink", key: "paymentLinks" },
  { model: "attemptGroup", key: "attemptGroups" },
  // Journal entries precede attempts because attempts carry ledgerEntryId.
  { model: "journalEntry", key: "journalEntries" },
  { model: "paymentAttempt", key: "paymentAttempts" },
  { model: "attemptStepLog", key: "attemptStepLogs" },
  { model: "inboundEvent", key: "inboundEvents" },
  { model: "journalLine", key: "journalLines" },
  { model: "reconciliationRun", key: "reconciliationRuns" },
  { model: "reconciliationItem", key: "reconciliationItems" },
  // The dispute -> adjustment scalar is linked after both tables exist.
  { model: "dispute", key: "disputes", transform: (rows) => rows.map(({ adjustmentId: _adjustmentId, ...rest }) => ({ ...rest, adjustmentId: null })) },
  { model: "adjustment", key: "adjustments" },
  { model: "cashoutRequest", key: "cashoutRequests" },
  { model: "amlScreening", key: "amlScreenings" },
  { model: "amlScreeningMatch", key: "amlScreeningMatches" },
  { model: "amlCase", key: "amlCases" },
  { model: "regulatoryReport", key: "regulatoryReports" },
  { model: "approvalRequest", key: "approvalRequests" },
  { model: "operatorCase", key: "operatorCases" },
  { model: "notificationTemplate", key: "notificationTemplates" },
  { model: "notification", key: "notifications" },
  { model: "auditLog", key: "auditLogs" },
  { model: "detailChangeLog", key: "detailChangeLogs" },
  { model: "velocityRule", key: "velocityRules" },
  { model: "amlRule", key: "amlRules" },
  { model: "reportingRule", key: "reportingRules" },
  { model: "platformSetting", key: "platformSettings" },
];

const SUCCESSFUL_STATUSES = new Set(["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"]);
const TERMINAL_FAILURE_STATUSES = new Set(["FAILED", "EXPIRED", "CANCELLED", "BLOCKED"]);

const insertChunked = async (
  prisma: PrismaClient,
  model: ModelName,
  rows: any[],
): Promise<number> => {
  const delegate = (prisma as unknown as Record<string, { createMany: (input: unknown) => Promise<{ count: number }> }>)[model];
  if (!delegate) throw new Error(`Unknown Prisma model '${model}'`);
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const data = rows.slice(offset, offset + CHUNK);
    const result = await delegate.createMany({ data, skipDuplicates: true });
    written += result.count;
  }
  return written;
};

const upsertChunked = async (
  prisma: PrismaClient,
  model: ModelName,
  table: string,
  columns: string[],
  primaryKeys: string[],
  rows: any[],
): Promise<number> => {
  if (rows.length === 0) return 0;
  const chunkSize = Math.max(1, Math.min(CHUNK, Math.floor(60_000 / columns.length)));
  const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
  const updateClause = updateColumns
    .map((column) => `\`${column}\`=VALUES(\`${column}\`)`)
    .join(", ");
  const camelKey = (column: string): string =>
    column.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
  const execute = (prisma as unknown as { $executeRawUnsafe?: (sql: string, ...values: unknown[]) => Promise<unknown> }).$executeRawUnsafe;

  if (typeof execute !== "function") {
    return insertChunked(prisma, model, rows);
  }

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const placeholders = chunk
      .map(() => `(${columns.map(() => "?").join(",")})`)
      .join(",");
    const values = chunk.flatMap((row) =>
      columns.map((column) => {
        const value = row[camelKey(column)];
        return column === "is_sensitive" ? (value ? 1 : 0) : value ?? null;
      }),
    );
    const sql = `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(",")}) `
      + `VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${updateClause}`;
    await execute.call(prisma, sql, ...values);
  }
  return rows.length;
};

const money = (value: unknown): string => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toFixed(4) : "0.0000";
};

const dateOf = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

const counterTimeZone = (ctx: SeederContext): string => {
  const configured = ctx.dataset.gatewaySettings[0]?.gatewayTimezone;
  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_COUNTER_TIMEZONE;
};

const buildRouteDailyVolumes = (ctx: SeederContext): any[] => {
  const rows = new Map<string, { routeId: string; dayBucket: string; succeededCount: number; totalChargedAmount: number; updatedAt: Date }>();
  const timeZone = counterTimeZone(ctx);
  for (const attempt of ctx.dataset.paymentAttempts) {
    if (!SUCCESSFUL_STATUSES.has(String(attempt.status))) continue;
    const routeId = String(attempt.routeId ?? "");
    if (!routeId) continue;
    const at = dateOf(attempt.terminalAt ?? attempt.createdAt);
    const dayBucket = counterDayBucket(at, timeZone);
    const key = `${routeId}:${dayBucket}`;
    const row = rows.get(key) ?? { routeId, dayBucket, succeededCount: 0, totalChargedAmount: 0, updatedAt: at };
    row.succeededCount += 1;
    row.totalChargedAmount += Number(attempt.totalChargedAmount ?? 0);
    if (at.getTime() > row.updatedAt.getTime()) row.updatedAt = at;
    rows.set(key, row);
  }
  return [...rows.values()].map((row) => ({ ...row, totalChargedAmount: money(row.totalChargedAmount) }));
};

const buildMerchantDailyStats = (ctx: SeederContext): any[] => {
  const railCodeByRoute = new Map(ctx.refs.routes.map((route) => [String(route.id), route.railCode]));
  const timeZone = counterTimeZone(ctx);
  const rows = new Map<string, {
    merchantId: string;
    dayBucket: string;
    railCode: string;
    initiatedCount: number;
    succeededCount: number;
    failedCount: number;
    expiredCount: number;
    refundedCount: number;
    disputedCount: number;
    grossSucceededAmount: number;
    platformCommissionAmount: number;
    netMerchantAmount: number;
    updatedAt: Date;
  }>();
  for (const attempt of ctx.dataset.paymentAttempts) {
    const merchantId = String(attempt.merchantId ?? "");
    if (!merchantId) continue;
    const at = dateOf(attempt.createdAt);
    const dayBucket = counterDayBucket(at, timeZone);
    const railCode = (railCodeByRoute.get(String(attempt.routeId)) ?? String(attempt.mode ?? "UNKNOWN")).slice(0, 64);
    const key = `${merchantId}:${dayBucket}:${railCode}`;
    const row = rows.get(key) ?? {
      merchantId,
      dayBucket,
      railCode,
      initiatedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      expiredCount: 0,
      refundedCount: 0,
      disputedCount: 0,
      grossSucceededAmount: 0,
      platformCommissionAmount: 0,
      netMerchantAmount: 0,
      updatedAt: at,
    };
    row.initiatedCount += 1;
    const status = String(attempt.status);
    if (SUCCESSFUL_STATUSES.has(status)) {
      row.succeededCount += 1;
      row.grossSucceededAmount += Number(attempt.totalChargedAmount ?? 0);
      row.platformCommissionAmount += Number(attempt.platformCommissionAmount ?? 0);
      row.netMerchantAmount += Number(attempt.netMerchantAmount ?? 0);
    }
    if (status === "FAILED" || status === "CANCELLED" || status === "BLOCKED") row.failedCount += 1;
    if (status === "EXPIRED") row.expiredCount += 1;
    if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") row.refundedCount += 1;
    if (status === "DISPUTED") row.disputedCount += 1;
    const eventAt = dateOf(attempt.terminalAt ?? attempt.createdAt);
    if (eventAt.getTime() > row.updatedAt.getTime()) row.updatedAt = eventAt;
    rows.set(key, row);
  }
  return [...rows.values()].map((row) => ({
    ...row,
    grossSucceededAmount: money(row.grossSucceededAmount),
    platformCommissionAmount: money(row.platformCommissionAmount),
    netMerchantAmount: money(row.netMerchantAmount),
  }));
};

const buildVelocityWindowBuckets = (ctx: SeederContext): any[] => {
  const windowStart = new Date(ctx.timeline.end.getTime() - 24 * 3_600_000);
  const rows = new Map<string, {
    scopeType: string;
    scopeHash: string;
    bucketEpoch: number;
    attemptCount: number;
    succeededCount: number;
    totalAmount: number;
    expiresAt: Date;
  }>();
  for (const attempt of ctx.dataset.paymentAttempts) {
    const createdAt = dateOf(attempt.createdAt);
    if (createdAt.getTime() < windowStart.getTime() || createdAt.getTime() > ctx.timeline.end.getTime()) continue;
    const status = String(attempt.status);
    const counted = !TERMINAL_FAILURE_STATUSES.has(status);
    const succeeded = SUCCESSFUL_STATUSES.has(status);
    const amount = Number(attempt.totalChargedAmount ?? 0);
    if (!counted && !succeeded) continue;
    const bucketEpoch = velocityBucketEpoch(createdAt);
    const expiresAt = new Date((bucketEpoch + VELOCITY_BUCKET_RETENTION_SECONDS) * 1000);
    for (const scope of velocityScopesForAttempt(attempt)) {
      const key = `${scope.scopeType}:${scope.scopeHash}:${bucketEpoch}`;
      const row = rows.get(key) ?? {
        scopeType: scope.scopeType,
        scopeHash: scope.scopeHash,
        bucketEpoch,
        attemptCount: 0,
        succeededCount: 0,
        totalAmount: 0,
        expiresAt,
      };
      if (counted) {
        row.attemptCount += 1;
        row.totalAmount += amount;
      }
      if (succeeded) row.succeededCount += 1;
      if (expiresAt.getTime() > row.expiresAt.getTime()) row.expiresAt = expiresAt;
      rows.set(key, row);
    }
  }
  return [...rows.values()].map((row) => ({ ...row, totalAmount: money(row.totalAmount) }));
};

const buildKybDocumentHashStats = (ctx: SeederContext): any[] => {
  const rows = new Map<string, {
    sha256: string;
    docCount: number;
    merchantCount: number;
    firstSeenAt: Date;
    updatedAt: Date;
    merchants: Set<string>;
  }>();
  for (const document of ctx.dataset.kybDocuments) {
    const sha256 = String(document.sha256 ?? "");
    if (!sha256) continue;
    const createdAt = dateOf(document.createdAt);
    const updatedAt = dateOf(document.updatedAt ?? document.createdAt);
    const row = rows.get(sha256) ?? {
      sha256,
      docCount: 0,
      merchantCount: 0,
      firstSeenAt: createdAt,
      updatedAt,
      merchants: new Set<string>(),
    };
    row.docCount += 1;
    row.merchants.add(String(document.merchantId ?? ""));
    if (createdAt.getTime() < row.firstSeenAt.getTime()) row.firstSeenAt = createdAt;
    if (updatedAt.getTime() > row.updatedAt.getTime()) row.updatedAt = updatedAt;
    rows.set(sha256, row);
  }
  return [...rows.values()].map((row) => ({
    sha256: row.sha256,
    docCount: row.docCount,
    merchantCount: row.merchants.size,
    firstSeenAt: row.firstSeenAt,
    updatedAt: row.updatedAt,
  }));
};

const buildEntitySearchTokens = (ctx: SeederContext): any[] => {
  const rows = new Map<string, any>();
  const add = (entityType: string, entity: any): void => {
    for (const row of buildEntitySearchTokenRows(entityType, entity)) {
      const key = `${row.token}\u0000${row.entityType}\u0000${row.entityId}`;
      const existing = rows.get(key);
      if (existing) {
        existing.baseWeight = Math.max(existing.baseWeight, row.baseWeight);
        existing.isSensitive = existing.isSensitive || row.isSensitive;
        continue;
      }
      rows.set(key, { ...row });
    }
  };

  const merchantsById = new Map(ctx.dataset.merchants.map((merchant) => [String(merchant.id), merchant]));
  const railsById = new Map(ctx.refs.rails.map((rail) => [String(rail.id), rail]));
  const attemptsById = new Map(ctx.dataset.paymentAttempts.map((attempt) => [String(attempt.id), attempt]));

  for (const gateway of ctx.refs.gateways) {
    add("gateway", { ...gateway, status: "ACTIVE", createdAt: ctx.timeline.start, updatedAt: ctx.timeline.start });
  }
  for (const rail of ctx.refs.rails) {
    add("rail", { ...rail, createdAt: ctx.timeline.start, updatedAt: ctx.timeline.start });
  }
  for (const route of ctx.refs.routes) {
    add("route", {
      ...route,
      gateway: { code: route.gatewayCode },
      rail: { code: route.railCode },
      createdAt: ctx.timeline.start,
      updatedAt: ctx.timeline.start,
    });
  }
  for (const merchant of ctx.dataset.merchants) add("merchant", merchant);
  for (const user of ctx.dataset.users) add("user", user);
  for (const joinRequest of ctx.dataset.joinRequests) {
    add("join_request", { ...joinRequest, merchant: merchantsById.get(String(joinRequest.merchantId)) });
  }
  for (const document of ctx.dataset.kybDocuments) {
    add("kyb_document", { ...document, merchant: merchantsById.get(String(document.merchantId)) });
  }
  for (const attempt of ctx.dataset.paymentAttempts) {
    add("payment_attempt", {
      ...attempt,
      merchant: merchantsById.get(String(attempt.merchantId)),
      rail: railsById.get(String(attempt.railId)),
    });
  }
  for (const dispute of ctx.dataset.disputes) {
    add("dispute", { ...dispute, attempt: attemptsById.get(String(dispute.attemptId)) });
  }
  for (const adjustment of ctx.dataset.adjustments) {
    add("adjustment", { ...adjustment, sourceAttempt: attemptsById.get(String(adjustment.sourceAttemptId)) });
  }
  for (const cashout of ctx.dataset.cashoutRequests) add("cashout", cashout);
  for (const screening of ctx.dataset.amlScreenings) add("aml_screening", screening);
  for (const amlCase of ctx.dataset.amlCases) add("aml_case", amlCase);
  for (const report of ctx.dataset.regulatoryReports) add("aml_report", report);
  for (const operatorCase of ctx.dataset.operatorCases) {
    add("operator_case", { ...operatorCase, attempt: attemptsById.get(String(operatorCase.attemptId)) });
  }
  for (const approval of ctx.dataset.approvalRequests) add("approval", approval);
  for (const auditLog of ctx.dataset.auditLogs) add("audit_log", auditLog);
  for (const run of ctx.dataset.reconciliationRuns) add("reconciliation_run", run);
  for (const rule of ctx.dataset.amlRules) add("aml_rule", rule);

  return [...rows.values()];
};

const updateGlAccountStates = async (prisma: PrismaClient, ctx: SeederContext): Promise<void> => {
  const datasetAccountIds = new Set(ctx.dataset.glAccounts.map((account) => String(account.id)));
  const entries = [...ctx.checkpoints.entries()].filter(([accountId]) => !datasetAccountIds.has(accountId));
  if (entries.length === 0) return;

  const states = new Map<string, { total: number; postDelta: number; postLines: number }>();
  for (const [accountId] of entries) states.set(accountId, { total: 0, postDelta: 0, postLines: 0 });
  for (const line of ctx.dataset.journalLines) {
    const accountId = String(line.glAccountId);
    const state = states.get(accountId);
    const checkpoint = ctx.checkpoints.get(accountId);
    if (!state || !checkpoint) continue;
    const at = dateOf(line.createdAt);
    const delta = line.direction === "DEBIT" ? Number(line.amount) : -Number(line.amount);
    state.total += delta;
    if (at.getTime() > checkpoint.at.getTime()) {
      state.postDelta += delta;
      state.postLines += 1;
    }
  }

  const execute = (prisma as unknown as { $executeRawUnsafe?: (sql: string, ...values: unknown[]) => Promise<unknown> }).$executeRawUnsafe;
  if (typeof execute !== "function") {
    throw new Error("bulkMysqlWriter requires $executeRawUnsafe for set-based GL account updates");
  }
  const chunkSize = 400;
  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    const chunk = entries.slice(offset, offset + chunkSize);
    const ids = chunk.map(([accountId]) => accountId);
    const checkpointBalanceCases = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const checkpointAtCases = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const lastCheckpointIdCases = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const currentBalanceCases = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const linesSinceCheckpointCases = chunk.map(() => "WHEN ? THEN ?").join(" ");
    const sql = `UPDATE \`gl_accounts\` SET `
      + `\`checkpoint_balance\` = CASE \`id\` ${checkpointBalanceCases} ELSE \`checkpoint_balance\` END, `
      + `\`checkpoint_at\` = CASE \`id\` ${checkpointAtCases} ELSE \`checkpoint_at\` END, `
      + `\`last_checkpoint_id\` = CASE \`id\` ${lastCheckpointIdCases} ELSE \`last_checkpoint_id\` END, `
      + `\`current_balance\` = CASE \`id\` ${currentBalanceCases} ELSE \`current_balance\` END, `
      + `\`lines_since_checkpoint\` = CASE \`id\` ${linesSinceCheckpointCases} ELSE \`lines_since_checkpoint\` END `
      + `WHERE \`id\` IN (${ids.map(() => "?").join(",")})`;
    const values: unknown[] = [];
    for (const [accountId, checkpoint] of chunk) values.push(accountId, checkpoint.balance);
    for (const [accountId, checkpoint] of chunk) values.push(accountId, checkpoint.at);
    for (const [accountId, checkpoint] of chunk) values.push(accountId, checkpoint.lastCheckpointId || null);
    for (const [accountId] of chunk) values.push(accountId, states.get(accountId)!.total.toFixed(4));
    for (const [accountId] of chunk) values.push(accountId, states.get(accountId)!.postLines);
    values.push(...ids);
    await execute.call(prisma, sql, ...values);
  }
};

export interface WriteReport {
  model: string;
  rows: number;
}

export const bulkMysqlWriter = async (
  prisma: PrismaClient,
  ctx: SeederContext,
): Promise<WriteReport[]> => {
  const report: WriteReport[] = [];
  for (const step of STEPS) {
    const source = ctx.dataset[step.key] as any[];
    if (!source || source.length === 0) continue;
    const rows = step.transform ? step.transform(source) : source;
    const written = await insertChunked(prisma, step.model, rows);
    report.push({ model: step.model, rows: written });
    if (process.env.SYNTHETIC_SEED_VERBOSE === "true") {
      console.log(`  ${step.model}: ${written}`);
    }
  }

  // Link the circular dispute <-> adjustment references now that both exist.
  await prisma.$executeRawUnsafe(
    `UPDATE disputes d
       INNER JOIN adjustments a ON a.dispute_id = d.id
       SET d.adjustment_id = a.id
       WHERE d.adjustment_id IS NULL`,
  );

  await updateGlAccountStates(prisma, ctx);

  const materialized: Array<[string, ModelName, string, string[], string[], any[]]> = [
    [
      "routeDailyVolume",
      "routeDailyVolume",
      "route_daily_volumes",
      ["route_id", "day_bucket", "succeeded_count", "total_charged_amount", "updated_at"],
      ["route_id", "day_bucket"],
      buildRouteDailyVolumes(ctx),
    ],
    [
      "merchantDailyStat",
      "merchantDailyStat",
      "merchant_daily_stats",
      [
        "merchant_id", "day_bucket", "rail_code", "initiated_count", "succeeded_count", "failed_count",
        "expired_count", "refunded_count", "disputed_count", "gross_succeeded_amount",
        "platform_commission_amount", "net_merchant_amount", "updated_at",
      ],
      ["merchant_id", "day_bucket", "rail_code"],
      buildMerchantDailyStats(ctx),
    ],
    [
      "velocityWindowBucket",
      "velocityWindowBucket",
      "velocity_window_buckets",
      ["scope_type", "scope_hash", "bucket_epoch", "attempt_count", "succeeded_count", "total_amount", "expires_at"],
      ["scope_type", "scope_hash", "bucket_epoch"],
      buildVelocityWindowBuckets(ctx),
    ],
    [
      "kybDocumentHashStat",
      "kybDocumentHashStat",
      "kyb_document_hash_stats",
      ["sha256", "doc_count", "merchant_count", "first_seen_at", "updated_at"],
      ["sha256"],
      buildKybDocumentHashStats(ctx),
    ],
    [
      "entitySearchToken",
      "entitySearchToken",
      "entity_search_tokens",
      [
        "token", "entity_type", "entity_id", "merchant_id", "is_sensitive", "base_weight",
        "title", "subtitle", "reference", "status", "operator_case_id", "entity_created_at",
      ],
      ["token", "entity_type", "entity_id"],
      buildEntitySearchTokens(ctx),
    ],
  ];

  for (const [model, modelName, table, columns, primaryKeys, rows] of materialized) {
    const written = await upsertChunked(prisma, modelName, table, columns, primaryKeys, rows);
    report.push({ model, rows: written });
    if (process.env.SYNTHETIC_SEED_VERBOSE === "true") {
      console.log(`  ${model}: ${written}`);
    }
  }

  return report;
};
