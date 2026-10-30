import type { SeederContext } from "../context";
import { addDays, randomName } from "../builders";

const PLATFORM_ROLES = [
  "GATEWAY_ADMIN", "GATEWAY_ADMIN", "SECURITY_ADMIN", "FINANCE", "FINANCE",
  "OPERATOR", "OPERATOR", "OPERATOR", "COMPLIANCE", "COMPLIANCE", "MLRO", "SUPPORT",
] as const;

const AUTHORITIES: Record<string, Record<string, string[]>> = {
  GATEWAY_ADMIN: { gateway: ["read", "write", "publish"], version: ["read", "write"] },
  SECURITY_ADMIN: { security: ["read", "write"], audit: ["read"] },
  FINANCE: { finance: ["read", "write"], reconciliation: ["read", "write"] },
  OPERATOR: { attempt: ["read", "write"], operator_case: ["read", "write"] },
  COMPLIANCE: { compliance: ["read", "write"], aml_case: ["read", "write"] },
  MLRO: { compliance: ["read", "write"], aml_case: ["read", "approve"], report: ["read", "approve"] },
  SUPPORT: { attempt: ["read"], merchant: ["read"] },
};

/** Platform staff, maker/checker pairs, rules and notification templates. */
export const generateAdminAndStaff = (ctx: SeederContext): void => {
  const start = ctx.timeline.start;
  const roles = [...PLATFORM_ROLES];
  let index = 0;
  for (const role of roles) {
    index += 1;
    const name = randomName(ctx);
    const createdAt = addDays(start, ctx.rng.int(0, 120));
    const isMaker = index % 2 === 1;
    const id = ctx.nextId("user");
    ctx.dataset.users.push({
      id,
      createdAt,
      updatedAt: createdAt,
      merchantId: null,
      email: `${role.toLowerCase().replaceAll("_", ".")}.${index}@${ctx.config.namespace}.pg.internal`,
      phone: null,
      passwordHash: null,
      role,
      authoritiesMap: AUTHORITIES[role] ?? {},
      appScopeIds: null,
      isMaker,
      isChecker: !isMaker,
      mfaRequired: true,
      mfaSecretCiphertext: null,
      status: ctx.rng.chance(8) ? "INVITED" : ctx.rng.chance(3) ? "SUSPENDED" : "ACTIVE",
      academyProgressJson: {
        completedModules: ctx.rng.int(0, 6),
        quizScores: { aml: ctx.rng.int(60, 100), pci: ctx.rng.int(60, 100) },
        badges: isMaker ? ["maker"] : ["checker"],
      },
    });
    ctx.dataset.userIdentities.push({
      id: ctx.nextId("identity"),
      createdAt,
      updatedAt: createdAt,
      userId: id,
      kind: "EMAIL",
      identifierNormalized: `${role.toLowerCase()}.${index}@${ctx.config.namespace}.pg.internal`,
      providerSubject: null,
      verifiedAt: createdAt,
      isPrimary: true,
      lastUsedAt: ctx.timeline.end,
    });
    ctx.refs.adminUsers.push({ id, email: `${role.toLowerCase()}.${index}@${ctx.config.namespace}.pg.internal`, role });
    void name;
  }

  // Notification templates for the main customer/operator events.
  const templates: Array<[string, string, string, string]> = [
    ["PAYMENT_SUCCEEDED", "SMS", "AR", "تم الدفع بنجاح"],
    ["PAYMENT_SUCCEEDED", "SMS", "EN", "Payment succeeded"],
    ["PAYMENT_FAILED", "SMS", "AR", "فشل الدفع"],
    ["PAYMENT_FAILED", "EMAIL", "EN", "Payment failed"],
    ["OTP_CODE", "SMS", "AR", "رمز التحقق الخاص بك"],
    ["OTP_CODE", "SMS", "EN", "Your verification code"],
    ["KYB_DOC_EXPIRING", "EMAIL", "EN", "A KYB document is expiring"],
    ["AML_HOLD", "EMAIL", "AR", "تم تعليق العملية للمراجعة"],
    ["DISPUTE_OPENED", "EMAIL", "EN", "A dispute was opened"],
    ["CASHOUT_COMPLETE", "SMS", "AR", "تم تحويل المبلغ"],
  ];
  for (const [code, channel, lang, body] of templates) {
    ctx.dataset.notificationTemplates.push({
      id: ctx.nextId("template"),
      createdAt: start,
      updatedAt: start,
      code,
      channel,
      lang,
      subjectTemplate: null,
      bodyTemplate: `${body} {{reference}}`,
      confidentialityClass: code.startsWith("AML") ? "INTERNAL" : "MERCHANT",
      version: 1,
      active: true,
    });
  }

  // Velocity rules (one of each scope), AML rules and reporting rules.
  const velocityScopes = ["END_CLIENT_IP", "END_CLIENT_PHONE", "END_CLIENT_CARD", "MERCHANT", "APPLICATION", "RAIL", "LINK"];
  for (const scope of velocityScopes) {
    ctx.dataset.velocityRules.push({
      id: ctx.nextId("velocity"),
      createdAt: addDays(start, ctx.rng.int(0, 90)),
      updatedAt: ctx.timeline.end,
      scopeType: scope,
      scopeValue: null,
      windowSeconds: 3600,
      maxCount: ctx.rng.int(20, 200),
      maxAmount: ctx.rng.decimal(1000, 50000, 4),
      action: ctx.rng.chance(70) ? "REJECT" : "FLAG",
      active: true,
      version: 1,
      effectiveFrom: start,
      effectiveTo: null,
      approvalRequestId: null,
    });
  }
  const amlRules = [
    ["AML-SINGLE-LARGE", "Single large transaction", "SINGLE_AMOUNT", "HOLD", "HIGH"],
    ["AML-STRUCTURING", "Structuring pattern", "STRUCTURING", "CASE_ONLY", "CRITICAL"],
    ["AML-CUMULATIVE", "Cumulative window", "CUMULATIVE_WINDOW", "FLAG", "MEDIUM"],
    ["AML-RISK-TIER", "High risk tier", "RISK_TIER", "FLAG", "HIGH"],
    ["AML-COUNTERPARTY", "High risk counterparty country", "COUNTERPARTY_COUNTRY", "BLOCK", "CRITICAL"],
    ["AML-MERCHANT-DIRECT", "Merchant direct amount", "MERCHANT_DIRECT_AMOUNT", "HOLD", "MEDIUM"],
  ] as const;
  for (const [code, name, ruleType, action, severity] of amlRules) {
    ctx.dataset.amlRules.push({
      id: ctx.nextId("aml-rule"),
      createdAt: start,
      updatedAt: start,
      code,
      name,
      ruleType,
      scope: { rail: null, merchantId: null },
      params: { threshold: ctx.rng.decimal(5000, 50000, 4) },
      action,
      baseSeverity: severity,
      active: true,
      version: 1,
      effectiveFrom: start,
      effectiveTo: null,
      approvalRequestId: null,
    });
  }
  const reportingRules = [
    ["LARGE_TRANSACTION", "LARGE_TRANSACTION", 50000],
    ["SUSPICIOUS_ACTIVITY", "SUSPICIOUS_ACTIVITY", null],
    ["PERIODIC_RETURN", "PERIODIC_RETURN", null],
  ] as const;
  for (const [name, reportType, threshold] of reportingRules) {
    ctx.dataset.reportingRules.push({
      id: ctx.nextId("reporting-rule"),
      createdAt: start,
      updatedAt: start,
      authority: "CBL",
      reportType,
      thresholdAmount: threshold ? String(threshold) : null,
      windowSeconds: reportType === "PERIODIC_RETURN" ? 30 * 86_400 : null,
      currency: "LYD",
      conditions: { name },
      sourceReference: null,
      status: "CONFIRMED",
      effectiveFrom: start,
      effectiveTo: null,
      approvalRequestId: null,
    });
  }

  ctx.dataset.platformSettings.push({
    id: ctx.nextId("platform-setting"),
    createdAt: start,
    updatedAt: ctx.timeline.end,
    key: "server.environment_mode",
    scope: "PLATFORM",
    version: 1,
    valueJson: { mode: "TEST_SANDBOX" },
    effectiveFrom: start,
    approvalRequestId: null,
  });
};
