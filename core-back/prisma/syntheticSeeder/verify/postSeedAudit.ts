import type { PrismaClient } from "../../../generated/prisma/client";
import type { SeederContext } from "../context";

export interface AuditReport {
  ok: boolean;
  ledgerDrift: string;
  unbalancedEntries: number;
  attempts: number;
  succeededWithoutLedger: number;
  slotViolations: number;
  counts: Record<string, number>;
}

const IN_FLIGHT = new Set(["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN"]);

export const auditInMemory = (ctx: SeederContext): AuditReport => {
  let debit = 0;
  let credit = 0;
  const perEntry = new Map<string, { debit: number; credit: number }>();
  for (const line of ctx.dataset.journalLines) {
    const value = Number(line.amount);
    if (line.direction === "DEBIT") debit += value;
    else credit += value;
    const entry = perEntry.get(String(line.entryId)) ?? { debit: 0, credit: 0 };
    if (line.direction === "DEBIT") entry.debit += value;
    else entry.credit += value;
    perEntry.set(String(line.entryId), entry);
  }
  const unbalancedEntries = [...perEntry.values()].filter(
    (entry) => Math.abs(entry.debit - entry.credit) > 0.00005,
  ).length;

  const succeededWithoutLedger = ctx.dataset.paymentAttempts.filter(
    (attempt) => attempt.status === "SUCCEEDED" && !attempt.ledgerEntryId,
  ).length;

  const inFlightByLink = new Map<string, number>();
  for (const attempt of ctx.dataset.paymentAttempts) {
    if (IN_FLIGHT.has(String(attempt.status))) {
      inFlightByLink.set(String(attempt.linkId), (inFlightByLink.get(String(attempt.linkId)) ?? 0) + 1);
    }
  }
  const slotViolations = ctx.dataset.paymentLinks.filter(
    (link) => Number(link.activeLockedCount) !== (inFlightByLink.get(String(link.id)) ?? 0),
  ).length;

  const drift = debit - credit;
  return {
    ok: Math.abs(drift) <= 0.00005 && unbalancedEntries === 0 && succeededWithoutLedger === 0 && slotViolations === 0,
    ledgerDrift: drift.toFixed(4),
    unbalancedEntries,
    attempts: ctx.dataset.paymentAttempts.length,
    succeededWithoutLedger,
    slotViolations,
    counts: Object.fromEntries(
      Object.entries(ctx.dataset)
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => [key, (value as unknown[]).length]),
    ),
  };
};

export const postSeedAudit = async (
  prisma: PrismaClient,
  ctx: SeederContext,
): Promise<AuditReport> => {
  const report = auditInMemory(ctx);
  const [attempts, entries, links] = await Promise.all([
    prisma.paymentAttempt.count(),
    prisma.journalEntry.count(),
    prisma.paymentLink.count(),
  ]);
  report.counts.dbPaymentAttempts = attempts;
  report.counts.dbJournalEntries = entries;
  report.counts.dbPaymentLinks = links;
  return report;
};
