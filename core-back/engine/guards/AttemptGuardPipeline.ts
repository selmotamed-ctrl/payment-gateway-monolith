import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../../lib/error";
import { moneyFromDecimal, moneyToString, type Money } from "../db/money";
import type {
  AmlAction,
  AttemptWindowStats,
  Channel,
  Environment,
  MerchantRow,
  PaymentAttemptRow,
  PaymentRepository,
  PrismaLike,
  Repositories,
  Severity,
  SettlementTarget,
  Tx,
  VelocityRuleRow,
} from "../db/ports";
import { buildLedgerTemplate, LedgerPoster } from "../ledger/LedgerPoster";
import { AmlRuleEngine, slaHoursForSeverity, type AmlRuleHit } from "./AmlRuleEngine";
import {
  buildScreeningSubject,
  normalizeIdentifier,
  publishWatchlist,
  type ScreeningProvider,
  type ScreeningResultCode,
} from "./ScreeningProvider";

export type GuardOutcome = "ALLOW" | "FLAG" | "HOLD" | "CASE_ONLY" | "BLOCK";

export interface GuardCustomerContext {
  phone?: string | null;
  ip?: string | null;
  cardAlias?: string | null;
  deviceFingerprint?: string | null;
  walletId?: string | null;
  name?: string | null;
}

/**
 * The configuration that is pinned on the attempt at creation
 * (design §9.1 rule 1).
 *
 * The caller resolves the route that the visible rails produced, so the
 * attempt is pinned to the route the customer was actually offered. When it
 * is absent the pipeline resolves the route itself.
 */
export interface GuardPinnedRoute {
  railId: string;
  routeId: string;
  credentialSetId: string;
  gatewayVersionId: string;
  commissionProfileId: string;
  settlementTarget?: SettlementTarget | null;
  gatewayId?: string | null;
  mode?: string | null;
}

/**
 * The monetary breakdown of the attempt.
 *
 * The amounts are resolved from the pinned commission profile and the pinned
 * route cost model by the caller, so the guard evaluates the AML rules
 * against the amount that is actually at stake and escrows exactly that
 * amount.
 */
export interface GuardAttemptAmounts {
  surchargeAmount?: string | null;
  totalChargedAmount?: string | null;
  platformCommissionAmount?: string | null;
  netMerchantAmount?: string | null;
  gatewayFeeAmount?: string | null;
}

export interface AttemptGuardRequest {
  linkKey: string;
  railCode: string;
  applicationId?: string | null;
  merchantId?: string | null;
  env: Environment;
  channel: Channel;
  mode?: string;
  subMode?: string | null;
  customer?: GuardCustomerContext;
  idempotencyKey?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  requestedByUserId?: string | null;
  pinnedRoute?: GuardPinnedRoute | null;
  amounts?: GuardAttemptAmounts | null;
  /** The already masked customer fields of the caller. */
  customerFields?: Record<string, unknown> | null;
  expiresAt?: Date | null;
  graceExpiresAt?: Date | null;
  nextCheckAt?: Date | null;
}

export interface GuardDecision {
  outcome: GuardOutcome;
  attemptId: string | null;
  reference: string | null;
  amount: Money;
  currency: string;
  severity: Severity | null;
  amlCaseId: string | null;
  velocityRuleIds: string[];
  amlHits: AmlRuleHit[];
  reasons: string[];
  customerMessageCode: string;
  holdRequired: boolean;
  settlementTarget: SettlementTarget;
  correlatedEscalation: boolean;
  slotReserved: boolean;
}

export interface AttemptGuardPipelineDeps {
  db: PrismaLike;
  repositories: Repositories;
  screening: ScreeningProvider;
  clock?: () => Date;
}

export interface VelocityEvaluation {
  rule: VelocityRuleRow;
  count: number;
  totalAmount: Money;
  exceeded: boolean;
}

interface ResolvedRoute {
  railId: string;
  routeId: string;
  credentialSetId: string;
  gatewayVersionId: string;
  commissionProfileId: string;
  mode: string;
}

/**
 * The monetary breakdown of an attempt, as exact money.
 */
interface ResolvedAmounts {
  requested: Money;
  surcharge: Money;
  totalCharged: Money;
  commission: Money;
  net: Money;
  gatewayFee: Money | null;
}

/**
 * The platform setting that publishes the internal watch list.
 */
export const WATCHLIST_SETTING_KEY = "screening.watchlist";

const ACTIVE_ATTEMPT_STATUSES = [
  "CREATED",
  "INITIATING",
  "AWAITING_CUSTOMER",
  "AUTHORIZING",
  "VERIFYING",
  "SUCCEEDED",
  "UNKNOWN",
];

const isTerminalStatus = (status: string): boolean =>
  ["FAILED", "EXPIRED", "CANCELLED", "BLOCKED"].includes(status);

const matchesScope = (
  rule: VelocityRuleRow,
  context: {
    merchantId: string;
    applicationId: string;
    linkId: string;
    railCode: string;
    clientIp: string | null;
    clientPhone: string | null;
    cardAlias: string | null;
  },
): boolean => {
  const scope = rule.scopeValue;
  switch (rule.scopeType) {
    case "MERCHANT":
      return scope === null || scope === context.merchantId;
    case "APPLICATION":
      return scope === null || scope === context.applicationId;
    case "LINK":
      return scope === null || scope === context.linkId;
    case "RAIL":
      return scope === null || scope === context.railCode;
    case "END_CLIENT_IP":
      return scope === null || (context.clientIp !== null && scope === context.clientIp);
    case "END_CLIENT_PHONE":
      return scope === null || (context.clientPhone !== null && scope === context.clientPhone);
    case "END_CLIENT_CARD":
      return scope === null || (context.cardAlias !== null && scope === context.cardAlias);
    default:
      return false;
  }
};

const blockDecision = (
  reason: string,
  customerMessageCode = "PAYMENT_CANNOT_BE_PROCESSED",
  velocityRuleIds: string[] = [],
  attemptId: string | null = null,
  reference: string | null = null,
  amount = 0n,
  currency = "LYD",
  severity: Severity | null = null,
  amlCaseId: string | null = null,
  settlementTarget: SettlementTarget = "PLATFORM_CLEARING",
): GuardDecision => ({
  outcome: "BLOCK",
  attemptId,
  reference,
  amount,
  currency,
  severity,
  amlCaseId,
  velocityRuleIds,
  amlHits: [],
  reasons: [reason],
  customerMessageCode,
  holdRequired: false,
  settlementTarget,
  correlatedEscalation: false,
  slotReserved: false,
});

export class AttemptGuardPipeline {
  private readonly db: PrismaLike;
  private readonly repositories: Repositories;
  private readonly screening: ScreeningProvider;
  private readonly clock: () => Date;

  constructor(deps: AttemptGuardPipelineDeps) {
    this.db = deps.db;
    this.repositories = deps.repositories;
    this.screening = deps.screening;
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * The attempt-creation guard.
   *
   * The guard is the transaction that reserves the slot of the link and
   * creates the attempt (design §9.1 rule 2): the velocity rules, the watch
   * list and the AML rules are evaluated inside it, so a rejected payment
   * leaves a terminal `BLOCKED` attempt behind and a held payment leaves its
   * money escrowed.
   *
   * The caller may supply the transaction it already runs in, so the guard
   * joins the initiation transaction of the caller instead of opening a
   * second one.
   */
  async guard(request: AttemptGuardRequest, transaction?: Tx): Promise<GuardDecision> {
    const run = async (tx: Tx): Promise<GuardDecision> => {
      const now = this.clock();
      const customer = request.customer ?? {};
      const clientIp = request.clientIp ?? customer.ip ?? null;
      const clientPhone = customer.phone ? normalizeIdentifier(customer.phone) : null;
      const cardAlias = customer.cardAlias ?? null;

      if (request.idempotencyKey) {
        const existing = await this.repositories.payments.findAttemptByIdempotencyKey(tx, request.idempotencyKey);
        if (existing) {
          const settlementTarget = request.pinnedRoute?.settlementTarget
            ?? await this.repositories.payments.resolveSettlementTarget(tx, {
              railCode: request.railCode,
              merchantId: request.merchantId ?? null,
              env: request.env,
            });
          return {
            outcome: "ALLOW" as GuardOutcome,
            attemptId: existing.id,
            reference: existing.reference,
            amount: moneyFromDecimal(existing.totalChargedAmount ?? existing.requestedAmount ?? 0),
            currency: existing.currency,
            severity: null,
            amlCaseId: existing.amlCaseId ?? null,
            velocityRuleIds: [],
            amlHits: [],
            reasons: ["IDEMPOTENT_REPLAY"],
            customerMessageCode: "OK",
            holdRequired: false,
            settlementTarget,
            correlatedEscalation: false,
            slotReserved: false,
          };
        }
      }

      const link = await this.repositories.payments.lockLinkByKey(tx, request.linkKey);
      if (!link) {
        throw new ApiError(404, "PAYMENT_LINK_NOT_FOUND", "Payment link not found");
      }
      if (link.state !== "PENDING") {
        throw new ApiError(409, "PAYMENT_LINK_NOT_AVAILABLE", "Payment link is not available");
      }
      if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) {
        throw new ApiError(409, "PAYMENT_LINK_EXPIRED", "Payment link has expired");
      }

      const applicationId = request.applicationId ?? link.applicationId;
      const merchant = await this.resolveMerchant(tx, applicationId, request.merchantId);
      if (!merchant) {
        throw new ApiError(404, "MERCHANT_NOT_FOUND", "Payment link merchant not found");
      }

      // The route is resolved before the posture check, because the blocked
      // attempt of a merchant that may not pay still has to be pinned to the
      // configuration it was refused on.
      const route = await this.resolveRoute(tx, request, merchant.id, applicationId);
      const amounts = this.resolveAmounts(request, moneyFromDecimal(link.amount));
      const currency = link.currency;
      const settlementTarget = request.pinnedRoute?.settlementTarget
        ?? await this.repositories.payments.resolveSettlementTarget(tx, {
          railCode: request.railCode,
          merchantId: merchant.id,
          env: request.env,
        });

      const posture = await this.merchantPosture(tx, merchant, request.env, now);
      if (!posture.allowed) {
        // A merchant that may not pay is blocked the same way a rejected
        // velocity rule is blocked: a terminal attempt keeps the refusal
        // auditable and no slot is reserved.
        const blocked = await this.createBlockedAttempt(tx, {
          link,
          merchant,
          request,
          route,
          amounts,
          currency,
          reason: posture.reason,
          velocityRuleIds: [],
          clientIp,
          clientPhone,
          now,
        });
        return blockDecision(
          posture.reason,
          "PAYMENT_CANNOT_BE_PROCESSED",
          [],
          blocked.id,
          blocked.reference,
          amounts.totalCharged,
          currency,
          null,
          null,
          settlementTarget,
        );
      }

      if (!link.infiniteUse && link.confirmedCount + link.activeLockedCount >= link.useCount) {
        const blocked = await this.createBlockedAttempt(tx, {
          link,
          merchant,
          request,
          route,
          amounts,
          currency,
          reason: "PAYMENT_LINK_SLOT_UNAVAILABLE",
          velocityRuleIds: [],
          clientIp,
          clientPhone,
          now,
        });
        return blockDecision(
          "PAYMENT_LINK_SLOT_UNAVAILABLE",
          "PAYMENT_IN_PROGRESS",
          [],
          blocked.id,
          blocked.reference,
          amounts.totalCharged,
          currency,
          null,
          null,
          settlementTarget,
        );
      }

      // The watch list of the platform is published before the hot path
      // screening, so the screening is run against the list that is
      // published and not against the list the process started with.
      await this.publishWatchlist(tx);

      const screening = this.screenHotPath({
        merchant,
        customer,
        clientIp,
        clientPhone,
        cardAlias,
        now,
      });
      const confirmedSanctions = screening?.result === "CONFIRMED_MATCH"
        && screening.matches.some((match) => match.listType === "SANCTIONS");
      if (confirmedSanctions) {
        const listType = screening.matches.find((match) => match.listType === "SANCTIONS")?.listType ?? "SANCTIONS";
        const blocked = await this.createBlockedAttempt(tx, {
          link,
          merchant,
          request,
          route,
          amounts,
          currency,
          reason: `SCREENING_CONFIRMED_MATCH:${listType}`,
          velocityRuleIds: [],
          clientIp,
          clientPhone,
          now,
        });
        return blockDecision(
          `SCREENING_CONFIRMED_MATCH:${listType}`,
          "PAYMENT_CANNOT_BE_PROCESSED",
          [],
          blocked.id,
          blocked.reference,
          amounts.totalCharged,
          currency,
          "CRITICAL",
          null,
          settlementTarget,
        );
      }

      const velocityRules = await this.repositories.risk.listActiveVelocityRules(tx);
      const velocityEvaluations = await this.evaluateVelocity(tx, {
        rules: velocityRules,
        merchant,
        link: { id: link.id, applicationId: link.applicationId },
        request,
        route,
        amounts,
        clientIp,
        clientPhone,
        cardAlias,
        now,
      });
      const rejectedRules = velocityEvaluations.filter((evaluation) => evaluation.exceeded && evaluation.rule.action === "REJECT");
      const flaggedRules = velocityEvaluations.filter((evaluation) => evaluation.exceeded && evaluation.rule.action === "FLAG");
      const flaggedVelocityRuleIds = flaggedRules.map((evaluation) => evaluation.rule.id);
      if (rejectedRules.length > 0) {
        const blocked = await this.createBlockedAttempt(tx, {
          link,
          merchant,
          request,
          route,
          amounts,
          currency,
          reason: `VELOCITY_REJECT:${rejectedRules[0]?.rule.id ?? "UNKNOWN"}`,
          velocityRuleIds: rejectedRules.map((evaluation) => evaluation.rule.id),
          clientIp,
          clientPhone,
          now,
        });
        return blockDecision(
          `VELOCITY_REJECT:${rejectedRules[0]?.rule.id ?? "UNKNOWN"}`,
          "PAYMENT_CANNOT_BE_PROCESSED",
          rejectedRules.map((evaluation) => evaluation.rule.id),
          blocked.id,
          blocked.reference,
          amounts.totalCharged,
          currency,
          null,
          null,
          settlementTarget,
        );
      }

      // The AML window is the merchant window: an attempt of another
      // merchant never contributes to the cumulative counters of this one.
      const windowStats = await this.repositories.payments.collectWindowStats(tx, {
        merchantId: merchant.id,
        applicationId: link.applicationId,
        since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      });
      const engine = new AmlRuleEngine({ risk: this.repositories.risk, tx });
      const amlResult = await engine.evaluate({
        subjectType: "PAYMENT_ATTEMPT",
        subjectId: link.id,
        merchantId: merchant.id,
        amount: amounts.totalCharged,
        currency,
        railCode: request.railCode,
        riskTier: merchant.riskTier,
        settlementTarget,
        counterpartyCountry: merchant.country ?? null,
        windowStats: { count: windowStats.count, totalAmount: windowStats.totalAmount, amounts: windowStats.amounts },
        expectedMonthlyVolume: this.expectedMonthlyVolume(merchant),
        openCaseCount: await this.repositories.risk.countOpenAmlCases(tx, "MERCHANT", merchant.id),
        velocityFlagged: flaggedRules.length > 0,
        screeningResult: (screening?.result ?? null) as ScreeningResultCode | null,
        screeningListType: screening?.matches[0]?.listType ?? null,
        now,
      });

      const amlAction: AmlAction | null = amlResult.effectiveAction;
      if (amlAction === "BLOCK") {
        const blocked = await this.createBlockedAttempt(tx, {
          link,
          merchant,
          request,
          route,
          amounts,
          currency,
          reason: `AML_BLOCK:${amlResult.hits[0]?.ruleCode ?? "UNKNOWN"}`,
          velocityRuleIds: flaggedVelocityRuleIds,
          clientIp,
          clientPhone,
          now,
        });
        return blockDecision(
          `AML_BLOCK:${amlResult.hits[0]?.ruleCode ?? "UNKNOWN"}`,
          "PAYMENT_CANNOT_BE_PROCESSED",
          flaggedVelocityRuleIds,
          blocked.id,
          blocked.reference,
          amounts.totalCharged,
          currency,
          amlResult.severity ?? "HIGH",
          null,
          settlementTarget,
        );
      }

      await this.repositories.payments.updateLinkSlotCount(tx, link.id, 1);
      const attemptGroupId = await this.resolveAttemptGroup(tx, link.id, customer, clientIp, clientPhone);
      // A held attempt waits for the resolution of its case, so it outlives
      // the session of the payment: the slot of the link stays reserved
      // until the case is decided (the SLA of the case is the deadline).
      const holdSlaHours = amlAction === "HOLD"
        ? slaHoursForSeverity(amlResult.severity ?? "MEDIUM")
        : 0;
      const attemptExpiresAt = holdSlaHours > 0
        ? new Date(now.getTime() + holdSlaHours * 60 * 60 * 1000)
        : request.expiresAt ?? link.expiresAt ?? new Date(now.getTime() + 20 * 60 * 1000);
      const attemptGraceExpiresAt = request.graceExpiresAt
        && request.graceExpiresAt.getTime() > attemptExpiresAt.getTime()
        ? request.graceExpiresAt
        : new Date(attemptExpiresAt.getTime() + 24 * 60 * 60 * 1000);
      const attemptData: Parameters<PaymentRepository["createAttempt"]>[1] & {
        settlementTarget?: SettlementTarget;
      } = {
        reference: this.buildReference(),
        idempotencyKey: request.idempotencyKey ?? null,
        linkId: link.id,
        attemptGroupId: attemptGroupId,
        applicationId: link.applicationId,
        merchantId: merchant.id,
        railId: route.railId,
        routeId: route.routeId,
        credentialSetId: route.credentialSetId,
        gatewayVersionId: route.gatewayVersionId,
        commissionProfileId: route.commissionProfileId,
        env: request.env,
        mode: request.mode ?? route.mode,
        subMode: request.subMode ?? null,
        status: "CREATED",
        requestedAmount: moneyToString(amounts.requested),
        totalChargedAmount: moneyToString(amounts.totalCharged),
        surchargeAmount: moneyToString(amounts.surcharge),
        platformCommissionAmount: moneyToString(amounts.commission),
        netMerchantAmount: moneyToString(amounts.net),
        ...(amounts.gatewayFee === null ? {} : { gatewayFeeAmount: moneyToString(amounts.gatewayFee) }),
        currency,
        feeBearer: link.feeBearer,
        settlementTarget,
        clientIp: clientIp,
        userAgent: request.userAgent ?? null,
        customerFieldsMasked: {
          phone: clientPhone,
          ip: clientIp,
          card_alias: cardAlias,
          device_fingerprint: customer.deviceFingerprint ?? null,
          walletId: customer.walletId ?? null,
          ...(request.customerFields ?? {}),
        },
        contextCiphertext: "",
        expiresAt: attemptExpiresAt,
        graceExpiresAt: attemptGraceExpiresAt,
        nextCheckAt: request.nextCheckAt ?? null,
      };
      const attempt = await this.repositories.payments.createAttempt(tx, attemptData);

      let amlCaseId: string | null = null;
      let severity: Severity | null = amlResult.severity;
      const screeningMatch = screening && screening.result !== "CLEAR" && screening.result !== "ERROR"
        ? screening
        : null;
      if (amlResult.hits.length > 0 || screeningMatch) {
        const caseRow = await this.createAmlCase(tx, {
          merchant,
          subjectType: "PAYMENT_ATTEMPT",
          subjectId: attempt.id,
          triggerReason: amlResult.hits.length > 0
            ? `AML_RULE:${amlResult.hits.map((hit) => hit.ruleCode).join(",")}`
            : `SCREENING_${screeningMatch?.result}:${screeningMatch?.matches[0]?.listType ?? "UNKNOWN"}`,
          severity: severity ?? "MEDIUM",
          severityInputs: amlResult.severityInputs,
          ruleId: amlResult.hits[0]?.ruleId ?? null,
          ruleVersion: amlResult.hits[0]?.ruleVersion ?? null,
          now,
        });
        amlCaseId = caseRow.id;
      } else if (flaggedRules.length > 0) {
        severity = "MEDIUM";
      }

      const outcome: GuardOutcome = amlAction === "HOLD"
        ? "HOLD"
        : amlAction === "CASE_ONLY"
          ? "CASE_ONLY"
          : flaggedRules.length > 0
            ? "FLAG"
            : "ALLOW";

      let holdJournalEntryId: string | null = null;
      if (outcome === "HOLD") {
        // The money of a held payment is escrowed (design §11.3 entry 7:
        // `Dr GATEWAY_CLEARING` / `Cr AML_HOLD`) and the attempt waits for the
        // resolution of the case. It is never settled from here.
        holdJournalEntryId = await this.postAmlHoldEscrow(tx, {
          attemptId: attempt.id,
          amount: amounts.totalCharged,
          currency,
          gatewayId: request.pinnedRoute?.gatewayId ?? null,
          credentialSetId: route.credentialSetId,
          env: request.env,
        });
        if (amlCaseId) {
          await this.repositories.risk.updateAmlCase(tx, amlCaseId, {
            holdJournalEntryId,
          });
        }
        await this.repositories.payments.updateAttempt(tx, attempt.id, {
          substatus: "AML_HOLD",
          nextCheckAt: null,
        });
      }

      if (request.requestedByUserId) {
        await this.repositories.governance.writeAuditLog(tx, {
          actorId: request.requestedByUserId,
          role: null,
          action: "ATTEMPT_GUARD_EVALUATED",
          entityType: "PAYMENT_ATTEMPT",
          entityId: attempt.id,
          afterJson: {
            outcome: amlAction ?? (flaggedRules.length > 0 ? "FLAG" : "ALLOW"),
            aml_hits: amlResult.hits.map((hit) => hit.ruleCode),
            velocity_rules: flaggedVelocityRuleIds,
            settlement_target: settlementTarget,
            ...(holdJournalEntryId ? { hold_journal_entry_id: holdJournalEntryId } : {}),
          },
        });
      }

      return {
        outcome,
        attemptId: attempt.id,
        reference: attempt.reference,
        amount: amounts.totalCharged,
        currency,
        severity,
        amlCaseId,
        velocityRuleIds: flaggedVelocityRuleIds,
        amlHits: amlResult.hits,
        reasons: [
          ...amlResult.hits.map((hit) => `AML:${hit.ruleCode}:${hit.action}`),
          ...flaggedVelocityRuleIds.map((id) => `VELOCITY_FLAG:${id}`),
          ...(outcome === "HOLD" ? ["AML_HOLD_ESCROWED"] : []),
        ],
        customerMessageCode: outcome === "ALLOW" || outcome === "FLAG"
          ? "OK"
          : "PAYMENT_UNDER_REVIEW",
        holdRequired: outcome === "HOLD",
        settlementTarget,
        correlatedEscalation: amlResult.correlatedEscalation,
        slotReserved: true,
      };
    };

    return transaction
      ? run(transaction)
      : (this.db.$transaction(run) as Promise<GuardDecision>);
  }

  private async resolveMerchant(
    tx: Tx,
    applicationId: string,
    requestedMerchantId: string | null | undefined,
  ): Promise<MerchantRow | null> {
    if (requestedMerchantId) {
      const merchant = await this.repositories.merchants.findMerchantById(tx, requestedMerchantId);
      if (merchant) {
        return merchant;
      }
    }
    return this.repositories.merchants.findMerchantByApplication(tx, applicationId);
  }

  private async resolveRoute(
    tx: Tx,
    request: AttemptGuardRequest,
    merchantId: string,
    applicationId: string,
  ): Promise<ResolvedRoute> {
    const pinned = request.pinnedRoute;
    if (pinned) {
      // The caller resolved the route that the customer was offered, so the
      // attempt is pinned to exactly that configuration (design §9.1 rule 1).
      return {
        railId: pinned.railId,
        routeId: pinned.routeId,
        credentialSetId: pinned.credentialSetId,
        gatewayVersionId: pinned.gatewayVersionId,
        commissionProfileId: pinned.commissionProfileId,
        mode: String(pinned.mode ?? request.mode ?? "OTP_PULL"),
      };
    }
    const client = tx as Record<string, any>;
    const rail = await client.rail.findUnique({ where: { code: request.railCode } });
    if (!rail) {
      throw new ApiError(404, "RAIL_NOT_FOUND", "Payment rail not found");
    }
    const routes = await client.railRoute.findMany({
      where: { railId: rail.id, status: "ACTIVE", healthState: "HEALTHY" },
      orderBy: [{ priority: "desc" }, { id: "asc" }],
    });
    let selected: { route: any; credential: any; gateway: any; commission: any } | null = null;
    for (const route of routes) {
      const credential = await client.credentialSet.findFirst({
        where: { gatewayId: route.gatewayId, env: request.env, status: "VERIFIED" },
        orderBy: { ownerType: "asc" },
      });
      if (!credential) {
        continue;
      }
      const gateway = await client.gateway.findUnique({ where: { id: route.gatewayId } });
      if (!gateway?.activeVersionId) {
        continue;
      }
      const commission = await client.commissionProfile.findFirst({
        where: {
          railCode: request.railCode,
          OR: [
            { merchantId, applicationId },
            { merchantId, applicationId: null },
            { merchantId: null, applicationId: null },
          ],
        },
        orderBy: { version: "desc" },
      });
      if (!commission) {
        continue;
      }
      selected = { route, credential, gateway, commission };
      break;
    }
    if (!selected) {
      throw new ApiError(409, "NO_ELIGIBLE_ROUTE", "No verified route is available for this rail");
    }
    return {
      railId: rail.id,
      routeId: selected.route.id,
      credentialSetId: selected.credential.id,
      gatewayVersionId: selected.gateway.activeVersionId,
      commissionProfileId: selected.commission.id,
      mode: String(rail.collectionMode ?? request.mode ?? "OTP_PULL"),
    };
  }

  private async resolveAttemptGroup(
    tx: Tx,
    linkId: string,
    customer: GuardCustomerContext,
    clientIp: string | null,
    clientPhone: string | null,
  ): Promise<string> {
    const client = tx as Record<string, any>;
    const fingerprint = createHash("sha256")
      .update([customer.deviceFingerprint, clientPhone, clientIp].filter(Boolean).join(":"))
      .digest("hex");
    const group = await client.attemptGroup.upsert({
      where: { linkId_customerFingerprint: { linkId, customerFingerprint: fingerprint } },
      create: { linkId, customerFingerprint: fingerprint },
      update: {},
    });
    return group.id;
  }

  private async merchantPosture(
    tx: Tx,
    merchant: MerchantRow,
    env: Environment,
    now: Date,
  ): Promise<{ allowed: boolean; reason: string }> {
    void now;
    switch (merchant.status) {
      case "ACTIVE":
        return { allowed: true, reason: "ACTIVE" };
      case "PENDING": {
        if (env !== "SANDBOX") {
          return { allowed: false, reason: "MERCHANT_NOT_ACTIVE" };
        }
        const setting = await this.repositories.governance.getPlatformSetting(tx, "onboarding.sandbox_before_approval");
        if (setting === false) {
          return { allowed: false, reason: "MERCHANT_NOT_ACTIVE" };
        }
        return { allowed: true, reason: "SANDBOX_ALLOWED" };
      }
      case "SUSPENDED":
        return { allowed: false, reason: "MERCHANT_SUSPENDED" };
      case "REJECTED":
        return { allowed: false, reason: "MERCHANT_REJECTED" };
      case "CLOSED":
        return { allowed: false, reason: "MERCHANT_CLOSED" };
      default:
        return { allowed: false, reason: "MERCHANT_STATUS_UNKNOWN" };
    }
  }

  private expectedMonthlyVolume(merchant: MerchantRow): Money | null {
    const raw = (merchant as { expectedMonthlyVolume?: unknown }).expectedMonthlyVolume;
    if (raw === null || raw === undefined) {
      return null;
    }
    try {
      return moneyFromDecimal(raw);
    } catch {
      return null;
    }
  }

  private screenHotPath(input: {
    merchant: MerchantRow;
    customer: GuardCustomerContext;
    clientIp: string | null;
    clientPhone: string | null;
    cardAlias: string | null;
    now: Date;
  }) {
    if (!this.screening.screenLocal) {
      return null;
    }
    const identifiers = [input.merchant.registrationNo, input.merchant.taxId, input.clientPhone, input.cardAlias].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return this.screening.screenLocal(
      buildScreeningSubject({
        subjectType: "MERCHANT",
        subjectId: input.merchant.id,
        names: [input.merchant.legalName, input.merchant.tradeName, input.customer.name],
        identifier: identifiers[0] ?? null,
        aliases: identifiers.slice(1),
      }),
    );
  }

  private async evaluateVelocity(
    tx: Tx,
    input: {
      rules: VelocityRuleRow[];
      merchant: MerchantRow;
      link: { id: string; applicationId: string };
      request: AttemptGuardRequest;
      route: ResolvedRoute;
      amounts: ResolvedAmounts;
      clientIp: string | null;
      clientPhone: string | null;
      cardAlias: string | null;
      now: Date;
    },
  ): Promise<VelocityEvaluation[]> {
    const results: VelocityEvaluation[] = [];
    for (const rule of input.rules) {
      if (!rule.active) {
        continue;
      }
      if (rule.effectiveFrom && rule.effectiveFrom.getTime() > input.now.getTime()) {
        continue;
      }
      if (rule.effectiveTo && rule.effectiveTo.getTime() <= input.now.getTime()) {
        continue;
      }
      const matched = matchesScope(rule, {
        merchantId: input.merchant.id,
        applicationId: input.link.applicationId,
        linkId: input.link.id,
        railCode: input.request.railCode,
        clientIp: input.clientIp,
        clientPhone: input.clientPhone,
        cardAlias: input.cardAlias,
      });
      if (!matched) {
        continue;
      }
      const since = new Date(input.now.getTime() - Math.max(1, rule.windowSeconds) * 1000);
      const stats = await this.collectScopedWindowStats(tx, {
        scopeType: rule.scopeType,
        merchantId: input.merchant.id,
        applicationId: input.link.applicationId,
        linkId: input.link.id,
        railId: input.route.railId,
        clientIp: input.clientIp,
        clientPhone: input.clientPhone,
        cardAlias: input.cardAlias,
        since,
      });
      const maxCount = rule.maxCount === null || rule.maxCount === undefined ? null : Number(rule.maxCount);
      const maxAmount = rule.maxAmount === null || rule.maxAmount === undefined ? null : moneyFromDecimal(rule.maxAmount);
      const countExceeded = maxCount !== null && stats.count >= maxCount;
      const amountExceeded = maxAmount !== null && stats.totalAmount + input.amounts.totalCharged > maxAmount;
      results.push({
        rule,
        count: stats.count,
        totalAmount: stats.totalAmount,
        exceeded: countExceeded || amountExceeded,
      });
    }
    return results;
  }

  /**
   * The window of a velocity rule, counted in the scope of the rule.
   *
   * The scope is what makes a sliding window meaningful: an
   * `END_CLIENT_IP` rule counts the attempts of that address, a `MERCHANT`
   * rule counts the attempts of the merchant. The counters therefore never
   * mix the volume of one scope into another.
   */
  private async collectScopedWindowStats(
    tx: Tx,
    scope: {
      scopeType: VelocityRuleRow["scopeType"];
      merchantId: string;
      applicationId: string;
      linkId: string;
      railId: string | null;
      clientIp: string | null;
      clientPhone: string | null;
      cardAlias: string | null;
      since: Date;
    },
  ): Promise<AttemptWindowStats> {
    const where: Record<string, unknown> = {
      createdAt: { gte: scope.since },
      status: { in: ACTIVE_ATTEMPT_STATUSES },
    };
    switch (scope.scopeType) {
      case "MERCHANT":
        where.merchantId = scope.merchantId;
        break;
      case "APPLICATION":
        where.applicationId = scope.applicationId;
        break;
      case "LINK":
        where.linkId = scope.linkId;
        break;
      case "RAIL":
        if (scope.railId) {
          where.railId = scope.railId;
        }
        break;
      case "END_CLIENT_IP":
        if (scope.clientIp) {
          where.clientIp = scope.clientIp;
        }
        break;
      case "END_CLIENT_PHONE":
        if (scope.clientPhone) {
          where.customerFieldsMasked = { path: ["phone"], equals: scope.clientPhone };
        }
        break;
      case "END_CLIENT_CARD":
        if (scope.cardAlias) {
          where.customerFieldsMasked = { path: ["card_alias"], equals: scope.cardAlias };
        }
        break;
      default:
        break;
    }
    const client = tx as Record<string, any>;
    const rows = await client.paymentAttempt.findMany({
      where,
      select: { requestedAmount: true, totalChargedAmount: true },
    });
    const amounts: Money[] = [];
    let total = 0n;
    for (const attempt of (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>) {
      const value = moneyFromDecimal(attempt.totalChargedAmount ?? attempt.requestedAmount ?? 0);
      amounts.push(value);
      total += value;
    }
    return { count: amounts.length, totalAmount: total, amounts };
  }

  private async createBlockedAttempt(
    tx: Tx,
    input: {
      link: { id: string; applicationId: string };
      merchant: MerchantRow | null;
      request: AttemptGuardRequest;
      route: ResolvedRoute;
      amounts: ResolvedAmounts;
      currency: string;
      reason: string;
      velocityRuleIds: string[];
      clientIp: string | null;
      clientPhone: string | null;
      now: Date;
    },
  ): Promise<PaymentAttemptRow> {
    const attempt = await this.repositories.payments.createAttempt(tx, {
      reference: this.buildReference(),
      idempotencyKey: input.request.idempotencyKey ?? null,
      linkId: input.link.id,
      attemptGroupId: await this.resolveAttemptGroup(
        tx,
        input.link.id,
        input.request.customer ?? {},
        input.clientIp,
        input.clientPhone,
      ),
      applicationId: input.link.applicationId,
      merchantId: input.merchant?.id ?? input.request.merchantId ?? "",
      railId: input.route.railId,
      routeId: input.route.routeId,
      credentialSetId: input.route.credentialSetId,
      gatewayVersionId: input.route.gatewayVersionId,
      commissionProfileId: input.route.commissionProfileId,
      env: input.request.env,
      mode: input.request.mode ?? input.route.mode,
      subMode: input.request.subMode ?? null,
      status: "BLOCKED",
      substatus: input.reason,
      requestedAmount: moneyToString(input.amounts.requested),
      totalChargedAmount: moneyToString(input.amounts.totalCharged),
      surchargeAmount: moneyToString(input.amounts.surcharge),
      platformCommissionAmount: moneyToString(input.amounts.commission),
      netMerchantAmount: moneyToString(input.amounts.net),
      currency: input.currency,
      feeBearer: "MERCHANT_ABSORBS",
      customerFieldsMasked: {},
      contextCiphertext: "",
      terminalAt: input.now,
    });
    if (input.request.requestedByUserId) {
      await this.repositories.governance.writeAuditLog(tx, {
        actorId: input.request.requestedByUserId,
        role: null,
        action: "ATTEMPT_BLOCKED",
        entityType: "PAYMENT_ATTEMPT",
        entityId: attempt.id,
        afterJson: { reason: input.reason, velocity_rules: input.velocityRuleIds },
      });
    }
    return attempt;
  }

  /**
   * The monetary breakdown of the attempt.
   *
   * The amounts are resolved by the caller from the pinned commission profile
   * and the pinned route cost model, so the guard evaluates the rules
   * against the money that is really at stake. A missing amount falls back
   * to the amount of the link, and never to a floating point value.
   */
  private resolveAmounts(request: AttemptGuardRequest, requested: Money): ResolvedAmounts {
    const amounts = request.amounts ?? {};
    const surcharge = amounts.surchargeAmount === null || amounts.surchargeAmount === undefined
      ? 0n
      : moneyFromDecimal(amounts.surchargeAmount);
    const totalCharged = amounts.totalChargedAmount === null || amounts.totalChargedAmount === undefined
      ? requested + surcharge
      : moneyFromDecimal(amounts.totalChargedAmount);
    const commission = amounts.platformCommissionAmount === null || amounts.platformCommissionAmount === undefined
      ? 0n
      : moneyFromDecimal(amounts.platformCommissionAmount);
    const net = amounts.netMerchantAmount === null || amounts.netMerchantAmount === undefined
      ? (totalCharged > commission ? totalCharged - commission : 0n)
      : moneyFromDecimal(amounts.netMerchantAmount);
    const gatewayFee = amounts.gatewayFeeAmount === null || amounts.gatewayFeeAmount === undefined
      ? null
      : moneyFromDecimal(amounts.gatewayFeeAmount);
    return { requested, surcharge, totalCharged, commission, net, gatewayFee };
  }

  /**
   * Publishes the watch list of the platform into the screening provider.
   *
   * The list is a versioned platform setting, so the provider screens
   * against the list the compliance team maintains instead of the list the
   * process started with. A provider that holds no local list (a mock, an
   * external provider) is left untouched.
   */
  private async publishWatchlist(tx: Tx): Promise<void> {
    if (!this.screening.setEntries) {
      return;
    }
    const setting = await this.repositories.governance.getPlatformSetting(tx, WATCHLIST_SETTING_KEY);
    if (!setting) {
      return;
    }
    publishWatchlist(this.screening, setting);
    // A published list invalidates the results that were screened against
    // the previous revision.
    await this.screening.refreshListVersions?.();
  }

  /**
   * Escrows the money of a held payment (design §11.3 entry 7).
   *
   * The posting is `Dr GATEWAY_CLEARING` / `Cr AML_HOLD` and it is written in
   * the same transaction as the attempt and the case, so the money can never
   * be settled while the case is open.
   */
  private async postAmlHoldEscrow(
    tx: Tx,
    input: {
      attemptId: string;
      amount: Money;
      currency: string;
      gatewayId: string | null;
      credentialSetId: string;
      env: Environment;
    },
  ): Promise<string> {
    const accounts = await this.resolveHoldAccounts(tx, input);
    const journal = buildLedgerTemplate("AML_HOLD_AND_RELEASE", {
      // The amount is exact money: it is scaled by 10^4 and never a float.
      amount: moneyToString(input.amount),
      commissionAmount: 0,
      merchantAmount: 0,
    });
    journal.refId = input.attemptId;
    const poster = new LedgerPoster(this.db as never);
    const posted = await poster.post(
      journal,
      { accounts, currency: input.currency },
      tx as never,
    );
    return posted.entry.id;
  }

  /**
   * The GL accounts of the escrow.
   *
   * The clearing account is the one of the pinned gateway, credential set and
   * environment. When the platform has no such account, the currency scoped
   * system account of the platform is used, so the escrow is never booked
   * against a wrong account.
   */
  private async resolveHoldAccounts(
    tx: Tx,
    input: {
      currency: string;
      gatewayId: string | null;
      credentialSetId: string;
      env: Environment;
    },
  ): Promise<{ GATEWAY_CLEARING: string; AML_HOLD: string }> {
    const client = tx as Record<string, any>;
    const accounts = client.glAccount;
    const clearing = await this.findGlAccount(accounts, [
      ...(input.gatewayId
        ? [{ accountType: "GATEWAY_CLEARING", gatewayId: input.gatewayId, credentialSetId: input.credentialSetId, env: input.env }]
        : []),
      { accountType: "GATEWAY_CLEARING", credentialSetId: input.credentialSetId, env: input.env },
      { accountType: "GATEWAY_CLEARING", currency: input.currency },
    ]);
    const hold = await this.findGlAccount(accounts, [
      { accountType: "AML_HOLD", currency: input.currency },
      { accountType: "AML_HOLD" },
    ]);
    if (!clearing || !hold) {
      throw new ApiError(
        409,
        "AML_HOLD_ACCOUNT_NOT_FOUND",
        "The AML hold escrow cannot be booked: the clearing or the hold account is missing",
      );
    }
    return { GATEWAY_CLEARING: clearing, AML_HOLD: hold };
  }

  private async findGlAccount(
    accounts: Record<string, any> | undefined,
    candidates: Array<Record<string, unknown>>,
  ): Promise<string | null> {
    if (!accounts?.findFirst) {
      return null;
    }
    for (const where of candidates) {
      const found = await accounts.findFirst({ where, select: { id: true } });
      if (found?.id) {
        return String(found.id);
      }
    }
    return null;
  }

  private async createAmlCase(
    tx: Tx,
    input: {
      merchant: MerchantRow;
      subjectType: "MERCHANT" | "PAYMENT_ATTEMPT";
      subjectId: string;
      triggerReason: string;
      severity: Severity;
      severityInputs: unknown[];
      ruleId?: string | null;
      ruleVersion?: number | null;
      now: Date;
    },
  ): Promise<{ id: string }> {
    const slaHours = input.severity === "CRITICAL" ? 4 : input.severity === "HIGH" ? 24 : input.severity === "MEDIUM" ? 72 : 120;
    return this.repositories.risk.createAmlCase(tx, {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      triggerReason: input.triggerReason,
      severity: input.severity,
      severityInputsJson: input.severityInputs,
      ruleId: input.ruleId ?? null,
      ruleVersion: input.ruleVersion ?? null,
      status: "OPEN",
      slaDueAt: new Date(input.now.getTime() + slaHours * 60 * 60 * 1000),
      confidential: true,
    });
  }

  private buildReference(): string {
    const stamp = Date.now().toString(36).toUpperCase();
    return `PA-${stamp}-${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  }
}

export const isAttemptTerminalStatus = isTerminalStatus;
export const ACTIVE_ATTEMPT_STATUS_LIST = ACTIVE_ATTEMPT_STATUSES;
