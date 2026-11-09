import { BaseWorker, sanitizeWorkerError, type WorkerOptions, type WorkerTickResult } from "./workerRuntime";
import { toCamelRows } from "../db/rawRows";
import { writeSystemAudit } from "../ledger/ledgerAlerts";
import { bilingualNotice, queueNotice, type NoticeDefinition } from "../../lib/automationNotices";
import { buildWebhookHeaders } from "../../lib/webhooks/standardWebhooks";
import { postPinned, WebhookEgressError, type PinnedPostInput, type PinnedPostResult } from "../../lib/webhooks/egress";
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS } from "../webhooks/events";

type Any = Record<string, any>;

export const MERCHANT_WEBHOOK_DISABLED_NOTICE: NoticeDefinition = bilingualNotice({
  code: "MERCHANT_WEBHOOK_DISABLED",
  en: {
    subject: "Your webhook endpoint was disabled",
    body: "We could not deliver webhooks to {{host}} for {{days}} days, so the endpoint was disabled. Fix the endpoint, enable it again in the portal and redeliver the events you missed.",
  },
  ar: {
    subject: "تم تعطيل نقطة استقبال الإشعارات",
    body: "تعذر علينا تسليم الإشعارات إلى {{host}} لمدة {{days}} أيام، لذلك تم تعطيل نقطة الاستقبال. أصلح النقطة ثم فعّلها من جديد في البوابة وأعد إرسال الأحداث الفائتة.",
  },
});

export interface MerchantWebhookWorkerDeps extends WorkerOptions {
  /** Decrypts a stored signing secret (production: the platform vault). */
  openSecret: (ciphertext: string) => Promise<string>;
  /** Sends one signed request; default {@link postPinned} (HTTPS, public addresses, pinned, no redirects). */
  send?: (input: PinnedPostInput) => Promise<PinnedPostResult>;
  /** HTTP destinations (development). Default false. */
  allowInsecure?: boolean;
  timeoutMs?: number;
  /** Deliveries sent in parallel inside one tick. Default 8. */
  concurrency?: number;
  /** Continuous failure after which an endpoint is disabled. Default 5 days. */
  disableAfterMs?: number;
  /** Restricts the worker to these merchants. Production leaves it unset; tests that share a database use it. */
  merchantIds?: readonly string[];
  /** Jitter: each delay is multiplied by a random factor in `[1 - jitter, 1 + jitter]`. Default 0.2. */
  jitter?: number;
}

interface Claimed {
  id: string;
  endpointId: string;
  merchantId: string;
  eventId: string;
  eventType: string;
  body: string;
  attempts: number;
  url: string;
  endpointStatus: string;
  secret: string;
  previousSecret: string | null;
  previousSecretExpiresAt: Date | null;
  failingSince: Date | null;
}

const LEASE_MS = 2 * 60 * 1000;
const DAY = 86_400_000;

/**
 * Delivers merchant webhooks (AUTO-34). Not a singleton: every node claims a batch with `FOR UPDATE SKIP LOCKED` and a
 * short lease (the claim already counts the attempt, so a crashed node's delivery is retried after the lease).
 *
 *  - Each request is signed with the Standard Webhooks scheme under every active secret (the current one and, during a
 *    rotation overlap, the previous one) and sent to the endpoint's PINNED public address (no redirects).
 *  - 2xx = delivered. Network errors, timeouts, 408, 429 and 5xx retry with exponential backoff and jitter (immediately,
 *    5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h: about 27 h). Any other answer (other 4xx, 3xx, an unsafe URL) parks the
 *    delivery at once; so does the last failed attempt. A parked delivery stays visible and can be redelivered.
 *  - An endpoint that has failed continuously for `disableAfterMs` (5 days) is DISABLED, its pending deliveries are
 *    parked, the merchant is told and an audit row is written.
 *
 * The response body is never stored (only status, latency and a short error): an endpoint cannot make the platform keep
 * arbitrary content.
 */
export class MerchantWebhookWorker extends BaseWorker {
  private readonly deps: MerchantWebhookWorkerDeps;
  private readonly sendRequest: NonNullable<MerchantWebhookWorkerDeps["send"]>;

  constructor(deps: MerchantWebhookWorkerDeps) {
    super({ ...deps, intervalMs: deps.intervalMs ?? 2_000, batchSize: deps.batchSize ?? 50 });
    this.deps = deps;
    this.sendRequest = deps.send ?? postPinned;
  }

  protected async tick(): Promise<WorkerTickResult> {
    const claimed = await this.claim(this.clock());
    const concurrency = Math.max(1, Math.floor(this.deps.concurrency ?? 8));
    let index = 0;
    const lanes = Array.from({ length: Math.min(concurrency, claimed.length) }, async () => {
      while (index < claimed.length) {
        const delivery = claimed[index++]!;
        try {
          await this.deliver(delivery);
        } catch (error) {
          this.logger.error("MerchantWebhookWorker: delivery bookkeeping failed", { deliveryId: delivery.id, error: sanitizeWorkerError(error) });
        }
      }
    });
    await Promise.all(lanes);
    return { processed: claimed.length };
  }

  private async claim(now: Date): Promise<Claimed[]> {
    const lease = new Date(now.getTime() + LEASE_MS);
    const scoped = this.deps.merchantIds && this.deps.merchantIds.length > 0;
    const rows = await this.inTransaction(async (tx) =>
      toCamelRows<Any>(
        await tx.$queryRawUnsafe(
          `WITH due AS (
             SELECT d.id FROM merchant_webhook_deliveries d
             WHERE d.status = 'PENDING' AND d.next_attempt_at <= $1${scoped ? " AND d.merchant_id = ANY($4::uuid[])" : ""}
             ORDER BY d.next_attempt_at ASC LIMIT $2 FOR UPDATE OF d SKIP LOCKED
           )
           UPDATE merchant_webhook_deliveries d
           SET attempts = d.attempts + 1, next_attempt_at = $3, last_attempt_at = $1, updated_at = $1
           FROM due, merchant_webhook_endpoints e
           WHERE d.id = due.id AND e.id = d.endpoint_id
           RETURNING d.id::text AS id, d.endpoint_id::text AS endpoint_id, d.merchant_id::text AS merchant_id, d.event_id, d.event_type, d.body, d.attempts,
                     e.url, e.status AS endpoint_status, e.secret_ciphertext, e.previous_secret_ciphertext, e.previous_secret_expires_at, e.failing_since`,
          now,
          this.batchSize,
          lease,
          ...(scoped ? [[...this.deps.merchantIds!]] : []),
        ),
      ),
    );
    const out: Claimed[] = [];
    for (const row of rows) {
      out.push({
        id: String(row.id),
        endpointId: String(row.endpointId),
        merchantId: String(row.merchantId),
        eventId: String(row.eventId),
        eventType: String(row.eventType),
        body: String(row.body),
        attempts: Number(row.attempts),
        url: String(row.url),
        endpointStatus: String(row.endpointStatus),
        // decrypted lazily in deliver(): a vault failure must fail that delivery only
        secret: String(row.secretCiphertext),
        previousSecret: row.previousSecretCiphertext ? String(row.previousSecretCiphertext) : null,
        previousSecretExpiresAt: row.previousSecretExpiresAt ? new Date(row.previousSecretExpiresAt) : null,
        failingSince: row.failingSince ? new Date(row.failingSince) : null,
      });
    }
    return out;
  }

  private delayAfter(attempts: number): number {
    const base = WEBHOOK_RETRY_DELAYS_MS[Math.min(attempts, WEBHOOK_RETRY_DELAYS_MS.length) - 1]!;
    const jitter = this.deps.jitter ?? 0.2;
    return Math.round(base * (1 + (this.random() * 2 - 1) * jitter));
  }

  private async deliver(delivery: Claimed): Promise<void> {
    if (delivery.endpointStatus !== "ACTIVE") {
      await this.park(delivery, "ENDPOINT_DISABLED", null, null, "The endpoint is disabled");
      return;
    }
    const now = this.clock();
    let outcome: { ok: true; status: number; latencyMs: number } | { ok: false; retryable: boolean; status: number | null; latencyMs: number | null; error: string };
    try {
      const secrets = [await this.deps.openSecret(delivery.secret)];
      if (delivery.previousSecret && delivery.previousSecretExpiresAt && delivery.previousSecretExpiresAt.getTime() > now.getTime()) {
        secrets.push(await this.deps.openSecret(delivery.previousSecret));
      }
      const headers = buildWebhookHeaders({ id: delivery.eventId, timestampSeconds: Math.floor(now.getTime() / 1000), body: delivery.body, secrets });
      const result = await this.sendRequest({ url: delivery.url, body: delivery.body, headers, timeoutMs: this.deps.timeoutMs, allowInsecure: this.deps.allowInsecure });
      if (result.status >= 200 && result.status < 300) {
        outcome = { ok: true, status: result.status, latencyMs: result.latencyMs };
      } else {
        const retryable = result.status === 408 || result.status === 429 || result.status >= 500;
        outcome = { ok: false, retryable, status: result.status, latencyMs: result.latencyMs, error: result.status >= 300 && result.status < 400 ? `The endpoint answered with a redirect (${result.status}); redirects are not followed` : `The endpoint answered ${result.status}` };
      }
    } catch (error) {
      const retryable = error instanceof WebhookEgressError ? error.retryable : true;
      outcome = { ok: false, retryable, status: null, latencyMs: null, error: sanitizeWorkerError(error).slice(0, 300) };
    }

    if (outcome.ok) {
      await this.inTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE merchant_webhook_deliveries SET status = 'DELIVERED', delivered_at = $2, next_attempt_at = NULL, last_status_code = $3, last_latency_ms = $4, last_error = NULL, updated_at = $2 WHERE id = $1::uuid AND status = 'PENDING'`,
          delivery.id,
          now,
          outcome.status,
          outcome.latencyMs,
        );
        await tx.$executeRawUnsafe(`UPDATE merchant_webhook_endpoints SET last_success_at = $2, failing_since = NULL, updated_at = $2 WHERE id = $1::uuid`, delivery.endpointId, now);
      });
      return;
    }

    const exhausted = delivery.attempts >= WEBHOOK_MAX_ATTEMPTS;
    await this.recordFailure(delivery, outcome, now, outcome.retryable && !exhausted);
  }

  private async recordFailure(
    delivery: Claimed,
    outcome: { retryable: boolean; status: number | null; latencyMs: number | null; error: string },
    now: Date,
    willRetry: boolean,
  ): Promise<void> {
    const disableAfterMs = this.deps.disableAfterMs ?? 5 * DAY;
    await this.inTransaction(async (tx) => {
      if (willRetry) {
        await tx.$executeRawUnsafe(
          `UPDATE merchant_webhook_deliveries SET next_attempt_at = $2, last_status_code = $3, last_latency_ms = $4, last_error = $5, updated_at = $6 WHERE id = $1::uuid AND status = 'PENDING'`,
          delivery.id,
          new Date(now.getTime() + this.delayAfter(delivery.attempts)),
          outcome.status,
          outcome.latencyMs,
          outcome.error,
          now,
        );
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE merchant_webhook_deliveries SET status = 'PARKED', parked_at = $2, park_reason = $3, next_attempt_at = NULL, last_status_code = $4, last_latency_ms = $5, last_error = $6, updated_at = $2 WHERE id = $1::uuid AND status = 'PENDING'`,
          delivery.id,
          now,
          outcome.retryable ? "MAX_ATTEMPTS" : "NOT_RETRYABLE",
          outcome.status,
          outcome.latencyMs,
          outcome.error,
        );
      }
      const failingSince = delivery.failingSince ?? now;
      await tx.$executeRawUnsafe(
        `UPDATE merchant_webhook_endpoints SET last_failure_at = $2, failing_since = COALESCE(failing_since, $2), updated_at = $2 WHERE id = $1::uuid`,
        delivery.endpointId,
        now,
      );
      if (now.getTime() - failingSince.getTime() >= disableAfterMs) {
        await this.disableEndpoint(tx as Any, delivery, now, Math.floor((now.getTime() - failingSince.getTime()) / DAY));
      }
    });
  }

  private async disableEndpoint(tx: Any, delivery: Claimed, now: Date, days: number): Promise<void> {
    const disabled = toCamelRows<Any>(
      await tx.$queryRawUnsafe(
        `UPDATE merchant_webhook_endpoints SET status = 'DISABLED', disabled_reason = 'FAILING_FOR_DAYS', disabled_at = $2, updated_at = $2
         WHERE id = $1::uuid AND status = 'ACTIVE' RETURNING url`,
        delivery.endpointId,
        now,
      ),
    );
    if (disabled.length === 0) return; // another delivery already disabled it
    await tx.$executeRawUnsafe(
      `UPDATE merchant_webhook_deliveries SET status = 'PARKED', parked_at = $2, park_reason = 'ENDPOINT_DISABLED', next_attempt_at = NULL, updated_at = $2
       WHERE endpoint_id = $1::uuid AND status = 'PENDING'`,
      delivery.endpointId,
      now,
    );
    let host = "your endpoint";
    try {
      host = new URL(String(disabled[0]!.url)).host;
    } catch {
      /* keep the generic text */
    }
    await writeSystemAudit(tx, {
      action: "MERCHANT_WEBHOOK_ENDPOINT_DISABLED",
      entityType: "MERCHANT_WEBHOOK_ENDPOINT",
      entityId: delivery.endpointId,
      after: { reason: "FAILING_FOR_DAYS", days, merchantId: delivery.merchantId },
    });
    await queueNotice(tx, {
      definition: MERCHANT_WEBHOOK_DISABLED_NOTICE,
      eventKey: `webhook-disabled:${delivery.endpointId}:${now.toISOString().slice(0, 10)}`,
      payload: { host, days },
      merchantId: delivery.merchantId,
    });
  }

  private async park(delivery: Claimed, reason: string, status: number | null, latencyMs: number | null, error: string): Promise<void> {
    const now = this.clock();
    await this.inTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE merchant_webhook_deliveries SET status = 'PARKED', parked_at = $2, park_reason = $3, next_attempt_at = NULL, last_status_code = $4, last_latency_ms = $5, last_error = $6, updated_at = $2 WHERE id = $1::uuid AND status = 'PENDING'`,
        delivery.id,
        now,
        reason,
        status,
        latencyMs,
        error,
      );
    });
  }
}
