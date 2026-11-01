import type { PrismaClient } from "../generated/prisma/client";

type KybNotificationCode =
  | "KYB_DOC_EXPIRING"
  | "KYB_DOCUMENT_REPLACEMENT_REQUESTED"
  | "KYB_DOCUMENT_REPLACEMENT_RECEIVED"
  | "KYB_REVALIDATION_DUE"
  | "KYB_EXPIRED_SUSPENSION";

const TEMPLATES: Array<{
  code: KybNotificationCode;
  channel: "IN_APP" | "EMAIL";
  lang: "EN" | "AR";
  subject: string | null;
  body: string;
}> = [
  {
    code: "KYB_DOC_EXPIRING",
    channel: "IN_APP",
    lang: "EN",
    subject: null,
    body: "KYB document {{documentType}} expires on {{expiresOn}}. Upload a replacement before the expiry date.",
  },
  {
    code: "KYB_DOC_EXPIRING",
    channel: "EMAIL",
    lang: "EN",
    subject: "KYB document expiring: {{documentType}}",
    body: "Your KYB document {{documentType}} expires on {{expiresOn}}. Please upload a replacement before the expiry date.",
  },
  {
    code: "KYB_DOC_EXPIRING",
    channel: "IN_APP",
    lang: "AR",
    subject: null,
    body: "تنتهي صلاحية وثيقة KYB من نوع {{documentType}} في {{expiresOn}}. يرجى رفع بديل قبل تاريخ الانتهاء.",
  },
  {
    code: "KYB_DOC_EXPIRING",
    channel: "EMAIL",
    lang: "AR",
    subject: "قرب انتهاء وثيقة KYB: {{documentType}}",
    body: "تنتهي صلاحية وثيقة KYB من نوع {{documentType}} في {{expiresOn}}. يرجى رفع بديل قبل تاريخ الانتهاء.",
  },
  {
    code: "KYB_DOCUMENT_REPLACEMENT_REQUESTED",
    channel: "IN_APP",
    lang: "EN",
    subject: null,
    body: "A replacement is required for KYB document {{documentType}}. {{message}}",
  },
  {
    code: "KYB_DOCUMENT_REPLACEMENT_REQUESTED",
    channel: "EMAIL",
    lang: "EN",
    subject: "KYB replacement required: {{documentType}}",
    body: "A replacement is required for KYB document {{documentType}}. {{message}}",
  },
  {
    code: "KYB_DOCUMENT_REPLACEMENT_REQUESTED",
    channel: "IN_APP",
    lang: "AR",
    subject: null,
    body: "مطلوب بديل لوثيقة KYB من نوع {{documentType}}. {{message}}",
  },
  {
    code: "KYB_DOCUMENT_REPLACEMENT_REQUESTED",
    channel: "EMAIL",
    lang: "AR",
    subject: "مطلوب بديل لوثيقة KYB: {{documentType}}",
    body: "مطلوب بديل لوثيقة KYB من نوع {{documentType}}. {{message}}",
  },
  {
    code: "KYB_DOCUMENT_REPLACEMENT_RECEIVED",
    channel: "IN_APP",
    lang: "EN",
    subject: null,
    body: "Your replacement for KYB document {{documentType}} was received and is waiting for review.",
  },
  {
    code: "KYB_DOCUMENT_REPLACEMENT_RECEIVED",
    channel: "EMAIL",
    lang: "EN",
    subject: "KYB replacement received: {{documentType}}",
    body: "Your replacement for KYB document {{documentType}} was received and is waiting for review.",
  },
  {
    code: "KYB_DOCUMENT_REPLACEMENT_RECEIVED",
    channel: "IN_APP",
    lang: "AR",
    subject: null,
    body: "تم استلام بديل وثيقة KYB من نوع {{documentType}} وهو بانتظار المراجعة.",
  },
  {
    code: "KYB_DOCUMENT_REPLACEMENT_RECEIVED",
    channel: "EMAIL",
    lang: "AR",
    subject: "تم استلام بديل وثيقة KYB: {{documentType}}",
    body: "تم استلام بديل وثيقة KYB من نوع {{documentType}} وهو بانتظار المراجعة.",
  },
  {
    code: "KYB_REVALIDATION_DUE",
    channel: "IN_APP",
    lang: "EN",
    subject: null,
    body: "Periodic KYB re-verification is due for {{documentType}}. Please upload a current document.",
  },
  {
    code: "KYB_REVALIDATION_DUE",
    channel: "EMAIL",
    lang: "EN",
    subject: "Periodic KYB re-verification due",
    body: "Periodic KYB re-verification is due for {{documentType}}. Please upload a current document.",
  },
  {
    code: "KYB_REVALIDATION_DUE",
    channel: "IN_APP",
    lang: "AR",
    subject: null,
    body: "حان موعد إعادة التحقق الدوري من KYB لوثيقة {{documentType}}. يرجى رفع وثيقة حديثة.",
  },
  {
    code: "KYB_REVALIDATION_DUE",
    channel: "EMAIL",
    lang: "AR",
    subject: "موعد إعادة التحقق الدوري من KYB",
    body: "حان موعد إعادة التحقق الدوري من KYB لوثيقة {{documentType}}. يرجى رفع وثيقة حديثة.",
  },
  {
    code: "KYB_EXPIRED_SUSPENSION",
    channel: "IN_APP",
    lang: "EN",
    subject: null,
    body: "Your account is suspended because a required KYB document expired. Contact support to restore access.",
  },
  {
    code: "KYB_EXPIRED_SUSPENSION",
    channel: "EMAIL",
    lang: "EN",
    subject: "Account suspended: KYB document expired",
    body: "Your account is suspended because a required KYB document expired. Contact support to restore access.",
  },
  {
    code: "KYB_EXPIRED_SUSPENSION",
    channel: "IN_APP",
    lang: "AR",
    subject: null,
    body: "تم تعليق حسابك لانتهاء صلاحية وثيقة KYB مطلوبة. يرجى التواصل مع الدعم لاستعادة الوصول.",
  },
  {
    code: "KYB_EXPIRED_SUSPENSION",
    channel: "EMAIL",
    lang: "AR",
    subject: "تم تعليق الحساب: انتهت صلاحية وثيقة KYB",
    body: "تم تعليق حسابك لانتهاء صلاحية وثيقة KYB مطلوبة. يرجى التواصل مع الدعم لاستعادة الوصول.",
  },
];

export const ensureKybNotificationTemplates = async (db: PrismaClient): Promise<void> => {
  await db.notificationTemplate.createMany({
    data: TEMPLATES.map((template) => ({
      code: template.code,
      channel: template.channel,
      lang: template.lang,
      subjectTemplate: template.subject,
      bodyTemplate: template.body,
      confidentialityClass: "MERCHANT",
      version: 1,
      active: true,
    })),
    skipDuplicates: true,
  });
};

const maskAddress = (value: string | null | undefined): string => {
  if (!value) return "merchant-contact";
  if (value.includes("@")) {
    const [local, domain] = value.split("@");
    return `${(local ?? "").slice(0, 2)}***@${domain ?? ""}`;
  }
  return `*******${value.slice(-4)}`;
};

export const queueKybNotification = async (
  db: PrismaClient,
  input: {
    merchantId: string;
    code: KybNotificationCode;
    payload: Record<string, unknown>;
    eventKey: string;
    channels?: Array<"IN_APP" | "EMAIL">;
  },
): Promise<void> => {
  await ensureKybNotificationTemplates(db);
  const merchant = await db.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true, contactEmail: true, contactPhone: true },
  });
  if (!merchant) return;
  const recipient = await db.user.findFirst({
    where: { merchantId: merchant.id, role: "MERCHANT_ADMIN", status: "ACTIVE" },
    select: { id: true, email: true, phone: true },
  });
  const address = recipient?.email ?? recipient?.phone ?? merchant.contactEmail ?? merchant.contactPhone ?? null;
  for (const channel of input.channels ?? ["IN_APP", "EMAIL"]) {
    const eventId = `kyb:${input.eventKey}:${channel}`.slice(0, 191);
    try {
      await db.notification.create({
        data: {
          eventId,
          recipientUserId: recipient?.id ?? null,
          recipientMerchantId: merchant.id,
          templateCode: input.code,
          channel,
          lang: "EN",
          payloadJson: input.payload as never,
          addressMasked: maskAddress(address),
          addressCiphertext: "",
          status: "QUEUED",
          attempts: 0,
        },
      });
    } catch {
      // The unique event id makes the queue idempotent across retried ticks.
    }
  }
};
