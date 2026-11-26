import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { merchantInternalRouter } from "../api/internal/merchant";
import { toErrorEnvelope } from "../lib/error";
import { client } from "../prisma/client";
import { Vault } from "../engine/crypto/Vault";
import { openMfaCode } from "../lib/auth/mfaChallenges";
import { __resetCommunicationSettingsForTests } from "../lib/communication/settings";

/**
 * End-to-end authentication communication on the real PostgreSQL schema:
 * registration -> e-mail verification -> password login -> e-mail + SMS OTP -> password reset.
 * No provider is called: the outbox rows are inspected and their sealed codes opened with the Vault.
 */

const EMAIL = `communication-${randomUUID()}@example.test`;
const PASSWORD = "CorrectHorseBattery1!";
const NEW_PASSWORD = "CorrectHorseBattery2!";
const vault = new Vault();
let server: Server;
let baseUrl = "";
let userId = "";

const setting = (key: string, value: unknown) => ({
  key,
  scope: "PLATFORM" as const,
  version: 9001,
  valueJson: value as never,
  source: "ADMIN",
  effectiveFrom: new Date(),
});

const post = async (path: string, body: unknown) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
};

const latestCode = async (templateCode: string, channel: "EMAIL" | "SMS") => {
  const notification = await client.notification.findFirst({
    where: { recipientUserId: userId, templateCode, channel },
    orderBy: { createdAt: "desc" },
  });
  expect(notification).not.toBeNull();
  const payload = notification!.payloadJson as Record<string, unknown>;
  expect(typeof payload.codeCiphertext).toBe("string");
  return openMfaCode(String(payload.codeCiphertext));
};

beforeAll(async () => {
  await client.platformSetting.deleteMany({
    where: { key: { in: ["communication.email", "communication.sms", "communication.policy"] }, version: 9001 },
  });
  await client.platformSetting.createMany({
    data: [
      setting("communication.email", {
        enabled: true,
        provider: "SMTP",
        smtpHost: "127.0.0.1",
        smtpPort: 2525,
        smtpSecurity: "NONE",
        fromEmail: "no-reply@example.test",
        fromName: "Payment Gateway",
        timeoutMs: 5000,
      }),
      setting("communication.sms", {
        enabled: true,
        provider: "WEBHOOK",
        webhookUrl: "https://sms.example.test/send",
        senderId: "PG",
        timeoutMs: 5000,
      }),
      setting("communication.policy", {
        smsMode: "ALL",
        smsTemplateCodes: ["LOGIN_MFA", "PASSWORD_RESET", "EMAIL_VERIFICATION"],
        staffSmsFallbackWhenEmailMissing: true,
      }),
    ],
  });
  await client.$executeRawUnsafe(
    `INSERT INTO platform_setting_secrets (id, updated_at, key, scope, version, field, ciphertext)
     VALUES ($1::uuid, now(), 'communication.sms', 'PLATFORM', 9001, 'webhookSecret', $2)
     ON CONFLICT (key, scope, version, field) DO UPDATE SET ciphertext = EXCLUDED.ciphertext`,
    randomUUID(),
    await vault.encryptSecret("sms-secret", "platform-setting-secret"),
  );
  __resetCommunicationSettingsForTests();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/internal/merchant", merchantInternalRouter);
  app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error?.statusCode ?? 500).json(toErrorEnvelope(error));
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await client.platformSettingSecret.deleteMany({ where: { version: 9001 } });
  await client.platformSetting.deleteMany({ where: { version: 9001 } });
  __resetCommunicationSettingsForTests();
});

describe("communication auth flows", () => {
  test("register requires no phone and queues an e-mail verification code", async () => {
    const created = await post("/internal/merchant/auth/register", {
      fullName: "Communication Merchant",
      email: EMAIL,
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
    expect(created.body.verificationRequired).toBe(true);
    expect(created.body.deliveryChannels).toEqual(["EMAIL"]);
    userId = String(created.body.userId);
    const user = await client.user.findUnique({ where: { id: userId } });
    expect(user?.phone).toBeNull();
    expect(user?.email).toBe(EMAIL);
    const identity = await client.userIdentity.findFirst({ where: { userId, kind: "EMAIL" } });
    expect(identity?.verifiedAt).toBeNull();
  });

  test("login before verification is refused with EMAIL_NOT_VERIFIED", async () => {
    const result = await post("/internal/merchant/auth/login", { identifier: EMAIL, password: PASSWORD });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("EMAIL_NOT_VERIFIED");
  });

  test("the e-mail code verifies the identity and the notification carries the real address, never the mask", async () => {
    const code = await latestCode("EMAIL_VERIFICATION", "EMAIL");
    const notification = await client.notification.findFirst({
      where: { recipientUserId: userId, templateCode: "EMAIL_VERIFICATION", channel: "EMAIL" },
      orderBy: { createdAt: "desc" },
    });
    expect(await vault.decryptSecret(String(notification!.addressCiphertext))).toBe(EMAIL);
    expect(notification!.addressMasked).not.toBe(EMAIL);
    const verified = await post("/internal/merchant/auth/email/verify", { email: EMAIL, code });
    expect(verified.status).toBe(200);
    expect(verified.body.verified).toBe(true);
    const identity = await client.userIdentity.findFirst({ where: { userId, kind: "EMAIL" } });
    expect(identity?.verifiedAt).not.toBeNull();
  });

  test("password login sends one code to e-mail and, once a phone exists, also to SMS", async () => {
    await client.user.update({ where: { id: userId }, data: { phone: "+218911234567" } });
    const login = await post("/internal/merchant/auth/login", { identifier: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(new Set(login.body.deliveryChannels)).toEqual(new Set(["EMAIL", "SMS"]));
    const emailCode = await latestCode("LOGIN_MFA", "EMAIL");
    const smsCode = await latestCode("LOGIN_MFA", "SMS");
    expect(smsCode).toBe(emailCode);
    const verified = await post("/internal/merchant/auth/mfa/verify", {
      challengeId: login.body.challengeId,
      code: emailCode,
    });
    expect(verified.status).toBe(200);
    expect(typeof verified.body.token).toBe("string");
  });

  test("password reset uses the same e-mail + SMS code and invalidates old sessions", async () => {
    const forgot = await post("/internal/merchant/auth/password/forgot", { email: EMAIL });
    expect(forgot.status).toBe(202);
    const emailCode = await latestCode("PASSWORD_RESET", "EMAIL");
    const smsCode = await latestCode("PASSWORD_RESET", "SMS");
    expect(smsCode).toBe(emailCode);
    const reset = await post("/internal/merchant/auth/password/reset", {
      email: EMAIL,
      code: emailCode,
      newPassword: NEW_PASSWORD,
    });
    expect(reset.status).toBe(200);
    const user = await client.user.findUnique({ where: { id: userId }, select: { sessionsInvalidBefore: true, passwordHash: true } });
    expect(user?.sessionsInvalidBefore).not.toBeNull();
    expect(user?.passwordHash).not.toBeNull();
    const oldLogin = await post("/internal/merchant/auth/login", { identifier: EMAIL, password: PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await post("/internal/merchant/auth/login", { identifier: EMAIL, password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.mfaRequired).toBe(true);
  });
});
