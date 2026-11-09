/**
 * AUTO-23 reconciliation follow-up against live PostgreSQL: one keyed case per exception item (linked both ways), a
 * dispute intake job for a matched chargeback row, statement evidence on an UNKNOWN attempt's case, the overflow summary,
 * and idempotency across a retried job.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaRepositories } from "../../engine/db/repositories";
import { runReconciliationFollowUp } from "../../engine/workers/ReconciliationFollowUp";
import { cleanupAutomationCatalog, createAutomationCatalog, type AutomationCatalog } from "../helpers/automationCatalog";
import { createPrisma, databaseIsReachable } from "../storage-engine/helpers/db";

const client = createPrisma({ max: 10 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const catalogs: AutomationCatalog[] = [];
const created = { runs: [] as string[], sources: [] as string[], jobs: [] as string[] };

afterAll(async () => {
  if (databaseIsReachable) {
    const runs = created.runs;
    await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE reconciliation_item_id IN (SELECT id FROM reconciliation_items WHERE run_id = ANY($1::uuid[])) OR subject_key LIKE ANY($2::text[])`, runs, runs.map((id) => `recon.overflow:${id}`));
    await client.$executeRawUnsafe(`DELETE FROM reconciliation_items WHERE run_id = ANY($1::uuid[])`, runs);
    await client.$executeRawUnsafe(`DELETE FROM reconciliation_runs WHERE id = ANY($1::uuid[])`, runs);
    await client.$executeRawUnsafe(`DELETE FROM statement_sources WHERE id = ANY($1::uuid[])`, created.sources);
    await client.$executeRawUnsafe(`DELETE FROM background_jobs WHERE reference_type = 'DISPUTE' AND reference_id LIKE ANY($1::text[])`, catalogs.map((entry) => `${entry.gatewayId}:%`));
    await cleanupAutomationCatalog(client, catalogs);
  }
  await client.$disconnect();
});

const fixture = async () => {
  const catalog = await createAutomationCatalog(client, { label: "recon" });
  catalogs.push(catalog);
  const source = await client.statementSource.create({
    data: { gatewayId: catalog.gatewayId, type: "UPLOAD", parserConfig: {}, settlementLagDays: 0 },
  });
  created.sources.push(source.id);
  const run = await client.reconciliationRun.create({
    data: { statementSourceId: source.id, windowStart: new Date(Date.now() - 86_400_000), windowEnd: new Date(), fileHash: randomUUID().replace(/-/g, "").padEnd(64, "0"), statsJson: {}, ingestedAt: new Date() },
  });
  created.runs.push(run.id);
  const item = (input: { result: string; attemptId?: string | null; rowType?: string | null; amount?: string; providerReference?: string; ourReference?: string }) =>
    client.reconciliationItem.create({
      data: {
        runId: run.id,
        attemptId: input.attemptId ?? null,
        ourReference: input.ourReference ?? `OUR-${randomUUID().slice(0, 6)}`,
        providerReference: input.providerReference ?? `PRV-${randomUUID().slice(0, 6)}`,
        statementAmount: input.amount ?? "100.0000",
        statementFee: "1.0000",
        result: input.result as never,
        ...(input.rowType !== undefined ? { rowType: input.rowType } : {}),
      },
    });
  const followUp = (maxCases?: number) =>
    runReconciliationFollowUp({ db: client as never, repositories: new PrismaRepositories(client as never), maxCases }, { id: run.id, statementSourceId: source.id });
  return { catalog, source, run, item, followUp };
};

describeDb("reconciliation exception cases", () => {
  test("every exception item gets ONE linked case of the right kind and priority; matched and duplicate items get none", async () => {
    const { catalog, run, item, followUp } = await fixture();
    const attempt = await catalog.newAttempt();
    const mismatch = await item({ result: "AMOUNT_MISMATCH", attemptId: attempt.id });
    const unmatched = await item({ result: "MISSING_AT_GATEWAY" });
    const missingLocally = await item({ result: "MISSING_LOCALLY", attemptId: attempt.id });
    const matched = await item({ result: "MATCHED", attemptId: attempt.id });
    const duplicate = await item({ result: "DUPLICATE" });

    const first = await followUp();
    expect(first).toMatchObject({ cases: 3, overflow: 0, disputesQueued: 0, unknownEvidence: 0 });
    const caseOf = (id: string) => client.operatorCase.findUnique({ where: { reconciliationItemId: id } });
    expect(await caseOf(mismatch.id)).toMatchObject({ kind: "MISMATCH", priority: "P2", state: "OPEN", subjectKey: `recon.item:${mismatch.id}` });
    expect(await caseOf(unmatched.id)).toMatchObject({ kind: "UNMATCHED_STATEMENT", priority: "P2" });
    expect(await caseOf(missingLocally.id)).toMatchObject({ kind: "MISMATCH", priority: "P3" });
    expect(await caseOf(matched.id)).toBeNull();
    expect(await caseOf(duplicate.id)).toBeNull();
    // linked the other way too
    const linked = await client.reconciliationItem.findUniqueOrThrow({ where: { id: mismatch.id } });
    expect(linked.operatorCaseId).toBe((await caseOf(mismatch.id))!.id);
    expect((await caseOf(mismatch.id))!.resolutionNotes).toContain(`run ${run.id}`);

    // a retried job opens nothing again
    expect(await followUp()).toMatchObject({ cases: 0, disputesQueued: 0 });
    expect(await client.operatorCase.count({ where: { subjectKey: { startsWith: "recon.item:" }, reconciliationItemId: { in: [mismatch.id, unmatched.id, missingLocally.id] } } })).toBe(3);
  });

  test("more exceptions than the cap open the first ones and ONE overflow summary", async () => {
    const { run, item, followUp } = await fixture();
    for (let index = 0; index < 5; index += 1) await item({ result: "MISSING_AT_GATEWAY" });
    const result = await followUp(2);
    expect(result).toMatchObject({ cases: 2, overflow: 3 });
    expect(await client.operatorCase.count({ where: { subjectKey: `recon.overflow:${run.id}` } })).toBe(1);
    await followUp(2);
    expect(await client.operatorCase.count({ where: { subjectKey: `recon.overflow:${run.id}` } })).toBe(1);
  });
});

describeDb("chargeback rows and UNKNOWN evidence", () => {
  test("a matched chargeback row queues the dispute intake job once; unmatched, duplicate and already-open ones do not", async () => {
    const { catalog, source, item, followUp } = await fixture();
    const attempt = await catalog.newAttempt({ settlementTarget: "PLATFORM_CLEARING" });
    await item({ result: "MATCHED", attemptId: attempt.id, rowType: "CHARGEBACK", amount: "40.0000", providerReference: "CB-1001" });
    await item({ result: "MISSING_AT_GATEWAY", rowType: "CHARGEBACK", providerReference: "CB-NOATTEMPT" }); // no attempt: cannot become a dispute
    await item({ result: "DUPLICATE", attemptId: attempt.id, rowType: "CHARGEBACK", providerReference: "CB-DUP" });
    const second = await catalog.newAttempt({ settlementTarget: "PLATFORM_CLEARING" });
    await item({ result: "MATCHED", attemptId: second.id, rowType: "CHARGEBACK", providerReference: "CB-EXISTS" });
    await client.dispute.create({
      data: { attemptId: second.id, gatewayId: catalog.gatewayId, railId: catalog.railId, externalDisputeRef: "CB-EXISTS", source: "WEBHOOK", amount: "10.0000", currency: "LYD", status: "OPENED", openedAt: new Date() },
    });

    const result = await followUp();
    expect(result.disputesQueued).toBe(1);
    const jobs = await client.backgroundJob.findMany({ where: { referenceType: "DISPUTE", referenceId: `${source.gatewayId}:CB-1001` } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobType: "ADJUSTMENT_EXECUTION", state: "QUEUED" });
    expect(jobs[0]!.payloadJson).toMatchObject({ kind: "DISPUTE_INTAKE", attemptId: attempt.id, gatewayId: source.gatewayId, railId: catalog.railId, externalDisputeRef: "CB-1001", source: "STATEMENT", amount: "40.0000" });
    expect(await client.backgroundJob.count({ where: { referenceType: "DISPUTE", referenceId: { in: [`${source.gatewayId}:CB-NOATTEMPT`, `${source.gatewayId}:CB-DUP`, `${source.gatewayId}:CB-EXISTS`] } } })).toBe(0);
    expect((await followUp()).disputesQueued).toBe(0); // the live job is not queued twice
    // the case of the matched row's kind: no exception case for a MATCHED chargeback
    expect(await client.operatorCase.count({ where: { attemptId: attempt.id, subjectKey: { startsWith: "recon.item:" } } })).toBe(0);
  });

  test("a statement line that proves an UNKNOWN attempt was paid is attached to its UNKNOWN case; the attempt is not finalised", async () => {
    const { catalog, item, followUp } = await fixture();
    const unknown = await catalog.newAttempt({ status: "UNKNOWN", settlementTarget: "PLATFORM_CLEARING" });
    const succeeded = await catalog.newAttempt({ status: "SUCCEEDED", settlementTarget: "PLATFORM_CLEARING" });
    await item({ result: "MATCHED", attemptId: unknown.id, rowType: "SETTLEMENT", providerReference: "PRV-PROOF" });
    await item({ result: "MATCHED", attemptId: succeeded.id, rowType: "SETTLEMENT" });
    // the PollWorker already opened the UNKNOWN case (AUTO-19)
    const existing = await client.operatorCase.create({
      data: { kind: "UNKNOWN", priority: "P1", state: "OPEN", subjectKey: `attempt.unknown:${unknown.id}`, attemptId: unknown.id, slaDueAt: new Date(Date.now() + 3_600_000), resolutionNotes: "polling window elapsed" },
    });

    const result = await followUp();
    expect(result.unknownEvidence).toBe(1);
    const cases = await client.operatorCase.findMany({ where: { attemptId: unknown.id, kind: "UNKNOWN" } });
    expect(cases).toHaveLength(1); // the same case, not a second one
    expect(cases[0]!.id).toBe(existing.id);
    expect(cases[0]!.resolutionNotes).toContain("polling window elapsed");
    expect(cases[0]!.resolutionNotes).toContain("[STATEMENT EVIDENCE run");
    expect(cases[0]!.resolutionNotes).toContain("PRV-PROOF");
    expect((await client.paymentAttempt.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe("UNKNOWN"); // never finalised here
    expect(await client.operatorCase.count({ where: { attemptId: succeeded.id, kind: "UNKNOWN" } })).toBe(0);
    // idempotent: the evidence line is not appended twice
    await followUp();
    expect(((await client.operatorCase.findUniqueOrThrow({ where: { id: existing.id } })).resolutionNotes!.match(/\[STATEMENT EVIDENCE run/g) ?? []).length).toBe(1);
  });

  test("with no UNKNOWN case yet, the evidence opens one", async () => {
    const { catalog, item, followUp } = await fixture();
    const unknown = await catalog.newAttempt({ status: "UNKNOWN", settlementTarget: "PLATFORM_CLEARING" });
    await item({ result: "MATCHED", attemptId: unknown.id, rowType: null });
    await followUp();
    const kase = await client.operatorCase.findFirstOrThrow({ where: { attemptId: unknown.id, kind: "UNKNOWN" } });
    expect(kase).toMatchObject({ priority: "P1", state: "OPEN", subjectKey: `attempt.unknown:${unknown.id}` });
  });
});
