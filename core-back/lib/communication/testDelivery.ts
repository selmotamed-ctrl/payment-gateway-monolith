import type { NotificationRow } from "../../engine/db/ports";
import type { RenderedNotification } from "../../engine/notifications/NotificationTransport";
import { SmtpEmailTransport, SmsWebhookTransport } from "../../engine/notifications/CommunicationTransport";
import {
  getCommunicationConfiguration,
  recordCommunicationTest,
  type CommunicationSettingsDatabase,
} from "./settings";

const testLogger = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
};

const fakeNotification = (channel: "EMAIL" | "SMS"): NotificationRow => ({
  id: `test-${Date.now()}`,
  eventId: `test-${Date.now()}`,
  recipientUserId: null,
  recipientMerchantId: null,
  addressMasked: null,
  addressCiphertext: null,
  templateCode: "COMMUNICATION_TEST",
  channel,
  lang: "en",
  payloadJson: {},
  status: "QUEUED",
  providerMessageId: null,
  attempts: 0,
  nextAttemptAt: null,
});

const rendered = (channel: "EMAIL" | "SMS"): RenderedNotification => ({
  subject: channel === "EMAIL" ? "Payment Gateway communication test" : null,
  body:
    channel === "EMAIL"
      ? "This is a test message from the Payment Gateway. If you received it, email delivery is configured correctly."
      : "Payment Gateway test message. SMS delivery is configured correctly.",
  templateCode: "COMMUNICATION_TEST",
  confidentialityClass: "PUBLIC",
  subjectTemplate: null,
  bodyTemplate: "test",
});

export interface TestDeliveryResult {
  ok: boolean;
  channel: "EMAIL" | "SMS";
  providerMessageId?: string;
  error?: string;
}

export interface TestDeliveryDatabase extends CommunicationSettingsDatabase {
}

export const sendTestEmail = async (
  db: TestDeliveryDatabase,
  input: { to: string; sendMail?: ConstructorParameters<typeof SmtpEmailTransport>[2] },
): Promise<TestDeliveryResult> => {
  const config = await getCommunicationConfiguration(db, { force: true });
  const transport = new SmtpEmailTransport(config.email, testLogger, input.sendMail);
  const result = await transport.deliver(fakeNotification("EMAIL"), rendered("EMAIL"), input.to);
  await recordCommunicationTest(db, "EMAIL", {
    status: result.status === "FAILED" ? "FAILED" : "PASSED",
    error: result.error ?? null,
  });
  return {
    ok: result.status !== "FAILED",
    channel: "EMAIL",
    providerMessageId: result.providerMessageId,
    error: result.error,
  };
};

export const sendTestSms = async (
  db: TestDeliveryDatabase,
  input: { to: string; fetchImpl?: typeof fetch },
): Promise<TestDeliveryResult> => {
  const config = await getCommunicationConfiguration(db, { force: true });
  const transport = new SmsWebhookTransport(config.sms, testLogger, input.fetchImpl);
  const result = await transport.deliver(fakeNotification("SMS"), rendered("SMS"), input.to);
  await recordCommunicationTest(db, "SMS", {
    status: result.status === "FAILED" ? "FAILED" : "PASSED",
    error: result.error ?? null,
  });
  return {
    ok: result.status !== "FAILED",
    channel: "SMS",
    providerMessageId: result.providerMessageId,
    error: result.error,
  };
};
