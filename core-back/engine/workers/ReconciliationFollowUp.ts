import { Decimal } from "decimal.js";
import type { BackgroundJobRow, PrismaLike, ReconciliationItemRow, Repositories, Tx } from "../db/ports";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { openKeyedOperatorCase, type KeyedOperatorCaseInput } from "./automationCases";

type Any = Record<string, any>;

/**
 * Follow-up of a reconciliation run (AUTO-23): what a person has to look at after the statement was matched.
 *
 *  - ONE keyed operator case per exception item: `AMOUNT_MISMATCH` (kind MISMATCH, P2), `MISSING_AT_GATEWAY` (a statement
 *    line we have no attempt for: kind UNMATCHED_STATEMENT, P2), `MISSING_LOCALLY` (we have an attempt the statement does
 *    not list: kind MISMATCH, P3). The case is linked to the item (`operator_cases.reconciliation_item_id` and
 *    `reconciliation_items.operator_case_id`), keyed `recon.item:<itemId>`, so a retried job never opens a second one.
 *    A run with more exceptions than `maxCases` opens the first `maxCases` and ONE summary case `recon.overflow:<runId>`.
 *  - A statement CHARGEBACK row that matched one of our attempts opens a dispute through the existing dispute intake job
 *    (`DISPUTE_INTAKE`, source STATEMENT): the dispute, the drafted chargeback adjustment and its finance approval are the
 *    same as for a webhook. The intake is idempotent on (gateway, external reference).
 *  - A statement line that proves an UNKNOWN attempt was settled is attached as evidence to the attempt's UNKNOWN case
 *    (`attempt.unknown:<id>`, opened here when it does not exist yet). The attempt is NOT finalised here: moving money
 *    for an unresolved payment stays the operator's decision through the existing UNKNOWN resolution.
 */

export const RECON_ITEM_SUBJECT_KEY = (itemId: string): string => `recon.item:${itemId}`;
export const RECON_OVERFLOW_SUBJECT_KEY = (runId: string): string => `recon.overflow:${runId}`;
export const UNKNOWN_ATTEMPT_SUBJECT_KEY = (attemptId: string): string => `attempt.unknown:${attemptId}`;

export interface ReconciliationFollowUpDeps {
  db: PrismaLike;
  repositories: Repositories;
  clock?: () => Date;
  /** Most exception cases one run opens (the rest is summarised). Default 500. */
  maxCases?: number;
  logger?: { info: (message: string, meta?: Record<string, unknown>) => void };
}

export interface ReconciliationFollowUpResult {
  cases: number;
  overflow: number;
  disputesQueued: number;
  unknownEvidence: number;
}

const EXCEPTION_RESULTS = new Set(["AMOUNT_MISMATCH", "MISSING_AT_GATEWAY", "MISSING_LOCALLY"]);

const exceptionCase = (
  item: ReconciliationItemRow,
  runId: string,
): Pick<KeyedOperatorCaseInput, "kind" | "priority" | "slaHours" | "notes"> => {
  const refs = `our reference '${item.ourReference ?? ""}', provider reference '${item.providerReference ?? ""}'`;
  const amount = new Decimal(String(item.statementAmount ?? 0)).toFixed(4);
  if (item.result === "AMOUNT_MISMATCH") {
    return {
      kind: "MISMATCH",
      priority: "P2",
      slaHours: 24,
      notes: `Reconciliation run ${runId}: the statement amount ${amount} differs from what we expected for the attempt (${refs}). Find out which side is wrong.`,
    };
  }
  if (item.result === "MISSING_AT_GATEWAY") {
    return {
      kind: "UNMATCHED_STATEMENT",
      priority: "P2",
      slaHours: 24,
      notes: `Reconciliation run ${runId}: the statement lists a payment of ${amount} that matches none of our attempts (${refs}). Identify it or raise it with the provider.`,
    };
  }
  return {
    kind: "MISMATCH",
    priority: "P3",
    slaHours: 72,
    notes: `Reconciliation run ${runId}: our attempt (${refs}) is not on the statement of the period. Check whether the provider settled it.`,
  };
};

export const runReconciliationFollowUp = async (
  deps: ReconciliationFollowUpDeps,
  run: { id: string; statementSourceId: string },
): Promise<ReconciliationFollowUpResult> => {
  const now = (deps.clock ?? (() => new Date()))();
  const maxCases = Math.max(1, Math.floor(deps.maxCases ?? 500));
  const items = await deps.repositories.reconciliation.listItemsByRun(deps.db as Tx, run.id);
  const db = deps.db as Any;
  const result: ReconciliationFollowUpResult = { cases: 0, overflow: 0, disputesQueued: 0, unknownEvidence: 0 };
  if (items.length === 0) return result;

  const attemptIds = [...new Set(items.map((item) => item.attemptId).filter((id): id is string => Boolean(id)))];
  const attempts = new Map<string, { status: string; railId: string | null; merchantId: string | null }>();
  if (attemptIds.length > 0) {
    for (const row of toCamelRows<Any>(
      await db.$queryRawUnsafe(
        "SELECT id::text AS id, status::text AS status, rail_id::text AS rail_id, merchant_id::text AS merchant_id FROM payment_attempts WHERE id = ANY($1::uuid[])",
        attemptIds,
      ),
    )) {
      attempts.set(String(row.id), { status: String(row.status), railId: row.railId ? String(row.railId) : null, merchantId: row.merchantId ? String(row.merchantId) : null });
    }
  }

  // ---- exception cases ----------------------------------------------------------------------------------------
  const exceptions = items.filter((item) => EXCEPTION_RESULTS.has(item.result));
  for (const item of exceptions.slice(0, maxCases)) {
    const description = exceptionCase(item, run.id);
    const opened = await openKeyedOperatorCase(db as never, {
      ...description,
      subjectKey: RECON_ITEM_SUBJECT_KEY(item.id),
      attemptId: item.attemptId,
      reconciliationItemId: item.id,
      now,
    });
    if (opened.created && opened.id) {
      result.cases += 1;
      await db.$executeRawUnsafe("UPDATE reconciliation_items SET operator_case_id = $1 WHERE id = $2::uuid AND operator_case_id IS NULL", opened.id, item.id);
    }
  }
  if (exceptions.length > maxCases) {
    result.overflow = exceptions.length - maxCases;
    await openKeyedOperatorCase(db as never, {
      kind: "MISMATCH",
      priority: "P2",
      subjectKey: RECON_OVERFLOW_SUBJECT_KEY(run.id),
      slaHours: 24,
      now,
      notes: `Reconciliation run ${run.id} has ${exceptions.length} exceptions; cases were opened for the first ${maxCases}. Review the remaining ${result.overflow} in the run's report.`,
    });
  }

  // ---- chargeback rows -> disputes (the existing intake job) -----------------------------------------------------
  const source = await deps.repositories.reconciliation.findStatementSourceById(deps.db as Tx, run.statementSourceId);
  if (source) {
    for (const item of items) {
      if (item.result === "DUPLICATE" || String(item.rowType ?? "").toUpperCase() !== "CHARGEBACK" || !item.attemptId) continue;
      const attempt = attempts.get(item.attemptId);
      const externalDisputeRef = String(item.providerReference || item.ourReference || "").trim();
      if (!attempt?.railId || !externalDisputeRef) continue;
      const amount = new Decimal(String(item.statementAmount ?? 0)).abs();
      if (!amount.gt(0)) continue;
      const referenceId = `${source.gatewayId}:${externalDisputeRef}`;
      const live = await deps.repositories.jobs.findLiveJobForReference(deps.db as Tx, "ADJUSTMENT_EXECUTION", "DISPUTE", referenceId);
      const existing = await db.dispute.findFirst({ where: { gatewayId: String(source.gatewayId), externalDisputeRef }, select: { id: true } });
      if (live || existing) continue;
      await deps.repositories.jobs.enqueueJob(deps.db as Tx, {
        jobType: "ADJUSTMENT_EXECUTION",
        referenceType: "DISPUTE",
        referenceId,
        payload: {
          kind: "DISPUTE_INTAKE",
          attemptId: item.attemptId,
          gatewayId: String(source.gatewayId),
          railId: attempt.railId,
          externalDisputeRef,
          source: "STATEMENT",
          reasonCode: "STATEMENT_CHARGEBACK",
          amount: amount.toFixed(4),
          currency: "LYD",
          actorUserId: null,
          actorRole: null,
        },
      } as never);
      result.disputesQueued += 1;
    }
  }

  // ---- statement evidence for an UNKNOWN attempt -----------------------------------------------------------------
  for (const item of items) {
    if (!item.attemptId || (item.result !== "MATCHED" && item.result !== "AMOUNT_MISMATCH")) continue;
    const rowType = String(item.rowType ?? "SETTLEMENT").toUpperCase();
    if (rowType !== "SETTLEMENT") continue;
    const attempt = attempts.get(item.attemptId);
    if (attempt?.status !== "UNKNOWN") continue;
    const evidence = `[STATEMENT EVIDENCE run ${run.id}] the statement lists this payment (${new Decimal(String(item.statementAmount ?? 0)).toFixed(4)}, provider reference '${item.providerReference ?? ""}'${item.result === "AMOUNT_MISMATCH" ? ", amount differs from ours" : ""}). It was settled at the provider: finalise the attempt.`;
    const opened = await openKeyedOperatorCase(db as never, {
      kind: "UNKNOWN",
      priority: "P1",
      subjectKey: UNKNOWN_ATTEMPT_SUBJECT_KEY(item.attemptId),
      attemptId: item.attemptId,
      dedupeOnAttempt: true,
      slaHours: 24,
      now,
      notes: evidence,
    });
    if (!opened.created && opened.id) {
      const current = await db.operatorCase.findUnique({ where: { id: opened.id }, select: { resolutionNotes: true } });
      const notes = String(current?.resolutionNotes ?? "");
      if (!notes.includes(`[STATEMENT EVIDENCE run ${run.id}]`)) {
        await db.operatorCase.update({ where: { id: opened.id }, data: { resolutionNotes: `${notes}\n${evidence}`.trim().slice(0, 8000) } });
      }
    }
    result.unknownEvidence += 1;
  }

  if (result.cases + result.disputesQueued + result.unknownEvidence + result.overflow > 0) {
    await writeSystemAudit(db, {
      action: "RECONCILIATION_FOLLOW_UP",
      entityType: "RECONCILIATION_RUN",
      entityId: run.id,
      after: { ...result, exceptions: exceptions.length },
    });
    deps.logger?.info("Reconciliation follow-up", { runId: run.id, ...result });
  }
  return result;
};

export type { BackgroundJobRow };
