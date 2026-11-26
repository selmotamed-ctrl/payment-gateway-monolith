import { describe, expect, test } from "bun:test";
import {
  __resetCommunicationSettingsForTests,
  buildCommunicationConfiguration,
  communicationStatus,
  hasRealEmail,
  maskEmailAddress,
  maskPhoneNumber,
} from "../lib/communication/settings";
import { resolveOtpDelivery, shouldSendSms } from "../lib/communication/policy";

const row = (key: string, value: unknown, version = 1, source = "ADMIN") => ({
  key,
  scope: "PLATFORM",
  version,
  valueJson: value,
  source,
});

const baseEmail = {
  enabled: true,
  provider: "SMTP",
  smtpHost: "smtp.example.test",
  smtpPort: 587,
  smtpSecurity: "STARTTLS",
  smtpUsername: "smtp-user",
  fromEmail: "no-reply@example.test",
  fromName: "Payment Gateway",
  timeoutMs: 10_000,
};

const baseSms = {
  enabled: true,
  provider: "WEBHOOK",
  webhookUrl: "https://sms.example.test/send",
  senderId: "PG",
  timeoutMs: 10_000,
};

const policy = {
  smsMode: "CRITICAL_ONLY",
  smsTemplateCodes: ["LOGIN_MFA", "PASSWORD_RESET"],
  staffSmsFallbackWhenEmailMissing: true,
};

const defaultSecrets = () =>
  new Map<string, Map<string, string>>([
    ["communication.email", new Map([["smtpPassword", "secret"]])],
    ["communication.sms", new Map([["webhookSecret", "secret"]])],
  ]);

const config = (rows: ReturnType<typeof row>[], secrets = defaultSecrets()) =>
  buildCommunicationConfiguration(rows, secrets);

describe("communication configuration merge", () => {
  test("email is unconfigured with no settings and runtime reports maintenance", async () => {
    __resetCommunicationSettingsForTests();
    const value = config([]);
    expect(value.email.configured).toBe(false);
    expect(value.email.enabled).toBe(false);
    expect(value.email.missingFields).toContain("smtpHost");
    const status = await communicationStatus({
      platformSetting: { findMany: async () => [] },
      communicationChannelStatus: {
        findMany: async () => [],
        upsert: async () => undefined,
      },
    });
    expect(status.maintenance?.code).toBe("EMAIL_NOT_CONFIGURED");
  });

  test("an explicit admin setting wins over the environment default", () => {
    const value = config([
      row("communication.email", baseEmail),
      row("communication.sms", baseSms),
      row("communication.policy", policy),
    ], defaultSecrets());
    expect(value.email.enabled).toBe(true);
    expect(value.email.configured).toBe(true);
    expect(value.email.smtpPassword).toBe("secret");
    expect(value.sms.configured).toBe(true);
    expect(value.policy.smsMode).toBe("CRITICAL_ONLY");
  });

  test("an explicit enabled=false disables the channel even when the deployment enables it", () => {
    const value = config([row("communication.email", { ...baseEmail, enabled: false })]);
    expect(value.email.enabled).toBe(false);
    expect(value.email.configured).toBe(false);
  });

  test("missing SMTP credentials are reported, not guessed", () => {
    const value = config([row("communication.email", { ...baseEmail, smtpUsername: "user", smtpPassword: undefined })]);
    expect(value.email.configured).toBe(true); // password may come from the secret row or env
    const missing = config([row("communication.email", { ...baseEmail, smtpHost: "" })]);
    expect(missing.email.configured).toBe(false);
    expect(missing.email.missingFields).toContain("smtpHost");
  });
});

describe("channel policy", () => {
  const value = () => config([
    row("communication.email", baseEmail),
    row("communication.sms", baseSms),
    row("communication.policy", policy),
  ]);

  test("auth OTP goes to email and SMS when both are configured", () => {
    const delivery = resolveOtpDelivery(value(), { email: "merchant@example.test", phone: "+218911234567" }, {
      channel: "MERCHANT",
      purpose: "LOGIN_MFA",
    });
    expect(delivery.channels).toEqual(["EMAIL", "SMS"]);
    expect(delivery.destinationMasked.email).toBe("me***@example.test");
    expect(delivery.destinationMasked.phone).toBe("*******4567");
  });

  test("SMS alone is used for staff when email is not configured", () => {
    const smsOnly = config([
      row("communication.sms", baseSms),
      row("communication.policy", policy),
    ]);
    const delivery = resolveOtpDelivery(smsOnly, { email: null, phone: "+218911234567" }, {
      channel: "ADMIN",
      purpose: "LOGIN_MFA",
    });
    expect(delivery.channels).toEqual(["SMS"]);
  });

  test("a merchant recipient without an email address falls back to SMS when configured", () => {
    const delivery = resolveOtpDelivery(value(), { email: null, phone: "+218911234567" }, {
      channel: "MERCHANT",
      purpose: "LOGIN_MFA",
    });
    expect(delivery.channels).toEqual(["SMS"]);
  });

  test("SMS mode OFF disables the second channel", () => {
    const off = config([
      row("communication.email", baseEmail),
      row("communication.sms", baseSms),
      row("communication.policy", { ...policy, smsMode: "OFF" }),
    ]);
    expect(shouldSendSms(off.policy, "LOGIN_MFA", true)).toBe(false);
    const delivery = resolveOtpDelivery(off, { email: "merchant@example.test", phone: "+218911234567" }, {
      channel: "MERCHANT",
      purpose: "LOGIN_MFA",
    });
    expect(delivery.channels).toEqual(["EMAIL"]);
  });

  test("transactional notices do not use SMS under CRITICAL_ONLY", () => {
    expect(shouldSendSms(value().policy, "PAYMENT_SUCCEEDED", true)).toBe(false);
    expect(shouldSendSms(value().policy, "LOGIN_MFA", true)).toBe(true);
  });
});

describe("address helpers", () => {
  test("synthetic placeholder addresses are not deliverable", () => {
    expect(hasRealEmail("merchant@example.test")).toBe(true);
    expect(hasRealEmail("merchant@pending.payment-gateway.local")).toBe(false);
    expect(hasRealEmail("merchant@invited.payment-gateway.local")).toBe(false);
    expect(hasRealEmail("not-an-email")).toBe(false);
  });

  test("masks keep only the minimum needed for the operator", () => {
    expect(maskEmailAddress("merchant@example.test")).toBe("me***@example.test");
    expect(maskPhoneNumber("+218911234567")).toBe("*******4567");
  });
});
