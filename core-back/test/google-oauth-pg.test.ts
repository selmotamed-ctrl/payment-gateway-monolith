import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { client } from "../prisma/client";
import { Vault } from "../engine/crypto/Vault";
import {
  exchangeGoogleLoginTicket,
  handleGoogleCallback,
  startGoogleOAuth,
} from "../lib/auth/googleOAuth";
import { __resetCommunicationSettingsForTests } from "../lib/communication/settings";

/**
 * Google OAuth state/PKCE/ticket flow against the real schema. Token verification is injected; the test proves the
 * one-time state, the one-time login ticket and the new merchant provisioning, not Google's cryptography.
 */

const EMAIL = `google-${randomUUID()}@example.test`;
const vault = new Vault();

beforeAll(async () => {
  await client.platformSetting.deleteMany({ where: { key: "auth.google", version: 9002 } });
  await client.platformSetting.create({
    data: {
      key: "auth.google",
      scope: "PLATFORM",
      version: 9002,
      valueJson: {
        enabled: true,
        clientId: "client-id.apps.googleusercontent.com",
        redirectUri: "https://merchant.example.test/api/v1/merchant/auth/google/callback",
        hostedDomain: "",
      },
      source: "ADMIN",
      effectiveFrom: new Date(),
    },
  });
  await client.$executeRawUnsafe(
    `INSERT INTO platform_setting_secrets (id, updated_at, key, scope, version, field, ciphertext)
     VALUES ($1::uuid, now(), 'auth.google', 'PLATFORM', 9002, 'clientSecret', $2)
     ON CONFLICT (key, scope, version, field) DO UPDATE SET ciphertext = EXCLUDED.ciphertext`,
    randomUUID(),
    await vault.encryptSecret("google-client-secret", "platform-setting-secret"),
  );
  __resetCommunicationSettingsForTests();
});

afterAll(async () => {
  await client.platformSettingSecret.deleteMany({ where: { version: 9002 } });
  await client.platformSetting.deleteMany({ where: { version: 9002 } });
  __resetCommunicationSettingsForTests();
});

describe("Google OAuth", () => {
  test("a registration creates the merchant and issues a single-use ticket", async () => {
    const start = await startGoogleOAuth(client as never, {
      mode: "register",
      returnPath: "/register",
      ip: "127.0.0.1",
    });
    expect(start.authorizationUrl).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(start.authorizationUrl).toContain("code_challenge_method=S256");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    const result = await handleGoogleCallback(client as never, {
      code: "authorization-code",
      state: state!,
      ip: "127.0.0.1",
      fetchImpl: (async () => new Response(JSON.stringify({ id_token: "fake-id-token" }), { status: 200 })) as unknown as typeof fetch,
      verifier: {
        verify: async () => ({
          sub: `google-sub-${EMAIL}`,
          email: EMAIL,
          emailVerified: true,
          hostedDomain: null,
          name: "Google Merchant",
        }),
      },
    });
    expect(result.redirectPath).toContain("/auth/google/finish?ticket=");
    const ticket = new URL(`https://example.test${result.redirectPath}`).searchParams.get("ticket");
    expect(ticket).toBeTruthy();
    const user = await exchangeGoogleLoginTicket(client as never, { ticket: ticket! });
    expect(user.email).toBe(EMAIL);
    expect(user.merchantId).toBeTruthy();
    const identity = await client.userIdentity.findFirst({ where: { userId: user.id, kind: "GOOGLE" } });
    expect(identity?.providerSubject).toBe(`google-sub-${EMAIL}`);
    expect(identity?.verifiedAt).not.toBeNull();
    await expect(exchangeGoogleLoginTicket(client as never, { ticket: ticket! })).rejects.toThrow("GOOGLE_TICKET_INVALID");
  });

  test("the state is single-use", async () => {
    const start = await startGoogleOAuth(client as never, {
      mode: "login",
      returnPath: "/login",
      ip: "127.0.0.1",
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const first = await handleGoogleCallback(client as never, {
      code: "authorization-code",
      state,
      ip: "127.0.0.1",
      fetchImpl: (async () => new Response(JSON.stringify({ id_token: "fake-id-token" }), { status: 200 })) as unknown as typeof fetch,
      verifier: {
        verify: async () => ({
          sub: `google-sub-${EMAIL}`,
          email: EMAIL,
          emailVerified: true,
          hostedDomain: null,
          name: "Google Merchant",
        }),
      },
    });
    expect(first.redirectPath).toBeTruthy();
    const second = await handleGoogleCallback(client as never, {
      code: "authorization-code",
      state,
      ip: "127.0.0.1",
      fetchImpl: (async () => new Response(JSON.stringify({ id_token: "fake-id-token" }), { status: 200 })) as unknown as typeof fetch,
      verifier: {
        verify: async () => ({
          sub: `google-sub-${EMAIL}`,
          email: EMAIL,
          emailVerified: true,
          hostedDomain: null,
          name: "Google Merchant",
        }),
      },
    });
    expect(second.errorCode).toBe("GOOGLE_STATE_INVALID");
  });
});
