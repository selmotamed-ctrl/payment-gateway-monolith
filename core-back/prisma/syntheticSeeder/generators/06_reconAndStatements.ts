import { buildLedgerTemplate, decimal } from "../../../engine/ledger/LedgerPoster";
import { metaOf, type SeederContext } from "../context";
import { addDays, ensureSystemAccounts, postTemplate, sha256Like } from "../builders";
import { SETTLED_STATUSES } from "../lifecycle";
import { D } from "../money";

type Result = "MATCHED" | "AMOUNT_MISMATCH" | "MISSING_AT_GATEWAY" | "MISSING_LOCALLY" | "DUPLICATE";

const dayKey = (date: Date): string => date.toISOString().slice(0, 10).replaceAll("-", "");

/**
 * T+N statement reconciliation history.
 *
 * Every run is a window of ONE statement source (gateway); its lines are the
 * settled attempts of that gateway whose terminal time falls in the window
 * (each attempt appears once), so `reconciliationItems` is an upper bound
 * (the profile volume) capped by what the payment history can really feed.
 * MATCHED lines of platform-cleared attempts are swept (`SETTLEMENT_SWEEP`:
 * Dr TREASURY net / Dr GATEWAY_FEE_ACCRUAL fee / Cr GATEWAY_CLEARING gross) at
 * ingestion time. The exception budget is derived from the operator-case
 * volume, so every non-MATCHED line gets a case in generator 09.
 */
export const generateReconciliation = (ctx: SeederContext): void => {
  const meta = metaOf(ctx);
  const sources = ctx.refs.statementSources;
  if (sources.length === 0) return;
  ensureSystemAccounts(ctx);
  const end = ctx.timeline.end;
  const start = ctx.timeline.start;
  const attemptsByGateway = new Map<string, Array<Record<string, unknown>>>();
  for (const attempt of ctx.dataset.paymentAttempts) {
    const info = meta.attempts.get(String(attempt.id));
    if (!info || !attempt.terminalAt) continue;
    const gwStatus = String(attempt.status);
    if (!SETTLED_STATUSES.has(gwStatus) || info.kind === "AML_RELEASED") continue;
    const list = attemptsByGateway.get(info.gatewayId) ?? [];
    list.push(attempt);
    attemptsByGateway.set(info.gatewayId, list);
  }
  for (const list of attemptsByGateway.values()) {
    list.sort((a, b) => (a.terminalAt as Date).getTime() - (b.terminalAt as Date).getTime());
  }

  const runsPerSource = Math.max(1, Math.round(ctx.config.volumes.reconciliationRuns / sources.length));
  const totalCandidates = [...attemptsByGateway.values()].reduce((sum, list) => sum + list.length, 0);
  const itemBudget = Math.min(ctx.config.volumes.reconciliationItems, totalCandidates);
  const exceptionBudget = Math.min(itemBudget, Math.round(ctx.config.volumes.operatorCases * 0.48));
  const exceptionRate = totalCandidates > 0 ? exceptionBudget / totalCandidates : 0;
  const span = end.getTime() - start.getTime();
  let itemsCreated = 0;
  let exceptions = 0;
  let sequence = 0;
  const sweptBatch = new Set<string>();

  for (const source of sources) {
    const list = attemptsByGateway.get(source.gatewayId) ?? [];
    const lagDays = source.settlementLagDays ?? 1;
    let cursor = 0;
    for (let index = 0; index < runsPerSource; index += 1) {
      const windowStart = new Date(start.getTime() + (span * index) / runsPerSource);
      const windowEnd = new Date(start.getTime() + (span * (index + 1)) / runsPerSource);
      const ingestedAt = new Date(addDays(windowEnd, lagDays).getTime() + 6 * 3_600_000);
      if (ingestedAt.getTime() > end.getTime()) break; // the statement has not arrived yet
      const inWindow: Array<Record<string, unknown>> = [];
      while (cursor < list.length && (list[cursor]!.terminalAt as Date).getTime() <= windowEnd.getTime()) {
        if ((list[cursor]!.terminalAt as Date).getTime() > windowStart.getTime() || index === 0) inWindow.push(list[cursor]!);
        cursor += 1;
      }
      const runId = ctx.nextId("recon-run");
      const stats = { statementLines: 0, matched: 0, mismatched: 0, currency: "LYD" };
      const fileName = `${source.gatewayCode}-${dayKey(windowStart)}-${dayKey(windowEnd)}.csv`;
      const csv: string[] = ["provider_reference,our_reference,amount,fee,currency,status,settled_at"];
      const run = {
        id: runId, createdAt: ingestedAt, updatedAt: ingestedAt, statementSourceId: source.id, windowStart, windowEnd,
        fileHash: sha256Like(ctx, `recon:${source.id}:${windowEnd.toISOString()}`), statsJson: stats, fileName,
        fileContent: Buffer.from(""), ingestedAt,
      };
      ctx.dataset.reconciliationRuns.push(run);

      const addItem = (attempt: Record<string, unknown> | null, result: Result, amount: string, fee: string): string => {
        sequence += 1;
        const batchReference = `${source.gatewayCode.toUpperCase()}-${dayKey(windowEnd)}-${sequence}`;
        const ourReference = attempt ? String(attempt.reference) : `UNMATCHED-${ctx.config.namespace}-${sequence}`;
        const providerReference = attempt ? String(attempt.providerReference) : `FK-UNMATCHED-${ctx.config.namespace}-${sequence}`;
        const id = ctx.nextId("recon-item");
        ctx.dataset.reconciliationItems.push({
          id, createdAt: ingestedAt, updatedAt: ingestedAt, runId, attemptId: attempt ? attempt.id : null,
          ourReference, providerReference, batchReference, statementAmount: amount, statementFee: fee, result, operatorCaseId: null,
        });
        csv.push([providerReference, ourReference, amount, fee, "LYD", result === "MATCHED" ? "PAID" : "REVIEW", ingestedAt.toISOString()].join(","));
        stats.statementLines += 1;
        if (result === "MATCHED") stats.matched += 1;
        else stats.mismatched += 1;
        itemsCreated += 1;
        return batchReference;
      };

      for (const attempt of inWindow) {
        if (itemsCreated >= itemBudget) break;
        const info = meta.attempts.get(String(attempt.id))!;
        const settledAmount = String(attempt.settledAmount ?? attempt.totalChargedAmount);
        const fee = info.ownershipMode === "INTERNAL" ? "0.0000" : String(attempt.gatewayFeeAmount ?? "0.0000");
        let result: Result = "MATCHED";
        if (exceptions < exceptionBudget && ctx.rng.next() < exceptionRate) {
          result = ctx.rng.weighted({ AMOUNT_MISMATCH: 40, MISSING_AT_GATEWAY: 30, DUPLICATE: 20, MISSING_LOCALLY: 10 }) as Result;
        }
        if (result === "MISSING_LOCALLY") {
          // A statement line for a payment we never saw: it replaces this slot.
          addItem(null, "MISSING_LOCALLY", D(attempt.totalChargedAmount as string).toFixed(4), "0.0000");
          exceptions += 1;
          addItem(attempt, "MATCHED", settledAmount, fee);
          continue;
        }
        if (result === "AMOUNT_MISMATCH") {
          const delta = D(ctx.rng.chance(50) ? "0.5000" : "-0.5000");
          addItem(attempt, "AMOUNT_MISMATCH", D(settledAmount).plus(delta).toFixed(4), fee);
          exceptions += 1;
          continue;
        }
        if (result === "MISSING_AT_GATEWAY") {
          addItem(attempt, "MISSING_AT_GATEWAY", "0.0000", "0.0000");
          exceptions += 1;
          continue;
        }
        const batchReference = addItem(attempt, "MATCHED", settledAmount, fee);
        if (result === "DUPLICATE") {
          addItem(attempt, "DUPLICATE", settledAmount, fee);
          exceptions += 1;
        }
        // Settlement sweep for platform-held money that sits in GATEWAY_CLEARING.
        const clearingLeg = info.ownershipMode === "PLATFORM_CLEARING"
          && (info.feeAccrual || attempt.feeBearer !== "MERCHANT_ABSORBS" || String(attempt.substatus ?? "") === "SUSPENSE_SETTLEMENT" ? true : false);
        if (clearingLeg && String(attempt.substatus ?? "") !== "SUSPENSE_SETTLEMENT") {
          const refId = `settlement:${batchReference}`;
          if (sweptBatch.has(refId)) continue;
          sweptBatch.add(refId);
          const gross = decimal(String(attempt.totalChargedAmount));
          const feeAmount = decimal(String(attempt.gatewayFeeAmount ?? "0"));
          const template = buildLedgerTemplate("SETTLEMENT_SWEEP", {
            amount: gross, gatewayFeeAmount: feeAmount, settledAmount: gross.minus(feeAmount),
          });
          postTemplate(ctx, { ...template, refId }, { gatewayId: info.gatewayId }, ingestedAt);
        }
      }
      run.fileContent = Buffer.from(`${csv.join("\n")}\n`);
    }
  }
  void ctx.dataset.reconciliationItems.length;
};
