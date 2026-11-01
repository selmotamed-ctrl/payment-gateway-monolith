import type { PrismaClient } from "../../../generated/prisma/client";
import type { SeederContext } from "../context";

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
  counts: Record<string, number>;
}

const IN_FLIGHT = new Set(["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN"]);


const auditOperatorCases = (ctx: SeederContext): OperatorCaseAudit => {
  const attempts = new Map(ctx.dataset.paymentAttempts.map((attempt) => [String(attempt.id), attempt]));
  const items = new Map(ctx.dataset.reconciliationItems.map((item) => [String(item.id), item]));
  const approvals = new Map(ctx.dataset.approvalRequests.map((approval) => [String(approval.id), approval]));
  const channels = new Set(ctx.dataset.confirmationChannels.map((channel) => String(channel.id)));
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
  const drift = debit - credit;
  return {
    ok: Math.abs(drift) <= 0.00005
      && unbalancedEntries === 0
      && succeededWithoutLedger === 0
      && slotViolations === 0
      && operatorCaseViolations === 0,
    ledgerDrift: drift.toFixed(4),
    unbalancedEntries,
    attempts: ctx.dataset.paymentAttempts.length,
    succeededWithoutLedger,
    slotViolations,
    operatorCaseViolations,
    operatorCases,
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
