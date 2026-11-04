import { Decimal } from "decimal.js";
import {
  buildLedgerTemplate,
  buildPaymentConfirmationTemplate,
  decimal,
  type LedgerPostContext,
} from "../../../engine/ledger/LedgerPoster";
import { shardIdForAttempt } from "../../../lib/storageEngine/shardBalances";
import { metaOf, type SeederContext } from "../context";
import { addMinutes, ensureSystemAccounts, postTemplate } from "../builders";

/** Resolves the posting context the engine builds for an attempt (`ledgerContext`). */
const contextOf = (attempt: Record<string, unknown>, walletGlAccountId: string): LedgerPostContext => ({
  merchantId: String(attempt.merchantId),
  credentialSetId: String(attempt.credentialSetId),
  env: String(attempt.env),
  currency: String(attempt.currency),
  accounts: { MERCHANT_WALLET: walletGlAccountId },
});

const SLA_HOURS: Record<string, number> = { CRITICAL: 4, HIGH: 24, MEDIUM: 72, LOW: 120 };

/**
 * Posts every ledger movement of the generated attempts through the ENGINE's
 * own journal templates (`buildPaymentConfirmationTemplate` /
 * `buildLedgerTemplate`) and creates the AML hold cases that own the
 * escrowed payments. Refunds, chargebacks and cash-outs are posted by
 * generator 07; the monthly checkpoints are taken last (`generateCheckpoints`).
 */
export const generateLedger = (ctx: SeederContext): void => {
  const meta = metaOf(ctx);
  ensureSystemAccounts(ctx);
  const compliance = ctx.dataset.users.filter((user) => user.merchantId === null && user.status === "ACTIVE" && ["COMPLIANCE", "MLRO"].includes(user.role));
  const amlRule = ctx.dataset.amlRules.find((rule) => rule.ruleType === "SINGLE_AMOUNT");

  for (const attempt of ctx.dataset.paymentAttempts) {
    const info = meta.attempts.get(String(attempt.id));
    if (!info) continue;
    const accountsContext = contextOf(attempt, info.walletGlAccountId);
    const requested = decimal(String(attempt.requestedAmount));
    const total = decimal(String(attempt.totalChargedAmount));
    const commission = decimal(String(attempt.platformCommissionAmount));
    const net = decimal(String(attempt.netMerchantAmount));
    const fee = attempt.gatewayFeeAmount === null ? undefined : decimal(String(attempt.gatewayFeeAmount));
    const createdAt = new Date(attempt.createdAt as Date);
    const terminalAt = attempt.terminalAt ? new Date(attempt.terminalAt as Date) : null;

    const confirm = (at: Date): string =>
      postTemplate(ctx, {
        ...buildPaymentConfirmationTemplate({
          ownershipMode: info.ownershipMode,
          feeBearer: attempt.feeBearer as "MERCHANT_ABSORBS" | "PAYER_SURCHARGE" | "SPLIT",
          feeAccrual: info.feeAccrual,
          amount: requested,
          surchargeAmount: decimal(String(attempt.surchargeAmount)),
          commissionAmount: commission,
          merchantAmount: net,
          ...(fee === undefined ? {} : { gatewayFeeAmount: fee, providerFeeAmount: fee }),
        }),
        refId: String(attempt.id),
      }, accountsContext, at);

    const isAml = info.kind === "AML_HELD" || info.kind === "AML_RELEASED" || info.kind === "AML_VOIDED";
    if (isAml) {
      // Guard pipeline: Dr GATEWAY_CLEARING / Cr AML_HOLD at attempt creation.
      const hold = { ...buildLedgerTemplate("AML_HOLD_AND_RELEASE", { amount: total, commissionAmount: 0, merchantAmount: 0 }), refId: String(attempt.id) };
      const holdEntryId = postTemplate(ctx, hold, accountsContext, createdAt);
      info.holdEntryId = holdEntryId;
      const severity = amlRule ? String(amlRule.baseSeverity) : "HIGH";
      const resolvedAt = terminalAt;
      let status = info.kind === "AML_RELEASED" ? "RELEASED" : info.kind === "AML_VOIDED" ? "REJECTED_VOID" : ctx.rng.weighted({ OPEN: 30, IN_REVIEW: 25, PENDING_CHECKER: 20, FROZEN: 8, ESCALATED_STR: 17 }) as string;
      const assignee = status === "OPEN" && ctx.rng.chance(40) ? null : compliance[Math.floor(ctx.rng.next() * compliance.length)] ?? null;
      const caseUpdated = resolvedAt ?? addMinutes(createdAt, ctx.rng.int(5, 600));
      info.amlCaseStatus = status;
      info.amlSeverity = severity;
      if (info.kind === "AML_RELEASED") {
        // AML_HOLD_AND_RELEASE (RELEASE): Dr AML_HOLD / Cr wallet + income. The
        // attempt's ledger entry is the release posting (finalizeAmlAttempt).
        const release = {
          ...buildLedgerTemplate("AML_HOLD_AND_RELEASE", { amount: total, commissionAmount: commission, merchantAmount: total.minus(commission), stage: "RELEASE" }),
          refId: String(attempt.id),
        };
        attempt.ledgerEntryId = postTemplate(ctx, release, accountsContext, resolvedAt!);
      } else if (info.kind === "AML_VOIDED") {
        const voided = { ...buildLedgerTemplate("AML_VOID", { amount: total }), refId: String(attempt.id) };
        postTemplate(ctx, voided, accountsContext, resolvedAt!);
      }
      ctx.dataset.amlCases.push({
        id: ctx.nextId("aml-case"),
        createdAt,
        updatedAt: caseUpdated,
        subjectType: "PAYMENT_ATTEMPT",
        subjectId: attempt.id,
        triggerReason: `AML_RULE:${amlRule?.code ?? "AML-SINGLE-LARGE"}`,
        severity,
        severityInputsJson: [{ rule: amlRule?.code ?? "AML-SINGLE-LARGE", amount: total.toFixed(4), currency: "LYD" }],
        screeningId: null,
        ruleId: amlRule?.id ?? null,
        ruleVersion: amlRule ? 1 : null,
        holdJournalEntryId: holdEntryId,
        status,
        slaDueAt: addMinutes(createdAt, (SLA_HOURS[severity] ?? 24) * 60),
        assignedReviewerId: assignee?.id ?? null,
        regulatoryReportId: null,
        confidential: true,
        reviewerNotes: status === "RELEASED" ? "Source of funds verified; released." : status === "REJECTED_VOID" ? "Could not verify the source of funds; voided." : status === "PENDING_CHECKER" ? "Proposed release; awaiting MLRO." : null,
      });
      status = "";
      continue;
    }

    if (info.kind === "SUSPENSE") {
      // Slot already used by the winner: the money is parked in SUSPENSE.
      const template = {
        ...buildLedgerTemplate("SUSPENSE_SETTLEMENT", { amount: total, ownershipMode: info.ownershipMode }),
        refId: String(attempt.id),
      };
      attempt.ledgerEntryId = postTemplate(ctx, template, accountsContext, terminalAt!);
      const suspense = ctx.refs.glAccounts.find((account) => account.accountType === "SUSPENSE" && !account.gatewayId)!;
      ctx.dataset.adjustments.push({
        id: ctx.nextId("adjustment"),
        createdAt: terminalAt,
        updatedAt: terminalAt,
        type: "REFUND",
        targetGlAccountId: suspense.id,
        sourceAttemptId: attempt.id,
        disputeId: null,
        draftedBySystem: true,
        amount: total.toFixed(4),
        reverseCommission: false,
        reason: `Automatic refund draft: the settlement of attempt ${attempt.id} was routed to SUSPENSE because the payment link slot was already used.`,
        externalDisputeRef: null,
        providerRefundRef: null,
        state: "PENDING_REVIEW",
        journalEntryId: null,
      });
      continue;
    }

    if (String(attempt.status) === "SUCCEEDED" && terminalAt) {
      attempt.ledgerEntryId = confirm(terminalAt);
    }
  }
};

/**
 * Monthly GL checkpoints: for every account the balance up to the end of the
 * last COMPLETE month, taken AFTER every posting of every generator so the
 * live formula `checkpoint_balance + SUM(lines after checkpoint_at)` equals the
 * plain sum of all lines. Also fills the shard balances.
 */
export const generateCheckpoints = (ctx: SeederContext): void => {
  const accountTypeById = new Map<string, string>();
  for (const account of [...ctx.dataset.glAccounts, ...ctx.refs.glAccounts]) {
    accountTypeById.set(String(account.id), String(account.accountType));
  }
  const refIdByEntry = new Map<string, string>();
  for (const entry of ctx.dataset.journalEntries) refIdByEntry.set(String(entry.id), String(entry.refId));
  const shardTotals = new Map<string, { glAccountId: string; shardId: number; balance: Decimal }>();
  for (const line of ctx.dataset.journalLines) {
    const glAccountId = String(line.glAccountId);
    const accountType = accountTypeById.get(glAccountId);
    if (!accountType) continue;
    const refId = refIdByEntry.get(String(line.entryId)) ?? String(line.entryId);
    const shardId = shardIdForAttempt(refId, accountType);
    const key = `${glAccountId}:${shardId}`;
    const current = shardTotals.get(key) ?? { glAccountId, shardId, balance: new Decimal(0) };
    const amount = decimal(String(line.amount));
    current.balance = line.direction === "DEBIT" ? current.balance.plus(amount) : current.balance.minus(amount);
    shardTotals.set(key, current);
  }
  for (const shard of shardTotals.values()) {
    ctx.dataset.glAccountShards.push({
      glAccountId: shard.glAccountId,
      shardId: shard.shardId,
      currentBalance: shard.balance.toFixed(4),
      updatedAt: ctx.timeline.end,
    });
  }

  // Checkpoint = end of the last complete month (UTC), the same instant for every account.
  const end = ctx.timeline.end;
  const checkpointAt = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1) - 1);
  const checkpointId = `checkpoint-${checkpointAt.getUTCFullYear()}-${String(checkpointAt.getUTCMonth() + 1).padStart(2, "0")}`;
  const balances = new Map<string, Decimal>();
  for (const line of ctx.dataset.journalLines) {
    if ((line.createdAt as Date).getTime() > checkpointAt.getTime()) continue;
    const id = String(line.glAccountId);
    const amount = decimal(String(line.amount));
    balances.set(id, (balances.get(id) ?? new Decimal(0)).plus(line.direction === "DEBIT" ? amount : amount.neg()));
  }
  const accountIds = new Set<string>([...ctx.dataset.glAccounts.map((a) => String(a.id)), ...ctx.refs.glAccounts.map((a) => a.id)]);
  for (const accountId of accountIds) {
    ctx.checkpoints.set(accountId, { balance: (balances.get(accountId) ?? new Decimal(0)).toFixed(4), at: checkpointAt, lastCheckpointId: checkpointId });
  }
  for (const account of ctx.dataset.glAccounts) {
    const checkpoint = ctx.checkpoints.get(String(account.id))!;
    account.checkpointBalance = checkpoint.balance;
    account.checkpointAt = checkpoint.at;
    account.lastCheckpointId = checkpoint.lastCheckpointId;
  }
};

/** Kept for callers of the old name. */
export const generateLedgerAndCheckpoints = (ctx: SeederContext): void => {
  generateLedger(ctx);
  generateCheckpoints(ctx);
};
