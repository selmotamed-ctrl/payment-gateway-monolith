import { Decimal } from "decimal.js";
import { buildLedgerTemplate, decimal, refundScenarioFor, type JournalTemplate, type LedgerPostContext } from "../../../engine/ledger/LedgerPoster";
import { metaOf, type SeederContext } from "../context";
import { addDays, addMinutes, between, ensureSystemAccounts, postTemplate, sha256Like } from "../builders";

const r4 = (value: Decimal.Value): Decimal => new Decimal(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

const REFUND_STATE_FOR_OPEN = { DRAFT: 15, PENDING_REVIEW: 45, APPROVED: 20, REJECTED: 20 } as const;
const DISPUTE_STATUS = { OPENED: 20, EVIDENCE_REQUESTED: 15, EVIDENCE_SUBMITTED: 15, WON: 22, LOST: 18, EXPIRED: 10 } as const;
const CASHOUT_STATE_OLD = { COMPLETE: 86, REJECTED: 14 } as const;

/**
 * Refunds, chargebacks (disputes), manual adjustments and cash-outs.
 *
 * Every executed adjustment carries the journal entry the real executor
 * (`executeAdjustment`) would post, with the engine's own template, keyed
 * `(ADJUSTMENT|DISPUTE_OUTCOME|FEE_VARIANCE, adjustment.id | dispute.id)`.
 * The attempt status is advanced along `SUCCEEDED -> REFUNDED |
 * PARTIALLY_REFUNDED | DISPUTED` only when the event happened before the
 * simulation clock. Cash-outs and manual debits are sized so that a wallet
 * never goes below zero at any instant (the negative-balance ceiling would
 * otherwise hold them in a P1 case).
 */
export const generateDisputesCashoutsAdjustments = (ctx: SeederContext): void => {
  const meta = metaOf(ctx);
  const end = ctx.timeline.end;
  const system = ensureSystemAccounts(ctx);
  const attemptsById = new Map(ctx.dataset.paymentAttempts.map((attempt) => [String(attempt.id), attempt]));
  const gatewayInfo = new Map(ctx.refs.routes.map((route) => [route.id, route]));
  const accountsOf = (attempt: Record<string, unknown>): LedgerPostContext => {
    const info = meta.attempts.get(String(attempt.id))!;
    return {
      merchantId: String(attempt.merchantId), credentialSetId: String(attempt.credentialSetId), env: String(attempt.env),
      currency: "LYD", accounts: { MERCHANT_WALLET: info.walletGlAccountId },
    };
  };
  const advance = (attempt: Record<string, unknown>, status: string, at: Date): void => {
    const info = meta.attempts.get(String(attempt.id))!;
    info.path = [...info.path, status];
    info.times = [...info.times, at];
    attempt.status = status;
    attempt.updatedAt = at;
  };
  const execJournal = (template: JournalTemplate, refId: string, refType: string | null, context: LedgerPostContext, at: Date): string =>
    postTemplate(ctx, { ...template, refId, ...(refType ? { refType } : {}) }, context, at);

  const settled = ctx.dataset.paymentAttempts.filter((attempt) => {
    const info = meta.attempts.get(String(attempt.id));
    return info && attempt.status === "SUCCEEDED" && (info.kind === "NORMAL" || info.kind === "LATE_SUCCESS") && attempt.terminalAt;
  });
  const splitCommission = (attempt: Record<string, unknown>, amount: Decimal): { commission: Decimal; merchant: Decimal } => {
    const total = decimal(String(attempt.totalChargedAmount));
    const commission = total.isZero() ? new Decimal(0) : r4(decimal(String(attempt.platformCommissionAmount)).mul(amount).div(total));
    return { commission, merchant: amount.minus(commission) };
  };
  const walletGl = (attempt: Record<string, unknown>): string => meta.attempts.get(String(attempt.id))!.walletGlAccountId;

  // ----------------------------------------------------------------- refunds
  const refundIds: string[] = [];
  const addRefund = (attempt: Record<string, unknown>, full: boolean): boolean => {
    const info = meta.attempts.get(String(attempt.id))!;
    const at = addMinutes(new Date(attempt.terminalAt as Date), ctx.rng.int(60, 20 * 24 * 60));
    if (at.getTime() > end.getTime()) return false;
    const total = decimal(String(attempt.totalChargedAmount));
    const amount = full ? total : r4(total.mul(ctx.rng.int(30, 70)).div(100).toDecimalPlaces(2));
    if (!amount.gt(0)) return false;
    const { commission, merchant } = splitCommission(attempt, amount);
    const refundScenario = refundScenarioFor(info.ownershipMode);
    const template = buildLedgerTemplate(refundScenario.scenario, {
      amount, commissionAmount: commission, merchantAmount: merchant, stage: refundScenario.stage,
    });
    // A merchant-direct refund only reverses commission. With none to reverse nothing would be
    // booked, and the seeded dataset requires every executed adjustment to carry a journal entry.
    if (template.lines.length === 0) return false;
    const adjustmentId = ctx.nextId("adjustment");
    const journalId = execJournal(template, adjustmentId, "ADJUSTMENT", accountsOf(attempt), at);
    ctx.dataset.adjustments.push({
      id: adjustmentId, createdAt: addMinutes(at, -ctx.rng.int(5, 240)), updatedAt: at, type: "REFUND",
      targetGlAccountId: walletGl(attempt), sourceAttemptId: attempt.id, disputeId: null, draftedBySystem: false,
      amount: amount.toFixed(4), reverseCommission: true, reason: full ? "Merchant-requested full refund" : "Merchant-requested partial refund",
      externalDisputeRef: null, providerRefundRef: `RF-${ctx.config.namespace}-${sha256Like(ctx, adjustmentId).slice(0, 10).toUpperCase()}`,
      state: "EXECUTED", journalEntryId: journalId,
    });
    advance(attempt, full ? "REFUNDED" : "PARTIALLY_REFUNDED", at);
    info.refund = { at, amount: amount.toFixed(4), full };
    refundIds.push(adjustmentId);
    return true;
  };
  for (const attempt of settled) {
    const info = meta.attempts.get(String(attempt.id))!;
    if (info.postSettlement === "REFUNDED") addRefund(attempt, true);
    else if (info.postSettlement === "PARTIALLY_REFUNDED") addRefund(attempt, false);
  }

  // ---------------------------------------------------------------- disputes
  // Only platform-cleared payments are disputed (a card chargeback needs the
  // platform-held reserve; MERCHANT_DIRECT money never sits in clearing).
  const disputable = settled.filter((attempt) => {
    const info = meta.attempts.get(String(attempt.id))!;
    return attempt.status === "SUCCEEDED" && info.ownershipMode === "PLATFORM_CLEARING";
  });
  const wanted = new Set<string>(disputable.filter((attempt) => meta.attempts.get(String(attempt.id))!.postSettlement === "DISPUTED").map((attempt) => String(attempt.id)));
  const extra = Math.max(0, ctx.config.volumes.disputes - wanted.size);
  for (let index = 0; index < extra && disputable.length > 0; index += 1) {
    wanted.add(String(disputable[Math.floor(ctx.rng.next() * disputable.length)]!.id));
  }
  let disputeCount = 0;
  for (const attemptId of wanted) {
    if (disputeCount >= Math.max(ctx.config.volumes.disputes, 1) * 2) break;
    const attempt = attemptsById.get(attemptId)!;
    if (attempt.status !== "SUCCEEDED") continue;
    const info = meta.attempts.get(attemptId)!;
    const route = gatewayInfo.get(String(attempt.routeId));
    if (!route) continue;
    const openedAt = addMinutes(new Date(attempt.terminalAt as Date), ctx.rng.int(2 * 24 * 60, 45 * 24 * 60));
    if (openedAt.getTime() > end.getTime()) continue;
    const status = ctx.rng.weighted(DISPUTE_STATUS) as string;
    const outcome = ["WON", "LOST", "EXPIRED"].includes(status);
    const outcomeAt = outcome ? between(ctx, addDays(openedAt, 5), addDays(openedAt, 40)) : null;
    if (outcomeAt && outcomeAt.getTime() > end.getTime()) continue;
    const disputeId = ctx.nextId("dispute");
    const adjustmentId = ctx.nextId("adjustment");
    const externalRef = `DSP-${ctx.config.namespace.toUpperCase()}-${sha256Like(ctx, attemptId).slice(0, 12).toUpperCase()}`;
    const total = decimal(String(attempt.totalChargedAmount));
    const commission = Decimal.min(decimal(String(attempt.platformCommissionAmount)), total);
    const merchant = total.minus(commission);
    const accounts = accountsOf(attempt);
    // Intake: the reserve is escrowed in the same transaction as the draft.
    execJournal(
      buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", { amount: total, commissionAmount: commission, merchantAmount: merchant, stage: "RESERVE" }),
      disputeId, "DISPUTE_OUTCOME", accounts, openedAt,
    );
    let adjustmentState = "PENDING_REVIEW";
    let journalEntryId: string | null = null;
    let updatedAt = openedAt;
    if (outcome) {
      const at = outcomeAt!;
      const template = status === "WON"
        ? buildLedgerTemplate("CHARGEBACK_WON", { amount: total, commissionAmount: commission, merchantAmount: merchant })
        : buildLedgerTemplate("CHARGEBACK_RESERVE_AND_LOST", { amount: total, commissionAmount: commission, merchantAmount: merchant, stage: "LOST" });
      journalEntryId = execJournal(template, adjustmentId, "DISPUTE_OUTCOME", accounts, at);
      adjustmentState = "EXECUTED";
      updatedAt = at;
    }
    ctx.dataset.disputes.push({
      id: disputeId, createdAt: openedAt, updatedAt, attemptId, gatewayId: route.gatewayId, railId: route.railId,
      externalDisputeRef: externalRef, source: ctx.rng.weighted({ WEBHOOK: 70, STATEMENT: 20, MANUAL: 10 }),
      reasonCode: ctx.rng.pick(["FRAUD", "PRODUCT_NOT_RECEIVED", "DUPLICATE", "AUTHORIZATION_ISSUE", "OTHER"]),
      amount: total.toFixed(4), currency: "LYD", status, openedAt,
      evidenceDueAt: addDays(openedAt, ctx.rng.int(7, 21)), outcomeAt, adjustmentId,
      evidenceJson: ["EVIDENCE_SUBMITTED", "WON", "LOST"].includes(status) ? { documents: ["receipt.pdf", "delivery-note.pdf"] } : null,
    });
    ctx.dataset.adjustments.push({
      id: adjustmentId, createdAt: openedAt, updatedAt, type: "CHARGEBACK", targetGlAccountId: info.walletGlAccountId,
      sourceAttemptId: attemptId, disputeId, draftedBySystem: true, amount: total.toFixed(4), reverseCommission: true,
      reason: `Chargeback drafted for dispute ${externalRef}`, externalDisputeRef: externalRef, providerRefundRef: null,
      state: adjustmentState, journalEntryId,
    });
    advance(attempt, "DISPUTED", openedAt);
    info.dispute = { at: openedAt };
    disputeCount += 1;
  }

  // ------------------------------------------- wallet timelines (balance guard)
  const walletIds = new Set(ctx.dataset.wallets.map((wallet) => String(wallet.glAccountId)));
  const timelines = new Map<string, Array<{ at: number; delta: Decimal }>>();
  const record = (glId: string, at: Date, delta: Decimal): void => {
    const list = timelines.get(glId) ?? [];
    list.push({ at: at.getTime(), delta });
    timelines.set(glId, list);
  };
  for (const line of ctx.dataset.journalLines) {
    const glId = String(line.glAccountId);
    if (!walletIds.has(glId)) continue;
    const amount = decimal(String(line.amount));
    record(glId, line.createdAt as Date, line.direction === "CREDIT" ? amount : amount.neg());
  }
  /** Can `amount` leave the wallet at `at` without the balance ever going below `reserve` afterwards? */
  const canWithdraw = (glId: string, at: Date, amount: Decimal, reserve: Decimal): boolean => {
    const events = [...(timelines.get(glId) ?? []), { at: at.getTime(), delta: amount.neg() }].sort((a, b) => a.at - b.at);
    let running = new Decimal(0);
    for (const event of events) {
      running = running.plus(event.delta);
      if (event.at >= at.getTime() && running.lt(reserve)) return false;
    }
    return true;
  };

  // ----------------------------------------------------------- cash-outs
  const merchantsById = new Map(ctx.dataset.merchants.map((merchant) => [String(merchant.id), merchant]));
  const merchantInfos = [...meta.merchants.values()].filter((merchant) => merchant.activatedAt && ["ACTIVE", "SUSPENDED", "CLOSED"].includes(merchant.status));
  let cashoutCount = 0;
  for (let attemptNo = 0; attemptNo < ctx.config.volumes.cashouts * 4 && cashoutCount < ctx.config.volumes.cashouts && merchantInfos.length > 0; attemptNo += 1) {
    const merchant = merchantInfos[Math.floor(ctx.rng.next() * merchantInfos.length)]!;
    const wallet = merchant.wallets[0]!;
    const recent = ctx.rng.chance(12) && merchant.status === "ACTIVE";
    const lo = new Date(merchant.activatedAt!.getTime() + 7 * 86_400_000);
    const hi = new Date(Math.min((merchant.stoppedAt ?? end).getTime() - 86_400_000, end.getTime() - 4 * 3_600_000));
    if (hi <= lo) continue;
    const createdAt = recent ? new Date(end.getTime() - ctx.rng.int(2, 60) * 3_600_000) : between(ctx, lo, hi);
    if (createdAt.getTime() > hi.getTime() && !recent) continue;
    const requested = r4(ctx.rng.decimal(50, 25_000, 4));
    const amount = requested;
    const reserveBuffer = new Decimal(20);
    // Largest amount that keeps the wallet >= buffer at every later instant.
    let approved = amount;
    for (let shrink = 0; shrink < 6 && !canWithdraw(wallet.glAccountId, createdAt, approved, reserveBuffer); shrink += 1) approved = r4(approved.div(2));
    if (approved.lt(50) || !canWithdraw(wallet.glAccountId, createdAt, approved, reserveBuffer)) continue;
    const merchantRow = merchantsById.get(merchant.id);
    const state = recent ? ctx.rng.weighted({ PENDING: 70, PROCESSING: 30 }) as string : ctx.rng.weighted(CASHOUT_STATE_OLD) as string;
    const cashoutId = ctx.nextId("cashout");
    let adjustmentId: string | null = null;
    let updatedAt = createdAt;
    if (state === "COMPLETE" || state === "REJECTED") {
      const decidedAt = addMinutes(createdAt, ctx.rng.int(4 * 60, 72 * 60));
      if (decidedAt.getTime() > end.getTime()) continue;
      adjustmentId = ctx.nextId("adjustment");
      updatedAt = decidedAt;
      let journalEntryId: string | null = null;
      if (state === "COMPLETE") {
        journalEntryId = execJournal(buildLedgerTemplate("CASHOUT", { amount: approved }), adjustmentId, "ADJUSTMENT", {
          merchantId: merchant.id, currency: "LYD", accounts: { MERCHANT_WALLET: wallet.glAccountId },
        }, decidedAt);
        record(wallet.glAccountId, decidedAt, approved.neg());
      }
      ctx.dataset.adjustments.push({
        id: adjustmentId, createdAt: decidedAt, updatedAt: decidedAt, type: "CASHOUT_SUBTRACTION", targetGlAccountId: wallet.glAccountId,
        sourceAttemptId: null, disputeId: null, draftedBySystem: false, amount: approved.toFixed(4), reverseCommission: false,
        reason: state === "COMPLETE" ? `Cash-out execution for request ${cashoutId}` : `Cash-out rejected for request ${cashoutId}: payout account under review`,
        externalDisputeRef: null, providerRefundRef: null, state: state === "COMPLETE" ? "EXECUTED" : "REJECTED", journalEntryId,
      });
    }
    ctx.dataset.cashoutRequests.push({
      id: cashoutId, createdAt, updatedAt, merchantId: merchant.id, walletId: wallet.id, amount: approved.toFixed(4),
      destinationBankJson: merchantRow?.payoutBankDetailsJson ?? { bank: "Jumhouria Bank" }, state, adjustmentId,
    });
    cashoutCount += 1;
  }

  // ------------------------------------------------- manual adjustments
  const needed = Math.max(0, ctx.config.volumes.adjustments - ctx.dataset.adjustments.length);
  const withWallets = merchantInfos.filter((merchant) => merchant.wallets.length > 0);
  for (let index = 0; index < needed && withWallets.length > 0; index += 1) {
    const merchant = withWallets[Math.floor(ctx.rng.next() * withWallets.length)]!;
    const wallet = merchant.wallets[0]!;
    const type = ctx.rng.weighted({ MANUAL_CREDIT: 35, MANUAL_DEBIT: 45, CORRECTION: 20 }) as string;
    const state = ctx.rng.weighted({ EXECUTED: 55, PENDING_REVIEW: 20, DRAFT: 8, APPROVED: 7, REJECTED: 10 }) as string;
    const lo = new Date(merchant.activatedAt!.getTime() + 3 * 86_400_000);
    const hi = new Date(Math.min((merchant.stoppedAt ?? end).getTime() - 3_600_000, end.getTime() - 3_600_000));
    if (hi <= lo) continue;
    const createdAt = state === "PENDING_REVIEW" || state === "DRAFT" || state === "APPROVED" ? between(ctx, new Date(Math.max(lo.getTime(), end.getTime() - 20 * 86_400_000)), hi) : between(ctx, lo, hi);
    const amount = r4(ctx.rng.decimal(5, 200, 4));
    const adjustmentId = ctx.nextId("adjustment");
    let journalEntryId: string | null = null;
    let updatedAt = createdAt;
    if (state === "EXECUTED") {
      const at = addMinutes(createdAt, ctx.rng.int(60, 48 * 60));
      if (at.getTime() > end.getTime()) continue;
      if (type === "MANUAL_DEBIT" && !canWithdraw(wallet.glAccountId, at, amount, new Decimal(20))) continue;
      const context = { merchantId: merchant.id, currency: "LYD", accounts: { MERCHANT_WALLET: wallet.glAccountId } } as LedgerPostContext;
      if (type === "MANUAL_DEBIT") {
        journalEntryId = execJournal(buildLedgerTemplate("CASHOUT", { amount }), adjustmentId, "ADJUSTMENT", context, at);
        record(wallet.glAccountId, at, amount.neg());
      } else if (type === "MANUAL_CREDIT") {
        journalEntryId = execJournal(buildLedgerTemplate("INTERNAL_CONFIRMATION", { amount, commissionAmount: 0, merchantAmount: amount }), adjustmentId, "ADJUSTMENT", context, at);
        record(wallet.glAccountId, at, amount);
      } else {
        journalEntryId = execJournal(buildLedgerTemplate("FEE_VARIANCE_TRUE_UP", { amount, varianceAmount: amount }), adjustmentId, null, context, at);
      }
      updatedAt = at;
    }
    ctx.dataset.adjustments.push({
      id: adjustmentId, createdAt, updatedAt, type, targetGlAccountId: wallet.glAccountId, sourceAttemptId: null, disputeId: null,
      draftedBySystem: false, amount: amount.toFixed(4), reverseCommission: false,
      reason: type === "CORRECTION" ? "Gateway fee variance true-up" : type === "MANUAL_CREDIT" ? "Goodwill credit after a failed settlement" : "Manual debit: duplicate payout reversal",
      externalDisputeRef: null, providerRefundRef: null, state, journalEntryId,
    });
  }

  // Open refund requests that were not executed yet (no ledger effect).
  const openRefunds = Math.round(ctx.config.volumes.adjustments * 0.05);
  const candidates = settled.filter((attempt) => attempt.status === "SUCCEEDED" && (attempt.terminalAt as Date).getTime() > end.getTime() - 25 * 86_400_000);
  for (let index = 0; index < openRefunds && candidates.length > 0; index += 1) {
    const attempt = candidates[Math.floor(ctx.rng.next() * candidates.length)]!;
    const createdAt = between(ctx, new Date(attempt.terminalAt as Date), end);
    const state = ctx.rng.weighted(REFUND_STATE_FOR_OPEN) as string;
    ctx.dataset.adjustments.push({
      id: ctx.nextId("adjustment"), createdAt, updatedAt: createdAt, type: "REFUND", targetGlAccountId: walletGl(attempt),
      sourceAttemptId: attempt.id, disputeId: null, draftedBySystem: false, amount: String(attempt.totalChargedAmount),
      reverseCommission: true, reason: "Merchant-requested refund", externalDisputeRef: null, providerRefundRef: null, state, journalEntryId: null,
    });
  }
  void system;
  void refundIds;
};
