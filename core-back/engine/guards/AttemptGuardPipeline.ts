import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../../lib/error";
import { moneyFromDecimal, moneyToString, type Money } from "../db/money";
import type {
  AmlAction,
  Channel,
  Environment,
  MerchantRow,
  PaymentAttemptRow,
  PrismaLike,
  Repositories,
  Severity,
  SettlementTarget,
  Tx,
  VelocityRuleRow,
} from "../db/ports";
import { AmlRuleEngine, type AmlRuleHit } from "./AmlRuleEngine";
import {
  buildScreeningSubject,
  normalizeIdentifier,
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

  async guard(request: AttemptGuardRequest): Promise<GuardDecision> {
    const now = this.clock();
    const customer = request.customer ?? {};
    const clientIp = request.clientIp ?? customer.ip ?? null;
    const clientPhone = customer.phone ? normalizeIdentifier(customer.phone) : null;
    const cardAlias = customer.cardAlias ?? null;

    return this.db.$transaction(async (tx: Tx) => {
      if (request.idempotencyKey) {
        const existing = await this.repositories.payments.findAttemptByIdempotencyKey(tx, request.idempotencyKey);
        if (existing) {
          const settlementTarget = await this.repositories.payments.resolveSettlementTarget(tx, {
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
      const posture = await this.merchantPosture(tx, merchant, request.env, now);
      if (!posture.allowed) {
        throw new ApiError(403, "MERCHANT_NOT_ALLOWED", posture.reason);
      }

      const route = await this.resolveRoute(tx, request, merchant.id, applicationId);
      const amount = moneyFromDecimal(link.amount);
      const currency = link.currency;
      const settlementTarget = await this.repositories.payments.resolveSettlementTarget(tx, {
        railCode: request.railCode,
        merchantId: merchant.id,
        env: request.env,
      });

      if (!link.infiniteUse && link.confirmedCount + link.activeLockedCount >= link.useCount) {
        const blocked = await this.createBlockedAttempt(tx, {
          link,
          merchant,
          request,
          route,
          amount,
          currency,
          reason: "PAYMENT_LINK_SLOT_UNAVAILABLE",
          velocityRuleIds: [],
          now,
        });
        return blockDecision(
          "PAYMENT_LINK_SLOT_UNAVAILABLE",
          "PAYMENT_IN_PROGRESS",
          [],
          blocked.id,
          blocked.reference,
          amount,
          currency,
          null,
          null,
          settlementTarget,
        );
      }

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
          amount,
          currency,
          reason: `SCREENING_CONFIRMED_MATCH:${listType}`,
          velocityRuleIds: [],
          now,
        });
        return blockDecision(
          `SCREENING_CONFIRMED_MATCH:${listType}`,
          "PAYMENT_CANNOT_BE_PROCESSED",
          [],
          blocked.id,
          blocked.reference,
          amount,
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
        amount,
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
          amount,
          currency,
          reason: `VELOCITY_REJECT:${rejectedRules[0]?.rule.id ?? "UNKNOWN"}`,
          velocityRuleIds: rejectedRules.map((evaluation) => evaluation.rule.id),
          now,
        });
        return blockDecision(
          `VELOCITY_REJECT:${rejectedRules[0]?.rule.id ?? "UNKNOWN"}`,
          "PAYMENT_CANNOT_BE_PROCESSED",
          rejectedRules.map((evaluation) => evaluation.rule.id),
          blocked.id,
          blocked.reference,
          amount,
          currency,
          null,
          null,
          settlementTarget,
        );
      }

      const windowStats = await this.repositories.payments.collectWindowStats(tx, {
        merchantId: merchant.id,
        applicationId: link.applicationId,
        linkId: link.id,
        clientIp,
        clientPhone,
        cardAlias,
        since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      });
      const engine = new AmlRuleEngine({ risk: this.repositories.risk, tx });
      const amlResult = await engine.evaluate({
        subjectType: "PAYMENT_ATTEMPT",
        subjectId: link.id,
        merchantId: merchant.id,
        amount,
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
          amount,
          currency,
          reason: `AML_BLOCK:${amlResult.hits[0]?.ruleCode ?? "UNKNOWN"}`,
          velocityRuleIds: flaggedVelocityRuleIds,
          now,
        });
        return blockDecision(
          `AML_BLOCK:${amlResult.hits[0]?.ruleCode ?? "UNKNOWN"}`,
          "PAYMENT_CANNOT_BE_PROCESSED",
          flaggedVelocityRuleIds,
          blocked.id,
          blocked.reference,
          amount,
          currency,
          amlResult.severity ?? "HIGH",
          null,
          settlementTarget,
        );
      }

      await this.repositories.payments.updateLinkSlotCount(tx, link.id, 1);
      const attemptGroupId = await this.resolveAttemptGroup(tx, link.id, customer, clientIp, clientPhone);
      const attempt = await this.repositories.payments.createAttempt(tx, {
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
        requestedAmount: moneyToString(amount),
        totalChargedAmount: moneyToString(amount),
        surchargeAmount: moneyToString(0n),
        platformCommissionAmount: moneyToString(0n),
        netMerchantAmount: moneyToString(0n),
        currency,
        feeBearer: link.feeBearer,
        clientIp: clientIp,
        userAgent: request.userAgent ?? null,
        customerFieldsMasked: {
          phone: clientPhone,
          ip: clientIp,
          card_alias: cardAlias,
          device_fingerprint: customer.deviceFingerprint ?? null,
          walletId: customer.walletId ?? null,
        },
        contextCiphertext: "",
        expiresAt: link.expiresAt ?? new Date(now.getTime() + 20 * 60 * 1000),
        graceExpiresAt: new Date((link.expiresAt ?? now).getTime() + 24 * 60 * 60 * 1000),
      });

      let amlCaseId: string | null = null;
      let severity: Severity | null = amlResult.severity;
      if (amlResult.hits.length > 0 || screening?.result === "POTENTIAL_MATCH") {
        const caseRow = await this.createAmlCase(tx, {
          merchant,
          subjectType: "PAYMENT_ATTEMPT",
          subjectId: attempt.id,
          triggerReason: amlResult.hits.length > 0
            ? `AML_RULE:${amlResult.hits.map((hit) => hit.ruleCode).join(",")}`
            : `SCREENING_POTENTIAL_MATCH:${screening?.matches[0]?.listType ?? "UNKNOWN"}`,
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
          },
        });
      }

      const outcome: GuardOutcome = amlAction === "HOLD"
        ? "HOLD"
        : amlAction === "CASE_ONLY"
          ? "CASE_ONLY"
          : flaggedRules.length > 0
            ? "FLAG"
            : "ALLOW";
      return {
        outcome,
        attemptId: attempt.id,
        reference: attempt.reference,
        amount,
        currency,
        severity,
        amlCaseId,
        velocityRuleIds: flaggedVelocityRuleIds,
        amlHits: amlResult.hits,
        reasons: [
          ...amlResult.hits.map((hit) => `AML:${hit.ruleCode}:${hit.action}`),
          ...flaggedVelocityRuleIds.map((id) => `VELOCITY_FLAG:${id}`),
        ],
        customerMessageCode: outcome === "ALLOW" ? "OK" : "PAYMENT_CANNOT_BE_PROCESSED",
        holdRequired: outcome === "HOLD",
        settlementTarget,
        correlatedEscalation: amlResult.correlatedEscalation,
        slotReserved: true,
      };
    }) as Promise<GuardDecision>;
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
      amount: Money;
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
      const stats = await this.repositories.payments.collectWindowStats(tx, {
        merchantId: input.merchant.id,
        applicationId: rule.scopeType === "APPLICATION" ? input.link.applicationId : null,
        linkId: rule.scopeType === "LINK" ? input.link.id : null,
        clientIp: rule.scopeType === "END_CLIENT_IP" ? input.clientIp : null,
        clientPhone: rule.scopeType === "END_CLIENT_PHONE" ? input.clientPhone : null,
        cardAlias: rule.scopeType === "END_CLIENT_CARD" ? input.cardAlias : null,
        since,
      });
      const maxCount = rule.maxCount === null || rule.maxCount === undefined ? null : Number(rule.maxCount);
      const maxAmount = rule.maxAmount === null || rule.maxAmount === undefined ? null : moneyFromDecimal(rule.maxAmount);
      const countExceeded = maxCount !== null && stats.count >= maxCount;
      const amountExceeded = maxAmount !== null && stats.totalAmount + input.amount > maxAmount;
      results.push({
        rule,
        count: stats.count,
        totalAmount: stats.totalAmount,
        exceeded: countExceeded || amountExceeded,
      });
    }
    return results;
  }

  private async createBlockedAttempt(
    tx: Tx,
    input: {
      link: { id: string; applicationId: string };
      merchant: MerchantRow | null;
      request: AttemptGuardRequest;
      route: ResolvedRoute;
      amount: Money;
      currency: string;
      reason: string;
      velocityRuleIds: string[];
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
        input.request.clientIp ?? null,
        input.request.customer?.phone ? normalizeIdentifier(input.request.customer.phone) : null,
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
      requestedAmount: moneyToString(input.amount),
      totalChargedAmount: moneyToString(input.amount),
      surchargeAmount: moneyToString(0n),
      platformCommissionAmount: moneyToString(0n),
      netMerchantAmount: moneyToString(0n),
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
