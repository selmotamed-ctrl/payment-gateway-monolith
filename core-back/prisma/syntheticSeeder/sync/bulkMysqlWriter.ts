import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../generated/prisma/client";
import type { SeederContext } from "../context";

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

/** Deterministic 60-bit BIGINT for append-only seeded rows. */
const stableBigInt = (value: unknown): bigint => {
  const digest = createHash("sha256").update(String(value)).digest("hex").slice(0, 15);
  return BigInt(`0x${digest}`) || 1n;
};

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
  { model: "journalEntry", key: "journalEntries", transform: (rows) => rows.map(({ updatedAt: _updatedAt, ...rest }) => rest) },
  { model: "paymentAttempt", key: "paymentAttempts" },
  { model: "attemptStepLog", key: "attemptStepLogs", transform: (rows) => rows.map(({ id, updatedAt: _updatedAt, ...rest }) => ({ ...rest, id: stableBigInt(id) })) },
  { model: "inboundEvent", key: "inboundEvents", transform: (rows) => rows.map(({ rawBodyBytes: _raw, redactedHeadersJson: _headers, updatedAt: _updatedAt, ...rest }) => ({ ...rest, id: stableBigInt(rest.id) })) },
  { model: "inboundEventPayload", key: "inboundEvents", transform: (rows) => rows.map((row) => ({ eventId: stableBigInt(row.id), rawBodyBytes: row.rawBodyBytes, redactedHeadersJson: row.redactedHeadersJson })) },
  { model: "journalLine", key: "journalLines", transform: (rows) => rows.map(({ id: _id, updatedAt: _updatedAt, ...rest }) => rest) },
  { model: "reconciliationRun", key: "reconciliationRuns", transform: (rows) => rows.map(({ fileContent: _fileContent, ...rest }) => rest) },
  { model: "reconciliationRunFile", key: "reconciliationRuns", transform: (rows) => rows.map((row) => ({ runId: row.id, fileContent: row.fileContent })) },
  { model: "reconciliationItem", key: "reconciliationItems" },
  // The dispute <-> adjustment pair is circular; strip both sides, link later.
  { model: "dispute", key: "disputes", transform: (rows) => rows.map(({ adjustmentId: _adjustmentId, ...rest }) => ({ ...rest, adjustmentId: null })) },
  { model: "adjustment", key: "adjustments", transform: (rows) => rows.map(({ disputeId: _disputeId, ...rest }) => ({ ...rest, disputeId: null })) },
  { model: "cashoutRequest", key: "cashoutRequests" },
  { model: "amlScreening", key: "amlScreenings" },
  { model: "amlScreeningMatch", key: "amlScreeningMatches" },
  { model: "amlCase", key: "amlCases" },
  { model: "regulatoryReport", key: "regulatoryReports" },
  { model: "approvalRequest", key: "approvalRequests" },
  { model: "operatorCase", key: "operatorCases" },
  { model: "notificationTemplate", key: "notificationTemplates" },
  { model: "notification", key: "notifications" },
  { model: "auditLog", key: "auditLogs", transform: (rows) => rows.map(({ beforeJson: _before, afterJson: _after, updatedAt: _updatedAt, ...rest }) => ({ ...rest, id: stableBigInt(rest.id), actorEmail: rest.actorEmail ?? "" })) },
  { model: "auditLogPayload", key: "auditLogs", transform: (rows) => rows.map((row) => ({ auditLogId: stableBigInt(row.id), beforeJson: row.beforeJson ?? {}, afterJson: row.afterJson ?? {} })) },
  { model: "detailChangeLog", key: "detailChangeLogs" },
  { model: "velocityRule", key: "velocityRules" },
  { model: "amlRule", key: "amlRules" },
  { model: "reportingRule", key: "reportingRules" },
  { model: "platformSetting", key: "platformSettings" },
];

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
  for (const dispute of ctx.dataset.disputes) {
    if (dispute.adjustmentId) {
      await prisma.dispute.update({ where: { id: dispute.id }, data: { adjustmentId: dispute.adjustmentId } }).catch(() => undefined);
    }
  }
  for (const adjustment of ctx.dataset.adjustments) {
    if (adjustment.disputeId) {
      await prisma.adjustment.update({ where: { id: adjustment.id }, data: { disputeId: adjustment.disputeId } }).catch(() => undefined);
    }
  }

  // Rebuild materialized GL balances from the seeded journal lines. SYNC
  // accounts get an exact current_balance; SHARDED accounts get one shard row
  // (the seeder is not a throughput benchmark for the live shard fan-out).
  await prisma.$executeRawUnsafe(
    `UPDATE gl_accounts g
     LEFT JOIN (
       SELECT gl_account_id,
              SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) AS balance,
              COUNT(*) AS line_count
         FROM journal_lines
        GROUP BY gl_account_id
     ) l ON l.gl_account_id = g.id
     SET g.current_balance = CASE WHEN g.balance_mode = 'SYNC' THEN COALESCE(l.balance, 0) ELSE 0 END`,
  );
  await prisma.$executeRawUnsafe("DELETE FROM gl_balance_shards");
  await prisma.$executeRawUnsafe(
    `INSERT INTO gl_balance_shards (gl_account_id, shard_no, balance, line_count)
     SELECT g.id, 0, COALESCE(l.balance, 0), COALESCE(l.line_count, 0)
       FROM gl_accounts g
       LEFT JOIN (
         SELECT gl_account_id,
                SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) AS balance,
                COUNT(*) AS line_count
           FROM journal_lines
          GROUP BY gl_account_id
       ) l ON l.gl_account_id = g.id
      WHERE g.balance_mode = 'SHARDED'`,
  );

  return report;
};
