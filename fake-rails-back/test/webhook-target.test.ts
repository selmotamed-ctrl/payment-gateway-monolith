import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";

/**
 * SSRF: a webhook may only go to an allowed host. The target used to be copied from the request body and
 * fetched as given, with redirects followed and the response stored where testers read it.
 */
const dbPath = `/tmp/fake-rails-webhook-target-${process.pid}-${Date.now()}.sqlite`;
process.env.NODE_ENV = "test";
process.env.FAKE_RAILS_ADMIN_USER = "tester_admin";
process.env.FAKE_RAILS_ADMIN_PASSWORD = "Strong-Tester-Pass-2026!";
process.env.FAKE_RAILS_JWT_SECRET = "jwt-Rk7Qm2Xv9Lp4Zn8Bc3Wd6Th1Yg5Js0Af";
process.env.FAKE_RAILS_SEEDER_TOKEN = "seed-Hv3Tn8Yq1Dz6Mk4Pw9Xc2Lb7Rg5Fj0Ua";
process.env.FAKE_RAILS_DATA_DIR = "/tmp/fake-rails-webhook-target-data";
process.env.FAKE_RAILS_DB_PATH = dbPath;
process.env.FAKE_RAILS_PUBLIC_BASE_URL = "http://127.0.0.1:8444";
process.env.FAKE_RAILS_WEBHOOK_TIMEOUT_MS = "500";
process.env.CORE_INBOUND_BASE_URL = "http://core.lab.internal:4103/api/v1/inbound";
process.env.FAKE_RAILS_WEBHOOK_ALLOWED_HOSTS = "receiver.lab.internal, hook.lab.internal:9443";

let app: Server;
let baseUrl = "";
let closeDb: () => void = () => undefined;
let victim: Server;
let victimHits: string[] = [];
let victimPort = 0;

beforeAll(async () => {
  victim = createServer((request, response) => {
    victimHits.push(request.url ?? "");
    response.writeHead(200).end("secret internal answer");
  });
  await new Promise<void>((resolve) => victim.listen(0, "127.0.0.1", resolve));
  victimPort = (victim.address() as { port: number }).port;
  const { createApp } = await import("../index");
  const db = await import("../engine/db");
  closeDb = db.closeDb;
  app = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => app.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
});

afterAll(() => {
  app?.close();
  victim?.close();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
});

describe("webhook target allowlist (pure)", () => {
  test("only allowed hosts, plain http(s) and no credentials pass", async () => {
    const { webhookTargetAllowed, allowedWebhookHosts } = await import("../lib/webhookTarget");
    expect(allowedWebhookHosts().sort()).toEqual(["core.lab.internal:4103", "hook.lab.internal:9443", "receiver.lab.internal"]);
    for (const ok of [
      "http://core.lab.internal:4103/api/v1/inbound/webhook/x",
      "https://receiver.lab.internal/hook",
      "http://receiver.lab.internal:8080/hook",
      "https://hook.lab.internal:9443/a",
    ]) expect([ok, webhookTargetAllowed(ok)]).toEqual([ok, true]);
    for (const bad of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:4000/internal",
      "http://localhost/admin",
      "http://[::1]/",
      "http://core.lab.internal:4999/other-port",
      "http://hook.lab.internal:9444/wrong-port",
      "http://user:pass@receiver.lab.internal/hook",
      "http://receiver.lab.internal.evil.example/hook",
      "http://evil.example/?receiver.lab.internal",
      "file:///etc/passwd",
      "ftp://receiver.lab.internal/x",
      "javascript:alert(1)",
      "not a url",
      "",
    ]) expect([bad, webhookTargetAllowed(bad)]).toEqual([bad, false]);
  });
});

describe("webhook_url on a rails initiate request", () => {
  const initiate = (webhookUrl: string | undefined, reference: string) =>
    fetch(`${baseUrl}/rails/tlync/payment/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference, amount: "10.00", return_url: "https://merchant.test/return", ...(webhookUrl ? { webhook_url: webhookUrl } : {}) }),
    });

  test("an internal or metadata target is refused and nothing is stored or fetched", async () => {
    victimHits = [];
    for (const target of [`http://127.0.0.1:${victimPort}/internal`, "http://169.254.169.254/latest/meta-data/", "http://localhost:1/x"]) {
      const response = await initiate(target, `SSRF-${Math.random().toString(36).slice(2, 8)}`);
      expect([target, response.status]).toEqual([target, 400]);
      expect(((await response.json()) as { code?: string }).code).toBe("WEBHOOK_URL_NOT_ALLOWED");
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(victimHits).toEqual([]);
  });

  test("a request without a webhook_url, or with an allowed host, is accepted", async () => {
    expect((await initiate(undefined, `OK-${Math.random().toString(36).slice(2, 8)}`)).status).toBeLessThan(300);
    expect((await initiate("http://receiver.lab.internal/hook", `OK-${Math.random().toString(36).slice(2, 8)}`)).status).toBeLessThan(300);
  });
});

describe("the dispatcher re-checks the target at send time", () => {
  test("a stored delivery pointing at a forbidden host is failed without any request", async () => {
    const { getDb, uuidv7, nowIso } = await import("../engine/db");
    const { webhookDispatcher } = await import("../engine/webhooks/WebhookDispatcher");
    victimHits = [];
    const id = uuidv7();
    getDb()
      .prepare(
        `INSERT INTO fake_webhook_deliveries
           (id, transaction_id, gateway_code, url, request_headers_json, request_body_raw, attempt, max_attempts, state, scheduled_for, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 3, 'QUEUED', ?, ?)`,
      )
      .run(id, "t-1", "tlync", `http://127.0.0.1:${victimPort}/pwned`, "{}", "{}", nowIso(), nowIso());
    const row = await webhookDispatcher.send(id);
    expect(row?.state).toBe("FAILED");
    expect(victimHits).toEqual([]);
  });
});
