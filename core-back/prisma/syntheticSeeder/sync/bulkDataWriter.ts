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

/**
 * Topological FK order. Notes:
 * - `approval_requests` only reference users, but join requests, gateway
 *   versions, commission profiles, reports, operator cases and audit rows
 *   reference approvals, so approvals come right after users;
 * - `aml_cases` reference screenings, AML rules and hold journal entries;
 * - `disputes.adjustment_id` is a plain column and `adjustments.dispute_id` is
 *   the FK, so disputes are inserted first and nothing needs relinking;
 * - `reconciliation_items.operator_case_id` is a plain column, the FK is on
 *   `operator_cases.reconciliation_item_id`, so items precede cases.
 */
const STEPS: Step[] = [
  { model: "merchant", key: "merchants" },
  { model: "user", key: "users" },
  { model: "userIdentity", key: "userIdentities" },
  { model: "approvalRequest", key: "approvalRequests" },
  { model: "amlScreening", key: "amlScreenings" },
  { model: "amlScreeningMatch", key: "amlScreeningMatches" },
  { model: "joinRequest", key: "joinRequests" },
  { model: "kybDocument", key: "kybDocuments" },
  { model: "beneficialOwner", key: "beneficialOwners" },
  { model: "glAccount", key: "glAccounts" },
  { model: "glAccountShard", key: "glAccountShards" },
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
  { model: "journalEntry", key: "journalEntries" },
  { model: "paymentAttempt", key: "paymentAttempts" },
  { model: "attemptStepLog", key: "attemptStepLogs" },
  { model: "inboundEvent", key: "inboundEvents" },
  { model: "journalLine", key: "journalLines" },
  { model: "reconciliationRun", key: "reconciliationRuns" },
  { model: "reconciliationItem", key: "reconciliationItems" },
  { model: "dispute", key: "disputes" },
  { model: "adjustment", key: "adjustments" },
  { model: "cashoutRequest", key: "cashoutRequests" },
  { model: "amlRule", key: "amlRules" },
  { model: "amlCase", key: "amlCases" },
  { model: "regulatoryReport", key: "regulatoryReports" },
  { model: "operatorCase", key: "operatorCases" },
  { model: "notificationTemplate", key: "notificationTemplates" },
  { model: "notification", key: "notifications" },
  { model: "auditLog", key: "auditLogs" },
  { model: "detailChangeLog", key: "detailChangeLogs" },
  { model: "velocityRule", key: "velocityRules" },
  { model: "reportingRule", key: "reportingRules" },
  { model: "platformSetting", key: "platformSettings" },
];

/** The ordered model names the writer inserts (exported for the tests). */
export const WRITE_ORDER: readonly string[] = STEPS.map((step) => step.model);

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

export const bulkDataWriter = async (
  prisma: PrismaClient,
  ctx: SeederContext,
): Promise<WriteReport[]> => {
  const report: WriteReport[] = [];
  for (const step of STEPS) {
    const source = ctx.dataset[step.key] as any[];
    if (!source || source.length === 0) continue;
    const rows = step.transform ? step.transform(source) : source;
    let written: number;
    if (step.model === "glAccountShard") {
      written = 0;
      for (const row of rows) {
        await prisma.glAccountShard.upsert({
          where: { glAccountId_shardId: { glAccountId: row.glAccountId, shardId: row.shardId } },
          update: { currentBalance: row.currentBalance, updatedAt: row.updatedAt },
          create: row,
        });
        written += 1;
      }
    } else {
      written = await insertChunked(prisma, step.model, rows);
    }
    report.push({ model: step.model, rows: written });
    if (process.env.SYNTHETIC_SEED_VERBOSE === "true") {
      console.log(`  ${step.model}: ${written}`);
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
      });
  }

  return report;
};
