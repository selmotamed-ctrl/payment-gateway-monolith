import "dotenv/config";
import { client, ensureSchemaVersion } from "../client";
import { loadSeederConfig } from "./config";
import { createContext } from "./context";
import { assertSafeToSeedSyntheticData } from "./SeederSafetyGate";
import { generateAdminAndStaff } from "./generators/01_adminAndStaffGenerator";
import { generateMerchantCohort } from "./generators/02_merchantCohortGenerator";
import { generateGatewayLifecycle } from "./generators/03_gatewayLifecycleGenerator";
import { generateLinksAndAttempts } from "./generators/04_linksAndAttemptsGenerator";
import { generateLedgerAndCheckpoints } from "./generators/05_ledgerAndCheckpoints";
import { generateReconciliation } from "./generators/06_reconAndStatements";
import { generateDisputesCashoutsAdjustments } from "./generators/07_disputesCashoutsAdjustments";
import { generateAmlAndGovernanceQueues } from "./generators/08_amlAndGovernanceQueues";
import { generateOperatorCases } from "./generators/09_operatorCasesGenerator";
import { bulkMysqlWriter } from "./sync/bulkMysqlWriter";
import { fakeRailsBulkSync } from "./sync/fakeRailsBulkSyncClient";
import { enrichKybDocuments } from "./sync/enrichKybDocuments";
import { auditInMemory, postSeedAudit } from "./verify/postSeedAudit";
import { findCompletedSeedRun, recordCompletedSeedRun } from "./seedRunRegistry";

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
    ["ledger & checkpoints", () => generateLedgerAndCheckpoints(ctx)],
    ["reconciliation", () => generateReconciliation(ctx)],
    ["disputes, cashouts & adjustments", () => generateDisputesCashoutsAdjustments(ctx)],
    ["AML & governance queues", () => generateAmlAndGovernanceQueues(ctx)],
    ["operator cases & approvals", () => generateOperatorCases(ctx)],
  ];
  for (const [label, run] of phases) {
    const phaseStart = Date.now();
    run();
    console.log(`[synthetic-seeder] ${label}: ${Date.now() - phaseStart}ms`);
  }

  const preAudit = auditInMemory(ctx);
  if (!preAudit.ok) {
    console.error("[synthetic-seeder] operator-case audit:", JSON.stringify(preAudit.operatorCases, null, 2));
    throw new Error(
      `Synthetic ledger invariant failed before writing: drift=${preAudit.ledgerDrift} unbalanced=${preAudit.unbalancedEntries} ` +
        `succeededWithoutLedger=${preAudit.succeededWithoutLedger} slotViolations=${preAudit.slotViolations} ` +
        `operatorCaseViolations=${preAudit.operatorCaseViolations}`,
    );
  }
  console.log(`[synthetic-seeder] in-memory invariant OK (0.0000 LYD drift)`);

  const writeReport = await bulkMysqlWriter(client, ctx);
  console.log(`[synthetic-seeder] wrote ${writeReport.reduce((sum, row) => sum + row.rows, 0)} rows across ${writeReport.length} tables`);

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
        `operatorCaseViolations=${audit.operatorCaseViolations}`,
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
