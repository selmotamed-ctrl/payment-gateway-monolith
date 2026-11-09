/**
 * Merchant webhook event types and how outbox events map to them (AUTO-34).
 *
 * Payloads carry identifiers, status and amounts, never card data, customer identity or AML information. Ordering is not
 * guaranteed (a retried older event can arrive after a newer one); the guide tells merchants to fetch the payment when in
 * doubt.
 */
export const WEBHOOK_EVENT_TYPES = [
  "payment.succeeded",
  "payment.failed",
  "payment.expired",
  "payment.refunded",
  "dispute.opened",
  "dispute.closed",
  "cashout.paid",
  "cashout.failed",
  "link.expired",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Sent by "send test event" in the portal; always delivered to the endpoint it was requested for, whatever its filter. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

export const isWebhookEventType = (value: string): value is WebhookEventType => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);

const ATTEMPT_STATUS_EVENT: Record<string, WebhookEventType | undefined> = {
  SUCCEEDED: "payment.succeeded",
  FAILED: "payment.failed",
  EXPIRED: "payment.expired",
  REFUNDED: "payment.refunded",
};

/** The webhook event an outbox event stands for, or null when it is not a merchant-facing event. */
export const webhookEventTypeOf = (topic: string, payload: Record<string, unknown>): WebhookEventType | null => {
  switch (topic) {
    case "attempt.transitioned":
      return payload.event === "terminal" ? (ATTEMPT_STATUS_EVENT[String(payload.status)] ?? null) : null;
    case "link.expired":
    case "dispute.opened":
    case "dispute.closed":
    case "cashout.paid":
    case "cashout.failed":
      return topic;
    default:
      return null;
  }
};

export interface WebhookEnvelope {
  id: string;
  type: string;
  /** ISO-8601 time the event was produced. */
  created: string;
  data: Record<string, unknown>;
}

/** The exact JSON text that is stored, signed and sent. */
export const serializeWebhookBody = (envelope: WebhookEnvelope): string => JSON.stringify(envelope);

export const webhookEventId = (outboxId: string): string => `evt_${outboxId}`;

/** Retry delays after the 1st..7th failed attempt (the first attempt is immediate): 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h (about 27 h in total). */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [5_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 5 * 3_600_000, 10 * 3_600_000, 10 * 3_600_000];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
