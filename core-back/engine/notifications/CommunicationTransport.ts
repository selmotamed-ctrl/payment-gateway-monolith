import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import type { NotificationRow } from "../db/ports";
import { Vault } from "../crypto/Vault";
import {
  assertDeliverableTemplate,
  formatNotificationLogLine,
  type NotificationDeliveryResult,
  type NotificationTransport,
  type NotificationTransportLogger,
  type RenderedNotification,
} from "./NotificationTransport";
import {
  getCommunicationConfiguration,
  hasRealEmail,
  maskEmailAddress,
  maskPhoneNumber,
  recordCommunicationDelivery,
  type CommunicationConfiguration,
  type CommunicationSettingsDatabase,
  type EmailConfiguration,
  type SmsConfiguration,
} from "../../lib/communication/settings";

/**
 * The runtime notification transport (schema v46).
 *
 * It reads the current Platform Settings on every delivery (the settings service caches for five seconds), so an
 * administrator can switch providers without restarting core. E-mail goes through SMTP; SMS goes through the signed
 * webhook aggregator. IN_APP rows are delivered by their own existence.
 *
 * The recipient is resolved from the sealed address, then from the user row and finally from the merchant contact.
 * A masked address is NEVER used as a delivery target.
 */

export interface RuntimeTransportDatabase extends CommunicationSettingsDatabase {
  user?: { findUnique(args: Record<string, unknown>): Promise<Record<string, unknown> | null> };
  merchant?: { findUnique(args: Record<string, unknown>): Promise<Record<string, unknown> | null> };
}

export interface RuntimeTransportOptions {
  db: RuntimeTransportDatabase;
  logger?: NotificationTransportLogger;
  /** Test seam for nodemailer. */
  sendMail?: (message: Record<string, unknown>, config: EmailConfiguration) => Promise<{ messageId?: string }>;
  /** Test seam for the SMS webhook. */
  fetchImpl?: typeof fetch;
}

const vault = new Vault();

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const bodyToHtml = (body: string): string =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#111">${escapeHtml(body).replaceAll("\n", "<br />")}</div>`;

export const formatFromAddress = (config: EmailConfiguration): string => {
  const name = config.fromName.replace(/[\r\n"]/g, "").trim();
  return name ? `"${name}" <${config.fromEmail}>` : config.fromEmail;
};

const openSealedAddress = async (ciphertext: string | null | undefined): Promise<string | null> => {
  const value = ciphertext?.trim();
  if (!value) return null;
  try {
    return (await vault.decryptSecret(value)).trim() || null;
  } catch {
    return null;
  }
};

export const resolveNotificationAddress = async (
  db: RuntimeTransportDatabase,
  notification: NotificationRow,
): Promise<string | null> => {
  const sealed = await openSealedAddress(notification.addressCiphertext);
  if (sealed) return sealed;

  if (notification.recipientUserId && db.user) {
    try {
      const user = await db.user.findUnique({
        where: { id: notification.recipientUserId },
        select: { email: true, phone: true },
      });
      const email = typeof user?.email === "string" ? user.email : null;
      const phone = typeof user?.phone === "string" ? user.phone : null;
      if (notification.channel === "EMAIL" && hasRealEmail(email)) return email;
      if (notification.channel === "SMS" && phone) return phone;
    } catch {
      // fall through to the merchant contact
    }
  }

  if (notification.recipientMerchantId && db.merchant) {
    try {
      const merchant = await db.merchant.findUnique({
        where: { id: notification.recipientMerchantId },
        select: { contactEmail: true, contactPhone: true },
      });
      const email = typeof merchant?.contactEmail === "string" ? merchant.contactEmail : null;
      const phone = typeof merchant?.contactPhone === "string" ? merchant.contactPhone : null;
      if (notification.channel === "EMAIL" && hasRealEmail(email)) return email;
      if (notification.channel === "SMS" && phone) return phone;
    } catch {
      // no usable address
    }
  }
  return null;
};

export const buildSmtpTransportOptions = (config: EmailConfiguration): Record<string, unknown> => ({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.smtpSecurity === "TLS",
  requireTLS: config.smtpSecurity === "STARTTLS",
  ignoreTLS: config.smtpSecurity === "NONE",
  ...(config.smtpUsername
    ? { auth: { user: config.smtpUsername, pass: config.smtpPassword } }
    : {}),
  tls: { rejectUnauthorized: !config.allowInsecure },
  connectionTimeout: config.timeoutMs,
  greetingTimeout: config.timeoutMs,
  socketTimeout: config.timeoutMs,
});

const defaultSendMail = async (
  message: Record<string, unknown>,
  config: EmailConfiguration,
): Promise<{ messageId?: string }> => {
  const transporter = nodemailer.createTransport(buildSmtpTransportOptions(config) as never);
  const result = await transporter.sendMail(message);
  return { messageId: typeof result.messageId === "string" ? result.messageId : undefined };
};

export class SmtpEmailTransport {
  constructor(
    private readonly config: EmailConfiguration,
    private readonly logger: NotificationTransportLogger,
    private readonly sendMail: NonNullable<RuntimeTransportOptions["sendMail"]> = defaultSendMail,
  ) {}

  async deliver(
    notification: NotificationRow,
    rendered: RenderedNotification,
    recipient?: string | null,
  ): Promise<NotificationDeliveryResult> {
    if (!this.config.configured) {
      return { status: "FAILED", permanent: true, error: "CHANNEL_NOT_CONFIGURED: e-mail" };
    }
    const refusal = assertDeliverableTemplate(rendered);
    if (refusal) return { status: "FAILED", permanent: true, error: refusal };
    const to = recipient;
    if (!to || !hasRealEmail(to)) {
      return { status: "FAILED", permanent: true, error: "RECIPIENT_ADDRESS_MISSING" };
    }
    try {
      const result = await this.sendMail(
        {
          from: formatFromAddress(this.config),
          to,
          ...(this.config.replyTo ? { replyTo: this.config.replyTo } : {}),
          subject: rendered.subject ?? rendered.templateCode.replaceAll("_", " ").toLowerCase(),
          text: rendered.body,
          html: bodyToHtml(rendered.body),
          headers: { "x-notification-id": notification.id, "x-notification-template": rendered.templateCode },
        },
        this.config,
      );
      this.logger.info(
        `[notification] EMAIL ${notification.templateCode} -> ${maskEmailAddress(to)} :: accepted by SMTP`,
      );
      return { status: "SENT", providerMessageId: result.messageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "SMTP delivery failed";
      this.logger.error(`[notification] EMAIL ${notification.templateCode} failed: ${message}`);
      return { status: "FAILED", error: message };
    }
  }
}

export class SmsWebhookTransport {
  constructor(
    private readonly config: SmsConfiguration,
    private readonly logger: NotificationTransportLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async deliver(notification: NotificationRow, rendered: RenderedNotification, recipient?: string | null): Promise<NotificationDeliveryResult> {
    if (!this.config.configured) {
      return { status: "FAILED", permanent: true, error: "CHANNEL_NOT_CONFIGURED: SMS" };
    }
    const refusal = assertDeliverableTemplate(rendered);
    if (refusal) return { status: "FAILED", permanent: true, error: refusal };
    const to = recipient;
    if (!to) return { status: "FAILED", permanent: true, error: "RECIPIENT_ADDRESS_MISSING" };
    const body = JSON.stringify({
      notificationId: notification.id,
      eventId: notification.eventId,
      channel: "SMS",
      to,
      senderId: this.config.senderId,
      templateCode: rendered.templateCode,
      body: rendered.body,
      lang: notification.lang,
    });
    const signature = `sha256=${createHmac("sha256", this.config.webhookSecret).update(body, "utf8").digest("hex")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(this.config.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-notification-signature": signature,
          "x-notification-delivery-id": notification.id,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        return { status: "FAILED", error: `The SMS provider responded with HTTP ${response.status}` };
      }
      this.logger.info(`[notification] SMS ${notification.templateCode} -> ${maskPhoneNumber(to)} :: accepted by provider`);
      return { status: "SENT", providerMessageId: notification.id };
    } catch (error) {
      const message = controller.signal.aborted
        ? `The SMS provider timed out after ${this.config.timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : "The SMS provider request failed";
      this.logger.error(`[notification] SMS ${notification.templateCode} failed: ${message}`);
      return { status: "FAILED", error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class RuntimeCommunicationTransport implements NotificationTransport {
  constructor(private readonly options: RuntimeTransportOptions) {}

  async deliver(notification: NotificationRow, rendered: RenderedNotification): Promise<NotificationDeliveryResult> {
    const logger = this.options.logger ?? {
      info: (message: string) => console.log(message),
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    };
    if (notification.channel === "IN_APP") {
      const refusal = assertDeliverableTemplate(rendered);
      if (refusal) return { status: "FAILED", permanent: true, error: refusal };
      logger.info(formatNotificationLogLine(notification, rendered));
      return { status: "DELIVERED", providerMessageId: `in-app-${notification.id}` };
    }

    let config: CommunicationConfiguration;
    try {
      config = await getCommunicationConfiguration(this.options.db);
    } catch {
      return { status: "FAILED", error: "COMMUNICATION_SETTINGS_UNAVAILABLE" };
    }

    const recipient = await resolveNotificationAddress(this.options.db, notification);
    let result: NotificationDeliveryResult;
    if (notification.channel === "EMAIL") {
      result = await new SmtpEmailTransport(config.email, logger, this.options.sendMail).deliver(
        notification,
        rendered,
        recipient,
      );
    } else {
      result = await new SmsWebhookTransport(config.sms, logger, this.options.fetchImpl).deliver(
        notification,
        rendered,
        recipient,
      );
    }
    await recordCommunicationDelivery(this.options.db, notification.channel, {
      status: result.status,
      error: result.error ?? null,
    });
    return result;
  }
}

export const createRuntimeCommunicationTransport = (options: RuntimeTransportOptions): NotificationTransport =>
  new RuntimeCommunicationTransport(options);
