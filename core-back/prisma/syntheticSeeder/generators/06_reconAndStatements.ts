import type { SeederContext } from "../context";
import { addDays, chance, sha256Like } from "../builders";

/**
 * 42 months of T+N statement reconciliation history. 97% of items match; the
 * remaining 3% are the open mismatches Finance works from the back office.
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

  const runCount = ctx.config.volumes.reconciliationRuns;
  const itemCount = ctx.config.volumes.reconciliationItems;
  const spanMs = ctx.timeline.end.getTime() - ctx.timeline.start.getTime();
  let itemsCreated = 0;
  const itemsPerRun = Math.max(1, Math.ceil(itemCount / runCount));

  for (let index = 0; index < runCount; index += 1) {
    const source = ctx.rng.pick(sources);
    const progress = (index + 1) / runCount;
    const windowEnd = new Date(ctx.timeline.start.getTime() + spanMs * progress);
    const windowStart = addDays(windowEnd, -ctx.rng.int(1, 7));
    const runId = ctx.nextId("recon-run");
    const stats = {
      statementLines: itemsPerRun,
      matched: Math.round(itemsPerRun * 0.97),
      mismatched: Math.round(itemsPerRun * 0.03),
      currency: "LYD",
    };
    ctx.dataset.reconciliationRuns.push({
      id: runId,
      createdAt: windowEnd,
      updatedAt: windowEnd,
      statementSourceId: source.id,
      windowStart,
      windowEnd,
      fileHash: sha256Like(ctx, `recon:${source.id}:${windowEnd.toISOString()}`),
      statsJson: stats,
      fileName: `${source.gatewayCode}-${windowStart.toISOString().slice(0, 10)}.csv`,
      fileContent: Buffer.from(`provider_reference,amount,fee\nsynthetic-${index},0.0000,0.0000\n`),
      ingestedAt: addDays(windowEnd, 1),
    });

    const gatewayAttempts = attemptsByGateway.get(source.gatewayId) ?? [];
    for (let itemIndex = 0; itemIndex < itemsPerRun && itemsCreated < itemCount; itemIndex += 1) {
      const attempt = gatewayAttempts.length > 0 ? ctx.rng.pick(gatewayAttempts) : null;
      const result = ctx.rng.weighted({
        MATCHED: 9700,
        AMOUNT_MISMATCH: 100,
        MISSING_AT_GATEWAY: 70,
        MISSING_LOCALLY: 80,
        DUPLICATE: 50,
      });
      const amountValue = attempt ? Number(attempt.settledAmount ?? attempt.totalChargedAmount ?? 0) : 10;
      const statementAmount = result === "AMOUNT_MISMATCH"
        ? (amountValue + (ctx.rng.chance(50) ? 0.15 : -0.15)).toFixed(4)
        : amountValue.toFixed(4);
      ctx.dataset.reconciliationItems.push({
        id: ctx.nextId("recon-item"),
        createdAt: windowEnd,
        updatedAt: windowEnd,
        runId,
        attemptId: attempt?.id ?? null,
        ourReference: attempt?.reference ?? `UNMATCHED-${ctx.config.namespace}-${itemsCreated}`,
        providerReference: attempt?.providerReference ?? `FK-UNMATCHED-${itemsCreated}`,
        batchReference: `${source.gatewayCode}-${windowStart.toISOString().slice(0, 10)}`,
        statementAmount,
        statementFee: ctx.rng.decimal(0, 5, 4),
        result,
        operatorCaseId: null,
      });
      itemsCreated += 1;
    }
    void chance;
  }
};
