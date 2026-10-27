import { assertNoTippingOff, redactAmlPayload, renderTemplate } from "../compliance/tippingOff";
import { toCamelRows } from "../db/rawRows";
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
      "SELECT * FROM notifications" +
      " WHERE status = 'QUEUED'" +
      " AND (next_attempt_at IS NULL OR next_attempt_at <= ?)" +
      " ORDER BY next_attempt_at ASC" +
      " LIMIT ?" +
      " FOR UPDATE SKIP LOCKED";
    const result = await this.db.$queryRawUnsafe(sql, now, this.batchSize);
    return toCamelRows<NotificationRow>(result);
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
