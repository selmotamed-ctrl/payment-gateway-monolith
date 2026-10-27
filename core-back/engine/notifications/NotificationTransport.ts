import { createHmac } from "node:crypto";
import { assertNoTippingOff, isConfidentialTemplateClass } from "../compliance/tippingOff";
import type { NotificationRow } from "../db/ports";

/**
 * The notification transport of `core-back`.
 *
 * Design v5 §7.6 declares `notifications` as a transactional outbox with the
 * delivery states `QUEUED | SENT | DELIVERED | FAILED | SUPPRESSED`, and §17
 * requires the platform to actually notify the merchant. Until now the outbox
 * worker only wrote the rendered message to the console and reported
 * `DELIVERED`, which is a lie: no provider ever confirmed the delivery.
 *
 * This module replaces that placeholder with a pluggable transport:
 *
 *  - `WebhookNotificationTransport` is the production path: it POSTs the
 *    rendered message to the SMS / email aggregator of the deployment and
 *    signs the request with an HMAC-SHA256 signature so the provider can
 *    authenticate the platform;
 *  - `LogNotificationTransport` keeps the platform usable in development. It
 *    reports `SENT` and never `DELIVERED`, because no provider confirmed
 *    anything;
 *  - `CompositeNotificationTransport` routes by channel. An `IN_APP`
 *    notification is delivered by the notification row itself (the merchant
 *    portal reads it), so it is `DELIVERED`; `SMS` and `EMAIL` go to the
 *    configured provider.
 *
 * Two rules are enforced by every transport:
 *
 *  1. the no-tipping-off rule is re-asserted on the template before the
 *     message leaves the platform (the worker validates it first as well, the
 *     transport never bypasses that ordering);
 *  2. the rendered body of an `INTERNAL` template is never written to the
 *     application log, because it carries AML details.
 */

/**
 * The confidentiality class of the template a notification was rendered from.
 * It mirrors `notification_templates.confidentiality_class` (design v5 §7.6).
 */
export type NotificationConfidentialityClass = "PUBLIC" | "MERCHANT" | "INTERNAL";

/**
 * A rendered notification.
 *
 * The template travels with the rendered text on purpose: a transport must be
 * able to re-assert the no-tipping-off rule on the template, and it must know
 * whether the rendered body may be written to the application log.
 */
export interface RenderedNotification {
  subject: string | null;
  body: string;
  templateCode: string;
  confidentialityClass: NotificationConfidentialityClass;
  subjectTemplate: string | null;
  bodyTemplate: string;
}

export type NotificationDeliveryStatus = "DELIVERED" | "SENT" | "FAILED";

export interface NotificationDeliveryResult {
  status: NotificationDeliveryStatus;
  providerMessageId?: string;
  error?: string;
}

/**
 * The port every notification transport implements.
 */
export interface NotificationTransport {
  deliver(
    notification: NotificationRow,
    rendered: RenderedNotification,
  ): Promise<NotificationDeliveryResult>;
}

export interface NotificationTransportLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleNotificationLogger: NotificationTransportLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/**
 * Resolves the address the provider has to deliver the message to.
 *
 * The platform stores the address of a recipient encrypted (`address_ciphertext`)
 * and keeps a mask for the logs (`address_masked`). A deployment wires a
 * resolver that decrypts the address; the default resolver falls back to the
 * mask, which is enough for a development setup without a provider.
 */
export type NotificationRecipientResolver = (
  notification: NotificationRow,
) => Promise<string | null> | string | null;

export const defaultNotificationRecipientResolver: NotificationRecipientResolver = (notification) =>
  notification.addressMasked;

export const DEFAULT_NOTIFICATION_WEBHOOK_TIMEOUT_MS = 5000;

export const NOTIFICATION_SIGNATURE_HEADER = "x-notification-signature";

export const NOTIFICATION_DELIVERY_HEADER = "x-notification-delivery-id";

/**
 * Signs a request body with HMAC-SHA256 so the provider can authenticate the
 * platform. The signature travels as `sha256=<hex>`.
 */
export const signNotificationPayload = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

/**
 * Derives the webhook signing key from the platform master key.
 *
 * The master key never leaves the process and is never handed to a provider,
 * so the transport derives a purpose bound key from it instead of reusing it.
 */
export const deriveNotificationWebhookSecret = (masterKey: string): string =>
  createHmac("sha256", masterKey).update("core-back/notification-webhook/v1", "utf8").digest("hex");

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * Builds the structured log line of a notification.
 *
 * A template of class `INTERNAL` (AML details, one time codes, approval
 * requests) is never logged verbatim: only the template code, the channel and
 * the masked recipient are written.
 */
export const formatNotificationLogLine = (
  notification: NotificationRow,
  rendered: RenderedNotification,
): string => {
  const head = `[notification] ${notification.channel} ${notification.templateCode} -> ${notification.addressMasked ?? "unknown"}`;
  if (isConfidentialTemplateClass(rendered.confidentialityClass)) {
    return head;
  }
  return `${head} :: ${collapseWhitespace(rendered.body)}`;
};

/**
 * Re-asserts the no-tipping-off rule on the template of a message.
 *
 * The outbox worker validates the template before it renders and before it
 * calls the sender; the transport repeats the check so no transport can be
 * used to send a message that references AML variables outside the internal
 * confidentiality class. It returns the reason of the refusal, or `null`.
 */
export const assertDeliverableTemplate = (
  rendered: RenderedNotification,
): string | null => {
  try {
    assertNoTippingOff({
      code: rendered.templateCode,
      subjectTemplate: rendered.subjectTemplate,
      bodyTemplate: rendered.bodyTemplate,
      confidentialityClass: rendered.confidentialityClass,
    });
  } catch (error) {
    return error instanceof Error ? error.message : "The template may not be delivered";
  }
  return null;
};

export interface LogNotificationTransportOptions {
  logger?: NotificationTransportLogger;
}

/**
 * The development transport: it writes the rendered message to the
 * application log and reports `SENT`.
 *
 * It never reports `DELIVERED`: no provider confirmed the delivery, so the
 * honest state of the outbox row is "the platform handed the message over".
 */
export class LogNotificationTransport implements NotificationTransport {
  private readonly logger: NotificationTransportLogger;

  constructor(options: LogNotificationTransportOptions = {}) {
    this.logger = options.logger ?? consoleNotificationLogger;
  }

  async deliver(
    notification: NotificationRow,
    rendered: RenderedNotification,
  ): Promise<NotificationDeliveryResult> {
    const refusal = assertDeliverableTemplate(rendered);
    if (refusal) {
      this.logger.error(`[notification] ${refusal}`);
      return { status: "FAILED", error: refusal };
    }
    this.logger.info(formatNotificationLogLine(notification, rendered));
    return { status: "SENT", providerMessageId: `local-${notification.id}` };
  }
}

export interface NotificationProviderResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export interface NotificationRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type NotificationFetch = (
  url: string,
  init: NotificationRequestInit,
) => Promise<NotificationProviderResponse>;

export const defaultNotificationFetch: NotificationFetch = (url, init) => fetch(url, init);

export interface WebhookNotificationTransportOptions {
  url: string;
  secret: string;
  timeoutMs?: number;
  logger?: NotificationTransportLogger;
  fetchImpl?: NotificationFetch;
  resolveRecipient?: NotificationRecipientResolver;
}

/**
 * The production transport: the rendered message is POSTed to the SMS / email
 * aggregator of the deployment.
 *
 * The request is signed with HMAC-SHA256 over the exact bytes that are
 * transmitted and it is aborted after a strict timeout, so a slow provider
 * can never block the outbox worker.
 */
export class WebhookNotificationTransport implements NotificationTransport {
  private readonly url: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly logger: NotificationTransportLogger;
  private readonly fetchImpl: NotificationFetch;
  private readonly resolveRecipient: NotificationRecipientResolver;

  constructor(options: WebhookNotificationTransportOptions) {
    this.url = options.url;
    this.secret = options.secret;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_NOTIFICATION_WEBHOOK_TIMEOUT_MS;
    this.logger = options.logger ?? consoleNotificationLogger;
    this.fetchImpl = options.fetchImpl ?? defaultNotificationFetch;
    this.resolveRecipient = options.resolveRecipient ?? defaultNotificationRecipientResolver;
  }

  async deliver(
    notification: NotificationRow,
    rendered: RenderedNotification,
  ): Promise<NotificationDeliveryResult> {
    const refusal = assertDeliverableTemplate(rendered);
    if (refusal) {
      this.logger.error(`[notification] ${refusal}`);
      return { status: "FAILED", error: refusal };
    }

    let recipient: string | null;
    try {
      recipient = await this.resolveRecipient(notification);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The recipient address could not be resolved";
      this.logger.error(`[notification] ${message}`);
      return { status: "FAILED", error: message };
    }

    const body = JSON.stringify({
      notificationId: notification.id,
      eventId: notification.eventId,
      channel: notification.channel,
      lang: notification.lang,
      templateCode: notification.templateCode,
      confidentialityClass: rendered.confidentialityClass,
      recipient,
      subject: rendered.subject,
      body: rendered.body,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [NOTIFICATION_SIGNATURE_HEADER]: signNotificationPayload(this.secret, body),
          [NOTIFICATION_DELIVERY_HEADER]: notification.id,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const message = `The notification provider responded with HTTP ${response.status}`;
        this.logger.error(`[notification] ${message}`);
        return { status: "FAILED", error: message };
      }
      const providerMessageId = await readProviderMessageId(response);
      this.logger.info(
        `[notification] ${notification.channel} ${notification.templateCode} -> ${notification.addressMasked ?? "unknown"} :: accepted by the provider`,
      );
      return { status: "SENT", providerMessageId };
    } catch (error) {
      const message = controller.signal.aborted
        ? `The notification provider timed out after ${this.timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : "The notification provider request failed";
      this.logger.error(`[notification] ${message}`);
      return { status: "FAILED", error: message };
    } finally {
      clearTimeout(timeout);
    }
  }
}

const readProviderMessageId = async (
  response: NotificationProviderResponse,
): Promise<string | undefined> => {
  try {
    const text = await response.text();
    if (!text || text.length > 8192) {
      return undefined;
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const key of ["messageId", "message_id", "providerMessageId", "id"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export interface CompositeNotificationTransportOptions {
  provider: NotificationTransport;
  logger?: NotificationTransportLogger;
}

/**
 * Routes a notification to the transport of its channel.
 *
 * An `IN_APP` notification is delivered by the notification row itself: the
 * merchant portal reads the row, so there is nothing to send and the state of
 * the row is `DELIVERED`. `SMS` and `EMAIL` go to the configured provider.
 */
export class CompositeNotificationTransport implements NotificationTransport {
  /**
   * The transport of the `SMS` and `EMAIL` channels. It is public so the
   * composition root can be asserted in a test.
   */
  readonly provider: NotificationTransport;
  private readonly logger: NotificationTransportLogger;

  constructor(options: CompositeNotificationTransportOptions) {
    this.provider = options.provider;
    this.logger = options.logger ?? consoleNotificationLogger;
  }

  async deliver(
    notification: NotificationRow,
    rendered: RenderedNotification,
  ): Promise<NotificationDeliveryResult> {
    if (notification.channel !== "IN_APP") {
      return this.provider.deliver(notification, rendered);
    }

    const refusal = assertDeliverableTemplate(rendered);
    if (refusal) {
      this.logger.error(`[notification] ${refusal}`);
      return { status: "FAILED", error: refusal };
    }
    this.logger.info(formatNotificationLogLine(notification, rendered));
    return { status: "DELIVERED", providerMessageId: `in-app-${notification.id}` };
  }
}

export interface NotificationTransportFactoryOptions {
  /**
   * The endpoint of the SMS / email aggregator. Without it the platform falls
   * back to the log transport.
   */
  webhookUrl?: string | null;
  timeoutMs?: number;
  /**
   * The shared secret the provider verifies the signature with. It defaults to
   * a key derived from the platform master key.
   */
  secret?: string;
  masterKey?: string;
  logger?: NotificationTransportLogger;
  fetchImpl?: NotificationFetch;
  resolveRecipient?: NotificationRecipientResolver;
}

/**
 * Builds the transport of the platform from its configuration.
 *
 * With a configured webhook endpoint the platform talks to the real provider,
 * without one it keeps working in development through the log transport.
 */
export const createNotificationTransport = (
  options: NotificationTransportFactoryOptions = {},
): NotificationTransport => {
  const logger = options.logger ?? consoleNotificationLogger;
  const url = options.webhookUrl?.trim();
  if (!url) {
    return new CompositeNotificationTransport({
      provider: new LogNotificationTransport({ logger }),
      logger,
    });
  }

  const secret = options.secret
    ?? (options.masterKey ? deriveNotificationWebhookSecret(options.masterKey) : undefined);
  if (!secret) {
    throw new Error(
      "A notification webhook requires a signing secret: the platform master key (KMS_MASTER_KEY) has to be configured",
    );
  }

  return new CompositeNotificationTransport({
    provider: new WebhookNotificationTransport({
      url,
      secret,
      timeoutMs: options.timeoutMs,
      logger,
      fetchImpl: options.fetchImpl,
      resolveRecipient: options.resolveRecipient,
    }),
    logger,
  });
};
