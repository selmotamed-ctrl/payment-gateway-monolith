import { moneyFromDecimal, type Money } from "./money";
import type {
  AdjustmentRow,
  AmlCaseRow,
  AmlRuleRow,
  AmlScreeningMatchRow,
  AmlScreeningRow,
  ApprovalRequestRow,
  AttemptWindowStats,
  BeneficialOwnerRow,
  DisputeRepository,
  DisputeRow,
  GovernanceRepository,
  IdentityRepository,
  JoinRequestRow,
  JoinRequestStatus,
  KybDocumentRow,
  MerchantRepository,
  MerchantRow,
  NotificationRepository,
  NotificationRow,
  NotificationTemplateRow,
  OnboardingRepository,
  OperatorCaseRow,
  PaymentAttemptRow,
  PaymentLinkRow,
  PaymentRepository,
  PlatformSettingRow,
  PrismaLike,
  ReconciliationItemRow,
  ReconciliationRepository,
  ReconciliationRunRow,
  RegulatoryReportRow,
  Repositories,
  ReportingRuleRow,
  RiskRepository,
  StatementSourceRow,
  Tx,
  UserIdentityRow,
  UserRow,
  VelocityRuleRow,
} from "./ports";

type Any = Record<string, any>;

const pascalCase = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

const model = (tx: Tx, name: string): Any => {
  const client = tx as Any;
  for (const candidate of [name, pascalCase(name)]) {
    if (client[candidate]) {
      return client[candidate];
    }
  }
  throw new Error(`Prisma model delegate is not available: ${name}`);
};

const rows = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const snakeToCamel = (key: string): string =>
  key.replace(/_([a-zA-Z0-9])/g, (_match, character: string) => character.toUpperCase());

const mapRawRow = <T>(value: unknown): T => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value as T;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[snakeToCamel(key)] = entry;
  }
  return output as T;
};

const mapRawRows = <T>(value: unknown): T[] => rows<unknown>(value).map((entry) => mapRawRow<T>(entry));

export const SYSTEM_AUDIT_ACTOR_EMAIL = "system-automation@payment-gateway.internal";

export class PrismaRepositories implements Repositories {
  private readonly db: PrismaLike;

  constructor(db: PrismaLike) {
    this.db = db;
  }

  identity: IdentityRepository = {
    createUser: async (tx, data) => {
      return model(tx, "user").create({ data }) as Promise<UserRow>;
    },
    findUserById: async (tx, id) => {
      return (await model(tx, "user").findUnique({ where: { id } })) as UserRow | null;
    },
    findUserByEmail: async (tx, email) => {
      return (await model(tx, "user").findFirst({ where: { email } })) as UserRow | null;
    },
    findUserByPhone: async (tx, phone) => {
      return (await model(tx, "user").findFirst({ where: { phone } })) as UserRow | null;
    },
    createIdentity: async (tx, data) => {
      return model(tx, "userIdentity").create({ data }) as Promise<UserIdentityRow>;
    },
    findIdentityByKind: async (tx, kind, identifierNormalized) => {
      return (await model(tx, "userIdentity").findFirst({
        where: { kind, identifierNormalized: identifierNormalized },
      })) as UserIdentityRow | null;
    },
    findIdentityByProviderSubject: async (tx, providerSubject) => {
      return (await model(tx, "userIdentity").findFirst({
        where: { providerSubject: providerSubject },
      })) as UserIdentityRow | null;
    },
    listIdentitiesByUser: async (tx, userId) => {
      return rows<UserIdentityRow>(await model(tx, "userIdentity").findMany({ where: { userId: userId } }));
    },
    markIdentityVerified: async (tx, id, verifiedAt) => {
      await model(tx, "userIdentity").update({ where: { id }, data: { verifiedAt: verifiedAt } });
    },
  };

  merchants: MerchantRepository = {
    createMerchant: async (tx, data) => {
      return model(tx, "merchant").create({ data }) as Promise<MerchantRow>;
    },
    findMerchantById: async (tx, id) => {
      return (await model(tx, "merchant").findUnique({ where: { id } })) as MerchantRow | null;
    },
    findMerchantByApplication: async (tx, applicationId) => {
      return (await model(tx, "application").findUnique({
        where: { id: applicationId },
        select: { merchantId: true },
      }).then(async (application: Any | null) => {
        if (!application) return null;
        return (await model(tx, "merchant").findUnique({ where: { id: application.merchantId } })) as MerchantRow | null;
      }));
    },
    updateMerchant: async (tx, id, patch) => {
      return model(tx, "merchant").update({ where: { id }, data: patch }) as Promise<MerchantRow>;
    },
    lockMerchantById: async (tx, id) => {
      const result = await tx.$queryRaw`
        SELECT * FROM merchants WHERE id = ${id} LIMIT 1 FOR UPDATE
      `;
      const found = mapRawRows<MerchantRow>(result)[0];
      if (!found) {
        return (await model(tx, "merchant").findUnique({ where: { id } })) as MerchantRow | null;
      }
      return found;
    },
    findMerchantsByDuplicateSignals: async (tx, signals) => {
      const where: Any = { status: { not: "CLOSED" } };
      const or: Any[] = [];
      if (signals.taxId) or.push({ taxId: signals.taxId });
      if (signals.registrationNo) or.push({ registrationNo: signals.registrationNo });
      if (signals.contactPhone) or.push({ contactPhone: signals.contactPhone });
      if (signals.contactEmail) or.push({ contactEmail: signals.contactEmail });
      if (or.length === 0) return [];
      return rows<MerchantRow>(await model(tx, "merchant").findMany({ where: { ...where, OR: or } }));
    },
    getWalletBalance: async (tx, merchantId) => {
      const result = await tx.$queryRaw`
        SELECT COALESCE(SUM(CASE WHEN jl.direction = 'CREDIT' THEN jl.amount ELSE -jl.amount END), 0) AS balance
        FROM journal_lines jl
        INNER JOIN gl_accounts a ON a.id = jl.gl_account_id
        WHERE a.account_type = 'MERCHANT_WALLET' AND a.owner_id = ${merchantId}
      `;
      const first = rows<Any>(result)[0];
      if (!first) return 0n;
      return moneyFromDecimal(first.balance ?? 0);
    },
    getNegativeBalanceCeiling: async (tx, merchantId) => {
      const merchant = (await model(tx, "merchant").findUnique({ where: { id: merchantId } })) as Any | null;
      if (!merchant) return 0n;
      return moneyFromDecimal(merchant.negativeBalanceCeiling ?? 0);
    },
  };

  onboarding: OnboardingRepository = {
    createJoinRequest: async (tx, data) => {
      return model(tx, "joinRequest").create({ data }) as Promise<JoinRequestRow>;
    },
    findJoinRequestById: async (tx, id) => {
      return (await model(tx, "joinRequest").findUnique({ where: { id } })) as JoinRequestRow | null;
    },
    findOpenJoinRequestByMerchant: async (tx, merchantId) => {
      return (await model(tx, "joinRequest").findFirst({
        where: {
          merchantId: merchantId,
          status: { in: ["DRAFT", "SUBMITTED", "IN_REVIEW", "INFO_REQUESTED", "PENDING_CHECKER"] },
        },
      })) as JoinRequestRow | null;
    },
    listJoinRequests: async (tx, filter) => {
      const where: Any = {};
      if (filter.status) where.status = filter.status;
      if (filter.merchantId) where.merchantId = filter.merchantId;
      return rows<JoinRequestRow>(
        await model(tx, "joinRequest").findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: filter.limit,
          skip: filter.offset,
        }),
      );
    },
    updateJoinRequest: async (tx, id, patch) => {
      return model(tx, "joinRequest").update({ where: { id }, data: patch }) as Promise<JoinRequestRow>;
    },
    createKybDocument: async (tx, data) => {
      return model(tx, "kybDocument").create({ data }) as Promise<KybDocumentRow>;
    },
    findKybDocumentById: async (tx, id) => {
      return (await model(tx, "kybDocument").findUnique({ where: { id } })) as KybDocumentRow | null;
    },
    findKybDocumentsBySha256: async (tx, sha256) => {
      return rows<KybDocumentRow>(await model(tx, "kybDocument").findMany({ where: { sha256 } }));
    },
    listKybDocumentsByMerchant: async (tx, merchantId) => {
      return rows<KybDocumentRow>(await model(tx, "kybDocument").findMany({ where: { merchantId: merchantId } }));
    },
    updateKybDocument: async (tx, id, patch) => {
      return model(tx, "kybDocument").update({ where: { id }, data: patch }) as Promise<KybDocumentRow>;
    },
    createBeneficialOwner: async (tx, data) => {
      return model(tx, "beneficialOwner").create({ data }) as Promise<BeneficialOwnerRow>;
    },
    findBeneficialOwnerById: async (tx, id) => {
      return (await model(tx, "beneficialOwner").findUnique({ where: { id } })) as BeneficialOwnerRow | null;
    },
    listBeneficialOwners: async (tx, merchantId) => {
      return rows<BeneficialOwnerRow>(
        await model(tx, "beneficialOwner").findMany({ where: { merchantId: merchantId } }),
      );
    },
    updateBeneficialOwner: async (tx, id, patch) => {
      return model(tx, "beneficialOwner").update({ where: { id }, data: patch }) as Promise<BeneficialOwnerRow>;
    },
  };

  risk: RiskRepository = {
    listActiveVelocityRules: async (tx) => {
      return rows<VelocityRuleRow>(
        await model(tx, "velocityRule").findMany({ where: { active: true } }),
      );
    },
    listActiveAmlRules: async (tx) => {
      return rows<AmlRuleRow>(await model(tx, "amlRule").findMany({ where: { active: true } }));
    },
    findAmlRuleById: async (tx, id) => {
      return (await model(tx, "amlRule").findUnique({ where: { id } })) as AmlRuleRow | null;
    },
    createAmlRule: async (tx, data) => {
      return model(tx, "amlRule").create({ data }) as Promise<AmlRuleRow>;
    },
    listAmlRules: async (tx) => {
      return rows<AmlRuleRow>(await model(tx, "amlRule").findMany({ orderBy: { code: "asc" } }));
    },
    createAmlCase: async (tx, data) => {
      return model(tx, "amlCase").create({ data }) as Promise<AmlCaseRow>;
    },
    findAmlCaseById: async (tx, id) => {
      return (await model(tx, "amlCase").findUnique({ where: { id } })) as AmlCaseRow | null;
    },
    listAmlCases: async (tx, filter) => {
      const where: Any = {};
      if (filter.status) where.status = filter.status;
      if (filter.subjectId) where.subjectId = filter.subjectId;
      return rows<AmlCaseRow>(
        await model(tx, "amlCase").findMany({ where, orderBy: { createdAt: "desc" }, take: filter.limit, skip: filter.offset }),
      );
    },
    updateAmlCase: async (tx, id, patch) => {
      return model(tx, "amlCase").update({ where: { id }, data: patch }) as Promise<AmlCaseRow>;
    },
    countOpenAmlCases: async (tx, subjectType, subjectId) => {
      const result = await model(tx, "amlCase").count({
        where: {
          subjectType: subjectType,
          subjectId: subjectId,
          status: { in: ["OPEN", "IN_REVIEW", "PENDING_CHECKER", "FROZEN", "ESCALATED_STR"] },
        },
      });
      return typeof result === "number" ? result : 0;
    },
    createScreening: async (tx, data) => {
      return model(tx, "amlScreening").create({ data }) as Promise<AmlScreeningRow>;
    },
    createScreeningMatch: async (tx, data) => {
      return model(tx, "amlScreeningMatch").create({ data }) as Promise<AmlScreeningMatchRow>;
    },
    findScreeningById: async (tx, id) => {
      return (await model(tx, "amlScreening").findUnique({ where: { id } })) as AmlScreeningRow | null;
    },
    listScreenings: async (tx, filter) => {
      const where: Any = {};
      if (filter.subjectId) where.subjectId = filter.subjectId;
      if (filter.result) where.result = filter.result;
      return rows<AmlScreeningRow>(
        await model(tx, "amlScreening").findMany({
          where,
          orderBy: { requestedAt: "desc" },
          take: filter.limit,
          skip: filter.offset,
        }),
      );
    },
    listScreeningMatches: async (tx, screeningId) => {
      return rows<AmlScreeningMatchRow>(
        await model(tx, "amlScreeningMatch").findMany({ where: { screeningId: screeningId } }),
      );
    },
    findScreeningMatchById: async (tx, id) => {
      return (await model(tx, "amlScreeningMatch").findUnique({ where: { id } })) as AmlScreeningMatchRow | null;
    },
    updateScreeningMatch: async (tx, id, patch) => {
      return model(tx, "amlScreeningMatch").update({ where: { id }, data: patch }) as Promise<AmlScreeningMatchRow>;
    },
    listReportingRules: async (tx) => {
      return rows<ReportingRuleRow>(await model(tx, "reportingRule").findMany());
    },
    createReportingRule: async (tx, data) => {
      return model(tx, "reportingRule").create({ data }) as Promise<ReportingRuleRow>;
    },
    listRegulatoryReports: async (tx, filter) => {
      const where: Any = {};
      if (filter.status) where.status = filter.status;
      return rows<RegulatoryReportRow>(
        await model(tx, "regulatoryReport").findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: filter.limit,
          skip: filter.offset,
        }),
      );
    },
    findRegulatoryReportById: async (tx, id) => {
      return (await model(tx, "regulatoryReport").findUnique({ where: { id } })) as RegulatoryReportRow | null;
    },
    createRegulatoryReport: async (tx, data) => {
      return model(tx, "regulatoryReport").create({ data }) as Promise<RegulatoryReportRow>;
    },
    updateRegulatoryReport: async (tx, id, patch) => {
      return model(tx, "regulatoryReport").update({ where: { id }, data: patch }) as Promise<RegulatoryReportRow>;
    },
    createOperatorCase: async (tx, data) => {
      return model(tx, "operatorCase").create({ data }) as Promise<OperatorCaseRow>;
    },
  };

  payments: PaymentRepository = {
    lockLinkByKey: async (tx, key) => {
      const result = await tx.$queryRaw`
        SELECT * FROM payment_links WHERE "key" = ${key} LIMIT 1 FOR UPDATE
      `;
      const found = mapRawRows<PaymentLinkRow>(result)[0];
      if (!found) {
        return (await model(tx, "paymentLink").findUnique({ where: { key } })) as PaymentLinkRow | null;
      }
      return found;
    },
    findLinkByKey: async (tx, key) => {
      return (await model(tx, "paymentLink").findUnique({ where: { key } })) as PaymentLinkRow | null;
    },
    findLinkById: async (tx, id) => {
      return (await model(tx, "paymentLink").findUnique({ where: { id } })) as PaymentLinkRow | null;
    },
    updateLinkSlotCount: async (tx, linkId, delta) => {
      await tx.$executeRaw`
        UPDATE payment_links
        SET active_locked_count = GREATEST(0, active_locked_count + ${delta})
        WHERE id = ${linkId}
      `;
    },
    resolveSettlementTarget: async (tx, input) => {
      const result = await tx.$queryRaw`
        SELECT cs.settlement_target AS settlement_target
        FROM rail_routes r
        INNER JOIN rails rl ON rl.id = r.rail_id
        INNER JOIN credential_sets cs ON cs.gateway_id = r.gateway_id AND cs.env = ${input.env}
        WHERE (${input.railCode ?? null} IS NULL OR rl.code = ${input.railCode ?? null})
          AND cs.status = 'VERIFIED'
        ORDER BY cs.owner_type ASC
        LIMIT 1
      `;
      const found = rows<Any>(result)[0];
      const target = found?.settlement_target;
      if (target === "MERCHANT_DIRECT" || target === "PROVIDER_HELD" || target === "PLATFORM_CLEARING") {
        return target;
      }
      return "PLATFORM_CLEARING";
    },
    createAttempt: async (tx, data) => {
      return model(tx, "paymentAttempt").create({ data }) as Promise<PaymentAttemptRow>;
    },
    findAttemptById: async (tx, id) => {
      return (await model(tx, "paymentAttempt").findUnique({ where: { id } })) as PaymentAttemptRow | null;
    },
    findAttemptByReference: async (tx, reference) => {
      return (await model(tx, "paymentAttempt").findUnique({ where: { reference } })) as PaymentAttemptRow | null;
    },
    findAttemptByIdempotencyKey: async (tx, idempotencyKey) => {
      return (await model(tx, "paymentAttempt").findFirst({
        where: { idempotencyKey: idempotencyKey },
      })) as PaymentAttemptRow | null;
    },
    findAttemptByProviderReference: async (tx, providerReference) => {
      return (await model(tx, "paymentAttempt").findFirst({
        where: { providerReference: providerReference },
      })) as PaymentAttemptRow | null;
    },
    updateAttempt: async (tx, id, patch) => {
      return model(tx, "paymentAttempt").update({ where: { id }, data: patch }) as Promise<PaymentAttemptRow>;
    },
    collectWindowStats: async (tx, filter) => {
      const or: Any[] = [{ merchantId: filter.merchantId }];
      if (filter.applicationId) or.push({ applicationId: filter.applicationId });
      if (filter.linkId) or.push({ linkId: filter.linkId });
      if (filter.clientIp) or.push({ clientIp: filter.clientIp });
      const result = await model(tx, "paymentAttempt").findMany({
        where: {
          createdAt: { gte: filter.since },
          OR: or,
          status: { in: ["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "SUCCEEDED", "UNKNOWN"] },
        },
        select: { requestedAmount: true, totalChargedAmount: true },
      });
      const amounts: Money[] = [];
      let total = 0n;
      for (const attempt of rows<Any>(result)) {
        const value = moneyFromDecimal(attempt.totalChargedAmount ?? attempt.requestedAmount ?? 0);
        amounts.push(value);
        total += value;
      }
      const stats: AttemptWindowStats = { count: amounts.length, totalAmount: total, amounts };
      return stats;
    },
    sumSucceededAmountByRouteInWindow: async (tx, window) => {
      const result = await tx.$queryRaw`
        SELECT route_id, SUM(total_charged_amount) AS processed_amount
        FROM payment_attempts
        WHERE status = 'SUCCEEDED'
          AND route_id IS NOT NULL
          AND COALESCE(terminal_at, created_at) >= ${window.since}
          AND COALESCE(terminal_at, created_at) < ${window.until}
        GROUP BY route_id
      `;
      const totals = new Map<string, Money>();
      for (const row of rows<Any>(result)) {
        const routeId = String(row.route_id ?? row.routeId ?? "");
        if (routeId.length === 0) {
          continue;
        }
        const amount = moneyFromDecimal(row.processed_amount ?? row.processedAmount ?? 0);
        totals.set(routeId, (totals.get(routeId) ?? 0n) + amount);
      }
      return totals;
    },
    listSettledAttemptsInWindow: async (tx, input) => {
      const result = await tx.$queryRaw`
        SELECT pa.*
        FROM payment_attempts pa
        INNER JOIN rail_routes rr ON rr.id = pa.route_id
        WHERE rr.gateway_id = ${input.gatewayId}
          AND pa.created_at >= ${input.since}
          AND pa.created_at <= ${input.until}
          AND pa.status IN ('SUCCEEDED', 'DISPUTED', 'PARTIALLY_REFUNDED')
      `;
      return mapRawRows<PaymentAttemptRow>(result);
    },
    listPollPolicies: async (tx) => {
      const result = await model(tx, "pollPolicy").findMany({});
      return rows<Any>(result).map((policy) => ({
        routeId: policy.routeId,
        firstAfterSeconds: policy.firstAfterSeconds ?? 5,
        backoffSeconds: Array.isArray(policy.backoffSeconds) ? policy.backoffSeconds : [],
        maxDurationSeconds: policy.maxDurationSeconds ?? 900,
        stopOnStates: Array.isArray(policy.stopOnStates) ? policy.stopOnStates : [],
      }));
    },
    listRouteInquirySupport: async (tx) => {
      const result = await model(tx, "railRoute").findMany({
        select: { id: true, gatewayVersionId: true },
      });
      const routes = rows<Any>(result);
      const settings = rows<Any>(await model(tx, "gatewaySetting").findMany({ select: { gatewayVersionId: true, supportsStatusCheck: true } }));
      const byVersion = new Map<string, boolean>();
      for (const setting of settings) {
        byVersion.set(String(setting.gatewayVersionId), Boolean(setting.supportsStatusCheck));
      }
      return routes.map((route) => ({
        routeId: String(route.id),
        supportsStatusCheck: byVersion.get(String(route.gatewayVersionId)) ?? false,
      }));
    },
  };

  disputes: DisputeRepository = {
    findDisputeByGatewayRef: async (tx, gatewayId, externalDisputeRef) => {
      return (await model(tx, "dispute").findFirst({
        where: { gatewayId: gatewayId, externalDisputeRef: externalDisputeRef },
      })) as DisputeRow | null;
    },
    createDispute: async (tx, data) => {
      return model(tx, "dispute").create({ data }) as Promise<DisputeRow>;
    },
    findDisputeById: async (tx, id) => {
      return (await model(tx, "dispute").findUnique({ where: { id } })) as DisputeRow | null;
    },
    listDisputes: async (tx, filter) => {
      const where: Any = {};
      if (filter.status) where.status = filter.status;
      if (filter.merchantId) where.merchantId = filter.merchantId;
      return rows<DisputeRow>(
        await model(tx, "dispute").findMany({ where, orderBy: { openedAt: "desc" }, take: filter.limit, skip: filter.offset }),
      );
    },
    updateDispute: async (tx, id, patch) => {
      return model(tx, "dispute").update({ where: { id }, data: patch }) as Promise<DisputeRow>;
    },
    createAdjustment: async (tx, data) => {
      return model(tx, "adjustment").create({ data }) as Promise<AdjustmentRow>;
    },
    findAdjustmentById: async (tx, id) => {
      return (await model(tx, "adjustment").findUnique({ where: { id } })) as AdjustmentRow | null;
    },
    findAdjustmentByDispute: async (tx, disputeId) => {
      return (await model(tx, "adjustment").findFirst({ where: { disputeId: disputeId } })) as AdjustmentRow | null;
    },
    listAdjustments: async (tx, filter) => {
      const where: Any = {};
      if (filter.state) where.state = filter.state;
      return rows<AdjustmentRow>(
        await model(tx, "adjustment").findMany({ where, orderBy: { createdAt: "desc" }, take: filter.limit, skip: filter.offset }),
      );
    },
    updateAdjustment: async (tx, id, patch) => {
      return model(tx, "adjustment").update({ where: { id }, data: patch }) as Promise<AdjustmentRow>;
    },
    sumExecutedRefundsForAttempt: async (tx, attemptId) => {
      const result = await model(tx, "adjustment").aggregate({
        where: { sourceAttemptId: attemptId, type: "REFUND", state: "EXECUTED" },
        _sum: { amount: true },
      });
      const sum = (result as Any)?._sum?.amount;
      return sum === null || sum === undefined ? 0n : moneyFromDecimal(sum);
    },
  };

  governance: GovernanceRepository = {
    createApprovalRequest: async (tx, data) => {
      return model(tx, "approvalRequest").create({ data }) as Promise<ApprovalRequestRow>;
    },
    findApprovalRequestById: async (tx, id) => {
      return (await model(tx, "approvalRequest").findUnique({ where: { id } })) as ApprovalRequestRow | null;
    },
    listApprovalRequests: async (tx, filter) => {
      const where: Any = {};
      if (filter.state) where.state = filter.state;
      if (filter.subjectType) where.subjectType = filter.subjectType;
      return rows<ApprovalRequestRow>(
        await model(tx, "approvalRequest").findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: filter.limit,
          skip: filter.offset,
        }),
      );
    },
    updateApprovalRequest: async (tx, id, patch) => {
      return model(tx, "approvalRequest").update({ where: { id }, data: patch }) as Promise<ApprovalRequestRow>;
    },
    writeAuditLog: async (tx, data) => {
      const actorId = await this.resolveAuditActor(tx, data.actorId);
      if (!actorId) {
        return;
      }
      await model(tx, "auditLog").create({
        data: {
          actorId,
          role: data.role ?? "SYSTEM",
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId,
          beforeJson: data.beforeJson ?? {},
          afterJson: data.afterJson ?? {},
          approvalRequestId: data.approvalRequestId ?? null,
        },
      });
    },
    getPlatformSetting: async (tx, key) => {
      const setting = (await model(tx, "platformSetting").findFirst({
        where: { key },
        orderBy: { version: "desc" },
      })) as PlatformSettingRow | null;
      return setting ? setting.valueJson : null;
    },
    listPlatformSettings: async (tx) => {
      return rows<PlatformSettingRow>(await model(tx, "platformSetting").findMany());
    },
  };

  notifications: NotificationRepository = {
    findTemplate: async (tx, code, channel, lang) => {
      const template = (await model(tx, "notificationTemplate").findFirst({
        where: { code, channel, lang, active: true },
        orderBy: { version: "desc" },
      })) as NotificationTemplateRow | null;
      return template;
    },
    listTemplates: async (tx) => {
      return rows<NotificationTemplateRow>(await model(tx, "notificationTemplate").findMany());
    },
    enqueueNotification: async (tx, data) => {
      return model(tx, "notification").create({ data }) as Promise<NotificationRow>;
    },
    updateNotification: async (tx, id, patch) => {
      return model(tx, "notification").update({ where: { id }, data: patch }) as Promise<NotificationRow>;
    },
  };

  reconciliation: ReconciliationRepository = {
    findStatementSourceById: async (tx, id) => {
      return (await model(tx, "statementSource").findUnique({ where: { id } })) as StatementSourceRow | null;
    },
    listStatementSources: async (tx) => {
      return rows<StatementSourceRow>(await model(tx, "statementSource").findMany());
    },
    findRunByFileHash: async (tx, fileHash) => {
      return (await model(tx, "reconciliationRun").findUnique({ where: { fileHash: fileHash } })) as ReconciliationRunRow | null;
    },
    createRun: async (tx, data) => {
      return model(tx, "reconciliationRun").create({ data }) as Promise<ReconciliationRunRow>;
    },
    updateRunStats: async (tx, id, stats) => {
      await model(tx, "reconciliationRun").update({ where: { id }, data: { statsJson: stats } });
    },
    createItem: async (tx, data) => {
      return model(tx, "reconciliationItem").create({ data }) as Promise<ReconciliationItemRow>;
    },
    listItemsByRun: async (tx, runId) => {
      return rows<ReconciliationItemRow>(
        await model(tx, "reconciliationItem").findMany({ where: { runId: runId } }),
      );
    },
  };

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx: Tx) => fn(tx)) as Promise<T>;
  }

  private async resolveAuditActor(tx: Tx, actorId: string | null): Promise<string | null> {
    if (actorId) {
      return actorId;
    }
    const existing = await model(tx, "user").findFirst({
      where: { email: SYSTEM_AUDIT_ACTOR_EMAIL },
      select: { id: true },
    });
    if (existing) {
      return String(existing.id);
    }
    const created = await model(tx, "user").create({
      data: {
        email: SYSTEM_AUDIT_ACTOR_EMAIL,
        role: "OPERATOR",
        authoritiesMap: {},
        appScopeIds: [],
        isMaker: false,
        isChecker: false,
        mfaRequired: false,
        status: "ACTIVE",
      },
    });
    return String(created.id);
  }
}

export const OPEN_JOIN_REQUEST_STATUSES: JoinRequestStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "IN_REVIEW",
  "INFO_REQUESTED",
  "PENDING_CHECKER",
];
