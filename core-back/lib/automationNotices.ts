type Any = Record<string, any>;

/**
 * Notices sent by the background automations (AUTO-xx): join request expiry, expiring tokens and credentials, approval
 * expiry, dispute reminders and the like.
 *
 * Every notice is queued on the notification outbox (`OutboxNotificationWorker` renders and sends it) with a stable
 * event id, so a repeated tick, a restart or a second node never sends it twice. The helper only issues statements that
 * cannot fail on a duplicate (`INSERT ... ON CONFLICT DO NOTHING` through `createMany({ skipDuplicates })`), so it is
 * safe INSIDE a database transaction (a failed statement would abort the whole transaction in PostgreSQL).
 *
 * Tipping-off: templates are `MERCHANT` or `INTERNAL` class and carry no compliance detail; anything touching AML is
 * never sent through here.
 */

export type NoticeChannel = "IN_APP" | "EMAIL";
export type NoticeLang = "EN" | "AR";
export type NoticeAudience = "MERCHANT" | "INTERNAL";

export interface NoticeTemplate {
  channel: NoticeChannel;
  lang: NoticeLang;
  subject: string | null;
  body: string;
}

export interface NoticeDefinition {
  code: string;
  audience: NoticeAudience;
  templates: readonly NoticeTemplate[];
}

/** Both channels and both languages from one short text pair (the common case). */
export const bilingualNotice = (input: {
  code: string;
  audience?: NoticeAudience;
  en: { subject: string; body: string };
  ar: { subject: string; body: string };
}): NoticeDefinition => ({
  code: input.code,
  audience: input.audience ?? "MERCHANT",
  templates: [
    { channel: "IN_APP", lang: "EN", subject: null, body: input.en.body },
    { channel: "EMAIL", lang: "EN", subject: input.en.subject, body: input.en.body },
    { channel: "IN_APP", lang: "AR", subject: null, body: input.ar.body },
    { channel: "EMAIL", lang: "AR", subject: input.ar.subject, body: input.ar.body },
  ],
});

export const ensureNoticeTemplates = async (db: Any, definitions: readonly NoticeDefinition[]): Promise<void> => {
  await db.notificationTemplate.createMany({
    data: definitions.flatMap((definition) =>
      definition.templates.map((template) => ({
        code: definition.code,
        channel: template.channel,
        lang: template.lang,
        subjectTemplate: template.subject,
        bodyTemplate: template.body,
        confidentialityClass: definition.audience,
        version: 1,
        active: true,
      })),
    ),
    skipDuplicates: true,
  });
};

export const maskNoticeAddress = (value: string | null | undefined): string => {
  if (!value) return "merchant-contact";
  if (value.includes("@")) {
    const [local, domain] = value.split("@");
    return `${(local ?? "").slice(0, 2)}***@${domain ?? ""}`;
  }
  return `*******${value.slice(-4)}`;
};

export interface QueueNoticeInput {
  definition: NoticeDefinition;
  /** Unique per (subject, stage): the notification's event id is `notice:<eventKey>:<channel>`. */
  eventKey: string;
  payload: Record<string, unknown>;
  /** The recipient user; otherwise the merchant's active MERCHANT_ADMIN, otherwise the merchant contact. */
  userId?: string | null;
  merchantId?: string | null;
  channels?: readonly NoticeChannel[];
  lang?: NoticeLang;
}

/** Queues the notice; returns how many NEW notifications were created (0 on a repeat). */
export const queueNotice = async (db: Any, input: QueueNoticeInput): Promise<number> => {
  await ensureNoticeTemplates(db, [input.definition]);
  let user: { id: string; email: string | null; phone: string | null; merchantId?: string | null } | null = null;
  if (input.userId) {
    user = await db.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true, phone: true, merchantId: true } });
  }
  const merchantId = input.merchantId ?? user?.merchantId ?? null;
  const merchant = merchantId
    ? await db.merchant.findUnique({ where: { id: merchantId }, select: { id: true, contactEmail: true, contactPhone: true } })
    : null;
  if (!user && merchant) {
    user = await db.user.findFirst({
      where: { merchantId: merchant.id, role: "MERCHANT_ADMIN", status: "ACTIVE" },
      select: { id: true, email: true, phone: true },
    });
  }
  if (!user && !merchant) return 0;
  const address = user?.email ?? user?.phone ?? merchant?.contactEmail ?? merchant?.contactPhone ?? null;
  const channels = input.channels ?? (["IN_APP", "EMAIL"] as const);
  const created = await db.notification.createMany({
    data: channels.map((channel) => ({
      eventId: `notice:${input.eventKey}:${channel}`.slice(0, 191),
      recipientUserId: user?.id ?? null,
      recipientMerchantId: merchant?.id ?? null,
      templateCode: input.definition.code,
      channel,
      lang: input.lang ?? "EN",
      payloadJson: input.payload as never,
      addressMasked: maskNoticeAddress(address),
      addressCiphertext: "",
      status: "QUEUED",
      attempts: 0,
    })),
    skipDuplicates: true,
  });
  return Number(created?.count ?? 0);
};
