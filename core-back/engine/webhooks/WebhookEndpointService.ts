import { randomUUID } from "node:crypto";
import { ApiError } from "../../lib/error";
import { writeAudit } from "../../lib/audit/writeAudit";
import { toCamelRows } from "../db/rawRows";
import { generateWebhookSecret } from "../../lib/webhooks/standardWebhooks";
import { resolvePinnedAddress, validateWebhookUrl, WebhookEgressError, type DnsResolver } from "../../lib/webhooks/egress";
import { isWebhookEventType, serializeWebhookBody, WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT } from "./events";

type Any = Record<string, any>;

export interface WebhookActor {
  userId: string | null;
  role: string | null;
}

export interface WebhookEndpointServiceDeps {
  db: Any;
  vault: { encryptSecret(plaintext: string, keyId: string): Promise<string>; decryptSecret(payload: string): Promise<string> };
  allowInsecure?: boolean;
  /** Endpoints one application may have. Default 5. */
  maxEndpointsPerApplication?: number;
  /** How long the previous secret keeps verifying after a rotation. Default 24 h. */
  rotationOverlapMs?: number;
  now?: () => Date;
  resolver?: DnsResolver;
}

export const WEBHOOK_SECRET_KEY_ID = "webhook-secret";

export interface PublicWebhookEndpoint {
  id: string;
  applicationId: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  status: string;
  disabledReason: string | null;
  disabledAt: string | null;
  secretRotatedAt: string | null;
  /** True while the previous secret still verifies (a rotation overlap is running). */
  rotationOverlapActive: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failingSince: string | null;
  createdAt: string;
}

const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);

/**
 * The merchant-facing management of webhook endpoints (AUTO-34): create, change, enable/disable, rotate the secret with
 * an overlap, list endpoints and deliveries, send a test event and redeliver. Every method is scoped by the caller's
 * merchant id: another merchant's endpoint or delivery looks like it does not exist. The signing secret is returned
 * exactly once (create and rotate) and never read back.
 */
export class WebhookEndpointService {
  private readonly now: () => Date;

  constructor(private readonly deps: WebhookEndpointServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async checkUrl(url: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = validateWebhookUrl(url, { allowInsecure: this.deps.allowInsecure });
      await resolvePinnedAddress(parsed.hostname, { resolver: this.deps.resolver, allowInsecure: this.deps.allowInsecure }).catch((error) => {
        // A name that does not resolve yet is accepted (delivery retries); one that resolves to a private address is not.
        if (error instanceof WebhookEgressError && !error.retryable) throw error;
      });
    } catch (error) {
      if (error instanceof WebhookEgressError) throw new ApiError(422, `WEBHOOK_${error.code}`, error.message);
      throw error;
    }
    return parsed.toString();
  }

  private checkEventTypes(types: readonly string[] | undefined): string[] {
    const list = [...new Set(types ?? [])];
    const unknown = list.filter((type) => !isWebhookEventType(type));
    if (unknown.length > 0) {
      throw new ApiError(422, "WEBHOOK_EVENT_TYPE_UNKNOWN", `Unknown event type(s): ${unknown.join(", ")}`, { allowed: WEBHOOK_EVENT_TYPES });
    }
    return list;
  }

  private publicView(row: Any, now: Date): PublicWebhookEndpoint {
    return {
      id: String(row.id),
      applicationId: String(row.applicationId),
      url: String(row.url),
      description: row.description ?? null,
      eventTypes: (row.eventTypes ?? []) as string[],
      status: String(row.status),
      disabledReason: row.disabledReason ?? null,
      disabledAt: iso(row.disabledAt),
      secretRotatedAt: iso(row.secretRotatedAt),
      rotationOverlapActive: Boolean(row.previousSecretCiphertext && row.previousSecretExpiresAt && new Date(row.previousSecretExpiresAt).getTime() > now.getTime()),
      lastSuccessAt: iso(row.lastSuccessAt),
      lastFailureAt: iso(row.lastFailureAt),
      failingSince: iso(row.failingSince),
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }

  private async load(merchantId: string, endpointId: string): Promise<Any> {
    const rows = toCamelRows<Any>(
      await this.deps.db.$queryRawUnsafe(
        `SELECT id::text AS id, application_id::text AS application_id, merchant_id::text AS merchant_id, url, description, event_types, status, disabled_reason, disabled_at,
                secret_ciphertext, previous_secret_ciphertext, previous_secret_expires_at, secret_rotated_at, failing_since, last_success_at, last_failure_at, created_at
         FROM merchant_webhook_endpoints WHERE id = $1::uuid AND merchant_id = $2::uuid`,
        endpointId,
        merchantId,
      ),
    );
    if (rows.length === 0) throw new ApiError(404, "WEBHOOK_ENDPOINT_NOT_FOUND", "The webhook endpoint does not exist");
    return rows[0]!;
  }

  private async audit(actor: WebhookActor, action: string, entityId: string, afterJson: Record<string, unknown>): Promise<void> {
    await writeAudit(this.deps.db, {
      data: { actorId: actor.userId, role: actor.role ?? "MERCHANT", action, entityType: "MERCHANT_WEBHOOK_ENDPOINT", entityId, beforeJson: {}, afterJson },
    } as never);
  }

  async list(merchantId: string, applicationId?: string): Promise<PublicWebhookEndpoint[]> {
    const now = this.now();
    const rows = toCamelRows<Any>(
      await this.deps.db.$queryRawUnsafe(
        `SELECT id::text AS id, application_id::text AS application_id, url, description, event_types, status, disabled_reason, disabled_at,
                previous_secret_ciphertext, previous_secret_expires_at, secret_rotated_at, failing_since, last_success_at, last_failure_at, created_at
         FROM merchant_webhook_endpoints WHERE merchant_id = $1::uuid${applicationId ? " AND application_id = $2::uuid" : ""} ORDER BY created_at ASC`,
        merchantId,
        ...(applicationId ? [applicationId] : []),
      ),
    );
    return rows.map((row) => this.publicView(row, now));
  }

  async create(input: { merchantId: string; applicationId: string; url: string; eventTypes?: string[]; description?: string | null; actor: WebhookActor }): Promise<{ endpoint: PublicWebhookEndpoint; secret: string }> {
    const application = toCamelRows<Any>(
      await this.deps.db.$queryRawUnsafe(`SELECT id::text AS id FROM applications WHERE id = $1::uuid AND merchant_id = $2::uuid`, input.applicationId, input.merchantId),
    );
    if (application.length === 0) throw new ApiError(404, "APPLICATION_NOT_FOUND", "The application does not exist");
    const url = await this.checkUrl(input.url);
    const eventTypes = this.checkEventTypes(input.eventTypes);
    const existing = Number(
      toCamelRows<Any>(await this.deps.db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM merchant_webhook_endpoints WHERE application_id = $1::uuid`, input.applicationId))[0]?.n ?? 0,
    );
    const limit = this.deps.maxEndpointsPerApplication ?? 5;
    if (existing >= limit) throw new ApiError(409, "WEBHOOK_ENDPOINT_LIMIT", `An application can have at most ${limit} webhook endpoints`);
    const secret = generateWebhookSecret();
    const now = this.now();
    const id = randomUUID();
    await this.deps.db.$executeRawUnsafe(
      `INSERT INTO merchant_webhook_endpoints (id, created_at, updated_at, merchant_id, application_id, url, description, event_types, status, secret_ciphertext)
       VALUES ($1::uuid, $2, $2, $3::uuid, $4::uuid, $5, $6, $7::jsonb, 'ACTIVE', $8)`,
      id,
      now,
      input.merchantId,
      input.applicationId,
      url,
      input.description?.slice(0, 200) ?? null,
      JSON.stringify(eventTypes),
      await this.deps.vault.encryptSecret(secret, WEBHOOK_SECRET_KEY_ID),
    );
    await this.audit(input.actor, "MERCHANT_WEBHOOK_ENDPOINT_CREATED", id, { applicationId: input.applicationId, url, eventTypes });
    return { endpoint: this.publicView(await this.load(input.merchantId, id), now), secret };
  }

  async update(input: { merchantId: string; endpointId: string; url?: string; eventTypes?: string[]; description?: string | null; enabled?: boolean; actor: WebhookActor }): Promise<PublicWebhookEndpoint> {
    const current = await this.load(input.merchantId, input.endpointId);
    const now = this.now();
    const url = input.url !== undefined ? await this.checkUrl(input.url) : String(current.url);
    const eventTypes = input.eventTypes !== undefined ? this.checkEventTypes(input.eventTypes) : (current.eventTypes as string[]);
    let status = String(current.status);
    let disabledReason: string | null = current.disabledReason ?? null;
    let disabledAt: Date | null = current.disabledAt ? new Date(current.disabledAt) : null;
    let failingSince: Date | null = current.failingSince ? new Date(current.failingSince) : null;
    if (input.enabled === true && status !== "ACTIVE") {
      status = "ACTIVE";
      disabledReason = null;
      disabledAt = null;
      failingSince = null;
    } else if (input.enabled === false && status === "ACTIVE") {
      status = "DISABLED";
      disabledReason = "DISABLED_BY_MERCHANT";
      disabledAt = now;
    }
    await this.deps.db.$executeRawUnsafe(
      `UPDATE merchant_webhook_endpoints SET url = $2, description = $3, event_types = $4::jsonb, status = $5, disabled_reason = $6, disabled_at = $7, failing_since = $8, updated_at = $9 WHERE id = $1::uuid`,
      input.endpointId,
      url,
      input.description !== undefined ? (input.description?.slice(0, 200) ?? null) : (current.description ?? null),
      JSON.stringify(eventTypes),
      status,
      disabledReason,
      disabledAt,
      failingSince,
      now,
    );
    if (status !== "ACTIVE" && String(current.status) === "ACTIVE") {
      // pending deliveries of a disabled endpoint wait parked until the merchant enables it and redelivers
      await this.deps.db.$executeRawUnsafe(
        `UPDATE merchant_webhook_deliveries SET status = 'PARKED', parked_at = $2, park_reason = 'ENDPOINT_DISABLED', next_attempt_at = NULL, updated_at = $2 WHERE endpoint_id = $1::uuid AND status = 'PENDING'`,
        input.endpointId,
        now,
      );
    }
    await this.audit(input.actor, "MERCHANT_WEBHOOK_ENDPOINT_UPDATED", input.endpointId, { url, eventTypes, status });
    return this.publicView(await this.load(input.merchantId, input.endpointId), now);
  }

  /** The new secret becomes current; the previous one keeps verifying for the overlap so the merchant can switch without losing events. */
  async rotateSecret(input: { merchantId: string; endpointId: string; actor: WebhookActor }): Promise<{ endpoint: PublicWebhookEndpoint; secret: string }> {
    const current = await this.load(input.merchantId, input.endpointId);
    const now = this.now();
    const secret = generateWebhookSecret();
    await this.deps.db.$executeRawUnsafe(
      `UPDATE merchant_webhook_endpoints SET previous_secret_ciphertext = secret_ciphertext, previous_secret_expires_at = $2, secret_ciphertext = $3, secret_rotated_at = $4, updated_at = $4 WHERE id = $1::uuid`,
      input.endpointId,
      new Date(now.getTime() + (this.deps.rotationOverlapMs ?? 24 * 3_600_000)),
      await this.deps.vault.encryptSecret(secret, WEBHOOK_SECRET_KEY_ID),
      now,
    );
    await this.audit(input.actor, "MERCHANT_WEBHOOK_SECRET_ROTATED", input.endpointId, { overlapHours: (this.deps.rotationOverlapMs ?? 24 * 3_600_000) / 3_600_000, hadPrevious: Boolean(current.previousSecretCiphertext) });
    return { endpoint: this.publicView(await this.load(input.merchantId, input.endpointId), now), secret };
  }

  async listDeliveries(input: { merchantId: string; endpointId?: string; status?: string; limit?: number; before?: string }): Promise<Array<Record<string, unknown>>> {
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 200);
    const params: unknown[] = [input.merchantId];
    const where = ["d.merchant_id = $1::uuid"];
    if (input.endpointId) { params.push(input.endpointId); where.push(`d.endpoint_id = $${params.length}::uuid`); }
    if (input.status) { params.push(input.status); where.push(`d.status = $${params.length}`); }
    if (input.before) { params.push(new Date(input.before)); where.push(`d.created_at < $${params.length}`); }
    params.push(limit);
    const rows = toCamelRows<Any>(
      await this.deps.db.$queryRawUnsafe(
        `SELECT d.id::text AS id, d.endpoint_id::text AS endpoint_id, d.event_id, d.event_type, d.status, d.attempts, d.next_attempt_at, d.last_attempt_at, d.last_status_code,
                d.last_latency_ms, d.last_error, d.delivered_at, d.parked_at, d.park_reason, d.created_at
         FROM merchant_webhook_deliveries d WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC, d.id DESC LIMIT $${params.length}`,
        ...params,
      ),
    );
    return rows.map((row) => ({
      id: String(row.id),
      endpointId: String(row.endpointId),
      eventId: String(row.eventId),
      eventType: String(row.eventType),
      status: String(row.status),
      attempts: Number(row.attempts),
      nextAttemptAt: iso(row.nextAttemptAt),
      lastAttemptAt: iso(row.lastAttemptAt),
      lastStatusCode: row.lastStatusCode ?? null,
      lastLatencyMs: row.lastLatencyMs ?? null,
      lastError: row.lastError ?? null,
      deliveredAt: iso(row.deliveredAt),
      parkedAt: iso(row.parkedAt),
      parkReason: row.parkReason ?? null,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
  }

  /** Puts a parked or delivered event back in the queue as a fresh delivery cycle. The endpoint must be active. */
  async redeliver(input: { merchantId: string; deliveryId: string; actor: WebhookActor }): Promise<{ id: string; status: string }> {
    const rows = toCamelRows<Any>(
      await this.deps.db.$queryRawUnsafe(
        `SELECT d.id::text AS id, d.endpoint_id::text AS endpoint_id, d.status, e.status AS endpoint_status
         FROM merchant_webhook_deliveries d JOIN merchant_webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.id = $1::uuid AND d.merchant_id = $2::uuid`,
        input.deliveryId,
        input.merchantId,
      ),
    );
    if (rows.length === 0) throw new ApiError(404, "WEBHOOK_DELIVERY_NOT_FOUND", "The delivery does not exist");
    const row = rows[0]!;
    if (String(row.endpointStatus) !== "ACTIVE") throw new ApiError(409, "WEBHOOK_ENDPOINT_DISABLED", "Enable the endpoint before redelivering");
    if (String(row.status) === "PENDING") throw new ApiError(409, "WEBHOOK_DELIVERY_PENDING", "The delivery is already queued");
    const now = this.now();
    await this.deps.db.$executeRawUnsafe(
      `UPDATE merchant_webhook_deliveries SET status = 'PENDING', attempts = 0, next_attempt_at = $2, parked_at = NULL, park_reason = NULL, delivered_at = NULL, updated_at = $2 WHERE id = $1::uuid AND status <> 'PENDING'`,
      input.deliveryId,
      now,
    );
    await this.audit(input.actor, "MERCHANT_WEBHOOK_REDELIVERED", String(row.endpointId), { deliveryId: input.deliveryId });
    return { id: input.deliveryId, status: "PENDING" };
  }

  /** Queues a `webhook.test` event for one endpoint (delivered whatever the endpoint's event filter). */
  async sendTest(input: { merchantId: string; endpointId: string; actor: WebhookActor }): Promise<{ deliveryId: string; eventId: string }> {
    const endpoint = await this.load(input.merchantId, input.endpointId);
    if (String(endpoint.status) !== "ACTIVE") throw new ApiError(409, "WEBHOOK_ENDPOINT_DISABLED", "Enable the endpoint before sending a test event");
    const now = this.now();
    const eventId = `evt_test_${randomUUID()}`;
    const body = serializeWebhookBody({ id: eventId, type: WEBHOOK_TEST_EVENT, created: now.toISOString(), data: { message: "This is a test event from the payment gateway." } });
    const deliveryId = randomUUID();
    await this.deps.db.$executeRawUnsafe(
      `INSERT INTO merchant_webhook_deliveries (id, created_at, updated_at, endpoint_id, merchant_id, event_id, event_type, body, status, attempts, next_attempt_at)
       VALUES ($1::uuid, $2, $2, $3::uuid, $4::uuid, $5, $6, $7, 'PENDING', 0, $2)`,
      deliveryId,
      now,
      input.endpointId,
      input.merchantId,
      eventId,
      WEBHOOK_TEST_EVENT,
      body,
    );
    await this.audit(input.actor, "MERCHANT_WEBHOOK_TEST_SENT", input.endpointId, { deliveryId, eventId });
    return { deliveryId, eventId };
  }
}
