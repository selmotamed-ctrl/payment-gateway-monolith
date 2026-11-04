import { createHash } from "node:crypto";
import { metaOf, type SeederContext } from "../context";
import { addDays, addMinutes, between, maxDate, sha256Like } from "../builders";
import { pendingVersionIds, rolledBackVersionIds } from "./03_gatewayLifecycleGenerator";

type Row = Record<string, any>;

/**
 * Screenings, AML cases, regulatory reports, maker-checker approvals bound to
 * REAL subject rows, notifications, audit trail and detail change logs.
 *
 * Every approval satisfies maker != checker, the maker `is_maker` and the
 * checker `is_checker` (the role flags of `scripts/createAdminPlan.ts`); a
 * decided approval is dated after its subject was proposed and before the
 * simulation clock. Audit rows are derived from the events that really
 * happened (executed adjustments, opened disputes, resolved AML cases,
 * onboarding decisions), not invented at random.
 */
export const generateAmlAndGovernanceQueues = (ctx: SeederContext): void => {
  const meta = metaOf(ctx);
  const end = ctx.timeline.end;
  const staff = ctx.dataset.users.filter((user) => user.merchantId === null && user.status === "ACTIVE");
  const makers = staff.filter((user) => user.isMaker);
  const checkers = staff.filter((user) => user.isChecker);
  const byRole = (...roles: string[]): Row[] => staff.filter((user) => roles.includes(String(user.role)));
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(ctx.rng.next() * list.length)]!;
  const checkerFor = (makerId: string, ...roles: string[]): Row | null => {
    const pool = (roles.length > 0 ? byRole(...roles) : checkers).filter((user) => user.isChecker && user.id !== makerId);
    return pool.length > 0 ? pick(pool) : null;
  };
  const makerFor = (...roles: string[]): Row => pick(byRole(...roles).filter((user) => user.isMaker).concat(roles.length === 0 ? makers : []).length > 0
    ? byRole(...roles).filter((user) => user.isMaker).concat(roles.length === 0 ? makers : [])
    : makers);
  const clamp = (date: Date): Date => (date.getTime() > end.getTime() ? new Date(end) : date);

  const approval = (input: {
    subjectType: string; subjectId: string; payload: Record<string, unknown>; maker: Row; checker: Row | null;
    state: string; createdAt: Date; decidedAt?: Date | null; mode?: string; rejectionReason?: string | null; baseVersion?: number | null;
  }): Row => {
    const createdAt = clamp(input.createdAt);
    const decidedAt = input.decidedAt ? clamp(maxDate(input.decidedAt, addMinutes(createdAt, 1))) : createdAt;
    const row: Row = {
      id: ctx.nextId("approval"),
      createdAt,
      updatedAt: decidedAt,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payloadDiffJson: input.payload,
      makerReason: "Maker request submitted for four-eyes review.",
      mode: input.mode ?? "STANDARD",
      baseVersion: input.baseVersion ?? null,
      expiresAt: addDays(createdAt, 7),
      ratifyDueAt: input.mode === "EMERGENCY_RATIFICATION" ? addDays(createdAt, 1) : null,
      makerUserId: input.maker.id,
      checkerUserId: ["PENDING_REVIEW", "DRAFT"].includes(input.state) ? null : input.checker?.id ?? null,
      state: input.state,
      rejectionReason: input.state === "REJECTED" ? input.rejectionReason ?? "Rejected after policy review." : null,
      riskAcceptanceNote: null,
    };
    ctx.dataset.approvalRequests.push(row);
    return row;
  };
  const audit = (actor: Row, action: string, entityType: string, entityId: string, at: Date, before: unknown, after: unknown, approvalRequestId: string | null = null): void => {
    const when = clamp(at);
    ctx.dataset.auditLogs.push({
      id: ctx.nextId("audit"), createdAt: when, updatedAt: when, actorId: actor.id, role: actor.role, action, entityType,
      entityId, beforeJson: before, afterJson: after, approvalRequestId,
    });
  };
  const systemUser = ctx.dataset.users.find((user) => user.id === meta.systemUserId);

  // ------------------------------------------------------------ screenings
  const merchants = ctx.dataset.merchants;
  const joinByMerchant = new Map<string, Row>();
  for (const join of ctx.dataset.joinRequests) joinByMerchant.set(String(join.merchantId), join); // the last (final) request wins
  const addScreening = (subjectType: string, subjectId: string, trigger: string, result: string, requestedAt: Date): Row => {
    const id = ctx.nextId("aml-screening");
    const matchCount = result === "POTENTIAL_MATCH" || result === "CONFIRMED_MATCH" ? ctx.rng.int(1, 2) : 0;
    const at = clamp(requestedAt);
    const row: Row = {
      id, createdAt: at, updatedAt: at, subjectType, subjectId, trigger, providerCode: "INTERNAL_WATCHLIST",
      providerRequestRef: `scr-${sha256Like(ctx, id).slice(0, 12)}`,
      listVersionsJson: { sanctions: "v2026.10", pep: "v2026.10", adverse_media: "v2026.09" },
      inputHash: sha256Like(ctx, `screening-input:${id}`), result, matchCount,
      highestScore: matchCount > 0 ? ctx.rng.decimal(70, 99, 2) : null, requestedAt: at,
      completedAt: result === "ERROR" ? null : clamp(addMinutes(at, ctx.rng.int(1, 30))),
    };
    ctx.dataset.amlScreenings.push(row);
    for (let index = 0; index < matchCount; index += 1) {
      const disposition = ctx.rng.weighted({ UNREVIEWED: 40, FALSE_POSITIVE: 40, TRUE_MATCH: 10, ESCALATED: 10 }) as string;
      const reviewer = pick(byRole("COMPLIANCE", "MLRO"));
      ctx.dataset.amlScreeningMatches.push({
        id: ctx.nextId("aml-match"), createdAt: at, updatedAt: at, screeningId: id,
        listType: ctx.rng.pick(["SANCTIONS", "PEP", "ADVERSE_MEDIA", "INTERNAL_WATCHLIST"]), listName: "Consolidated screening list",
        listEntryRef: `LST-${ctx.rng.int(10000, 99999)}`, matchedName: ctx.rng.pick(["Mohamed Ali", "Ahmed Salem", "Omar Khaled", "Ali Hassan"]),
        score: ctx.rng.decimal(70, 99, 2), attributesJson: { country: "LY", dateOfBirth: "1980-01-01" }, disposition,
        dispositionById: disposition === "UNREVIEWED" ? null : reviewer.id,
        dispositionNotes: disposition === "FALSE_POSITIVE" ? "Reviewed and dismissed." : disposition === "UNREVIEWED" ? null : "Reviewed by compliance.",
        suppressFuture: disposition === "FALSE_POSITIVE" && ctx.rng.chance(30), suppressUntil: null,
      });
    }
    return row;
  };
  // Onboarding screening of every submitted join request (final one).
  for (const merchant of merchants) {
    const join = joinByMerchant.get(String(merchant.id));
    if (!join || !join.submittedAt) continue;
    const screening = addScreening("MERCHANT", String(merchant.id), "ONBOARDING", "CLEAR", addMinutes(join.submittedAt as Date, ctx.rng.int(1, 20)));
    join.screeningId = screening.id;
    join.lastScreenedAt = screening.requestedAt;
  }
  // Owner screenings follow the owner's screening status.
  for (const owner of ctx.dataset.beneficialOwners) {
    if (owner.screeningStatus === "NOT_SCREENED") continue;
    addScreening("BENEFICIAL_OWNER", String(owner.id), "ONBOARDING", String(owner.screeningStatus), addMinutes(owner.createdAt as Date, ctx.rng.int(5, 90)));
  }
  // Periodic and list-update screenings of operating merchants top up the volume.
  const operating = merchants.filter((merchant) => merchant.activatedAt);
  while (ctx.dataset.amlScreenings.length < ctx.config.volumes.amlScreenings && operating.length > 0) {
    const merchant = pick(operating);
    const at = between(ctx, addDays(merchant.activatedAt as Date, 30), end);
    addScreening("MERCHANT", String(merchant.id), ctx.rng.weighted({ PERIODIC: 70, LIST_UPDATE: 25, MANUAL: 5 }) as string,
      ctx.rng.weighted({ CLEAR: 9000, POTENTIAL_MATCH: 800, CONFIRMED_MATCH: 100, ERROR: 100 }) as string, at);
    if (ctx.dataset.amlScreenings.length > ctx.config.volumes.amlScreenings * 3) break;
  }

  // ------------------------------------------------- screening AML cases
  const amlCasesFromAttempts = ctx.dataset.amlCases.length;
  const caseBudget = Math.max(0, ctx.config.volumes.amlCases - amlCasesFromAttempts);
  const flagged = ctx.dataset.amlScreenings.filter((screening) => ["POTENTIAL_MATCH", "CONFIRMED_MATCH"].includes(String(screening.result)));
  let screeningCases = 0;
  for (const screening of flagged) {
    if (screeningCases >= caseBudget) break;
    if (!ctx.rng.chance(60)) continue;
    const status = ctx.rng.weighted({ OPEN: 25, IN_REVIEW: 25, PENDING_CHECKER: 15, RELEASED: 15, REJECTED_VOID: 8, FROZEN: 5, ESCALATED_STR: 7 }) as string;
    const createdAt = clamp(addMinutes(screening.requestedAt as Date, ctx.rng.int(10, 600)));
    const severity = screening.result === "CONFIRMED_MATCH" ? ctx.rng.weighted({ HIGH: 55, CRITICAL: 45 }) : ctx.rng.weighted({ LOW: 25, MEDIUM: 45, HIGH: 30 });
    const slaHours = ({ CRITICAL: 4, HIGH: 24, MEDIUM: 72, LOW: 120 } as Record<string, number>)[severity as string]!;
    ctx.dataset.amlCases.push({
      id: ctx.nextId("aml-case"), createdAt, updatedAt: ["RELEASED", "REJECTED_VOID"].includes(status) ? clamp(addDays(createdAt, ctx.rng.int(1, 5))) : createdAt,
      subjectType: screening.subjectType, subjectId: screening.subjectId,
      triggerReason: `SCREENING_${screening.result}:${ctx.rng.pick(["SANCTIONS", "PEP", "ADVERSE_MEDIA"])}`,
      severity, severityInputsJson: [{ screening: screening.id, score: screening.highestScore }], screeningId: screening.id,
      ruleId: null, ruleVersion: null, holdJournalEntryId: null, status, slaDueAt: addMinutes(createdAt, slaHours * 60),
      assignedReviewerId: status === "OPEN" && ctx.rng.chance(40) ? null : pick(byRole("COMPLIANCE", "MLRO")).id,
      regulatoryReportId: null, confidential: true,
      reviewerNotes: status === "PENDING_CHECKER" ? "Proposed release; awaiting MLRO." : null,
    });
    screeningCases += 1;
  }

  // -------------------------------------------------- AML case approvals
  const attemptById = new Map(ctx.dataset.paymentAttempts.map((attempt) => [String(attempt.id), attempt]));
  for (const amlCase of ctx.dataset.amlCases) {
    const status = String(amlCase.status);
    if (!["PENDING_CHECKER", "RELEASED", "REJECTED_VOID", "ESCALATED_STR", "FROZEN"].includes(status)) continue;
    const maker = pick(byRole("COMPLIANCE", "OPERATOR").filter((user) => user.isMaker || user.role === "COMPLIANCE").length > 0
      ? byRole("COMPLIANCE", "OPERATOR") : staff);
    const makerRow = makers.find((user) => user.role === "OPERATOR") ?? maker;
    const proposedAt = addMinutes(amlCase.createdAt as Date, ctx.rng.int(30, 24 * 60));
    const action = status === "RELEASED" ? "RELEASE" : status === "REJECTED_VOID" ? "REJECT" : status === "ESCALATED_STR" ? "ESCALATE" : status === "FROZEN" ? "HOLD" : "RELEASE";
    const decided = ["RELEASED", "REJECTED_VOID", "ESCALATED_STR", "FROZEN"].includes(status);
    const checker = checkerFor(String(makerRow.id), "MLRO", "COMPLIANCE");
    const row = approval({
      subjectType: "AML_CASE", subjectId: String(amlCase.id), payload: { action, notes: "Reviewed against the screening and rule evidence." },
      maker: makerRow, checker, state: decided ? "EXECUTED" : "PENDING_REVIEW", createdAt: proposedAt,
      decidedAt: decided ? (amlCase.updatedAt as Date) : null,
    });
    if (decided) {
      audit(checker ?? makerRow, "AML_CASE_RESOLVED", "AML_CASE", String(amlCase.id), row.updatedAt as Date, { status: "PENDING_CHECKER" }, { status, action }, String(row.id));
    }
    // Suspicious-activity report for escalated cases.
    if (status === "ESCALATED_STR") {
      const reportId = ctx.nextId("report");
      const payload = { caseId: amlCase.id, subjectType: amlCase.subjectType, subjectId: amlCase.subjectId, narrative: "Escalated suspicious activity." };
      const plaintext = JSON.stringify(payload);
      const reportStatus = ctx.rng.weighted({ DRAFT: 15, PENDING_CHECKER: 20, APPROVED: 20, SUBMITTED: 20, ACKNOWLEDGED: 20, REJECTED_BY_AUTHORITY: 5 }) as string;
      const reportAt = clamp(addDays(amlCase.updatedAt as Date, 1));
      const submitted = ["SUBMITTED", "ACKNOWLEDGED", "REJECTED_BY_AUTHORITY"].includes(reportStatus);
      const needsApproval = reportStatus !== "DRAFT";
      const reportMaker = pick(makers.filter((user) => user.role === "OPERATOR"));
      const reportApproval = needsApproval
        ? approval({
            subjectType: "REGULATORY_REPORT", subjectId: reportId, payload: { reportType: "SUSPICIOUS_ACTIVITY" }, maker: reportMaker,
            checker: checkerFor(String(reportMaker.id), "MLRO"), state: reportStatus === "PENDING_CHECKER" ? "PENDING_REVIEW" : "EXECUTED",
            createdAt: reportAt, decidedAt: addMinutes(reportAt, ctx.rng.int(60, 24 * 60)),
          })
        : null;
      const row: Row = {
        id: reportId, createdAt: reportAt, updatedAt: reportApproval?.updatedAt ?? reportAt, reportType: "SUSPICIOUS_ACTIVITY", authority: "CBL",
        subjectType: amlCase.subjectType, subjectId: amlCase.subjectId, amlCaseId: amlCase.id,
        periodStart: addDays(amlCase.createdAt as Date, -30), periodEnd: amlCase.createdAt, status: reportStatus,
        payloadCiphertext: "", payloadSha256: createHash("sha256").update(plaintext).digest("hex"),
        submissionRef: submitted ? `CBL-STR-${ctx.config.namespace.toUpperCase()}-${ctx.rng.int(10000, 99999)}` : null,
        submittedAt: submitted ? clamp(addMinutes(row_updated(reportApproval, reportAt), ctx.rng.int(30, 240))) : null,
        confidential: true, approvalRequestId: reportApproval?.id ?? null,
      };
      ctx.dataset.regulatoryReports.push(row);
      meta.pendingSecrets.push({ row, field: "payloadCiphertext", plaintext: JSON.stringify(plaintext), keyId: "reporting-payload", mode: "context" });
      amlCase.regulatoryReportId = reportId;
    }
  }

  // ---------------------------------------------------- join request approvals
  for (const merchant of merchants) {
    const info = meta.merchants.get(String(merchant.id));
    const join = joinByMerchant.get(String(merchant.id));
    if (!info?.join || !join) continue;
    const reviewer = staff.find((user) => user.id === join.assignedReviewerId);
    if (!reviewer || !reviewer.isMaker) continue;
    if (join.status === "PENDING_CHECKER") {
      const row = approval({
        subjectType: "JOIN_REQUEST", subjectId: String(join.id), payload: { decision: "APPROVED", proposedRiskTier: join.proposedRiskTier },
        maker: reviewer, checker: null, state: "PENDING_REVIEW", createdAt: info.join.proposedAt ?? addMinutes(join.submittedAt as Date, 600),
      });
      join.approvalRequestId = row.id;
    } else if (["APPROVED", "REJECTED"].includes(String(join.status)) && join.fourEyesRequired && info.join.proposedAt && info.join.decidedAt) {
      const checker = checkerFor(String(reviewer.id));
      const row = approval({
        subjectType: "JOIN_REQUEST", subjectId: String(join.id),
        payload: { decision: join.status === "APPROVED" ? "APPROVED" : "REJECTED", reasonCode: join.decisionReasonCode, proposedRiskTier: join.proposedRiskTier },
        maker: reviewer, checker, state: join.status === "APPROVED" ? "EXECUTED" : "REJECTED", createdAt: info.join.proposedAt, decidedAt: info.join.decidedAt,
      });
      join.approvalRequestId = row.id;
      audit(checker ?? reviewer, join.status === "APPROVED" ? "JOIN_REQUEST_APPROVED" : "JOIN_REQUEST_REJECTED", "JOIN_REQUEST", String(join.id), info.join.decidedAt, { status: "PENDING_CHECKER" }, { status: join.status }, String(row.id));
    } else if (["APPROVED", "REJECTED"].includes(String(join.status)) && info.join.decidedAt) {
      audit(reviewer, join.status === "APPROVED" ? "JOIN_REQUEST_APPROVED" : "JOIN_REQUEST_REJECTED", "JOIN_REQUEST", String(join.id), info.join.decidedAt, { status: "IN_REVIEW" }, { status: join.status });
    }
    // Suspensions and closures were decided by a checker.
    if (merchant.status === "SUSPENDED" && merchant.suspendedAt) {
      const maker = pick(makers);
      const checker = checkerFor(String(maker.id));
      const row = approval({
        subjectType: "MERCHANT", subjectId: String(merchant.id), payload: { kind: "SUSPEND", reasonCode: merchant.suspensionReasonCode, baseVersion: 1 },
        maker, checker, state: "EXECUTED", createdAt: addMinutes(merchant.suspendedAt as Date, -ctx.rng.int(30, 600)), decidedAt: merchant.suspendedAt as Date, baseVersion: 1,
      });
      audit(checker ?? maker, "MERCHANT_SUSPENDED", "MERCHANT", String(merchant.id), merchant.suspendedAt as Date, { status: "ACTIVE" }, { status: "SUSPENDED", reason: merchant.suspensionReasonCode }, String(row.id));
    }
  }
  // Two live emergency suspensions waiting for ratification.
  const emergencyCandidates = merchants.filter((merchant) => merchant.status === "ACTIVE");
  for (let index = 0; index < Math.min(2, emergencyCandidates.length); index += 1) {
    const merchant = emergencyCandidates[index]!;
    const maker = pick(makers);
    approval({
      subjectType: "MERCHANT", subjectId: String(merchant.id), payload: { kind: "SUSPEND_EMERGENCY", reasonCode: "FRAUD", baseVersion: 1 },
      maker, checker: null, state: "PENDING_REVIEW", mode: "EMERGENCY_RATIFICATION", createdAt: addMinutes(end, -ctx.rng.int(60, 12 * 60)), baseVersion: 1,
    });
  }

  // ------------------------------------------------------ adjustment approvals
  for (const adjustment of ctx.dataset.adjustments) {
    if (adjustment.state === "DRAFT") continue;
    const system = adjustment.draftedBySystem && systemUser ? systemUser : null;
    const maker = system ?? pick(makers.filter((user) => ["OPERATOR", "GATEWAY_ADMIN", "SECURITY_ADMIN"].includes(String(user.role))));
    const needsFinance = adjustment.type === "CHARGEBACK" || adjustment.type === "CASHOUT_SUBTRACTION" || adjustment.type === "REFUND";
    const checker = checkerFor(String(maker.id), needsFinance ? "FINANCE" : "SECURITY_ADMIN", "FINANCE");
    const state = String(adjustment.state);
    const row = approval({
      subjectType: "ADJUSTMENT", subjectId: String(adjustment.id), payload: { type: adjustment.type, outcome: "PENDING", amount: adjustment.amount },
      maker, checker, state: state === "EXECUTING" ? "APPROVED" : state === "PENDING_REVIEW" ? "PENDING_REVIEW" : state,
      createdAt: adjustment.createdAt as Date, decidedAt: adjustment.updatedAt as Date,
    });
    if (state === "EXECUTED" && checker) {
      audit(checker, "ADJUSTMENT_EXECUTED", "ADJUSTMENT", String(adjustment.id), adjustment.updatedAt as Date, { state: "APPROVED", type: adjustment.type }, { state: "EXECUTED", type: adjustment.type, journalEntryId: adjustment.journalEntryId, amount: adjustment.amount }, String(row.id));
    }
  }
  for (const dispute of ctx.dataset.disputes) {
    audit(systemUser ?? pick(staff), "DISPUTE_OPENED", "DISPUTE", String(dispute.id), dispute.openedAt as Date, {}, { status: "OPENED", amount: dispute.amount, externalDisputeRef: dispute.externalDisputeRef });
  }

  // ------------------------------------------- gateway version approvals
  const versions = new Map(ctx.dataset.gatewayVersions.map((version) => [String(version.id), version]));
  for (const id of pendingVersionIds.get(ctx) ?? []) {
    const version = versions.get(id)!;
    const maker = staff.find((user) => user.id === version.createdById) ?? pick(makers);
    const row = approval({ subjectType: "GATEWAY_VERSION", subjectId: id, payload: { action: "ACTIVATE" }, maker, checker: null, state: "PENDING_REVIEW", createdAt: addMinutes(version.createdAt as Date, 90) });
    version.approvalRequestId = row.id;
  }
  for (const id of rolledBackVersionIds.get(ctx) ?? []) {
    const version = versions.get(id)!;
    const maker = staff.find((user) => user.id === version.createdById) ?? pick(makers);
    const checker = checkerFor(String(maker.id), "SECURITY_ADMIN");
    const row = approval({ subjectType: "GATEWAY_VERSION", subjectId: id, payload: { action: "ACTIVATE" }, maker, checker, state: "EXECUTED", createdAt: addMinutes(version.createdAt as Date, 90), decidedAt: addDays(version.createdAt as Date, 1) });
    version.approvalRequestId = row.id;
    audit(checker ?? maker, "GATEWAY_VERSION_PROMOTED", "GATEWAY_VERSION", id, row.updatedAt as Date, { state: "PENDING_APPROVAL" }, { state: "LIVE" }, String(row.id));
  }
  // Negotiated commission profiles went through a checker.
  for (const profile of ctx.dataset.commissionProfiles) {
    if (!profile.merchantId || !ctx.rng.chance(20)) continue;
    const maker = pick(makers.filter((user) => ["OPERATOR", "GATEWAY_ADMIN", "SECURITY_ADMIN"].includes(String(user.role))));
    const checker = checkerFor(String(maker.id), "FINANCE");
    const row = approval({ subjectType: "COMMISSION_PROFILE", subjectId: String(profile.id), payload: { effectiveFrom: profile.effectiveFrom }, maker, checker, state: "EXECUTED", createdAt: addMinutes(profile.createdAt as Date, -600), decidedAt: profile.createdAt as Date });
    profile.approvalRequestId = row.id;
  }

  // ----------------------------------------------------------- notifications
  const templates = ctx.refs.notificationTemplates ?? [];
  const hasTemplate = (code: string, channel: string, lang: string) => templates.length === 0 || templates.some((t) => t.code === code && t.channel === channel && t.lang === lang);
  const merchantById = new Map(merchants.map((merchant) => [String(merchant.id), merchant]));
  const notify = (code: string, entityId: string, merchantId: string | null, userId: string | null, at: Date, payload: Record<string, unknown>): void => {
    const known = templates.filter((t) => t.code === code);
    const channel = known.length > 0 ? pick(known).channel : "EMAIL";
    const lang = ctx.rng.chance(70) ? "AR" : "EN";
    if (!hasTemplate(code, channel, lang)) return;
    const merchant = merchantId ? merchantById.get(merchantId) : null;
    const address = channel === "EMAIL" ? String(merchant?.contactEmail ?? "ops@example.ly") : String(merchant?.contactPhone ?? "0911234567");
    const when = clamp(at);
    const ageHours = (end.getTime() - when.getTime()) / 3_600_000;
    const status = ageHours < 0.1 ? "QUEUED" : ageHours < 1 ? "SENT" : ctx.rng.weighted({ DELIVERED: 94, FAILED: 4, SUPPRESSED: 2 }) as string;
    const row: Row = {
      id: ctx.nextId("notification"), createdAt: when, updatedAt: clamp(addMinutes(when, status === "QUEUED" ? 0 : 1)),
      eventId: `${code}:${entityId}:${channel}`, recipientUserId: userId, recipientMerchantId: merchantId,
      addressMasked: channel === "EMAIL" ? `${address.slice(0, 2)}***@${address.split("@")[1] ?? "example.ly"}` : `*******${address.slice(-4)}`,
      addressCiphertext: "", templateCode: code, channel, lang, payloadJson: payload, status,
      providerMessageId: status === "QUEUED" || status === "SUPPRESSED" ? null : `msg-${sha256Like(ctx, `${code}:${entityId}`).slice(0, 12)}`,
      attempts: status === "QUEUED" ? 0 : status === "FAILED" ? 3 : 1,
      nextAttemptAt: status === "QUEUED" ? addMinutes(when, 1) : null,
    };
    ctx.dataset.notifications.push(row);
    meta.pendingSecrets.push({ row, field: "addressCiphertext", plaintext: address, keyId: "notification-address", mode: "secret" });
  };
  for (const dispute of ctx.dataset.disputes) {
    const attempt = attemptById.get(String(dispute.attemptId));
    if (attempt) notify("DISPUTE_OPENED", String(dispute.id), String(attempt.merchantId), null, dispute.openedAt as Date, { reference: attempt.reference, amount: dispute.amount });
  }
  for (const cashout of ctx.dataset.cashoutRequests) {
    notify("CASHOUT_REQUESTED", String(cashout.id), String(cashout.merchantId), null, cashout.createdAt as Date, { amount: cashout.amount });
  }
  const sample = ctx.dataset.paymentAttempts.filter(() => ctx.rng.next() < Math.min(1, 600 / Math.max(1, ctx.dataset.paymentAttempts.length)));
  for (const attempt of sample) {
    if (!["SUCCEEDED", "FAILED"].includes(String(attempt.status)) || !attempt.terminalAt) continue;
    notify(attempt.status === "SUCCEEDED" ? "PAYMENT_SUCCEEDED" : "PAYMENT_FAILED", String(attempt.id), String(attempt.merchantId), null, attempt.terminalAt as Date, { reference: attempt.reference, amount: attempt.totalChargedAmount });
  }
  for (const pending of ctx.dataset.approvalRequests.filter((row) => row.state === "PENDING_REVIEW")) {
    const checker = checkerFor(String(pending.makerUserId));
    if (checker) notify("APPROVAL_REQUIRED", String(pending.id), null, String(checker.id), pending.createdAt as Date, { subjectType: pending.subjectType });
  }

  // -------------------------------------------------------- detail change logs
  for (const merchant of merchants) {
    const info = meta.merchants.get(String(merchant.id));
    if (!info?.adminUserId || !merchant.activatedAt || !ctx.rng.chance(12)) continue;
    const at = between(ctx, addDays(merchant.activatedAt as Date, 10), end);
    ctx.dataset.detailChangeLogs.push({
      id: ctx.nextId("detail-change"), createdAt: at, updatedAt: at, actorId: info.adminUserId, merchantId: merchant.id,
      entityType: "Merchant", entityId: merchant.id, fieldName: "contact_phone", oldValue: `09${ctx.rng.int(1, 5)}${String(ctx.rng.int(0, 9_999_999)).padStart(7, "0")}`,
      newValue: merchant.contactPhone, approvalRequestId: null, source: "PORTAL", requestId: sha256Like(ctx, `detail:${merchant.id}`).slice(0, 16),
      clientIp: `203.0.113.${ctx.rng.int(1, 250)}`,
    });
  }
};

const row_updated = (row: Row | null, fallback: Date): Date => (row ? (row.updatedAt as Date) : fallback);
