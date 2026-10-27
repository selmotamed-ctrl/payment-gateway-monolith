import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  CompositeNotificationTransport,
  LogNotificationTransport,
  WebhookNotificationTransport,
  createNotificationTransport,
  formatNotificationLogLine,
  signNotificationPayload,
  type NotificationFetch,
  type NotificationProviderResponse,
  type NotificationTransportLogger,
  type RenderedNotification,
} from "../engine/notifications/NotificationTransport";
import { resolveNotificationTransport } from "../engine/workers/productionRuntime";
import { OutboxNotificationWorker } from "../engine/workers/OutboxNotificationWorker";
import { createFakeDb, createFakeRepositories } from "./helpers/fakeRepositories";
import { envSchema } from "../lib/env";
import type { NotificationRow, NotificationTemplateRow, PrismaLike } from "../engine/db/ports";
import {
  CURRENCY_SCOPED_GL_ACCOUNT_TYPES,
  SUPPORTED_CURRENCIES,
  seedSystemGlAccounts,
  systemGlAccountSeedKey,
} from "../prisma/seedGlAccounts";
import { LedgerPoster } from "../engine/ledger/LedgerPoster";
import { createFakePrisma, fakeTable, resetFakeDatabase } from "./helpers/fakePrisma";

/**
 * The notification transport and the currency scoped GL accounts.
 *
 * The transport is executed against an in-memory provider, the seed against
 * the in-memory Prisma stand-in: no database and no network are involved.
 */

const notification = (overrides: Partial<NotificationRow> = {}): NotificationRow => ({
  id: "notification-1",
  eventId: "event-1",
  recipientUserId: "user-1",
  recipientMerchantId: null,
  addressMasked: "+2189**1234",
  addressCiphertext: null,
  templateCode: "PAYMENT_SUCCEEDED",
  channel: "EMAIL",
  lang: "en",
  payloadJson: {},
  status: "QUEUED",
  providerMessageId: null,
  attempts: 0,
  nextAttemptAt: null,
  ...overrides,
});

const rendered = (overrides: Partial<RenderedNotification> = {}): RenderedNotification => ({
  subject: "Payment completed",
  body: "A payment of 100.00 LYD was received.",
  templateCode: "PAYMENT_SUCCEEDED",
  confidentialityClass: "MERCHANT",
  subjectTemplate: "Payment completed",
  bodyTemplate: "A payment of {{amount}} {{currency}} was received.",
  ...overrides,
});

const capturingLogger = (): NotificationTransportLogger & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
};

describe("composite notification transport", () => {
  test("an IN_APP notification is delivered by the notification row itself", async () => {
    const logger = capturingLogger();
    const provider = new LogNotificationTransport({ logger });
    const transport = new CompositeNotificationTransport({ provider, logger });

    const result = await transport.deliver(
      notification({ channel: "IN_APP", templateCode: "PAYMENT_SUCCEEDED" }),
      rendered(),
    );

    expect(result.status).toBe("DELIVERED");
    expect(result.providerMessageId).toBe("in-app-notification-1");
  });

  test("an SMS notification is routed to the provider transport", async () => {
    const logger = capturingLogger();
    const delivered: string[] = [];
    const provider = {
      deliver: async (row: NotificationRow): Promise<{ status: "SENT"; providerMessageId: string }> => {
        delivered.push(row.channel);
        return { status: "SENT", providerMessageId: "provider-1" };
      },
    };
    const transport = new CompositeNotificationTransport({ provider, logger });

    const result = await transport.deliver(notification({ channel: "SMS" }), rendered());

    expect(delivered).toEqual(["SMS"]);
    expect(result.status).toBe("SENT");
    expect(result.providerMessageId).toBe("provider-1");
  });

  test("an EMAIL notification is routed to the provider transport", async () => {
    const logger = capturingLogger();
    const delivered: string[] = [];
    const provider = {
      deliver: async (row: NotificationRow): Promise<{ status: "SENT" }> => {
        delivered.push(row.channel);
        return { status: "SENT" };
      },
    };
    const transport = new CompositeNotificationTransport({ provider, logger });

    const result = await transport.deliver(notification({ channel: "EMAIL" }), rendered());

    expect(delivered).toEqual(["EMAIL"]);
    expect(result.status).toBe("SENT");
  });

  test("the log transport reports SENT and never DELIVERED", async () => {
    const logger = capturingLogger();
    const transport = createNotificationTransport({ logger });

    const result = await transport.deliver(notification({ channel: "EMAIL" }), rendered());

    expect(result.status).toBe("SENT");
    expect(result.status).not.toBe("DELIVERED");
    expect(result.providerMessageId).toBe("local-notification-1");
  });
});

describe("webhook notification transport", () => {
  const secret = "provider-shared-secret";

  const providerResponse = (
    status: number,
    payload: Record<string, unknown> = {},
  ): NotificationProviderResponse => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  });

  test("posts the rendered message with an HMAC-SHA256 signature", async () => {
    const logger = capturingLogger();
    const calls: Array<{ url: string; init: Parameters<NotificationFetch>[1] }> = [];
    const fetchImpl: NotificationFetch = async (url, init) => {
      calls.push({ url, init });
      return providerResponse(202, { messageId: "provider-message-1" });
    };

    const transport = new WebhookNotificationTransport({
      url: "https://notifications.example.ly/send",
      secret,
      fetchImpl,
      logger,
    });

    const result = await transport.deliver(
      notification({ channel: "SMS", addressMasked: "+2189**1234" }),
      rendered({ subject: null, body: "A payment of 100.00 LYD was received." }),
    );

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call?.url).toBe("https://notifications.example.ly/send");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers["content-type"]).toBe("application/json");
    expect(call?.init.headers["x-notification-delivery-id"]).toBe("notification-1");

    const expectedSignature = createHmac("sha256", secret)
      .update(call?.init.body ?? "", "utf8")
      .digest("hex");
    const signature = call?.init.headers["x-notification-signature"] ?? "";
    expect(signature).toBe(`sha256=${expectedSignature}`);
    expect(signNotificationPayload(secret, call?.init.body ?? "")).toBe(signature);

    const payload = JSON.parse(call?.init.body ?? "{}") as Record<string, unknown>;
    expect(payload.body).toBe("A payment of 100.00 LYD was received.");
    expect(payload.channel).toBe("SMS");
    expect(payload.templateCode).toBe("PAYMENT_SUCCEEDED");

    expect(result.status).toBe("SENT");
    expect(result.providerMessageId).toBe("provider-message-1");
  });

  test("maps a provider error to FAILED", async () => {
    const logger = capturingLogger();
    const fetchImpl: NotificationFetch = async () => providerResponse(500, { error: "rejected" });

    const transport = new WebhookNotificationTransport({
      url: "https://notifications.example.ly/send",
      secret,
      fetchImpl,
      logger,
    });

    const result = await transport.deliver(notification({ channel: "SMS" }), rendered());

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("500");
  });

  test("maps a provider timeout to FAILED", async () => {
    const logger = capturingLogger();
    const fetchImpl: NotificationFetch = (_url, init) =>
      new Promise<NotificationProviderResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const transport = new WebhookNotificationTransport({
      url: "https://notifications.example.ly/send",
      secret,
      timeoutMs: 10,
      fetchImpl,
      logger,
    });

    const result = await transport.deliver(notification({ channel: "SMS" }), rendered());

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("timed out");
  });
});

describe("notification logging", () => {
  test("the rendered body of an INTERNAL template is never written to the log", async () => {
    const logger = capturingLogger();
    const transport = new LogNotificationTransport({ logger });

    const result = await transport.deliver(
      notification({ channel: "SMS", templateCode: "LOGIN_MFA" }),
      rendered({
        subject: "Your sign-in code",
        body: "Your sign-in code is 441902. Never share this code with anyone.",
        templateCode: "LOGIN_MFA",
        confidentialityClass: "INTERNAL",
        subjectTemplate: "Your sign-in code",
        bodyTemplate: "Your sign-in code is {{code}}. Never share this code with anyone.",
      }),
    );

    expect(result.status).toBe("SENT");
    expect(logger.lines.length).toBe(1);
    const line = logger.lines[0] ?? "";
    expect(line).not.toContain("441902");
    expect(line).not.toContain("Never share this code");
    expect(line).toContain("LOGIN_MFA");
    expect(line).toContain("SMS");
    expect(line).toContain("+2189**1234");
  });

  test("the log line of a merchant template keeps the rendered body", () => {
    const line = formatNotificationLogLine(notification({ channel: "EMAIL" }), rendered());
    expect(line).toContain("A payment of 100.00 LYD was received.");
    expect(line).toContain("PAYMENT_SUCCEEDED");
  });

  test("a template that tips off the merchant is never delivered", async () => {
    const logger = capturingLogger();
    const transport = new LogNotificationTransport({ logger });

    const result = await transport.deliver(
      notification({ channel: "EMAIL", templateCode: "AML_CASE_OPENED" }),
      rendered({
        body: "Your case {{aml_case_id}} is open",
        templateCode: "AML_CASE_OPENED",
        confidentialityClass: "MERCHANT",
        bodyTemplate: "Your case {{aml_case_id}} is open",
      }),
    );

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("AML variables");
    expect(logger.lines.join("\n")).not.toContain("aml_case_id");
  });
});

describe("the outbox worker and the transport", () => {
  const dueNotification = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "notification-1",
    event_id: "event-1",
    recipient_user_id: null,
    recipient_merchant_id: "merchant-1",
    address_masked: "+2189**1234",
    address_ciphertext: null,
    template_code: "PAYMENT_SUCCEEDED",
    channel: "EMAIL",
    lang: "en",
    payload_json: { amount: "100.00", currency: "LYD" },
    status: "QUEUED",
    provider_message_id: null,
    attempts: 0,
    next_attempt_at: null,
    ...overrides,
  });

  const template: NotificationTemplateRow = {
    code: "PAYMENT_SUCCEEDED",
    channel: "EMAIL",
    lang: "en",
    subjectTemplate: "Payment completed",
    bodyTemplate: "A payment of {{amount}} {{currency}} was received.",
    confidentialityClass: "MERCHANT",
    version: 1,
    active: true,
  };

  const runWorker = async (options: {
    channel: "EMAIL" | "IN_APP";
  }): Promise<Array<Record<string, unknown>>> => {
    const updates: Array<Record<string, unknown>> = [];
    const logger = capturingLogger();
    const transport = new CompositeNotificationTransport({
      provider: new LogNotificationTransport({ logger }),
      logger,
    });
    const db = createFakeDb({
      dueMerchants: [dueNotification({ channel: options.channel })],
    });
    const repositories = createFakeRepositories({
      notifications: {
        findTemplate: async () => template,
        updateNotification: async (_tx, _id, patch) => {
          updates.push({ ...patch });
          return { ...notification(), ...patch };
        },
      },
    });

    const worker = new OutboxNotificationWorker({
      db,
      repositories,
      sender: {
        send: async (row, message) => {
          const result = await transport.deliver(row, message);
          return {
            status: result.status,
            providerMessageId: result.providerMessageId ?? null,
            ...(result.error === undefined ? {} : { error: result.error }),
          };
        },
      },
    });
    await worker.runOnce();
    return updates;
  };

  test("a delivered notification of the log transport is SENT and never DELIVERED", async () => {
    const updates = await runWorker({ channel: "EMAIL" });
    expect(updates.length).toBe(1);
    expect(updates[0]?.status).toBe("SENT");
    expect(updates[0]?.status).not.toBe("DELIVERED");
    expect(updates[0]?.providerMessageId).toBe("local-notification-1");
  });

  test("an IN_APP notification is DELIVERED by the notification row", async () => {
    const updates = await runWorker({ channel: "IN_APP" });
    expect(updates.length).toBe(1);
    expect(updates[0]?.status).toBe("DELIVERED");
  });
});

describe("the notification transport of the production runtime", () => {
  const withEnvironment = (
    variables: Record<string, string | undefined>,
    assertion: () => void,
  ): void => {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(variables)) {
      previous.set(key, process.env[key]);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      assertion();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };

  test("without a configured endpoint the platform keeps the log transport", () => {
    withEnvironment({ NOTIFICATION_WEBHOOK_URL: undefined }, () => {
      const transport = resolveNotificationTransport({ db: {} as PrismaLike });
      expect(transport).toBeInstanceOf(CompositeNotificationTransport);
      expect((transport as CompositeNotificationTransport).provider).toBeInstanceOf(
        LogNotificationTransport,
      );
    });
  });

  test("a configured endpoint makes the platform talk to the provider", () => {
    withEnvironment({ NOTIFICATION_WEBHOOK_URL: "https://notifications.example.ly/send" }, () => {
      const transport = resolveNotificationTransport({ db: {} as PrismaLike });
      expect((transport as CompositeNotificationTransport).provider).toBeInstanceOf(
        WebhookNotificationTransport,
      );
    });
  });
});

describe("the notification environment", () => {
  const baseEnvironment = {
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/payment_gateway",
    MTLS_CA_CERT_PATH: "./certs/internal-ca.crt",
    MTLS_SERVER_CERT_PATH: "./certs/core-back.crt",
    MTLS_SERVER_KEY_PATH: "./certs/core-back.key",
    KMS_MASTER_KEY: "phase-test-master-key-value",
  };

  test("the webhook url is optional", () => {
    const parsed = envSchema.safeParse({ ...baseEnvironment });
    expect(parsed.success).toBe(true);
  });

  test("a malformed webhook url is rejected", () => {
    const parsed = envSchema.safeParse({
      ...baseEnvironment,
      NOTIFICATION_WEBHOOK_URL: "not-a-url",
    });
    expect(parsed.success).toBe(false);
  });

  test("the timeout is a positive integer with a sane default", () => {
    const parsed = envSchema.safeParse({ ...baseEnvironment });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.NOTIFICATION_WEBHOOK_TIMEOUT_MS).toBe(5000);
    }

    const invalid = envSchema.safeParse({
      ...baseEnvironment,
      NOTIFICATION_WEBHOOK_TIMEOUT_MS: 0,
    });
    expect(invalid.success).toBe(false);

    const valid = envSchema.safeParse({
      ...baseEnvironment,
      NOTIFICATION_WEBHOOK_TIMEOUT_MS: "2500",
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.NOTIFICATION_WEBHOOK_TIMEOUT_MS).toBe(2500);
    }
  });
});

describe("currency scoped GL accounts", () => {
  test("the seed creates one system account per account type and currency", async () => {
    resetFakeDatabase();
    const prisma = createFakePrisma();

    await seedSystemGlAccounts(prisma);

    const accounts = fakeTable("glAccount");
    expect(accounts.length).toBe(
      CURRENCY_SCOPED_GL_ACCOUNT_TYPES.length * SUPPORTED_CURRENCIES.length,
    );

    for (const accountType of CURRENCY_SCOPED_GL_ACCOUNT_TYPES) {
      for (const currency of SUPPORTED_CURRENCIES) {
        const matches = accounts.filter(
          (row) => row.accountType === accountType && row.currency === currency,
        );
        expect(matches.length).toBe(1);
        expect(matches[0]?.seedKey).toBe(systemGlAccountSeedKey(accountType, currency));
        expect(String(matches[0]?.checkpointBalance)).toBe("0");
      }
    }

    const seedKeys = accounts.map((row) => row.seedKey);
    expect(new Set(seedKeys).size).toBe(seedKeys.length);
  });

  test("the seed is idempotent", async () => {
    resetFakeDatabase();
    const prisma = createFakePrisma();

    await seedSystemGlAccounts(prisma);
    const first = fakeTable("glAccount").map((row) => ({ ...row }));
    await seedSystemGlAccounts(prisma);
    const second = fakeTable("glAccount").map((row) => ({ ...row }));

    expect(second.length).toBe(first.length);
    expect(second).toEqual(first);
  });

  test("the ledger resolves an account of a foreign currency", async () => {
    resetFakeDatabase();
    const prisma = createFakePrisma();
    await seedSystemGlAccounts(prisma);

    const poster = new LedgerPoster(prisma as never);
    const result = await poster.postScenario(
      "CASHOUT",
      "cashout-usd-1",
      { amount: "10.0000" },
      { currency: "USD" },
    );

    expect(result.created).toBe(true);
    expect(result.lines.length).toBe(2);
    for (const line of result.lines) {
      const account = fakeTable("glAccount").find((row) => row.id === line.glAccountId);
      expect(account?.currency).toBe("USD");
    }
  });
});
