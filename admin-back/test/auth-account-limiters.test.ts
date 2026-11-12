import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { createAccountLimiters } from "../lib/authLimiters";
import { resetEnvCache } from "../lib/env";
import { CORE_SERVICE_NAME } from "../lib/coreInternalClient";
import { createTestPki } from "./helpers/core";

const pki = createTestPki(CORE_SERVICE_NAME);

/**
 * The per-account limiter used to be keyed on the account alone and to count every request, so anyone
 * who knew a victim's identifier could make the portal answer 429 to the real owner without guessing a
 * password. These tests pin the replacement: a per-address budget, an account-wide ceiling for guessing
 * spread over many addresses, and no cost for successful requests.
 */
const ENV_KEYS = ["CORE_BACK_URL", "CORE_BACK_URLS", "MTLS_CLIENT_CERT_PATH", "MTLS_CLIENT_KEY_PATH", "MTLS_CA_CERT_PATH"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const saved = {
  max: process.env.AUTH_RATE_LIMIT_MAX,
  window: process.env.AUTH_RATE_LIMIT_WINDOW_MS,
  proxies: process.env.TRUSTED_PROXY_CIDRS,
  node: process.env.NODE_ENV,
};
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let base = "";

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = "https://core.invalid:4000";
  process.env.CORE_BACK_URLS = "https://core.invalid:4000";
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.AUTH_RATE_LIMIT_MAX = "3";
  process.env.AUTH_RATE_LIMIT_WINDOW_MS = "600000";
  process.env.TRUSTED_PROXY_CIDRS = "127.0.0.1/32,::1/128";
  resetEnvCache();
  const limiters = createAccountLimiters((req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.challengeId === "string") return { kind: "challenge", value: body.challengeId };
    return typeof body.identifier === "string" ? { kind: "account", value: body.identifier.toLowerCase() } : undefined;
  });
  const app = express();
  app.use(express.json());
  app.post("/login", limiters.perAddress, limiters.ceiling, (req, res) => {
    res.status(req.body.password === "right" ? 200 : 401).json({});
  });
  server = app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  for (const [key, value] of [["AUTH_RATE_LIMIT_MAX", saved.max], ["AUTH_RATE_LIMIT_WINDOW_MS", saved.window], ["TRUSTED_PROXY_CIDRS", saved.proxies], ["NODE_ENV", saved.node]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetEnvCache();
});

const login = async (identifier: string, password: string, ip: string): Promise<number> =>
  (await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify({ identifier, password }),
  })).status;

describe("account limiters", () => {
  test("an attacker exhausting their own budget does not lock the owner out from another address", async () => {
    for (let i = 0; i < 3; i += 1) expect(await login("victim@example.com", "wrong", "203.0.113.66")).toBe(401);
    expect(await login("victim@example.com", "wrong", "203.0.113.66")).toBe(429);
    // The real owner, from their own address, can still sign in.
    expect(await login("victim@example.com", "right", "10.0.0.20")).toBe(200);
  });

  test("successful sign-ins never consume the budget", async () => {
    for (let i = 0; i < 10; i += 1) expect(await login("busy@example.com", "right", "10.0.0.30")).toBe(200);
    expect(await login("busy@example.com", "wrong", "10.0.0.30")).toBe(401);
  });

  test("guessing spread over many addresses still reaches the account-wide ceiling", async () => {
    // ceiling = 3 x 5 = 15 failed requests across addresses (3 per address, so 5 addresses fill it).
    for (let address = 1; address <= 5; address += 1) {
      for (let i = 0; i < 3; i += 1) expect(await login("target@example.com", "wrong", `198.51.100.${address}`)).toBe(401);
    }
    expect(await login("target@example.com", "wrong", "198.51.100.99")).toBe(429);
    expect(await login("target@example.com", "right", "198.51.100.100")).toBe(429);
    // Another account is unaffected.
    expect(await login("someone-else@example.com", "wrong", "198.51.100.99")).toBe(401);
  });
});

import { afterAll as afterAllCleanup } from "bun:test";
afterAllCleanup(() => { delete process.env.CORE_BACK_URLS; }); // CLEANUP_CORE_BACK_URLS
