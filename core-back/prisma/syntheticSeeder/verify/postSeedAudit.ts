import type { PrismaClient } from "../../../generated/prisma/client";
import type { SeederContext } from "../context";
import { moneyFromString } from "../../../engine/db/money";
import { checkInvariants, type InvariantReport } from "./invariants";

export interface OperatorCaseAudit {
  total: number;
  missingEvidence: number;
  wrongEvidenceKind: number;
  matchedReconciliation: number;
  pendingWithoutApproval: number;
  resolvedWithoutNotes: number;
  resolvedWithoutExecutedApproval: number;
  makerCheckerViolations: number;
  invalidResolutionAction: number;
  duplicateOpenCases: number;
  timestampViolations: number;
  itemBacklinkViolations: number;
  nonMatchedWithoutCase: number;
  inboundEventViolations: number;
  countsByKind: Record<string, number>;
  countsByState: Record<string, number>;
  samples: string[];
}

export interface AuditReport {
  ok: boolean;
  ledgerDrift: string;
  unbalancedEntries: number;
  attempts: number;
  succeededWithoutLedger: number;
  slotViolations: number;
  operatorCaseViolations: number;
  operatorCases: OperatorCaseAudit;
  /** Cross-table invariants (relations, lifecycle, ledger math, maker-checker, volumes). */
  invariants: InvariantReport;
  /** Violations found by comparing the database with the in-memory dataset. */
  databaseViolations: number;
  counts: Record<string, number>;
}

const IN_FLIGHT = new Set(["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN"]);


const auditOperatorCases = (ctx: SeederContext): OperatorCaseAudit => {
  const attempts = new Map(ctx.dataset.paymentAttempts.map((attempt) => [String(attempt.id), attempt]));
  const items = new Map(ctx.dataset.reconciliationItems.map((item) => [String(item.id), item]));
  const approvals = new Map(ctx.dataset.approvalRequests.map((approval) => [String(approval.id), approval]));
  // Events may reference channels the baseline already owns (ctx.refs) as well as channels
  // this run created, so both sets are valid targets.
  const channels = new Set(
    [...(ctx.refs.confirmationChannels ?? []), ...ctx.dataset.confirmationChannels].map((channel) => String(channel.id)),
  );
  const countsByKind: Record<string, number> = {};
  const countsByState: Record<string, number> = {};
  const duplicateOpen = new Map<string, number>();
  const inboundKeys = new Set<string>();
  let missingEvidence = 0;
  let wrongEvidenceKind = 0;
  let matchedReconciliation = 0;
  let pendingWithoutApproval = 0;
  let resolvedWithoutNotes = 0;
  let resolvedWithoutExecutedApproval = 0;
  let makerCheckerViolations = 0;
  let invalidResolutionAction = 0;
  let timestampViolations = 0;
  let itemBacklinkViolations = 0;
  let nonMatchedWithoutCase = 0;
  let inboundEventViolations = 0;
  const samples: string[] = [];
  const note = (message: string) => {
    if (samples.length < 20) samples.push(message);
  };

  for (const operatorCase of ctx.dataset.operatorCases) {
    const kind = String(operatorCase.kind);
    const state = String(operatorCase.state);
    countsByKind[kind] = (countsByKind[kind] ?? 0) + 1;
    countsByState[state] = (countsByState[state] ?? 0) + 1;
    const attempt = operatorCase.attemptId ? attempts.get(String(operatorCase.attemptId)) : undefined;
    const item = operatorCase.reconciliationItemId ? items.get(String(operatorCase.reconciliationItemId)) : undefined;
    const approval = operatorCase.approvalRequestId ? approvals.get(String(operatorCase.approvalRequestId)) : undefined;

    if (!attempt && !item) missingEvidence += 1;
    if (["UNKNOWN", "CONFLICT", "HELD", "MANUAL_REVIEW", "LATE_SUCCESS"].includes(kind) && !attempt) {
      wrongEvidenceKind += 1;
      note(`${operatorCase.id} ${kind}: no attempt`);
    }
    if (["MISMATCH", "UNMATCHED_STATEMENT"].includes(kind) && !item) {
      wrongEvidenceKind += 1;
      note(`${operatorCase.id} ${kind}: no reconciliation item`);
    }
    if (kind === "UNMATCHED_STATEMENT" && item && item.attemptId) {
      wrongEvidenceKind += 1;
      note(`${operatorCase.id} ${kind}: item has an attempt`);
    }
    if (kind !== "UNMATCHED_STATEMENT" && item && item.result === "MATCHED") matchedReconciliation += 1;
    if (item && item.attemptId && operatorCase.attemptId !== item.attemptId) {
      wrongEvidenceKind += 1;
      note(`${operatorCase.id} ${kind}: attempt ${operatorCase.attemptId} != item attempt ${item.attemptId}`);
    }
    if (item && String(item.operatorCaseId ?? "") !== String(operatorCase.id)) itemBacklinkViolations += 1;
    if (state === "PENDING_CHECKER" && (!approval || approval.state !== "PENDING_REVIEW")) pendingWithoutApproval += 1;
    if (state === "RESOLVED") {
      if (!operatorCase.resolutionNotes) resolvedWithoutNotes += 1;
      if (!approval || approval.state !== "EXECUTED") resolvedWithoutExecutedApproval += 1;
    }
    if (approval) {
      if (approval.makerUserId === approval.checkerUserId) makerCheckerViolations += 1;
      const payload = (approval.payloadDiffJson ?? {}) as Record<string, unknown>;
      const action = String(payload.action ?? "");
      if (action === "CLOSE_CASE" && attempt && !attempt.terminalAt) invalidResolutionAction += 1;
    }
    const createdAt = new Date(operatorCase.createdAt).getTime();
    const updatedAt = new Date(operatorCase.updatedAt).getTime();
    const slaDueAt = new Date(operatorCase.slaDueAt).getTime();
    if (createdAt > updatedAt || slaDueAt < createdAt) timestampViolations += 1;
    if (state !== "RESOLVED" && operatorCase.attemptId) {
      const key = `${operatorCase.attemptId}:${kind}`;
      duplicateOpen.set(key, (duplicateOpen.get(key) ?? 0) + 1);
    }
  }

  const caseByItem = new Set(
    ctx.dataset.operatorCases
      .map((operatorCase) => operatorCase.reconciliationItemId)
      .filter(Boolean)
      .map(String),
  );
  for (const item of ctx.dataset.reconciliationItems) {
    if (item.result !== "MATCHED" && !caseByItem.has(String(item.id))) nonMatchedWithoutCase += 1;
  }

  for (const event of ctx.dataset.inboundEvents) {
    if (!event.channelId || !channels.has(String(event.channelId))) inboundEventViolations += 1;
    if (!event.attemptId || !attempts.has(String(event.attemptId))) inboundEventViolations += 1;
    const receivedAt = new Date(event.receivedAt).getTime();
    if (Number.isNaN(receivedAt) || receivedAt > ctx.timeline.end.getTime()) inboundEventViolations += 1;
    const key = `${event.channelId}:${event.dedupeKey}`;
    if (inboundKeys.has(key)) inboundEventViolations += 1;
    inboundKeys.add(key);
  }

  return {
    total: ctx.dataset.operatorCases.length,
    missingEvidence,
    wrongEvidenceKind,
    matchedReconciliation,
    pendingWithoutApproval,
    resolvedWithoutNotes,
    resolvedWithoutExecutedApproval,
    makerCheckerViolations,
    invalidResolutionAction,
    duplicateOpenCases: [...duplicateOpen.values()].filter((count) => count > 1).length,
    timestampViolations,
    itemBacklinkViolations,
    nonMatchedWithoutCase,
    inboundEventViolations,
    countsByKind,
    countsByState,
    samples,
  };
};

export const auditInMemory = (ctx: SeederContext): AuditReport => {
  const invariants = checkInvariants(ctx);
  const perEntry = new Map<string, bigint>();
  let drift = 0n;
  for (const line of ctx.dataset.journalLines) {
    const value = moneyFromString(String(line.amount));
    const signed = line.direction === "DEBIT" ? value : -value;
    drift += signed;
    perEntry.set(String(line.entryId), (perEntry.get(String(line.entryId)) ?? 0n) + signed);
  }
  const unbalancedEntries = [...perEntry.values()].filter((total) => total !== 0n).length;
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

  const operatorCases = auditOperatorCases(ctx);
  const operatorCaseViolations = operatorCases.missingEvidence
    + operatorCases.wrongEvidenceKind
    + operatorCases.matchedReconciliation
    + operatorCases.pendingWithoutApproval
    + operatorCases.resolvedWithoutNotes
    + operatorCases.resolvedWithoutExecutedApproval
    + operatorCases.makerCheckerViolations
    + operatorCases.invalidResolutionAction
    + operatorCases.duplicateOpenCases
    + operatorCases.timestampViolations
    + operatorCases.itemBacklinkViolations
    + operatorCases.nonMatchedWithoutCase
    + operatorCases.inboundEventViolations;
  const scaled = drift.toString().padStart(5, "0");
  const ledgerDrift = `${drift < 0n ? "-" : ""}${scaled.replace("-", "").slice(0, -4)}.${scaled.replace("-", "").slice(-4)}`;
  return {
    ok: drift === 0n
      && unbalancedEntries === 0
      && succeededWithoutLedger === 0
      && slotViolations === 0
      && operatorCaseViolations === 0
      && invariants.total === 0,
    ledgerDrift,
    unbalancedEntries,
    attempts: ctx.dataset.paymentAttempts.length,
    succeededWithoutLedger,
    slotViolations,
    operatorCaseViolations,
    operatorCases,
    invariants,
    databaseViolations: 0,
    counts: Object.fromEntries(
      Object.entries(ctx.dataset)
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => [key, (value as unknown[]).length]),
    ),
  };
};

/**
 * After the write: the database must hold EXACTLY what the dataset holds
 * (a skipped duplicate or a failed chunk is a violation, not a silent
 * success) and the ledger must balance in SQL, not only in memory.
 */
export const postSeedAudit = async (
  prisma: PrismaClient,
  ctx: SeederContext,
): Promise<AuditReport> => {
  const report = auditInMemory(ctx);
  const expected = ctx.dataset;
  const [attempts, entries, links, lines, merchants, adjustments, disputes] = await Promise.all([
    countByIds(prisma, "paymentAttempt", expected.paymentAttempts),
    countByIds(prisma, "journalEntry", expected.journalEntries),
    countByIds(prisma, "paymentLink", expected.paymentLinks),
    countByIds(prisma, "journalLine", expected.journalLines),
    countByIds(prisma, "merchant", expected.merchants),
    countByIds(prisma, "adjustment", expected.adjustments),
    countByIds(prisma, "dispute", expected.disputes),
  ]);
  report.counts.dbPaymentAttempts = attempts;
  report.counts.dbJournalEntries = entries;
  report.counts.dbJournalLines = lines;
  report.counts.dbPaymentLinks = links;
  const mismatches: Array<[string, number, number]> = [
    ["paymentAttempts", attempts, expected.paymentAttempts.length],
    ["journalEntries", entries, expected.journalEntries.length],
    ["journalLines", lines, expected.journalLines.length],
    ["paymentLinks", links, expected.paymentLinks.length],
    ["merchants", merchants, expected.merchants.length],
    ["adjustments", adjustments, expected.adjustments.length],
    ["disputes", disputes, expected.disputes.length],
  ];
  for (const [name, actual, wanted] of mismatches) {
    if (actual !== wanted) {
      report.databaseViolations += 1;
      report.invariants.samples.push(`database.count ${name}: db=${actual} dataset=${wanted}`);
    }
  }
  const sql = (await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0)::text AS drift FROM journal_lines`,
  )) as Array<{ drift: string }>;
  const unbalanced = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT entry_id FROM journal_lines GROUP BY entry_id
       HAVING SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0) t`,
  )) as Array<{ n: number }>;
  report.counts.dbUnbalancedEntries = Number(unbalanced[0]?.n ?? 0);
  if (Number(sql[0]?.drift ?? 0) !== 0 || Number(unbalanced[0]?.n ?? 0) !== 0) report.databaseViolations += 1;
  report.ok = report.ok && report.databaseViolations === 0;
  return report;
};

const countByIds = async (prisma: PrismaClient, model: string, rows: Array<Record<string, unknown>>): Promise<number> => {
  const delegate = (prisma as unknown as Record<string, { count: (args: unknown) => Promise<number> }>)[model]!;
  let total = 0;
  for (let offset = 0; offset < rows.length; offset += 20_000) {
    total += await delegate.count({ where: { id: { in: rows.slice(offset, offset + 20_000).map((row) => row.id) } } });
  }
  return total;
};
