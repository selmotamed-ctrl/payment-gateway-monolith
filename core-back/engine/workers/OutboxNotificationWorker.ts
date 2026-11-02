import { assertNoTippingOff, redactAmlPayload, renderTemplate } from "../compliance/tippingOff";
import { mysqlPlaceholders, toCamelRows } from "../db/rawRows";
import type { NotificationRow, Tx } from "../db/ports";
import type { RenderedNotification } from "../notifications/NotificationTransport";
import { BaseWorker, backoffDelayMs, type WorkerOptions } from "./workerRuntime";

export interface NotificationSendResult {
  providerMessageId: string | null;
  status: "SENT" | "DELIVERED" | "FAILED";
  error?: string;
}

export interface NotificationSender {
  send(notification: NotificationRow, rendered: RenderedNotification): Promise<NotificationSendResult>;
}

const NOTIFICATION_CLAIM_LEASE_MS = 5 * 60 * 1000;
const NOTIFICATION_CLAIM_COLUMNS = [
  "id", "created_at", "updated_at", "event_id", "recipient_user_id",
  "recipient_merchant_id", "address_masked", "address_ciphertext",
  "template_code", "channel", "lang", "payload_json", "status",
  "provider_message_id", "attempts", "next_attempt_at",
].join(", ");

export interface OutboxNotificationWorkerDeps extends WorkerOptions {
  sender?: NotificationSender;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAttempts?: number;
}

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
    const sql =
      `SELECT ${NOTIFICATION_CLAIM_COLUMNS} FROM notifications` +
      " WHERE status = 'QUEUED'" +
      " AND (next_attempt_at IS NULL OR next_attempt_at <= ?)" +
      " ORDER BY next_attempt_at ASC" +
      " LIMIT ?" +
      " FOR UPDATE SKIP LOCKED";
    // Selection and claim commit together; the provider call happens after
    // the transaction. The existing `next_attempt_at` column is the lease, so
    // a crashed node's notification becomes claimable again after the lease.
    return this.db.$transaction(async (tx: Tx) => {
      const result = await tx.$queryRawUnsafe(sql, now, this.batchSize);
      const notifications = toCamelRows<NotificationRow>(result);
      if (notifications.length === 0) {
        return notifications;
      }
      const leaseUntil = new Date(now.getTime() + NOTIFICATION_CLAIM_LEASE_MS);
      const idPlaceholders = mysqlPlaceholders(notifications.length);
      await tx.$executeRawUnsafe(
        `UPDATE notifications SET next_attempt_at = ?, updated_at = NOW()
          WHERE id IN (${idPlaceholders}) AND status = 'QUEUED'`,
        leaseUntil,
        ...notifications.map((notification) => notification.id),
      );
      return notifications;
    });
  }

  private async deliver(notification: NotificationRow, now: Date): Promise<void> {
    const template = await this.repositories.notifications.findTemplate(
      this.db as Tx,
      notification.templateCode,
      notification.channel,
      notification.lang,
    );
    if (!template) {
      await this.fail(notification, now, `Template not found: ${notification.templateCode}`, 0);
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
      await this.fail(notification, now, (error as Error).message, 0);
      return;
    }

    const payloadRaw = (notification.payloadJson ?? {}) as Record<string, unknown>;
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
        await this.fail(notification, now, result.error ?? "Sender reported failure", notification.attempts);
        return;
      }
      await this.repositories.notifications.updateNotification(this.db as Tx, notification.id, {
        status: result.status === "DELIVERED" ? "DELIVERED" : "SENT",
        providerMessageId: result.providerMessageId,
        attempts: notification.attempts + 1,
        nextAttemptAt: null,
      });
    } catch (error) {
      await this.fail(notification, now, (error as Error).message, notification.attempts);
    }
  }

  private async fail(notification: NotificationRow, now: Date, reason: string, previousAttempts: number): Promise<void> {
    const attempts = previousAttempts + 1;
    if (attempts >= this.maxAttempts) {
      await this.repositories.notifications.updateNotification(this.db as Tx, notification.id, {
        status: "FAILED",
        attempts,
        nextAttemptAt: null,
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
    });
    this.logger.warn("OutboxNotificationWorker: notification delivery failed, will retry", {
      notificationId: notification.id,
      reason,
      attempts,
    });
  }
}
