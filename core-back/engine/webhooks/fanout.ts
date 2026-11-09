import { toCamelRows } from "../db/rawRows";
import type { OutboxEnvelope } from "../../lib/storageEngine/ports";
import { serializeWebhookBody, webhookEventId, webhookEventTypeOf, type WebhookEnvelope } from "./events";

type Any = Record<string, any>;

/**
 * The merchant webhook fan-out (AUTO-34): an outbox batch handler that turns merchant-facing outbox events into one
 * delivery row per matching ACTIVE endpoint, in the relay's own transaction. The unique `(endpoint_id, event_id)` makes
 * it idempotent: a relay retry, a second node or a replayed event never creates a second delivery. An event whose
 * merchant has no matching endpoint costs one indexed query per batch and writes nothing.
 *
 * The event identity is `evt_<outbox id>`: stable across retries and endpoints.
 */
export const createWebhookFanout = (options: { now?: () => Date } = {}) => async (events: OutboxEnvelope[], tx: Any): Promise<void> => {
  const now = options.now?.() ?? new Date();
  const wanted = events
    .map((event) => ({ event, type: webhookEventTypeOf(event.topic, event.payload) }))
    .filter((entry): entry is { event: OutboxEnvelope; type: NonNullable<ReturnType<typeof webhookEventTypeOf>> } => entry.type !== null);
  if (wanted.length === 0) return;

  // Resolve the application (the endpoint scope) and the public data of each event.
  const attemptIds = wanted.filter((entry) => entry.event.topic === "attempt.transitioned").map((entry) => String(entry.event.payload.attemptId ?? entry.event.aggregateId));
  const attempts = new Map<string, Any>();
  if (attemptIds.length > 0) {
    for (const row of toCamelRows<Any>(
      await tx.$queryRawUnsafe(
        `SELECT id::text AS id, application_id::text AS application_id, merchant_id::text AS merchant_id, reference, status::text AS status, currency,
                total_charged_amount::text AS total_charged_amount, net_merchant_amount::text AS net_merchant_amount, link_id::text AS link_id
         FROM payment_attempts WHERE id = ANY($1::uuid[])`,
        attemptIds,
      ),
    )) {
      attempts.set(String(row.id), row);
    }
  }
  const linkIds = wanted.filter((entry) => entry.event.topic === "link.expired").map((entry) => String(entry.event.payload.linkId ?? entry.event.aggregateId));
  const links = new Map<string, Any>();
  if (linkIds.length > 0) {
    for (const row of toCamelRows<Any>(
      await tx.$queryRawUnsafe(`SELECT id::text AS id, application_id::text AS application_id, key FROM payment_links WHERE id = ANY($1::uuid[])`, linkIds),
    )) {
      links.set(String(row.id), row);
    }
  }

  /** `applicationId` null = a merchant-level event (disputes, cash-outs): every endpoint of the merchant that subscribes gets it. */
  interface Candidate { eventId: string; type: string; applicationId: string | null; merchantId: string; envelope: WebhookEnvelope }
  const candidates: Candidate[] = [];
  for (const { event, type } of wanted) {
    const outboxId = event.id ?? `${event.topic}:${event.aggregateId}`;
    const eventId = webhookEventId(outboxId);
    const created = typeof event.payload.occurredAt === "string" ? String(event.payload.occurredAt) : now.toISOString();
    if (event.topic === "attempt.transitioned") {
      const attempt = attempts.get(String(event.payload.attemptId ?? event.aggregateId));
      if (!attempt) continue;
      candidates.push({
        eventId,
        type,
        applicationId: String(attempt.applicationId),
        merchantId: String(attempt.merchantId),
        envelope: {
          id: eventId,
          type,
          created,
          data: {
            paymentId: String(attempt.id),
            reference: String(attempt.reference),
            status: String(attempt.status),
            currency: String(attempt.currency).trim(),
            amount: String(attempt.totalChargedAmount),
            netAmount: String(attempt.netMerchantAmount),
            linkId: attempt.linkId ? String(attempt.linkId) : null,
          },
        },
      });
    } else if (event.topic === "link.expired") {
      const link = links.get(String(event.payload.linkId ?? event.aggregateId));
      if (!link || !event.merchantId) continue;
      candidates.push({
        eventId,
        type,
        applicationId: String(link.applicationId),
        merchantId: String(event.merchantId),
        envelope: { id: eventId, type, created, data: { linkId: String(link.id), linkKey: String(link.key), expiredAt: String(event.payload.expiredAt ?? created) } },
      });
    } else {
      // dispute.* and cashout.*: merchant-level events; the producer already wrote the merchant-safe data.
      if (!event.merchantId) continue;
      const { occurredAt: _occurredAt, ...data } = event.payload;
      candidates.push({ eventId, type, applicationId: null, merchantId: String(event.merchantId), envelope: { id: eventId, type, created, data } });
    }
  }
  if (candidates.length === 0) return;

  const endpoints = toCamelRows<Any>(
    await tx.$queryRawUnsafe(
      `SELECT id::text AS id, application_id::text AS application_id, merchant_id::text AS merchant_id, event_types FROM merchant_webhook_endpoints
       WHERE status = 'ACTIVE' AND (application_id = ANY($1::uuid[]) OR merchant_id = ANY($2::uuid[]))`,
      [...new Set(candidates.flatMap((candidate) => (candidate.applicationId ? [candidate.applicationId] : [])))],
      [...new Set(candidates.filter((candidate) => candidate.applicationId === null).map((candidate) => candidate.merchantId))],
    ),
  );
  for (const candidate of candidates) {
    const body = serializeWebhookBody(candidate.envelope);
    for (const endpoint of endpoints) {
      if (candidate.applicationId !== null ? String(endpoint.applicationId) !== candidate.applicationId : String(endpoint.merchantId) !== candidate.merchantId) continue;
      const types = (endpoint.eventTypes ?? []) as string[];
      if (types.length > 0 && !types.includes(candidate.type)) continue;
      await tx.$executeRawUnsafe(
        `INSERT INTO merchant_webhook_deliveries (id, created_at, updated_at, endpoint_id, merchant_id, event_id, event_type, body, status, attempts, next_attempt_at)
         VALUES (gen_random_uuid(), $1, $1, $2::uuid, $3::uuid, $4, $5, $6, 'PENDING', 0, $1)
         ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
        now,
        String(endpoint.id),
        candidate.merchantId,
        candidate.eventId,
        candidate.type,
        body,
      );
    }
  }
};
