import type { SeederContext } from "../context";
import { addDays, addMinutes, chance } from "../builders";

type OperatorCaseKind =
  | "UNKNOWN" | "HELD" | "CONFLICT" | "MISMATCH"
  | "LATE_SUCCESS" | "MANUAL_REVIEW" | "UNMATCHED_STATEMENT";

interface Candidate {
  kind: OperatorCaseKind;
  attempt?: any;
  item?: any;
  evidenceAt: Date;
}

const STATE_WEIGHTS = { OPEN: 32, IN_PROGRESS: 24, PENDING_CHECKER: 14, RESOLVED: 30 } as const;
const SLA_HOURS = { P1: 4, P2: 24, P3: 72 } as const;

const priorityFor = (ctx: SeederContext, kind: OperatorCaseKind, amount: number): "P1" | "P2" | "P3" => {
  if (kind === "CONFLICT") return "P1";
  if (kind === "MANUAL_REVIEW" || kind === "UNMATCHED_STATEMENT") {
    return amount >= 1500 ? "P2" : "P3";
  }
  if (kind === "UNKNOWN" || kind === "HELD" || kind === "LATE_SUCCESS") {
    return amount >= 750 || ctx.rng.chance(30) ? "P1" : "P2";
  }
  return amount >= 1000 ? "P1" : ctx.rng.chance(60) ? "P2" : "P3";
};

const actionFor = (attempt: any | undefined): "MARK_SUCCEEDED" | "MARK_FAILED" | "CLOSE_CASE" => {
  if (attempt && !attempt.terminalAt && ["UNKNOWN", "VERIFYING"].includes(String(attempt.status))) {
    return "MARK_FAILED";
  }
  return "CLOSE_CASE";
};

const reasonFor = (kind: OperatorCaseKind): string => {
  switch (kind) {
    case "CONFLICT":
      return "Verified webhook and gateway inquiry disagree; manual outcome requested.";
    case "UNKNOWN":
      return "Gateway did not return a definitive status; attempted inquiry remains inconclusive.";
    case "HELD":
      return "Payment is held for manual review before funds can be released.";
    case "MISMATCH":
      return "Statement amount or reference does not match the local attempt.";
    case "LATE_SUCCESS":
      return "A verified payment arrived after the attempt expired.";
    case "MANUAL_REVIEW":
      return "Risk evidence requires an operator decision.";
    default:
      return "Statement line could not be matched to a local attempt.";
  }
};

export const generateOperatorCases = (ctx: SeederContext): void => {
  const activePlatformUsers = ctx.dataset.users.filter(
    (user) => user.merchantId === null && user.status === "ACTIVE",
  );
  const operators = activePlatformUsers.filter((user) => user.role === "OPERATOR");
  const operatorPool = operators.length > 0 ? operators : activePlatformUsers;
  const checkers = activePlatformUsers.filter((user) => ["FINANCE", "MLRO", "SECURITY_ADMIN"].includes(user.role));
  if (operatorPool.length === 0) return;

  const attemptById = new Map(ctx.dataset.paymentAttempts.map((attempt) => [String(attempt.id), attempt]));
  const runById = new Map(ctx.dataset.reconciliationRuns.map((run) => [String(run.id), run]));
  const lastStepByAttempt = new Map<string, any>();
  for (const log of ctx.dataset.attemptStepLogs) {
    const current = lastStepByAttempt.get(String(log.attemptId));
    if (!current || new Date(log.createdAt) > new Date(current.createdAt)) {
      lastStepByAttempt.set(String(log.attemptId), log);
    }
  }
  const lastInboundByAttempt = new Map<string, any>();
  for (const event of ctx.dataset.inboundEvents) {
    if (!event.attemptId) continue;
    const current = lastInboundByAttempt.get(String(event.attemptId));
    if (!current || new Date(event.receivedAt) > new Date(current.receivedAt)) {
      lastInboundByAttempt.set(String(event.attemptId), event);
    }
  }

  const pools: Record<OperatorCaseKind, Candidate[]> = {
    UNKNOWN: [], HELD: [], CONFLICT: [], MISMATCH: [],
    LATE_SUCCESS: [], MANUAL_REVIEW: [], UNMATCHED_STATEMENT: [],
  };

  // Reconciliation-linked cases. The exception budget in generator 06 is
  // derived from this volume, so every non-MATCHED item has a candidate here.
  for (const item of ctx.dataset.reconciliationItems) {
    if (item.result === "MATCHED") continue;
    const attempt = item.attemptId ? attemptById.get(String(item.attemptId)) : undefined;
    const run = runById.get(String(item.runId));
    const evidenceAt = new Date(run?.ingestedAt ?? run?.windowEnd ?? item.createdAt);
    if (item.result === "MISSING_LOCALLY") {
      pools.UNMATCHED_STATEMENT.push({ kind: "UNMATCHED_STATEMENT", item, evidenceAt });
    } else if (attempt) {
      pools.MISMATCH.push({ kind: "MISMATCH", attempt, item, evidenceAt });
    }
  }

  for (const attempt of ctx.dataset.paymentAttempts) {
    const status = String(attempt.status);
    const substatus = String(attempt.substatus ?? "");
    const lastStep = lastStepByAttempt.get(String(attempt.id));
    const lastInbound = lastInboundByAttempt.get(String(attempt.id));
    const stepAt = new Date(lastStep?.createdAt ?? attempt.createdAt);
    const inboundAt = new Date(lastInbound?.receivedAt ?? stepAt);
    if (status === "UNKNOWN" && substatus === "CONFLICTING_TRUSTED_SIGNALS") {
      pools.CONFLICT.push({ kind: "CONFLICT", attempt, evidenceAt: lastInbound ? inboundAt : stepAt });
    } else if (status === "UNKNOWN") {
      pools.UNKNOWN.push({ kind: "UNKNOWN", attempt, evidenceAt: stepAt });
    } else if (status === "VERIFYING" && substatus === "AML_HOLD") {
      pools.HELD.push({ kind: "HELD", attempt, evidenceAt: stepAt });
    } else if (status === "EXPIRED" && substatus === "LATE_SUCCESS_PENDING") {
      pools.LATE_SUCCESS.push({ kind: "LATE_SUCCESS", attempt, evidenceAt: lastInbound ? inboundAt : stepAt });
    } else if (status === "VERIFYING" && substatus === "MANUAL_REVIEW") {
      pools.MANUAL_REVIEW.push({ kind: "MANUAL_REVIEW", attempt, evidenceAt: stepAt });
    }
  }

  const usedAttempts = new Set<string>();
  const usedItems = new Set<string>();
  const selected: Candidate[] = [];
  const take = (kind: OperatorCaseKind, limit: number): void => {
    const pool = pools[kind];
    while (selected.length < ctx.config.volumes.operatorCases && limit > 0 && pool.length > 0) {
      const candidate = pool.splice(ctx.rng.int(0, pool.length - 1), 1)[0]!;
      if (candidate.attempt && usedAttempts.has(String(candidate.attempt.id))) continue;
      if (candidate.item && usedItems.has(String(candidate.item.id))) continue;
      if (candidate.attempt) usedAttempts.add(String(candidate.attempt.id));
      if (candidate.item) usedItems.add(String(candidate.item.id));
      selected.push(candidate);
      limit -= 1;
    }
  };

  // Reconciliation exceptions come first: every non-MATCHED statement line
  // must end up with a case, otherwise the reconciliation page shows an
  // unexplained exception that no operator can resolve.
  take("MISMATCH", ctx.config.volumes.operatorCases);
  take("UNMATCHED_STATEMENT", ctx.config.volumes.operatorCases);

  const remainingBudget = Math.max(0, ctx.config.volumes.operatorCases - selected.length);
  const attemptQuotas: Array<[OperatorCaseKind, number]> = [
    ["UNKNOWN", 0.35],
    ["CONFLICT", 0.10],
    ["HELD", 0.15],
    ["LATE_SUCCESS", 0.25],
    ["MANUAL_REVIEW", 0.15],
  ];
  for (const [kind, ratio] of attemptQuotas) {
    take(kind, Math.round(remainingBudget * ratio));
  }
  // Fill any shortfall from all remaining valid candidates.
  let cursor = 0;
  while (selected.length < ctx.config.volumes.operatorCases) {
    const kinds = Object.keys(pools) as OperatorCaseKind[];
    const kind = kinds[cursor % kinds.length]!;
    cursor += 1;
    const pool = pools[kind];
    if (pool.length === 0) {
      if (kinds.every((entry) => pools[entry].length === 0)) break;
      continue;
    }
    take(kind, 1);
  }

  for (const candidate of selected) {
    const attempt = candidate.attempt;
    const item = candidate.item;
    const amount = Number(
      attempt?.totalChargedAmount
        ?? item?.statementAmount
        ?? 0,
    );
    const priority = priorityFor(ctx, candidate.kind, amount);
    const createdAt = new Date(Math.min(
      ctx.timeline.end.getTime(),
      addMinutes(candidate.evidenceAt, ctx.rng.int(2, 45)).getTime(),
    ));
    let state = ctx.rng.weighted(STATE_WEIGHTS) as keyof typeof STATE_WEIGHTS;
    // A resolved case must never leave a non-terminal attempt behind: the
    // real resolution workflow would have closed or failed it first.
    if (state === "RESOLVED" && attempt && !attempt.terminalAt) {
      state = "PENDING_CHECKER";
    }
    const clamp = (date: Date): Date => new Date(Math.min(ctx.timeline.end.getTime(), date.getTime()));
    const assignedAt = clamp(addMinutes(createdAt, ctx.rng.int(2, 90)));
    const inquiryAt = clamp(addMinutes(createdAt, ctx.rng.int(5, 180)));
    const assignee = state === "OPEN" && !chance(ctx, 55)
      ? null
      : ctx.rng.pick(operatorPool);
    const maker = assignee ?? ctx.rng.pick(operatorPool);
    const checker = checkers.filter((user) => user.id !== maker.id)[0] ?? checkers[0];
    const proposedAt = new Date(Math.min(
      ctx.timeline.end.getTime(),
      addMinutes(createdAt, ctx.rng.int(10, 360)).getTime(),
    ));
    const resolvedAt = new Date(Math.min(
      ctx.timeline.end.getTime(),
      addMinutes(proposedAt, ctx.rng.int(10, 480)).getTime(),
    ));
    let approvalRequestId: string | null = null;
    let updatedAt = state === "OPEN" && !assignee ? createdAt : assignedAt;
    if (state === "IN_PROGRESS") updatedAt = inquiryAt;
    if ((state === "PENDING_CHECKER" || state === "RESOLVED") && checker) {
      const approvalId = ctx.nextId("approval");
      const action = actionFor(attempt);
      const providerReference = attempt?.providerReference ?? (candidate.kind === "LATE_SUCCESS" ? `FK-LATE-${String(attempt?.id ?? "").slice(-8)}` : null);
      const payload = {
        action,
        reason: reasonFor(candidate.kind),
        notes: `Seeded ${candidate.kind} case resolution.`,
        providerReference,
        settledAmount: action === "MARK_SUCCEEDED" ? String(attempt?.settledAmount ?? attempt?.totalChargedAmount ?? "") : null,
        caseId: "", // patched after the case id is allocated below
        caseRef: attempt?.reference ?? item?.ourReference ?? "",
        attemptId: attempt?.id ?? null,
        attemptReference: attempt?.reference ?? null,
        proposedAt: proposedAt.toISOString(),
      };
      const caseId = ctx.nextId("operator-case");
      payload.caseId = caseId;
      const approvalState = state === "RESOLVED" ? "EXECUTED" : "PENDING_REVIEW";
      ctx.dataset.approvalRequests.push({
        id: approvalId,
        createdAt: proposedAt,
        updatedAt: state === "RESOLVED" ? resolvedAt : proposedAt,
        subjectType: "OPERATOR_CASE",
        subjectId: caseId,
        payloadDiffJson: payload,
        mode: "STANDARD",
        baseVersion: null,
        expiresAt: addDays(proposedAt, 3),
        ratifyDueAt: null,
        makerUserId: maker.id,
        checkerUserId: state === "RESOLVED" ? checker.id : null,
        state: approvalState,
        rejectionReason: null,
        riskAcceptanceNote: null,
      });
      approvalRequestId = approvalId;
      updatedAt = state === "RESOLVED" ? resolvedAt : proposedAt;
      ctx.dataset.operatorCases.push({
        id: caseId,
        createdAt,
        updatedAt,
        attemptId: attempt?.id ?? null,
        reconciliationItemId: item?.id ?? null,
        kind: candidate.kind,
        priority,
        slaDueAt: addMinutes(createdAt, SLA_HOURS[priority] * 60),
        state,
        assigneeUserId: assignee?.id ?? maker.id,
        resolutionNotes: state === "RESOLVED"
          ? `Resolution action: ${action}\nReason: ${reasonFor(candidate.kind)}\nChecker: ${checker.email}\nExecuted at: ${resolvedAt.toISOString()}`
          : null,
        approvalRequestId,
      });
      if (item) item.operatorCaseId = caseId;
      ctx.dataset.auditLogs.push(
        {
          id: ctx.nextId("audit"),
          createdAt,
          updatedAt: createdAt,
          actorId: maker.id,
          role: "OPERATOR",
          action: "OPERATOR_CASE_OPENED",
          entityType: "OPERATOR_CASE",
          entityId: caseId,
          beforeJson: {},
          afterJson: { kind: candidate.kind, priority, state: "OPEN" },
          approvalRequestId: null,
        },
        {
          id: ctx.nextId("audit"),
          createdAt: proposedAt,
          updatedAt: proposedAt,
          actorId: maker.id,
          role: "OPERATOR",
          action: "OPERATOR_CASE_RESOLUTION_PROPOSED",
          entityType: "OPERATOR_CASE",
          entityId: caseId,
          beforeJson: { state },
          afterJson: { state: "PENDING_CHECKER", action },
          approvalRequestId,
        },
      );
      if (state === "RESOLVED") {
        ctx.dataset.auditLogs.push({
          id: ctx.nextId("audit"),
          createdAt: resolvedAt,
          updatedAt: resolvedAt,
          actorId: checker.id,
          role: checker.role,
          action: "OPERATOR_CASE_RESOLVED",
          entityType: "OPERATOR_CASE",
          entityId: caseId,
          beforeJson: { state: "PENDING_CHECKER" },
          afterJson: { state: "RESOLVED", action },
          approvalRequestId,
        });
      }
      continue;
    }

    const caseId = ctx.nextId("operator-case");
    ctx.dataset.operatorCases.push({
      id: caseId,
      createdAt,
      updatedAt,
      attemptId: attempt?.id ?? null,
      reconciliationItemId: item?.id ?? null,
      kind: candidate.kind,
      priority,
      slaDueAt: addMinutes(createdAt, SLA_HOURS[priority] * 60),
      state,
      assigneeUserId: assignee?.id ?? null,
      resolutionNotes: null,
      approvalRequestId: null,
    });
    if (item) item.operatorCaseId = caseId;
    ctx.dataset.auditLogs.push({
      id: ctx.nextId("audit"),
      createdAt,
      updatedAt: createdAt,
      actorId: (assignee ?? maker).id,
      role: "OPERATOR",
      action: "OPERATOR_CASE_OPENED",
      entityType: "OPERATOR_CASE",
      entityId: caseId,
      beforeJson: {},
      afterJson: { kind: candidate.kind, priority, state: "OPEN" },
      approvalRequestId: null,
    });
    if (assignee) {
      ctx.dataset.auditLogs.push({
        id: ctx.nextId("audit"),
        createdAt: assignedAt,
        updatedAt: assignedAt,
        actorId: assignee.id,
        role: "OPERATOR",
        action: "OPERATOR_CASE_ASSIGNED",
        entityType: "OPERATOR_CASE",
        entityId: caseId,
        beforeJson: { assigneeUserId: null },
        afterJson: { assigneeUserId: assignee.id },
        approvalRequestId: null,
      });
    }
    if (state === "IN_PROGRESS" && ["UNKNOWN", "CONFLICT"].includes(candidate.kind)) {
      ctx.dataset.auditLogs.push({
        id: ctx.nextId("audit"),
        createdAt: inquiryAt,
        updatedAt: inquiryAt,
        actorId: (assignee ?? maker).id,
        role: "OPERATOR",
        action: "OPERATOR_CASE_INQUIRY_SCHEDULED",
        entityType: "OPERATOR_CASE",
        entityId: caseId,
        beforeJson: { state: "OPEN" },
        afterJson: { state: "IN_PROGRESS", attemptId: attempt?.id ?? null },
        approvalRequestId: null,
      });
    }
  }
};
