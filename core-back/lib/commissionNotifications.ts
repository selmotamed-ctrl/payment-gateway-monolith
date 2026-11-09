type Any = Record<string, any>;

/**
 * Merchant notices of the commission netting (AUTO-21, decision D8). One code today:
 *
 *   COMMISSION_RECEIVABLE_SETTLEMENT_DUE  the merchant-direct commission receivable is above the merchant's ceiling and
 *                                         the wallet cannot cover it: new merchant-direct payments are paused until it
 *                                         is settled (they resume automatically once it is back under the ceiling).
 *
 * Queued on the notification outbox (OutboxNotificationWorker renders and sends). The event id is unique per merchant,
 * day and channel, so a repeated run never queues a second notice.
 */
export type CommissionNotificationCode = "COMMISSION_RECEIVABLE_SETTLEMENT_DUE";

const TEMPLATES: Array<{
  code: CommissionNotificationCode;
  channel: "IN_APP" | "EMAIL";
  lang: "EN" | "AR";
  subject: string | null;
  body: string;
}> = [
  {
    code: "COMMISSION_RECEIVABLE_SETTLEMENT_DUE",
    channel: "IN_APP",
    lang: "EN",
    subject: null,
    body:
      "Your outstanding platform commission of {{receivable}} {{currency}} is above your limit of {{ceiling}} {{currency}} and your wallet balance cannot cover it. Merchant-direct payments are paused until it is settled.",
  },
  {
    code: "COMMISSION_RECEIVABLE_SETTLEMENT_DUE",
    channel: "EMAIL",
    lang: "EN",
    subject: "Action needed: settle your outstanding platform commission",
    body:
      "Your outstanding platform commission of {{receivable}} {{currency}} is above your limit of {{ceiling}} {{currency}} and your wallet balance cannot cover it. Merchant-direct payments are paused until it is settled. They resume automatically once the amount is back under the limit.",
  },
  {
    code: "COMMISSION_RECEIVABLE_SETTLEMENT_DUE",
    channel: "IN_APP",
    lang: "AR",
    subject: null,
    body:
      "عمولة المنصة المستحقة عليك وقدرها {{receivable}} {{currency}} تجاوزت الحد المسموح {{ceiling}} {{currency}} ورصيد محفظتك لا يغطيها. تم إيقاف المدفوعات المباشرة إلى حين تسويتها.",
  },
  {
    code: "COMMISSION_RECEIVABLE_SETTLEMENT_DUE",
    channel: "EMAIL",
    lang: "AR",
    subject: "إجراء مطلوب: تسوية عمولة المنصة المستحقة",
    body:
      "عمولة المنصة المستحقة عليك وقدرها {{receivable}} {{currency}} تجاوزت الحد المسموح {{ceiling}} {{currency}} ورصيد محفظتك لا يغطيها. تم إيقاف المدفوعات المباشرة إلى حين تسويتها، وتستأنف تلقائيا عند عودة المبلغ دون الحد.",
  },
];

export const ensureCommissionNotificationTemplates = async (db: Any): Promise<void> => {
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

export const queueCommissionNotification = async (
  db: Any,
  input: { merchantId: string; code: CommissionNotificationCode; payload: Record<string, unknown>; eventKey: string },
): Promise<void> => {
  await ensureCommissionNotificationTemplates(db);
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
  for (const channel of ["IN_APP", "EMAIL"] as const) {
    const eventId = `commission:${input.eventKey}:${channel}`.slice(0, 191);
    try {
      await db.notification.create({
        data: {
          eventId,
          recipientUserId: recipient?.id ?? null,
          recipientMerchantId: merchant.id,
          templateCode: input.code,
          channel,
          lang: "EN",
          payloadJson: input.payload,
          addressMasked: maskAddress(address),
          addressCiphertext: "",
          status: "QUEUED",
          attempts: 0,
        },
      });
    } catch {
      // The unique event id makes the queue idempotent across retried runs.
    }
  }
};
