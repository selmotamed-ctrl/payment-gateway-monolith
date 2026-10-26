import "dotenv/config";
import { Prisma } from "../generated/prisma/client";
import { client, ensureSchemaVersion } from "./client";
import { seedBlueprints } from "./seedBlueprints";

const platformSettings = [
  {
    key: "OD-1",
    valueJson: {
      mode: "PROVISIONAL",
      internalOnly: true,
      description: "CBL reporting thresholds remain provisional until written instructions are recorded.",
    },
  },
  {
    key: "OD-2",
    valueJson: {
      policy: "RISK_BASED",
      description: "Join request four-eyes decisions are selected by risk assessment.",
    },
  },
  {
    key: "OD-3",
    valueJson: {
      provider: "INTERNAL_WATCHLIST",
      adapters: ["internal-watchlist", "mock-sandbox"],
      description: "Screening is provider-driven and ships with internal and sandbox adapters.",
    },
  },
  {
    key: "OD-4",
    valueJson: {
      kybYears: 5,
      description: "KYB and related records are retained for five years by default.",
    },
  },
  {
    key: "OD-5",
    valueJson: {
      gatewayCode: "neompay",
      kind: "INTERNAL",
      recommendedStage: 2,
      description: "NeomPay is the recommended first production internal rail.",
    },
  },
  {
    key: "OD-6",
    valueJson: {
      ownerThresholdPercent: 25,
      description: "Beneficial owners at or above twenty-five percent are captured.",
    },
  },
  {
    key: "OD-7",
    valueJson: {
      otpPullSeconds: 1200,
      redirectSeconds: 1800,
      qrDisplaySeconds: 900,
      pushApprovalSeconds: 900,
      description: "Platform TTL ceilings for payment collection modes.",
    },
  },
  {
    key: "OD-8",
    valueJson: {
      negativeBalanceCeiling: "0.0000",
      currency: "LYD",
      description: "New merchants have no negative wallet balance allowance by default.",
    },
  },
  {
    key: "OD-9",
    valueJson: {
      ratificationWindowHours: 24,
      authorizedRoles: ["MLRO", "COMPLIANCE"],
      description: "Emergency suspensions require ratification by MLRO or a second compliance officer.",
    },
  },
  {
    key: "OD-10",
    valueJson: {
      sandboxBeforeApproval: true,
      description: "Pending merchants may use sandbox rails before approval.",
    },
  },
  {
    key: "OD-11",
    valueJson: {
      checkerRoles: ["MLRO", "COMPLIANCE", "FINANCE"],
      description: "Named organizational checker accounts are provisioned without embedded credentials.",
    },
  },
] as const;

const glAccountTypes = [
  "TREASURY",
  "GATEWAY_CLEARING",
  "MERCHANT_WALLET",
  "PLATFORM_INCOME",
  "PROVIDER_FEE_EXPENSE",
  "GATEWAY_FEE_EXPENSE",
  "GATEWAY_FEE_ACCRUAL",
  "COMMISSION_RECEIVABLE",
  "AML_HOLD",
  "CHARGEBACK_RESERVE",
  "SUSPENSE",
] as const;

const adminUsers = [
  {
    email: "gateway-admin@payment-gateway.internal",
    role: "GATEWAY_ADMIN",
    authorities: ["gateway:read", "gateway:write", "gateway:test"],
    isMaker: true,
    isChecker: false,
  },
  {
    email: "security-admin@payment-gateway.internal",
    role: "SECURITY_ADMIN",
    authorities: ["security:read", "security:write", "credential:write"],
    isMaker: true,
    isChecker: true,
  },
  {
    email: "finance@payment-gateway.internal",
    role: "FINANCE",
    authorities: ["finance:read", "finance:write", "commission:write", "cashout:review"],
    isMaker: false,
    isChecker: true,
  },
  {
    email: "compliance@payment-gateway.internal",
    role: "COMPLIANCE",
    authorities: ["compliance:read", "compliance:write", "aml:review", "report:review"],
    isMaker: false,
    isChecker: true,
  },
  {
    email: "mlro@payment-gateway.internal",
    role: "MLRO",
    authorities: ["aml:read", "aml:write", "aml:release", "report:approve"],
    isMaker: false,
    isChecker: true,
  },
  {
    email: "operator@payment-gateway.internal",
    role: "OPERATOR",
    authorities: ["attempt:read", "attempt:inquire", "case:read"],
    isMaker: true,
    isChecker: false,
  },
  {
    email: "support@payment-gateway.internal",
    role: "SUPPORT",
    authorities: ["merchant:read", "attempt:read", "case:read"],
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

  for (const accountType of glAccountTypes) {
    await client.glAccount.upsert({
      where: { seedKey: `system:${accountType}` },
      update: {},
      create: {
        accountType,
        currency: "LYD",
        checkpointBalance: new Prisma.Decimal(0),
        seedKey: `system:${accountType}`,
      },
    });
  }

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

  for (const template of notificationTemplates) {
    for (const [lang, content] of [
      ["AR", template.ar],
      ["EN", template.en],
    ] as const) {
      await client.notificationTemplate.upsert({
        where: {
          code_channel_lang_version: {
            code: template.code,
            channel: "EMAIL",
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
          channel: "EMAIL",
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

  await seedBlueprints(client);
};

try {
  await seed();
  process.stdout.write("Core seed completed successfully.\n");
} finally {
  await client.$disconnect();
}
