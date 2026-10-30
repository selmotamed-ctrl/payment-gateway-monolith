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
  { model: "gatewayVersionEvidence", key: "gatewayVersionEvidence" },
  { model: "gatewayHealthSample", key: "gatewayHealthSamples" },
  { model: "statementSource", key: "statementSources" },
  { model: "paymentLink", key: "paymentLinks" },
  { model: "attemptGroup", key: "attemptGroups" },
  // Journal entries precede attempts because attempts carry ledgerEntryId.
  { model: "journalEntry", key: "journalEntries" },
  { model: "paymentAttempt", key: "paymentAttempts" },
  { model: "attemptStepLog", key: "attemptStepLogs" },
  { model: "journalLine", key: "journalLines" },
  { model: "reconciliationRun", key: "reconciliationRuns" },
  { model: "reconciliationItem", key: "reconciliationItems" },
  // The dispute <-> adjustment pair is circular; strip both sides, link later.
  { model: "dispute", key: "disputes", transform: (rows) => rows.map(({ adjustmentId, ...rest }) => ({ ...rest, adjustmentId: null })) },
  { model: "adjustment", key: "adjustments", transform: (rows) => rows.map(({ disputeId, ...rest }) => ({ ...rest, disputeId: null })) },
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

  // Apply the monthly GL checkpoints (including the already-seeded accounts).
  for (const [accountId, checkpoint] of ctx.checkpoints) {
    await prisma.glAccount
      .update({
        where: { id: accountId },
        data: {
          checkpointBalance: checkpoint.balance,
          checkpointAt: checkpoint.at,
          lastCheckpointId: checkpoint.lastCheckpointId,
        },
      })
      .catch(() => undefined);
  }

  return report;
};
