import type { SeederContext } from "../context";
import { addDays, sha256Like } from "../builders";

/**
 * 42 months of T+N statement reconciliation history.
 *
 * The exception budget is derived from the requested operator-case volume, so
 * every non-MATCHED item has a real case later instead of leaving thousands of
 * orphaned mismatches behind.
 */
export const generateReconciliation = (ctx: SeederContext): void => {
  const sources = ctx.refs.statementSources;
  if (sources.length === 0) return;
  const routeGateway = new Map(ctx.refs.routes.map((route) => [route.id, route.gatewayId]));
  const attemptsByGateway = new Map<string, any[]>();
  for (const attempt of ctx.dataset.paymentAttempts) {
    if (!["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"].includes(String(attempt.status))) continue;
    const gatewayId = routeGateway.get(String(attempt.routeId));
    if (!gatewayId) continue;
    const list = attemptsByGateway.get(gatewayId) ?? [];
    list.push(attempt);
    attemptsByGateway.set(gatewayId, list);
  }
  for (const list of attemptsByGateway.values()) {
    list.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  }

  const runCount = ctx.config.volumes.reconciliationRuns;
  const itemCount = ctx.config.volumes.reconciliationItems;
  const exceptionBudget = Math.min(itemCount, Math.max(1, Math.round(ctx.config.volumes.operatorCases * 0.48)));
  const spanMs = ctx.timeline.end.getTime() - ctx.timeline.start.getTime();
  const itemsPerRun = Math.max(1, Math.ceil(itemCount / runCount));
  const statsByRun = new Map<string, { matched: number; mismatched: number; statementLines: number }>();
  const usedExceptionAttempts = new Set<string>();
  let itemsCreated = 0;
  let exceptionsCreated = 0;

  for (let index = 0; index < runCount; index += 1) {
    const source = ctx.rng.pick(sources);
    const progress = (index + 1) / runCount;
    const windowEnd = new Date(ctx.timeline.start.getTime() + spanMs * progress);
    const windowStart = addDays(windowEnd, -ctx.rng.int(1, 7));
    const ingestedAt = new Date(Math.min(ctx.timeline.end.getTime(), addDays(windowEnd, 1).getTime()));
    const runId = ctx.nextId("recon-run");
    ctx.dataset.reconciliationRuns.push({
      id: runId,
      createdAt: ingestedAt,
      updatedAt: ingestedAt,
      statementSourceId: source.id,
      windowStart,
      windowEnd,
      fileHash: sha256Like(ctx, `recon:${source.id}:${windowEnd.toISOString()}`),
      statsJson: { statementLines: 0, matched: 0, mismatched: 0, currency: "LYD" },
      fileName: `${source.gatewayCode}-${windowStart.toISOString().slice(0, 10)}.csv`,
      fileContent: Buffer.from(`provider_reference,amount,fee\nsynthetic-${index},0.0000,0.0000\n`),
      ingestedAt,
    });
    statsByRun.set(runId, { matched: 0, mismatched: 0, statementLines: 0 });

    const gatewayAttempts = attemptsByGateway.get(source.gatewayId) ?? [];
    const inWindow = gatewayAttempts.filter((attempt) => {
      const at = new Date(attempt.createdAt).getTime();
      return at >= windowStart.getTime() && at <= windowEnd.getTime();
    });
    const recent = gatewayAttempts.filter((attempt) => new Date(attempt.createdAt).getTime() <= windowEnd.getTime());
    const pool = inWindow.length > 0 ? inWindow : recent.slice(-250);
    const exceptionTarget = Math.min(
      itemsPerRun,
      Math.floor(((index + 1) * exceptionBudget) / runCount) - Math.floor((index * exceptionBudget) / runCount),
    );

    for (let itemIndex = 0; itemIndex < itemsPerRun && itemsCreated < itemCount; itemIndex += 1) {
      const shouldBeException = itemIndex < exceptionTarget && exceptionsCreated < exceptionBudget;
      let attempt = pool.length > 0 ? ctx.rng.pick(pool) : null;
      if (shouldBeException && attempt && usedExceptionAttempts.has(String(attempt.id))) {
        attempt = pool.find((candidate) => !usedExceptionAttempts.has(String(candidate.id))) ?? null;
      }
      let result: "MATCHED" | "AMOUNT_MISMATCH" | "MISSING_AT_GATEWAY" | "MISSING_LOCALLY" | "DUPLICATE";
      if (!shouldBeException) {
        result = "MATCHED";
      } else {
        result = ctx.rng.weighted({
          AMOUNT_MISMATCH: 3500,
          MISSING_AT_GATEWAY: 2500,
          MISSING_LOCALLY: 2500,
          DUPLICATE: 1500,
        }) as typeof result;
      }
      if (result === "MATCHED" && !attempt) continue;
      if (result !== "MISSING_LOCALLY" && !attempt) {
        result = "MISSING_LOCALLY";
      }
      if (result !== "MATCHED") exceptionsCreated += 1;
      const linkedAttempt = result === "MISSING_LOCALLY" ? null : attempt;
      if (shouldBeException && linkedAttempt) usedExceptionAttempts.add(String(linkedAttempt.id));

      const amountValue = linkedAttempt ? Number(linkedAttempt.settledAmount ?? linkedAttempt.totalChargedAmount ?? 0) : ctx.rng.int(10, 2500);
      const statementAmount = result === "AMOUNT_MISMATCH"
        ? (amountValue + (ctx.rng.chance(50) ? 0.15 : -0.15)).toFixed(4)
        : amountValue.toFixed(4);
      const itemId = ctx.nextId("recon-item");
      ctx.dataset.reconciliationItems.push({
        id: itemId,
        createdAt: ingestedAt,
        updatedAt: ingestedAt,
        runId,
        attemptId: linkedAttempt?.id ?? null,
        ourReference: linkedAttempt?.reference ?? `UNMATCHED-${ctx.config.namespace}-${itemsCreated}`,
        providerReference: linkedAttempt?.providerReference ?? `FK-UNMATCHED-${ctx.config.namespace}-${itemsCreated}`,
        batchReference: `${source.gatewayCode}-${windowStart.toISOString().slice(0, 10)}`,
        statementAmount,
        statementFee: ctx.rng.decimal(0, 5, 4),
        result,
        operatorCaseId: null,
      });
      const stats = statsByRun.get(runId)!;
      stats.statementLines += 1;
      if (result === "MATCHED") stats.matched += 1;
      else stats.mismatched += 1;
      itemsCreated += 1;
    }
  }

  for (const run of ctx.dataset.reconciliationRuns) {
    const stats = statsByRun.get(String(run.id));
    if (stats) run.statsJson = { ...stats, currency: "LYD" };
  }
};
