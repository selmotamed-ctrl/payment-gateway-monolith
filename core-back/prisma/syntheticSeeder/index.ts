import "dotenv/config";
import { client, ensureSchemaVersion } from "../client";
import { loadSeederConfig } from "./config";
import { createContext } from "./context";
import { assertSafeToSeedSyntheticData } from "./SeederSafetyGate";
import { generateAdminAndStaff } from "./generators/01_adminAndStaffGenerator";
import { generateMerchantCohort } from "./generators/02_merchantCohortGenerator";
import { generateGatewayLifecycle, generateRouteHealth } from "./generators/03_gatewayLifecycleGenerator";
import { generateLinksAndAttempts } from "./generators/04_linksAndAttemptsGenerator";
import { generateCheckpoints, generateLedger } from "./generators/05_ledgerAndCheckpoints";
import { generateReconciliation } from "./generators/06_reconAndStatements";
import { generateDisputesCashoutsAdjustments } from "./generators/07_disputesCashoutsAdjustments";
import { generateAmlAndGovernanceQueues } from "./generators/08_amlAndGovernanceQueues";
import { generateOperatorCases } from "./generators/09_operatorCasesGenerator";
import { bulkDataWriter } from "./sync/bulkDataWriter";
import { fakeRailsBulkSync } from "./sync/fakeRailsBulkSyncClient";
import { enrichKybDocuments } from "./sync/enrichKybDocuments";
import { encryptPendingSecrets } from "./sync/encryptSecrets";
import { writeReadModels } from "./sync/readModels";
import { auditInMemory, postSeedAudit } from "./verify/postSeedAudit";
import { findCompletedSeedRun, findOtherCompletedSeedRun, recordCompletedSeedRun } from "./seedRunRegistry";

/**
 * Multi-year synthetic operational data seeder.
 *
 *   SYNTHETIC_SEED_PROFILE=COMPACT bun run seed-synthetic-history
 *
 * It refuses to run on anything that is not an explicitly declared test server
 * whose gateways all point at Fake Rails (see SeederSafetyGate).
 */
export const runSyntheticSeeder = async (): Promise<void> => {
  const startedAt = Date.now();
  const config = loadSeederConfig();
  console.log(`[synthetic-seeder] profile=${config.profile} seed=${config.seedKey} span=${config.volumes.yearsSpan}y`);

  await ensureSchemaVersion();

  const completedRun = await findCompletedSeedRun(client, config.seedKey);
  if (completedRun) {
    console.log(
      `[synthetic-seeder] seed key '${config.seedKey}' was already seeded successfully at ${completedRun.completedAt}; skipping. ` +
        "Set SYNTHETIC_SEED_KEY to a new value to generate a fresh history.",
    );
    return;
  }

  const otherRun = await findOtherCompletedSeedRun(client, config.seedKey, config.namespace);
  if (otherRun) {
    console.log(
      `[synthetic-seeder] synthetic history already present under seed key '${otherRun.seedKey}' ` +
        `(profile ${otherRun.profile}, completed ${otherRun.completedAt}); skipping seed key '${config.seedKey}'. ` +
        `A second history cannot be layered on the first. Set SYNTHETIC_SEED_KEY='${otherRun.seedKey}' to keep it, ` +
        "or reset the database to generate a new one.",
    );
    return;
  }

  const health = await assertSafeToSeedSyntheticData(client);
  console.log(`[synthetic-seeder] Fake Rails handshake OK (${health.transactionCount ?? 0} existing transactions)`);

  const ctx = await createContext(client, config);
  if (ctx.refs.gateways.length === 0 || ctx.refs.rails.length === 0) {
    throw new Error("No seeded gateways/rails found. Run seedFakeRails.ts (and the blueprint seed) first.");
  }

  const phases: Array<[string, () => void]> = [
    ["admin & staff", () => generateAdminAndStaff(ctx)],
    ["merchants, KYB & owners", () => generateMerchantCohort(ctx)],
    ["gateway lifecycle & health", () => generateGatewayLifecycle(ctx)],
    ["links & attempts", () => generateLinksAndAttempts(ctx)],
    ["route health", () => generateRouteHealth(ctx)],
    ["ledger postings", () => generateLedger(ctx)],
    ["reconciliation & settlement sweeps", () => generateReconciliation(ctx)],
    ["refunds, disputes, cashouts & adjustments", () => generateDisputesCashoutsAdjustments(ctx)],
    ["AML & governance queues", () => generateAmlAndGovernanceQueues(ctx)],
    ["operator cases & approvals", () => generateOperatorCases(ctx)],
    // Checkpoints and shard balances come LAST: every posting is final.
    ["GL checkpoints & shards", () => generateCheckpoints(ctx)],
  ];
  for (const [label, run] of phases) {
    const phaseStart = Date.now();
    run();
    console.log(`[synthetic-seeder] ${label}: ${Date.now() - phaseStart}ms`);
  }

  const preAudit = auditInMemory(ctx);
  if (!preAudit.ok) {
    console.error("[synthetic-seeder] operator-case audit:", JSON.stringify(preAudit.operatorCases, null, 2));
    console.error("[synthetic-seeder] invariant violations:", JSON.stringify(preAudit.invariants.byRule), preAudit.invariants.samples.slice(0, 20));
    throw new Error(
      `Synthetic ledger invariant failed before writing: drift=${preAudit.ledgerDrift} unbalanced=${preAudit.unbalancedEntries} ` +
        `succeededWithoutLedger=${preAudit.succeededWithoutLedger} slotViolations=${preAudit.slotViolations} ` +
        `operatorCaseViolations=${preAudit.operatorCaseViolations} invariantViolations=${preAudit.invariants.total}`,
    );
  }
  console.log(`[synthetic-seeder] in-memory invariants OK (0.0000 LYD drift, ${JSON.stringify(preAudit.invariants.metrics)})`);

  const secrets = await encryptPendingSecrets(ctx);
  console.log(`[synthetic-seeder] encrypted ${secrets} sensitive columns with the Vault`);

  const writeReport = await bulkDataWriter(client, ctx);
  console.log(`[synthetic-seeder] wrote ${writeReport.reduce((sum, row) => sum + row.rows, 0)} rows across ${writeReport.length} tables`);

  const readModels = await writeReadModels(client, ctx);
  console.log(`[synthetic-seeder] projected ${readModels.merchantDays} merchant-day and ${readModels.routeDays} route-day read-model rows`);

  const kyb = await enrichKybDocuments(client);
  console.log(
    `[synthetic-seeder] KYB enrichment: ${kyb.documents} document payloads, ${kyb.ownerDocuments} owner documents, ` +
      `${kyb.revalidations} re-verification requests, ${kyb.merchantsScheduled} review dates`,
  );

  const synced = await fakeRailsBulkSync(ctx);
  console.log(`[synthetic-seeder] synced ${synced.transactions} transactions and ${synced.events} events to Fake Rails`);

  const audit = await postSeedAudit(client, ctx);
  if (!audit.ok) {
    throw new Error(
      `Post-seed audit failed: drift=${audit.ledgerDrift} unbalanced=${audit.unbalancedEntries} ` +
        `succeededWithoutLedger=${audit.succeededWithoutLedger} slotViolations=${audit.slotViolations} ` +
        `operatorCaseViolations=${audit.operatorCaseViolations} invariantViolations=${audit.invariants.total} databaseViolations=${audit.databaseViolations} ${JSON.stringify(audit.invariants.samples.slice(0, 10))}`,
    );
  }
  await recordCompletedSeedRun(client, config, {
    attempts: audit.attempts,
    journalLines: audit.counts.journalLines,
    ledgerDrift: audit.ledgerDrift,
  });
  console.log(
    `[synthetic-seeder] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ` +
      `${audit.attempts} attempts · ${audit.counts.journalLines} journal lines · drift ${audit.ledgerDrift} LYD`,
  );
};

if (import.meta.main) {
  runSyntheticSeeder()
    .then(async () => {
      await client.$disconnect();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      console.error(error);
      await client.$disconnect();
      process.exit(1);
    });
}
