import "dotenv/config";
import { Prisma } from "../generated/prisma/client";
import { client, ensureSchemaVersion } from "./client";
import { seedBlueprints, seedPlatformCredentialSets } from "./seedBlueprints";
import { seedCheckoutSupport, seedRailHelpGuides } from "./seedGuides";
import { seedSystemGlAccounts } from "./seedGlAccounts";
import { seedDefaultChromeSpecs } from "../engine/reportStudio/seedDefaultChromeSpecs";
import { ensureCommunicationTemplates } from "../lib/communication/templates";
import { platformSettings } from "./platformSettingsSeed";


const adminUsers = [
  {
    email: "gateway-admin@payment-gateway.internal",
    role: "GATEWAY_ADMIN",
    authorities: ["gateway:read", "gateway:write", "gateway:test", "settings:read", "settings:write", "report_engine:run"],
    isMaker: true,
    isChecker: false,
  },
  {
    email: "security-admin@payment-gateway.internal",
    role: "SECURITY_ADMIN",
    authorities: ["security:read", "security:write", "credential:read", "credential:write", "settings:read", "settings:write", "system:storage:read", "system:storage:admin", "system:storage:legal-hold", "approval:read", "approval:check", "approval:write", "report_engine:run"],
    isMaker: true,
    isChecker: true,
  },
  {
    email: "finance@payment-gateway.internal",
    role: "FINANCE",
    authorities: ["finance:read", "finance:write", "commission:write", "cashout:review", "dispute:read", "dispute:write", "reconciliation:read", "reconciliation:write", "velocity:read", "velocity:write", "approval:read", "approval:check", "approval:write", "case:read", "operator:read", "report_engine:run"],
    isMaker: false,
    isChecker: true,
  },
  {
    email: "compliance@payment-gateway.internal",
    role: "COMPLIANCE",
    authorities: ["compliance:read", "compliance:write", "aml:review", "report:review", "aml.read_confidential", "approval:read", "approval:check", "approval:write", "case:read", "operator:read", "merchant:read", "merchant:write", "kyb:read", "kyb:write", "report_engine:run"],
    isMaker: false,
    isChecker: true,
  },
  {
    email: "mlro@payment-gateway.internal",
    role: "MLRO",
    authorities: ["aml:read", "aml:write", "aml:release", "report:approve", "aml.read_confidential", "approval:read", "approval:check", "approval:write", "case:read", "operator:read", "merchant:read", "kyb:read", "kyb:write", "report_engine:run"],
    isMaker: false,
    isChecker: true,
  },
  {
    email: "operator@payment-gateway.internal",
    role: "OPERATOR",
    authorities: ["attempt:read", "attempt:inquire", "case:read", "case:write", "merchant:read", "kyb:read", "kyb:write", "report_engine:run"],
    isMaker: true,
    isChecker: false,
  },
  {
    email: "support@payment-gateway.internal",
    role: "SUPPORT",
    authorities: ["merchant:read", "attempt:read", "case:read", "report_engine:run"],
    isMaker: false,
    isChecker: false,
  },
] as const;

const notificationTemplates = [
  {
    code: "PAYMENT_SUCCEEDED",
    confidentialityClass: "MERCHANT",
    ar: {
      subject: "تم الدفع بنجاح",
      body: "تم استلام دفعة بقيمة {{amount}} {{currency}}.",
    },
    en: {
      subject: "Payment completed",
      body: "A payment of {{amount}} {{currency}} was received.",
    },
  },
  {
    code: "PAYMENT_FAILED",
    confidentialityClass: "MERCHANT",
    ar: {
      subject: "فشل الدفع",
      body: "لم تكتمل دفعة بقيمة {{amount}} {{currency}}.",
    },
    en: {
      subject: "Payment failed",
      body: "A payment of {{amount}} {{currency}} could not be completed.",
    },
  },
  {
    code: "PAYMENT_UNKNOWN",
    confidentialityClass: "INTERNAL",
    ar: {
      subject: "الدفع قيد التحقق",
      body: "يتم التحقق من حالة الدفعة بقيمة {{amount}} {{currency}}.",
    },
    en: {
      subject: "Payment verification pending",
      body: "The status of a payment of {{amount}} {{currency}} is being verified.",
    },
  },
  {
    code: "AML_HOLD_CREATED",
    confidentialityClass: "INTERNAL",
    ar: {
      subject: "إجراء مراجعة مطلوب",
      body: "تم إنشاء حالة مراجعة داخلية تتطلب إجراءً من فريق الامتثال.",
    },
    en: {
      subject: "Review action required",
      body: "An internal review case was created for the compliance team.",
    },
  },
  {
    code: "DISPUTE_OPENED",
    confidentialityClass: "MERCHANT",
    ar: {
      subject: "تم فتح نزاع",
      body: "تم فتح نزاع بقيمة {{amount}} {{currency}}.",
    },
    en: {
      subject: "Dispute opened",
      body: "A dispute of {{amount}} {{currency}} has been opened.",
    },
  },
  {
    code: "CASHOUT_REQUESTED",
    confidentialityClass: "MERCHANT",
    ar: {
      subject: "تم استلام طلب السحب",
      body: "تم استلام طلب سحب بقيمة {{amount}} {{currency}}.",
    },
    en: {
      subject: "Cash-out request received",
      body: "A cash-out request of {{amount}} {{currency}} was received.",
    },
  },
  {
    code: "APPROVAL_REQUIRED",
    confidentialityClass: "INTERNAL",
    ar: {
      subject: "مطلوب اعتماد",
      body: "هناك طلب اعتماد جديد بانتظار المراجعة.",
    },
    en: {
      subject: "Approval required",
      body: "A new approval request is waiting for review.",
    },
  },
  {
    code: "LOGIN_MFA",
    confidentialityClass: "INTERNAL",
    channel: "SMS",
    ar: {
      subject: "رمز الدخول",
      body: "رمز الدخول الخاص بك هو {{code}}. لا تشارك هذا الرمز مع أي شخص.",
    },
    en: {
      subject: "Your sign-in code",
      body: "Your sign-in code is {{code}}. Never share this code with anyone.",
    },
  },
  {
    code: "IDENTITY_VERIFICATION",
    confidentialityClass: "INTERNAL",
    channel: "SMS",
    ar: {
      subject: "رمز التحقق",
      body: "رمز التحقق من هويتك هو {{code}}. لا تشارك هذا الرمز مع أي شخص.",
    },
    en: {
      subject: "Your verification code",
      body: "Your identity verification code is {{code}}. Never share this code with anyone.",
    },
  },
] as const;

const seed = async () => {
  await ensureSchemaVersion();

  for (const setting of platformSettings) {
    await client.platformSetting.upsert({
      where: {
        key_scope_version: {
          key: setting.key,
          scope: "PLATFORM",
          version: 1,
        },
      },
      update: {},
      create: {
        key: setting.key,
        scope: "PLATFORM",
        valueJson: setting.valueJson,
        version: 1,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
  }

  // One system GL account per (account type, currency): the ledger resolves
  // its accounts by currency, so every supported currency needs its own row.
  await seedSystemGlAccounts(client);

  for (const user of adminUsers) {
    await client.user.upsert({
      where: { email: user.email },
      update: {
        role: user.role,
        authoritiesMap: user.authorities,
        isMaker: user.isMaker,
        isChecker: user.isChecker,
        mfaRequired: true,
        passwordHash: null,
        mfaSecretCiphertext: null,
      },
      create: {
        email: user.email,
        role: user.role,
        authoritiesMap: user.authorities,
        isMaker: user.isMaker,
        isChecker: user.isChecker,
        mfaRequired: true,
        status: "INVITED",
        passwordHash: null,
        mfaSecretCiphertext: null,
      },
    });
  }

  // Default bilingual report chrome (header/footer) for the Report Studio.
  const chromeSeedUser = await client.user.findUnique({
    where: { email: "security-admin@payment-gateway.internal" },
  });
  if (chromeSeedUser) {
    await seedDefaultChromeSpecs(client, chromeSeedUser.id);
  }

  for (const template of notificationTemplates) {
    const channel = "channel" in template ? template.channel : "EMAIL";
    for (const [lang, content] of [
      ["AR", template.ar],
      ["EN", template.en],
    ] as const) {
      await client.notificationTemplate.upsert({
        where: {
          code_channel_lang_version: {
            code: template.code,
            channel,
            lang,
            version: 1,
          },
        },
        update: {
          subjectTemplate: content.subject,
          bodyTemplate: content.body,
          confidentialityClass: template.confidentialityClass,
          active: true,
        },
        create: {
          code: template.code,
          channel,
          lang,
          subjectTemplate: content.subject,
          bodyTemplate: content.body,
          confidentialityClass: template.confidentialityClass,
          version: 1,
          active: true,
        },
      });
    }
  }

  await client.commissionProfile.upsert({
    where: { seedKey: "platform-default" },
    update: {},
    create: {
      railCode: "default",
      calcType: "PERCENTAGE",
      percentageRate: new Prisma.Decimal("0.030000"),
      flatFee: new Prisma.Decimal(0),
      minFee: new Prisma.Decimal(0),
      feeBearerDefault: "MERCHANT_ABSORBS",
      roundingMode: "HALF_UP",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      version: 1,
      seedKey: "platform-default",
    },
  });

  await ensureCommunicationTemplates(client as never);

  await seedBlueprints(client);

  // The platform owned credential sets of the seeded gateways. Without them a
  // route with the `PLATFORM` credential policy has no `VERIFIED` credential
  // set, so no rail is ever visible and no payment can start.
  const seededCredentialSets = await seedPlatformCredentialSets(client);
  process.stdout.write(`Seeded ${seededCredentialSets} platform credential sets.\n`);

  // The regulatory reporting rules (design §20, OD-1). A CONFIRMED rule
  // generates a live filing; a PROVISIONAL rule only drafts an internal one.
  const reportingRuleSeeds = [
    {
      reportType: "SUSPICIOUS_ACTIVITY" as const,
      thresholdAmount: "50000.0000",
      windowSeconds: 86400,
      sourceReference: "CBL-SUSPICIOUS-ACTIVITY-PROVISIONAL-001",
      status: "PROVISIONAL" as const,
      requiredOutputFormats: ["XML"] as const,
      primaryOutputFormat: "XML" as const,
    },
  ];
  let seededReportingRules = 0;
  for (const rule of reportingRuleSeeds) {
    const existing = await client.reportingRule.findFirst({
      where: { sourceReference: rule.sourceReference },
    });
    if (existing) {
      continue;
    }
    await client.reportingRule.create({
      data: {
        authority: "CBL",
        reportType: rule.reportType,
        thresholdAmount: new Prisma.Decimal(rule.thresholdAmount),
        windowSeconds: rule.windowSeconds,
        currency: "LYD",
        conditions: {},
        sourceReference: rule.sourceReference,
        status: rule.status,
        requiredOutputFormats: [...rule.requiredOutputFormats] as never,
        primaryOutputFormat: rule.primaryOutputFormat as never,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    seededReportingRules += 1;
  }
  process.stdout.write(`Seeded ${seededReportingRules} reporting rules.\n`);

  // The four built-in portal guides: the checkout support configuration and the
  // bilingual per-rail walkthroughs rendered by the checkout help center.
  await seedCheckoutSupport(client);
  const guidedRails = await seedRailHelpGuides(client);
  process.stdout.write(`Seeded the checkout support config and ${guidedRails} rail help guides.\n`);
};

try {
  await seed();
  process.stdout.write("Core seed completed successfully.\n");
} finally {
  await client.$disconnect();
}
