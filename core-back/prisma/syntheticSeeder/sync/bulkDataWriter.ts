import type { PrismaClient } from "../../../generated/prisma/client";
import type { SeederContext, ShardCheckpointSnapshot } from "../context";

/**
 * Topological FK-ordered, chunked `createMany` writer.
 *
 * Shard rows and per-shard checkpoints are upserted (the DB trigger creates the shard rows with the account).
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

/**
 * Shard rows: the DB trigger `gl_accounts_create_shards` has ALREADY created shard rows 0..shard_count-1 for
 * every account inserted above (and baseline accounts have theirs), so a plain insert would collide. Each chunk
 * is one `INSERT ... ON CONFLICT DO UPDATE` over `unnest` arrays: it fills balance + `line_seq` on the existing
 * rows and still inserts a row the trigger did not create.
 */
const upsertShards = async (prisma: PrismaClient, rows: any[]): Promise<number> => {
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const chunk = rows.slice(offset, offset + CHUNK);
    written += await prisma.$executeRawUnsafe(
      `INSERT INTO "gl_account_shards" ("gl_account_id", "shard_id", "current_balance", "line_seq", "updated_at")
       SELECT t.gl_account_id::uuid, t.shard_id::smallint, t.current_balance::numeric(18,4), t.line_seq::bigint, t.updated_at::timestamptz
       FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[]) AS t(gl_account_id, shard_id, current_balance, line_seq, updated_at)
       ON CONFLICT ("gl_account_id", "shard_id") DO UPDATE
         SET "current_balance" = EXCLUDED."current_balance", "line_seq" = EXCLUDED."line_seq", "updated_at" = EXCLUDED."updated_at"`,
      chunk.map((row) => String(row.glAccountId)),
      chunk.map((row) => Number(row.shardId)),
      chunk.map((row) => String(row.currentBalance)),
      chunk.map((row) => String(row.lineSeq)),
      chunk.map((row) => (row.updatedAt as Date).toISOString()),
    );
  }
  return written;
};

const upsertShardCheckpoints = async (prisma: PrismaClient, rows: ShardCheckpointSnapshot[]): Promise<number> => {
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const chunk = rows.slice(offset, offset + CHUNK);
    written += await prisma.$executeRawUnsafe(
      `INSERT INTO "gl_shard_checkpoints" ("gl_account_id", "shard_id", "checkpoint_balance", "checkpoint_seq", "checkpoint_at", "verified_at", "status")
       SELECT t.gl_account_id::uuid, t.shard_id::smallint, t.balance::numeric(18,4), t.seq::bigint, t.at::timestamptz, t.at::timestamptz, 'OK'
       FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[]) AS t(gl_account_id, shard_id, balance, seq, at)
       ON CONFLICT ("gl_account_id", "shard_id") DO UPDATE
         SET "checkpoint_balance" = EXCLUDED."checkpoint_balance", "checkpoint_seq" = EXCLUDED."checkpoint_seq",
             "checkpoint_at" = EXCLUDED."checkpoint_at", "verified_at" = EXCLUDED."verified_at", "status" = 'OK',
             "failure_kind" = NULL, "consecutive_failures" = 0, "last_failure_at" = NULL`,
      chunk.map((row) => row.glAccountId),
      chunk.map((row) => row.shardId),
      chunk.map((row) => row.balance),
      chunk.map((row) => String(row.seq)),
      chunk.map((row) => row.at.toISOString()),
    );
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
    const written = step.model === "glAccountShard"
      ? await upsertShards(prisma, rows)
      : await insertChunked(prisma, step.model, rows);
    report.push({ model: step.model, rows: written });
    if (process.env.SYNTHETIC_SEED_VERBOSE === "true") {
      console.log(`  ${step.model}: ${written}`);
    }
  }

  // The per-shard month-end checkpoints reference the shard rows, so they come after them.
  const checkpointRows = await upsertShardCheckpoints(prisma, [...ctx.checkpoints.values()]);
  report.push({ model: "glShardCheckpoint", rows: checkpointRows });
  if (process.env.SYNTHETIC_SEED_VERBOSE === "true") {
    console.log(`  glShardCheckpoint: ${checkpointRows}`);
  }

  return report;
};
