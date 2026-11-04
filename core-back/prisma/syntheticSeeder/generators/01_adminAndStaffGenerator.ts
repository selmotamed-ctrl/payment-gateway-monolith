import type { SeederContext } from "../context";
import { metaOf } from "../context";
import { addDays } from "../builders";
import { ROLE_AUTHORITIES, ROLE_FLAGS, type AdminRole } from "../../../scripts/createAdminPlan";

/**
 * The platform staff of the simulated operator: one row per seat, with the
 * SAME flat authority list and maker/checker flags the bootstrap CLI and the
 * baseline seed use (`scripts/createAdminPlan.ts`). The previous generator
 * wrote a nested `{ gateway: ["read"] }` map that `parseAuthorities` ignores,
 * so every seeded staff member resolved to zero authorities.
 */
export const PLATFORM_SEATS: readonly AdminRole[] = [
  "GATEWAY_ADMIN", "GATEWAY_ADMIN", "SECURITY_ADMIN", "FINANCE", "FINANCE",
  "OPERATOR", "OPERATOR", "OPERATOR", "OPERATOR", "COMPLIANCE", "COMPLIANCE", "MLRO", "SUPPORT",
];

export const staffEmail = (ctx: SeederContext, role: string, index: number): string =>
  `${role.toLowerCase().replaceAll("_", ".")}.${index}@${ctx.config.namespace}.pg.internal`;

/** Platform staff, the system drafter, rules and policy rows. */
export const generateAdminAndStaff = (ctx: SeederContext): void => {
  const start = ctx.timeline.start;
  let index = 0;
  for (const role of PLATFORM_SEATS) {
    index += 1;
    const createdAt = addDays(start, ctx.rng.int(0, 60));
    const flags = ROLE_FLAGS[role];
    // Every maker and checker seat stays ACTIVE so the maker-checker queues
    // always have an eligible pair; only the support desk shows the other
    // lifecycle states.
    const status = role === "SUPPORT" ? "INVITED" : "ACTIVE";
    const id = ctx.nextId("user");
    const email = staffEmail(ctx, role, index);
    ctx.dataset.users.push({
      id,
      createdAt,
      updatedAt: createdAt,
      merchantId: null,
      email,
      phone: null,
      passwordHash: null,
      role,
      authoritiesMap: [...ROLE_AUTHORITIES[role]],
      appScopeIds: null,
      isMaker: flags.isMaker,
      isChecker: flags.isChecker,
      mfaRequired: true,
      mfaSecretCiphertext: null,
      invitationTokenHash: null,
      invitationExpiresAt: null,
      invitedById: null,
      status,
      academyProgressJson: {
        completedModules: ctx.rng.int(1, 6),
        quizScores: { aml: ctx.rng.int(60, 100), pci: ctx.rng.int(60, 100) },
        badges: [flags.isMaker ? "maker" : null, flags.isChecker ? "checker" : null].filter(Boolean),
      },
    });
    ctx.dataset.userIdentities.push({
      id: ctx.nextId("identity"),
      createdAt,
      updatedAt: createdAt,
      userId: id,
      kind: "EMAIL",
      identifierNormalized: email,
      providerSubject: null,
      verifiedAt: status === "ACTIVE" ? createdAt : null,
      isPrimary: true,
      lastUsedAt: status === "ACTIVE" ? addDays(ctx.timeline.end, -ctx.rng.int(0, 3)) : null,
    });
    ctx.refs.adminUsers.push({ id, email, role });
  }

  // The automation identity that drafts chargebacks and SUSPENSE refunds.
  // It mirrors `ensureSystemAutomationUser` (DISABLED, never maker/checker)
  // with a UUID id: the engine constant `SYSTEM_AUTOMATION` is not a UUID and
  // cannot be stored in `users.id` (reported separately).
  const systemId = ctx.nextId("user");
  ctx.dataset.users.push({
    id: systemId,
    createdAt: start,
    updatedAt: start,
    merchantId: null,
    email: `system-drafter@${ctx.config.namespace}.pg.internal`,
    phone: null,
    passwordHash: null,
    role: "OPERATOR",
    authoritiesMap: {},
    appScopeIds: [],
    isMaker: false,
    isChecker: false,
    mfaRequired: false,
    mfaSecretCiphertext: null,
    invitationTokenHash: null,
    invitationExpiresAt: null,
    invitedById: null,
    status: "DISABLED",
    academyProgressJson: null,
  });
  metaOf(ctx).systemUserId = systemId;

  // Velocity rules. Thresholds are the ones a Libyan switch would really run:
  // tight per-customer limits that REJECT, wide merchant/rail limits that only
  // FLAG. (The previous thresholds - e.g. RAIL REJECT above 20 payments an
  // hour - would have blocked live test traffic on the seeded server.)
  const velocity: Array<[string, number, number, string, string]> = [
    ["END_CLIENT_IP", 900, 12, "15000.0000", "REJECT"],
    ["END_CLIENT_PHONE", 3600, 8, "20000.0000", "REJECT"],
    ["END_CLIENT_CARD", 3600, 6, "15000.0000", "REJECT"],
    ["MERCHANT", 3600, 1500, "750000.0000", "FLAG"],
    ["APPLICATION", 3600, 1200, "500000.0000", "FLAG"],
    ["RAIL", 3600, 20000, "5000000.0000", "FLAG"],
    ["LINK", 3600, 40, "100000.0000", "FLAG"],
  ];
  for (const [scopeType, windowSeconds, maxCount, maxAmount, action] of velocity) {
    const createdAt = addDays(start, ctx.rng.int(0, 30));
    ctx.dataset.velocityRules.push({
      id: ctx.nextId("velocity"),
      createdAt,
      updatedAt: createdAt,
      scopeType,
      scopeValue: null,
      windowSeconds,
      maxCount,
      maxAmount,
      action,
      active: true,
      version: 1,
      effectiveFrom: createdAt,
      effectiveTo: null,
      approvalRequestId: null,
    });
  }

  // AML rules with the parameter keys `AmlRuleEngine.evaluateRule` reads
  // (`min_amount`, `max_amount`/`max_count`/`window_seconds`, `threshold`,
  // `tier`, `countries`/`mode`). The old rows carried a generic `threshold`
  // key, so five of the six rules could never fire.
  const amlRules: Array<[string, string, string, Record<string, unknown>, string, string]> = [
    ["AML-SINGLE-LARGE", "Single large transaction", "SINGLE_AMOUNT", { min_amount: "25000.0000", currency: "LYD" }, "HOLD", "HIGH"],
    ["AML-STRUCTURING", "Structuring below the CBL threshold", "STRUCTURING", { threshold: "50000.0000", band_percent: 10, min_count: 3, window_seconds: 86_400 }, "CASE_ONLY", "CRITICAL"],
    ["AML-CUMULATIVE", "Cumulative 24h window", "CUMULATIVE_WINDOW", { max_amount: "120000.0000", max_count: 60, window_seconds: 86_400 }, "FLAG", "MEDIUM"],
    ["AML-RISK-TIER", "High risk tier large payment", "RISK_TIER", { tier: "HIGH", min_amount: "10000.0000" }, "HOLD", "HIGH"],
    ["AML-COUNTERPARTY", "High risk counterparty country", "COUNTERPARTY_COUNTRY", { countries: ["KP", "IR", "SY"], mode: "DENY" }, "BLOCK", "CRITICAL"],
  ];
  for (const [code, name, ruleType, params, action, severity] of amlRules) {
    ctx.dataset.amlRules.push({
      id: ctx.nextId("aml-rule"),
      createdAt: start,
      updatedAt: start,
      code: `${code}-${ctx.config.namespace}`.toUpperCase(),
      name,
      ruleType,
      scope: { rail: null, merchantId: null },
      params,
      action,
      baseSeverity: severity,
      active: true,
      version: 1,
      effectiveFrom: start,
      effectiveTo: null,
      approvalRequestId: null,
    });
  }

  // Reporting rules and notification templates are NOT generated: the baseline
  // seed (`prisma/seed.ts`) owns the bilingual template catalogue and the CBL
  // reporting rules. Re-creating them here produced duplicate CONFIRMED
  // LARGE_TRANSACTION rules (double filings) and template rows the unique key
  // silently dropped. The `server.environment_mode` setting likewise belongs to
  // `seedFakeRails.ts`.
};
