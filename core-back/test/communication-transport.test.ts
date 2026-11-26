import { describe, expect, test } from "bun:test";
import {
  formatFromAddress,
  resolveNotificationAddress,
  SmtpEmailTransport,
  SmsWebhookTransport,
} from "../engine/notifications/CommunicationTransport";
import type { EmailConfiguration, SmsConfiguration } from "../lib/communication/settings";
import type { NotificationRow } from "../engine/db/ports";
import { Vault } from "../engine/crypto/Vault";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const emailConfig = (overrides: Partial<EmailConfiguration> = {}): EmailConfiguration => ({
  enabled: true,
  provider: "SMTP",
  fromEmail: "no-reply@example.test",
  fromName: "Payment Gateway",
  replyTo: "support@example.test",
  smtpHost: "smtp.example.test",
  smtpPort: 587,
  smtpSecurity: "STARTTLS",
  smtpUsername: "smtp-user",
  smtpPassword: "smtp-password",
  timeoutMs: 10_000,
  allowInsecure: false,
  source: "ADMIN",
  configured: true,
  missingFields: [],
  ...overrides,
});

const smsConfig = (overrides: Partial<SmsConfiguration> = {}): SmsConfiguration => ({
  enabled: true,
  provider: "WEBHOOK",
  webhookUrl: "https://sms.example.test/send",
  webhookSecret: "sms-secret",
  senderId: "PG",
  timeoutMs: 10_000,
  source: "ADMIN",
  configured: true,
  missingFields: [],
  ...overrides,
});

const notification = (channel: "EMAIL" | "SMS", overrides: Partial<NotificationRow> = {}): NotificationRow => ({
  id: "notification-1",
  eventId: "event-1",
  recipientUserId: null,
  recipientMerchantId: null,
  addressMasked: "a***@example.test",
  addressCiphertext: null,
  templateCode: "LOGIN_MFA",
  channel,
  lang: "en",
  payloadJson: {},
  status: "QUEUED",
  providerMessageId: null,
  attempts: 0,
  nextAttemptAt: null,
  ...overrides,
});

const rendered = {
  subject: "Your sign-in code",
  body: "Your sign-in code is 123456.",
  templateCode: "LOGIN_MFA",
  confidentialityClass: "INTERNAL" as const,
  subjectTemplate: "Your sign-in code",
  bodyTemplate: "Your sign-in code is {{code}}.",
};

describe("SMTP email transport", () => {
  test("sends text + html with the configured From address and no masked recipient", async () => {
    let sent: any = null;
    const transport = new SmtpEmailTransport(emailConfig(), logger, async (message) => {
      sent = message;
      return { messageId: "smtp-1" };
    });
    const result = await transport.deliver(notification("EMAIL"), rendered, "merchant@example.test");
    expect(result.status).toBe("SENT");
    expect(result.providerMessageId).toBe("smtp-1");
    expect(sent?.to).toBe("merchant@example.test");
    expect(sent?.from).toBe('"Payment Gateway" <no-reply@example.test>');
    expect(String(sent?.subject)).toContain("sign-in");
    expect(String(sent?.text)).toContain("123456");
    expect(String(sent?.html)).toContain("123456");
  });

  test("fails permanently when the channel is not configured", async () => {
    const transport = new SmtpEmailTransport(emailConfig({ configured: false, enabled: false }), logger);
    const result = await transport.deliver(notification("EMAIL"), rendered, "merchant@example.test");
    expect(result.status).toBe("FAILED");
    expect(result.permanent).toBe(true);
    expect(result.error).toContain("CHANNEL_NOT_CONFIGURED");
  });

  test("never sends to a masked address", async () => {
    let called = false;
    const transport = new SmtpEmailTransport(emailConfig(), logger, async () => {
      called = true;
      return {};
    });
    const result = await transport.deliver(notification("EMAIL"), rendered, "me***@example.test");
    expect(result.status).toBe("FAILED");
    expect(result.permanent).toBe(true);
    expect(called).toBe(false);
  });

  test("formats a From address without a display name", () => {
    expect(formatFromAddress(emailConfig({ fromName: "" }))).toBe("no-reply@example.test");
  });
});

describe("SMS webhook transport", () => {
  test("posts the signed body to the aggregator and reports SENT", async () => {
    let body = "";
    let headers: Record<string, string> = {};
    const transport = new SmsWebhookTransport(smsConfig(), logger, (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      headers = init.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    const result = await transport.deliver(notification("SMS"), { ...rendered, subject: null }, "+218911234567");
    expect(result.status).toBe("SENT");
    expect(body).toContain("+218911234567");
    expect(body).toContain("PG");
    expect(headers["x-notification-signature"]).toStartWith("sha256=");
  });

  test("reports a provider HTTP error as a failed delivery", async () => {
    const transport = new SmsWebhookTransport(smsConfig(), logger, (async () =>
      new Response("no", { status: 503 })) as unknown as typeof fetch);
    const result = await transport.deliver(notification("SMS"), rendered, "+218911234567");
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("503");
  });
});

describe("notification recipient resolution", () => {
  test("opens a sealed address", async () => {
    const ciphertext = await new Vault().encryptSecret("merchant@example.test", "notification-address");
    const address = await resolveNotificationAddress({ platformSetting: { findMany: async () => [] } }, notification("EMAIL", {
      addressCiphertext: ciphertext,
    }));
    expect(address).toBe("merchant@example.test");
  });

  test("falls back to the user row when no address is sealed", async () => {
    const address = await resolveNotificationAddress(
      {
        platformSetting: { findMany: async () => [] },
        user: { findUnique: async () => ({ email: "user@example.test", phone: "+218911234567" }) },
      },
      notification("EMAIL", { recipientUserId: "user-1" }),
    );
    expect(address).toBe("user@example.test");
  });

  test("never returns the masked address", async () => {
    const address = await resolveNotificationAddress({ platformSetting: { findMany: async () => [] } }, notification("EMAIL"));
    expect(address).toBeNull();
  });
});
