import { assertNoTippingOff, redactAmlPayload, renderTemplate } from "../compliance/tippingOff";
import { openMfaCode } from "../../lib/auth/mfaChallenges";
import { toCamelRows } from "../db/rawRows";
import type { NotificationRow, Tx } from "../db/ports";
import type { RenderedNotification } from "../notifications/NotificationTransport";
import { BaseWorker, backoffDelayMs, type WorkerOptions } from "./workerRuntime";
import { getCommunicationConfiguration, maskPhoneNumber } from "../../lib/communication/settings";
import { shouldSendSms } from "../../lib/communication/policy";
import { Vault } from "../crypto/Vault";

const fanoutVault = new Vault();

export interface NotificationSendResult {
  providerMessageId: string | null;
  status: "SENT" | "DELIVERED" | "FAILED";
  error?: string;
  /** Configuration made the failure permanent; retrying cannot help. */
  permanent?: boolean;
}

export interface NotificationSender {
  send(notification: NotificationRow, rendered: RenderedNotification): Promise<NotificationSendResult>;
}

export interface OutboxNotificationWorkerDeps extends WorkerOptions {
  sender?: NotificationSender;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAttempts?: number;
}

const redactDeliveryError = (reason: string): string =>
  reason
    .replace(/\b\d{6}\b/g, "******")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (value) => {
      const [local = "", domain = ""] = value.split("@");
      return `${local.slice(0, 2)}***@${domain}`;
    })
    .replace(/\+\d{6,}/g, "*******")
    .slice(0, 500);

export class OutboxNotificationWorker extends BaseWorker {
  private readonly sender: NotificationSender | undefined;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;

  constructor(deps: OutboxNotificationWorkerDeps) {
    super(deps);
    this.sender = deps.sender;
    this.baseBackoffMs = deps.baseBackoffMs ?? 60_000;
    this.maxBackoffMs = deps.maxBackoffMs ?? 60 * 60_000;
    this.maxAttempts = deps.maxAttempts ?? 8;
  }

  protected async tick(): Promise<void> {
    const now = this.clock();
    const notifications = await this.lockQueuedNotifications(now);
    for (const notification of notifications) {
      await this.deliver(notification, now);
    }
  }

  private async lockQueuedNotifications(now: Date): Promise<NotificationRow[]> {
    // One statement in one transaction: lock with SKIP LOCKED and lease the
    // rows by pushing next_attempt_at forward. Delivery then runs outside the
    // transaction and every outcome rewrites next_attempt_at / status.
    const sql =
      "WITH claimed AS (" +
      "SELECT id FROM notifications" +
      " WHERE status = 'QUEUED'" +
      " AND (next_attempt_at IS NULL OR next_attempt_at <= $1)" +
      " ORDER BY next_attempt_at ASC" +
      " LIMIT $2" +
      " FOR UPDATE SKIP LOCKED)" +
      " UPDATE notifications n SET next_attempt_at = $3, updated_at = now()" +
      " FROM claimed WHERE n.id = claimed.id RETURNING n.*";
    const leaseUntil = new Date(now.getTime() + this.claimLeaseSeconds * 1000);
    const result = await this.inTransaction((tx) => tx.$queryRawUnsafe(sql, now, this.batchSize, leaseUntil));
    return toCamelRows<NotificationRow>(result);
  }

  private async deliver(notification: NotificationRow, now: Date): Promise<void> {
    if (notification.channel === "EMAIL") {
      await this.fanOutSms(notification);
    }
    const template = await this.repositories.notifications.findTemplate(
      this.db as Tx,
      notification.templateCode,
      notification.channel,
      notification.lang,
    );
    if (!template) {
      await this.fail(notification, now, `Template not found: ${notification.templateCode}`, notification.attempts);
      return;
    }

    try {
      assertNoTippingOff({
        code: template.code,
        subjectTemplate: template.subjectTemplate,
        bodyTemplate: template.bodyTemplate,
        confidentialityClass: template.confidentialityClass,
      });
    } catch (error) {
      await this.fail(notification, now, (error as Error).message, notification.attempts);
      return;
    }

    const payloadRaw = { ...((notification.payloadJson ?? {}) as Record<string, unknown>) };
    // MFA codes are stored encrypted (never in plaintext in payload_json); open them for delivery only.
    if (typeof payloadRaw.codeCiphertext === "string") {
      try {
        payloadRaw.code = await openMfaCode(payloadRaw.codeCiphertext);
      } catch {
        await this.fail(notification, now, "MFA code could not be decrypted", notification.attempts);
        return;
      }
      delete payloadRaw.codeCiphertext;
    }
    // A staff invitation token is stored sealed as well; it is opened for delivery only.
    if (typeof payloadRaw.tokenCiphertext === "string") {
      try {
        payloadRaw.token = await openMfaCode(payloadRaw.tokenCiphertext);
      } catch {
        await this.fail(notification, now, "Invitation token could not be decrypted", notification.attempts);
        return;
      }
      delete payloadRaw.tokenCiphertext;
    }
    const payload = redactAmlPayload(payloadRaw, template.confidentialityClass);
    const subject = template.subjectTemplate ? renderTemplate(template.subjectTemplate, payload) : null;
    const body = renderTemplate(template.bodyTemplate, payload);

    if (!this.sender) {
      await this.fail(notification, now, "No notification sender registered", notification.attempts);
      return;
    }

    try {
      const result = await this.sender.send(notification, {
        subject,
        body,
        templateCode: template.code,
        confidentialityClass: template.confidentialityClass,
        subjectTemplate: template.subjectTemplate,
        bodyTemplate: template.bodyTemplate,
      });
      if (result.status === "FAILED") {
        if (result.permanent) {
          await this.repositories.notifications.updateNotification(this.db as Tx, notification.id, {
            status: "SUPPRESSED",
            attempts: notification.attempts + 1,
            nextAttemptAt: null,
            lastError: result.error ?? "Delivery suppressed",
          });
          this.logger.warn("OutboxNotificationWorker: notification suppressed", {
            notificationId: notification.id,
            reason: result.error,
          });
          return;
        }
        await this.fail(notification, now, result.error ?? "Sender reported failure", notification.attempts);
        return;
      }
      const delivered = result.status === "DELIVERED";
      await this.repositories.notifications.updateNotification(this.db as Tx, notification.id, {
        status: delivered ? "DELIVERED" : "SENT",
        providerMessageId: result.providerMessageId,
        attempts: notification.attempts + 1,
        nextAttemptAt: null,
        lastError: null,
        sentAt: delivered ? undefined : now,
        deliveredAt: delivered ? now : undefined,
      });
    } catch (error) {
      await this.fail(notification, now, (error as Error).message, notification.attempts);
    }
  }

  /**
   * Adds an SMS copy of an EMAIL notification when the channel policy marks the template as critical and the
   * recipient has a phone. The SMS template must exist; a missing template is not an error (the email still goes).
   * The event id mirrors the email's (`...:EMAIL` -> `...:SMS`), so `skipDuplicates` makes the fan-out idempotent
   * and an OTP challenge that already queued both channels is not duplicated.
   */
  private async fanOutSms(notification: NotificationRow): Promise<void> {
    if (notification.status !== "QUEUED") return;
    try {
      const config = await getCommunicationConfiguration(this.db as never);
      if (!shouldSendSms(config.policy, notification.templateCode, config.sms.configured)) return;
      const smsTemplate = await this.repositories.notifications.findTemplate(
        this.db as Tx,
        notification.templateCode,
        "SMS",
        notification.lang,
      );
      if (!smsTemplate) return;
      let phone: string | null = null;
      if (notification.recipientUserId && this.db.user?.findUnique) {
        const user = await this.db.user.findUnique({
          where: { id: notification.recipientUserId },
          select: { phone: true },
        });
        phone = typeof user?.phone === "string" && user.phone.trim() ? user.phone.trim() : null;
      }
      if (!phone && notification.recipientMerchantId && this.db.merchant?.findUnique) {
        const merchant = await this.db.merchant.findUnique({
          where: { id: notification.recipientMerchantId },
          select: { contactPhone: true },
        });
        phone = typeof merchant?.contactPhone === "string" && merchant.contactPhone.trim()
          ? merchant.contactPhone.trim()
          : null;
      }
      if (!phone) return;
      const eventId = notification.eventId.endsWith(":EMAIL")
        ? `${notification.eventId.slice(0, -":EMAIL".length)}:SMS`
        : `${notification.eventId}:SMS`;
      await this.db.notification.createMany({
        data: [
          {
            eventId: eventId.slice(0, 191),
            recipientUserId: notification.recipientUserId,
            recipientMerchantId: notification.recipientMerchantId,
            templateCode: notification.templateCode,
            channel: "SMS",
            lang: notification.lang,
            payloadJson: notification.payloadJson,
            addressMasked: maskPhoneNumber(phone),
            addressCiphertext: await fanoutVault.encryptSecret(phone, "notification-address"),
            status: "QUEUED",
            attempts: 0,
          },
        ],
        skipDuplicates: true,
      });
    } catch {
      // The e-mail delivery must proceed even when the optional SMS fan-out cannot be prepared.
    }
  }

  private async fail(notification: NotificationRow, now: Date, reason: string, previousAttempts: number): Promise<void> {    const attempts = previousAttempts + 1;
    if (attempts >= this.maxAttempts) {
      await this.repositories.notifications.updateNotification(this.db as Tx, notification.id, {
        status: "FAILED",
        attempts,
        nextAttemptAt: null,
        lastError: redactDeliveryError(reason),
      });
      this.logger.error("OutboxNotificationWorker: notification permanently failed", {
        notificationId: notification.id,
        reason,
      });
      return;
    }
    const delay = backoffDelayMs(attempts, this.baseBackoffMs, this.maxBackoffMs);
    await this.repositories.notifications.updateNotification(this.db as Tx, notification.id, {
      status: "QUEUED",
      attempts,
      nextAttemptAt: new Date(now.getTime() + delay),
      lastError: redactDeliveryError(reason),
    });
    this.logger.warn("OutboxNotificationWorker: notification delivery failed, will retry", {
      notificationId: notification.id,
      reason,
      attempts,
    });
  }
}
