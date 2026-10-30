import { getDb, nowIso, uuidv7, type FakeTransactionRow } from "../db";
import { env } from "../../lib/env";
import { Prng } from "../chaos/prng";
import {
  deriveSecret,
  sign,
  type CanonicalizationMode,
  type CryptoAlgorithm,
  type OutputEncoding,
  type SigningRecipe,
} from "../crypto/FakeCryptoSigner";

/**
 * Asynchronous outbound webhook dispatcher.
 *
 * It reproduces the delivery anomalies the gateway must survive: delayed
 * delivery (after the session TTL), duplicated deliveries, out-of-order
 * PENDING after PAID, corrupt signatures and retry backoff.
 */

export interface WebhookBehavior {
  delaySeconds: number;
  duplicateCount: number;
  outOfOrderPendingAfterPaid: boolean;
  corruptSignatureChancePercent: number;
}

export interface WebhookDispatchInput {
  transaction: FakeTransactionRow;
  event: string;
  payload: Record<string, unknown>;
  url?: string | null;
  behavior?: Partial<WebhookBehavior>;
  headers?: Record<string, string>;
}

interface DeliveryRow {
  id: string;
  transaction_id: string | null;
  gateway_code: string;
  url: string;
  request_headers_json: string;
  request_body_raw: string;
  signature_valid: number;
  attempt: number;
  max_attempts: number;
  state: string;
  response_status: number | null;
  response_body_raw: string | null;
  scheduled_for: string;
  sent_at: string | null;
  error: string | null;
  created_at: string;
}

export type WebhookEventSink = (event: {
  type: "webhook.queued" | "webhook.sent" | "webhook.failed";
  deliveryId: string;
  transactionId: string | null;
  gatewayCode: string;
  event: string;
  state: string;
  detail?: unknown;
}) => void;

interface SignatureProfile {
  algorithm: CryptoAlgorithm;
  canonicalizationMode: CanonicalizationMode;
  outputEncoding: OutputEncoding;
  secretEncoding: "UTF8" | "HEX" | "BASE64";
  signatureHeader: string;
  timestampHeader?: string;
}

const SIGNATURE_PROFILES: Record<string, SignatureProfile> = {
  dpay: {
    algorithm: "HMAC_SHA256",
    canonicalizationMode: "TIMESTAMP_DOT_RAW_BODY",
    outputEncoding: "HEX_LOWER",
    secretEncoding: "UTF8",
    signatureHeader: "X-DPay-Signature",
    timestampHeader: "X-DPay-Timestamp",
  },
  mypay: {
    algorithm: "HMAC_SHA256",
    canonicalizationMode: "RAW_BODY",
    outputEncoding: "HEX_LOWER",
    secretEncoding: "UTF8",
    signatureHeader: "X-MYPAY-SIGNATURE",
  },
  ly_pay: {
    algorithm: "HMAC_SHA256",
    canonicalizationMode: "SORTED_KEY_VALUE_AMP",
    outputEncoding: "HEX_UPPER",
    secretEncoding: "UTF8",
    signatureHeader: "X-LYPAY-Signature",
  },
  plutu: {
    algorithm: "HMAC_SHA256",
    canonicalizationMode: "SORTED_VALUES_HASH",
    outputEncoding: "HEX_UPPER",
    secretEncoding: "UTF8",
    signatureHeader: "X-Plutu-Signature",
  },
  moamalat: {
    algorithm: "HMAC_SHA256",
    canonicalizationMode: "SORTED_KEY_VALUE_AMP",
    outputEncoding: "HEX_UPPER",
    secretEncoding: "HEX",
    signatureHeader: "SecureHash",
  },
  mpgs: {
    algorithm: "HMAC_SHA256",
    canonicalizationMode: "RAW_BODY",
    outputEncoding: "HEX_LOWER",
    secretEncoding: "UTF8",
    signatureHeader: "X-Notification-Secret",
  },
};

const profileFor = (gatewayCode: string): SignatureProfile =>
  SIGNATURE_PROFILES[gatewayCode] ?? {
    algorithm: "HMAC_SHA256",
    canonicalizationMode: "SORTED_KEY_VALUE_AMP",
    outputEncoding: "HEX_LOWER",
    secretEncoding: "UTF8",
    signatureHeader: "X-Fake-Rails-Signature",
  };

const recipeFor = (gatewayCode: string, corrupt: boolean): SigningRecipe => {
  const profile = profileFor(gatewayCode);
  const secret = deriveSecret(env.FAKE_RAILS_SEEDER_TOKEN, gatewayCode, "webhook");
  return {
    algorithm: profile.algorithm,
    canonicalizationMode: profile.canonicalizationMode,
    secret: corrupt ? `${secret}-tampered` : secret,
    secretKeyEncoding: profile.secretEncoding,
    outputEncoding: profile.outputEncoding,
  };
};

const defaultUrlFor = (transaction: FakeTransactionRow): string | null => {
  if (transaction.webhook_url) return transaction.webhook_url;
  return `${env.CORE_INBOUND_BASE_URL.replace(/\/$/, "")}/webhook/${transaction.gateway_code}/${transaction.env.toLowerCase()}/${transaction.gateway_code}-webhook`;
};

const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export class WebhookDispatcher {
  private sink?: WebhookEventSink;

  constructor(sink?: WebhookEventSink) {
    this.sink = sink;
    this.resumeQueued();
  }

  setSink(sink: WebhookEventSink): void {
    this.sink = sink;
  }

  dispatch(input: WebhookDispatchInput): DeliveryRow[] {
    const behavior: WebhookBehavior = {
      delaySeconds: 0,
      duplicateCount: 1,
      outOfOrderPendingAfterPaid: false,
      corruptSignatureChancePercent: 0,
      ...input.behavior,
    };
    const url = input.url ?? defaultUrlFor(input.transaction);
    if (!url) {
      return [];
    }
    const deliveries: DeliveryRow[] = [];
    const copies = Math.max(1, Math.min(5, Math.trunc(behavior.duplicateCount)));
    for (let index = 0; index < copies; index += 1) {
      deliveries.push(this.enqueue(input.transaction, input.event, input.payload, url, behavior, input.headers));
    }
    if (behavior.outOfOrderPendingAfterPaid && /paid|success|captured/i.test(input.event)) {
      const pending = this.enqueue(
        input.transaction,
        "transaction.pending",
        { ...input.payload, status: "PENDING", event: "transaction.pending" },
        url,
        { ...behavior, delaySeconds: behavior.delaySeconds + 2, duplicateCount: 1, outOfOrderPendingAfterPaid: false },
        input.headers,
      );
      deliveries.push(pending);
    }
    return deliveries;
  }

  private enqueue(
    transaction: FakeTransactionRow,
    event: string,
    payload: Record<string, unknown>,
    url: string,
    behavior: WebhookBehavior,
    extraHeaders?: Record<string, string>,
  ): DeliveryRow {
    const profile = profileFor(transaction.gateway_code);
    const prng = new Prng(`${transaction.id}:${event}:${uuidv7()}`);
    const corrupt = prng.chance(behavior.corruptSignatureChancePercent);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ ...payload, event });
    const signature = sign(recipeFor(transaction.gateway_code, corrupt), payload, { rawBody, timestamp });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-fake-rails-signature-valid": corrupt ? "false" : "true",
      "x-fake-rails-event": event,
      [profile.signatureHeader]: signature,
      ...(profile.timestampHeader ? { [profile.timestampHeader]: timestamp } : {}),
      ...(extraHeaders ?? {}),
    };
    const scheduledFor = new Date(Date.now() + Math.max(0, behavior.delaySeconds) * 1000).toISOString();
    const row: DeliveryRow = {
      id: uuidv7(),
      transaction_id: transaction.id,
      gateway_code: transaction.gateway_code,
      url,
      request_headers_json: JSON.stringify(headers),
      request_body_raw: rawBody,
      signature_valid: corrupt ? 0 : 1,
      attempt: 1,
      max_attempts: 3,
      state: "QUEUED",
      response_status: null,
      response_body_raw: null,
      scheduled_for: scheduledFor,
      sent_at: null,
      error: null,
      created_at: nowIso(),
    };
    getDb()
      .prepare(
        `INSERT INTO fake_webhook_deliveries (
          id, transaction_id, gateway_code, url, request_headers_json, request_body_raw,
          signature_valid, attempt, max_attempts, state, response_status, response_body_raw,
          scheduled_for, sent_at, error, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.transaction_id, row.gateway_code, row.url, row.request_headers_json,
        row.request_body_raw, row.signature_valid, row.attempt, row.max_attempts, row.state,
        row.response_status, row.response_body_raw, row.scheduled_for, row.sent_at, row.error, row.created_at,
      );
    this.sink?.({
      type: "webhook.queued",
      deliveryId: row.id,
      transactionId: row.transaction_id,
      gatewayCode: row.gateway_code,
      event,
      state: row.state,
      detail: { scheduledFor, signatureValid: !corrupt },
    });
    this.schedule(row.id, new Date(scheduledFor).getTime() - Date.now());
    return row;
  }

  private schedule(deliveryId: string, delayMs: number): void {
    if (activeTimers.has(deliveryId)) {
      clearTimeout(activeTimers.get(deliveryId));
    }
    const timer = setTimeout(() => {
      activeTimers.delete(deliveryId);
      void this.send(deliveryId);
    }, Math.max(0, delayMs));
    timer.unref?.();
    activeTimers.set(deliveryId, timer);
  }

  async send(deliveryId: string): Promise<DeliveryRow | null> {
    const row = this.get(deliveryId);
    if (!row || row.state === "SENT") return row;
    const headers = JSON.parse(row.request_headers_json) as Record<string, string>;
    try {
      const response = await fetch(row.url, {
        method: "POST",
        headers,
        body: row.request_body_raw,
        signal: AbortSignal.timeout(env.FAKE_RAILS_WEBHOOK_TIMEOUT_MS),
      });
      const text = (await response.text()).slice(0, 4000);
      const state = response.ok ? "SENT" : row.attempt >= row.max_attempts ? "FAILED" : "QUEUED";
      getDb()
        .prepare(
          `UPDATE fake_webhook_deliveries
           SET state = ?, response_status = ?, response_body_raw = ?, sent_at = ?, error = NULL
           WHERE id = ?`,
        )
        .run(state, response.status, text, nowIso(), deliveryId);
      this.sink?.({
        type: state === "SENT" ? "webhook.sent" : "webhook.failed",
        deliveryId,
        transactionId: row.transaction_id,
        gatewayCode: row.gateway_code,
        event: headers["x-fake-rails-event"] ?? "unknown",
        state,
        detail: { status: response.status },
      });
      if (state === "QUEUED") {
        await this.retry(deliveryId, row.attempt + 1);
      }
      return this.get(deliveryId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "delivery failed";
      const state = row.attempt >= row.max_attempts ? "FAILED" : "QUEUED";
      getDb()
        .prepare("UPDATE fake_webhook_deliveries SET state = ?, error = ?, sent_at = ? WHERE id = ?")
        .run(state, message, nowIso(), deliveryId);
      this.sink?.({
        type: "webhook.failed",
        deliveryId,
        transactionId: row.transaction_id,
        gatewayCode: row.gateway_code,
        event: headers["x-fake-rails-event"] ?? "unknown",
        state,
        detail: { error: message },
      });
      if (state === "QUEUED") {
        await this.retry(deliveryId, row.attempt + 1);
      }
      return this.get(deliveryId);
    }
  }

  private async retry(deliveryId: string, nextAttempt: number): Promise<void> {
    getDb()
      .prepare("UPDATE fake_webhook_deliveries SET attempt = ?, scheduled_for = ? WHERE id = ?")
      .run(nextAttempt, new Date(Date.now() + 1000 * 2 ** (nextAttempt - 1)).toISOString(), deliveryId);
    this.schedule(deliveryId, 1000 * 2 ** (nextAttempt - 1));
  }

  get(deliveryId: string): DeliveryRow | null {
    return (
      (getDb()
        .prepare("SELECT * FROM fake_webhook_deliveries WHERE id = ?")
        .get(deliveryId) as DeliveryRow | null) ?? null
    );
  }

  list(transactionId?: string): DeliveryRow[] {
    if (transactionId) {
      return getDb()
        .prepare("SELECT * FROM fake_webhook_deliveries WHERE transaction_id = ? ORDER BY created_at DESC")
        .all(transactionId) as DeliveryRow[];
    }
    return getDb()
      .prepare("SELECT * FROM fake_webhook_deliveries ORDER BY created_at DESC LIMIT 500")
      .all() as DeliveryRow[];
  }

  replay(deliveryId: string, tamper = false): DeliveryRow | null {
    const original = this.get(deliveryId);
    if (!original) return null;
    const headers = JSON.parse(original.request_headers_json) as Record<string, string>;
    if (tamper) {
      for (const key of Object.keys(headers)) {
        if (/signature|securehash|notification-secret/i.test(key)) {
          headers[key] = "forged-signature-0000";
        }
      }
      headers["x-fake-rails-signature-valid"] = "false";
    }
    getDb()
      .prepare(
        `UPDATE fake_webhook_deliveries
         SET request_headers_json = ?, state = 'QUEUED', attempt = 1, scheduled_for = ?, sent_at = NULL, error = NULL
         WHERE id = ?`,
      )
      .run(JSON.stringify(headers), nowIso(), deliveryId);
    this.schedule(deliveryId, 0);
    return this.get(deliveryId);
  }

  private resumeQueued(): void {
    try {
      const rows = getDb()
        .prepare("SELECT id, scheduled_for FROM fake_webhook_deliveries WHERE state = 'QUEUED'")
        .all() as Array<{ id: string; scheduled_for: string }>;
      for (const row of rows) {
        this.schedule(row.id, new Date(row.scheduled_for).getTime() - Date.now());
      }
    } catch {
      // The database may not exist yet during the very first import.
    }
  }
}

export const webhookDispatcher = new WebhookDispatcher();
