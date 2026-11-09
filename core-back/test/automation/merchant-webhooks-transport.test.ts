/**
 * AUTO-34 transport: the Standard Webhooks signature (sign, verify, tolerance, two secrets), the URL rules, address
 * pinning against a real local HTTP server, redirects not followed, timeouts and the private-address block.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  buildWebhookHeaders,
  generateWebhookSecret,
  signWebhookWithSecret,
  verifyWebhook,
  WEBHOOK_SECRET_PREFIX,
} from "../../lib/webhooks/standardWebhooks";
import { postPinned, resolvePinnedAddress, validateWebhookUrl, WebhookEgressError } from "../../lib/webhooks/egress";

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

describe("Standard Webhooks signatures", () => {
  const secret = `${WEBHOOK_SECRET_PREFIX}${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
  const body = JSON.stringify({ id: "evt_1", type: "payment.succeeded", data: { amount: "10.0000" } });

  test("the signature is base64 HMAC-SHA256 over id.timestamp.body keyed with the decoded secret", () => {
    const signature = signWebhookWithSecret({ id: "evt_1", timestampSeconds: 1_700_000_000, body, secret });
    const expected = createHmac("sha256", Buffer.from("0123456789abcdef0123456789abcdef")).update(`evt_1.1700000000.${body}`).digest("base64");
    expect(signature).toBe(`v1,${expected}`);
  });

  test("a generated secret has the whsec_ prefix and 32 random bytes; two are never equal", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.startsWith("whsec_")).toBe(true);
    expect(Buffer.from(a.slice(6), "base64")).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(() => signWebhookWithSecret({ id: "x", timestampSeconds: 1, body: "{}", secret: "not-a-secret" })).toThrow(/whsec_/);
    expect(() => signWebhookWithSecret({ id: "x", timestampSeconds: 1, body: "{}", secret: "whsec_AAAA" })).toThrow(/16 key bytes/);
  });

  test("a receiver verifies the headers; a changed body, id, timestamp or secret fails", () => {
    const now = new Date(1_700_000_100 * 1000);
    const headers = buildWebhookHeaders({ id: "evt_1", timestampSeconds: 1_700_000_000, body, secrets: [secret] });
    expect(verifyWebhook({ headers, body, secrets: [secret], now })).toBe(true);
    expect(verifyWebhook({ headers, body: body + " ", secrets: [secret], now })).toBe(false);
    expect(verifyWebhook({ headers: { ...headers, "webhook-id": "evt_2" }, body, secrets: [secret], now })).toBe(false);
    expect(verifyWebhook({ headers: { ...headers, "webhook-timestamp": "1700000001" }, body, secrets: [secret], now })).toBe(false);
    expect(verifyWebhook({ headers, body, secrets: [generateWebhookSecret()], now })).toBe(false);
    expect(verifyWebhook({ headers: { ...headers, "webhook-signature": "" }, body, secrets: [secret], now })).toBe(false);
    expect(verifyWebhook({ headers: { ...headers, "webhook-timestamp": "abc" }, body, secrets: [secret], now })).toBe(false);
  });

  test("replay protection: a timestamp outside the tolerance is rejected in both directions", () => {
    const headers = buildWebhookHeaders({ id: "evt_1", timestampSeconds: 1_700_000_000, body, secrets: [secret] });
    expect(verifyWebhook({ headers, body, secrets: [secret], now: new Date((1_700_000_000 + 299) * 1000) })).toBe(true);
    expect(verifyWebhook({ headers, body, secrets: [secret], now: new Date((1_700_000_000 + 301) * 1000) })).toBe(false);
    expect(verifyWebhook({ headers, body, secrets: [secret], now: new Date((1_700_000_000 - 301) * 1000) })).toBe(false);
    expect(verifyWebhook({ headers, body, secrets: [secret], now: new Date((1_700_000_000 + 3000) * 1000), toleranceSeconds: 3600 })).toBe(true);
  });

  test("during a rotation the request carries two signatures and either secret verifies it", () => {
    const next = generateWebhookSecret();
    const headers = buildWebhookHeaders({ id: "evt_1", timestampSeconds: 1_700_000_000, body, secrets: [next, secret] });
    expect((headers["webhook-signature"] ?? "").split(" ")).toHaveLength(2);
    const now = new Date(1_700_000_001 * 1000);
    expect(verifyWebhook({ headers, body, secrets: [secret], now })).toBe(true); // the merchant still on the old secret
    expect(verifyWebhook({ headers, body, secrets: [next], now })).toBe(true); // and the one that switched
    expect(() => buildWebhookHeaders({ id: "x", timestampSeconds: 1, body: "{}", secrets: [] })).toThrow();
  });
});

describe("destination URL rules", () => {
  test("HTTPS only, no credentials, no fragments, no private or local hosts", () => {
    expect(validateWebhookUrl("https://shop.example.ly/hooks/pay?x=1").hostname).toBe("shop.example.ly");
    const rejected: Array<[string, string]> = [
      ["http://shop.example.ly/hook", "INSECURE_URL"],
      ["ftp://shop.example.ly/hook", "INSECURE_URL"],
      ["https://user:pw@shop.example.ly/hook", "URL_USERINFO"],
      ["https://shop.example.ly/hook#frag", "URL_FRAGMENT"],
      ["https://localhost/hook", "PRIVATE_HOST"],
      ["https://api.localhost/hook", "PRIVATE_HOST"],
      ["https://printer.local/hook", "PRIVATE_HOST"],
      ["https://db.internal/hook", "PRIVATE_HOST"],
      ["https://127.0.0.1/hook", "PRIVATE_HOST"],
      ["https://10.1.2.3/hook", "PRIVATE_HOST"],
      ["https://192.168.0.5/hook", "PRIVATE_HOST"],
      ["https://169.254.169.254/latest/meta-data", "PRIVATE_HOST"],
      ["https://[::1]/hook", "PRIVATE_HOST"],
      ["not a url", "INVALID_URL"],
      ["", "INVALID_URL"],
      ["https://shop.example.ly/ho ok", "INVALID_URL"],
    ];
    for (const [url, code] of rejected) {
      const error = (() => {
        try {
          validateWebhookUrl(url);
          return null;
        } catch (caught) {
          return caught as WebhookEgressError;
        }
      })();
      expect(error?.code, url).toBe(code);
      expect(error?.retryable, url).toBe(false);
    }
  });

  test("development mode (allowInsecure) accepts http and local hosts", () => {
    expect(validateWebhookUrl("http://127.0.0.1:9000/hook", { allowInsecure: true }).port).toBe("9000");
    expect(validateWebhookUrl("http://localhost:9000/hook", { allowInsecure: true }).hostname).toBe("localhost");
  });
});

describe("address pinning", () => {
  test("every resolved address must be public; the first is pinned", async () => {
    expect(await resolvePinnedAddress("shop.example.ly", { resolver: async () => ["93.184.216.34", "93.184.216.35"] })).toEqual({ address: "93.184.216.34", family: 4 });
    expect((await resolvePinnedAddress("shop.example.ly", { resolver: async () => ["2606:2800:220:1:248:1893:25c8:1946"] })).family).toBe(6);
    // one private address among public ones is enough to refuse (DNS rebinding with a mixed answer)
    const mixed = await resolvePinnedAddress("shop.example.ly", { resolver: async () => ["93.184.216.34", "10.0.0.7"] }).catch((e) => e);
    expect(mixed).toBeInstanceOf(WebhookEgressError);
    expect(mixed.code).toBe("PRIVATE_HOST");
    expect(mixed.retryable).toBe(false);
    const empty = await resolvePinnedAddress("shop.example.ly", { resolver: async () => [] }).catch((e) => e);
    expect(empty.code).toBe("DNS_FAILURE");
    expect(empty.retryable).toBe(true);
    const failing = await resolvePinnedAddress("shop.example.ly", { resolver: async () => { throw new Error("ENOTFOUND"); } }).catch((e) => e);
    expect(failing.code).toBe("DNS_FAILURE");
  });

  const listen = async (handler: (request: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; delayMs?: number } | Promise<{ status: number; headers?: Record<string, string>; delayMs?: number }>): Promise<number> => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", async () => {
        const result = await handler(request, Buffer.concat(chunks).toString("utf8"));
        setTimeout(() => {
          response.writeHead(result.status, result.headers);
          response.end("ok");
        }, result.delayMs ?? 0);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as { port: number }).port;
  };

  test("the request goes to the PINNED address (a host name that exists nowhere reaches the local server), with the signed headers and exact body", async () => {
    let seen: { headers: Record<string, string | string[] | undefined>; body: string; method: string | undefined; url: string | undefined } | null = null;
    const port = await listen((request, body) => {
      seen = { headers: request.headers, body, method: request.method, url: request.url };
      return { status: 204 };
    });
    let resolved = 0;
    const result = await postPinned({
      url: `http://hooks.merchant.example:${port}/pay?x=1`,
      body: '{"a":1}',
      headers: { "webhook-id": "evt_1", "webhook-timestamp": "1700000000", "webhook-signature": "v1,abc" },
      allowInsecure: true,
      resolver: async () => {
        resolved += 1;
        return ["127.0.0.1"];
      },
    });
    expect(result.status).toBe(204);
    expect(resolved).toBe(1); // resolved exactly once: nothing re-resolves between the check and the connect
    expect(seen!.method).toBe("POST");
    expect(seen!.url).toBe("/pay?x=1");
    expect(seen!.body).toBe('{"a":1}');
    expect(seen!.headers["webhook-id"]).toBe("evt_1");
    expect(seen!.headers["webhook-signature"]).toBe("v1,abc");
    expect(seen!.headers["content-type"]).toBe("application/json");
    expect(String(seen!.headers["user-agent"])).toContain("PaymentGateway-Webhooks");
    expect(String(seen!.headers.host)).toBe(`hooks.merchant.example:${port}`);
  });

  test("a redirect is reported as its status and never followed", async () => {
    let hits = 0;
    const port = await listen((request) => {
      hits += 1;
      return request.url === "/moved" ? { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } } : { status: 200 };
    });
    const result = await postPinned({ url: `http://127.0.0.1:${port}/moved`, body: "{}", headers: {}, allowInsecure: true });
    expect(result.status).toBe(302);
    expect(hits).toBe(1);
  });

  test("an endpoint that does not answer in time is a retryable timeout; a refused connection is a retryable network error", async () => {
    const port = await listen(() => ({ status: 200, delayMs: 1500 }));
    const slow = await postPinned({ url: `http://127.0.0.1:${port}/`, body: "{}", headers: {}, allowInsecure: true, timeoutMs: 150 }).catch((e) => e);
    expect(slow).toBeInstanceOf(WebhookEgressError);
    expect(slow.code).toBe("TIMEOUT");
    expect(slow.retryable).toBe(true);
    const refused = await postPinned({ url: "http://127.0.0.1:1/", body: "{}", headers: {}, allowInsecure: true }).catch((e) => e);
    expect(refused.code).toBe("NETWORK");
    expect(refused.retryable).toBe(true);
  });

  test("outside development a private resolution is refused before any connection is made", async () => {
    let connected = false;
    const port = await listen(() => {
      connected = true;
      return { status: 200 };
    });
    const blocked = await postPinned({ url: `https://rebind.merchant.example:${port}/`, body: "{}", headers: {}, resolver: async () => ["127.0.0.1"] }).catch((e) => e);
    expect(blocked.code).toBe("PRIVATE_HOST");
    expect(blocked.retryable).toBe(false);
    expect(connected).toBe(false);
    const plainHttp = await postPinned({ url: `http://203.0.113.9:${port}/`, body: "{}", headers: {} }).catch((e) => e);
    expect(plainHttp.code).toBe("INSECURE_URL");
  });
});
