import { describe, expect, test } from "bun:test";
import {
  ApiConsumer,
  ApiConsumerError,
  isPublicIpAddress,
  isAuthenticationError,
} from "../../engine/apiConsumer/ApiConsumer";
import { ConsumerRegistry } from "../../engine/apiConsumer/ConsumerRegistry";
import { InvalidationBus } from "../../lib/invalidationBus";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const baseConfig = (overrides: Record<string, unknown> = {}) => ({
  gatewayId: "gw-1",
  env: "SANDBOX",
  credentialSetId: "cs-1",
  allowedHosts: ["gateway.example.com"],
  auth: { method: "NONE" as const },
  dnsLookup: async () => ["93.184.216.34"],
  ...overrides,
});

describe("ApiConsumer authentication methods", () => {
  test("NONE sends no credential", async () => {
    let seen: { url: string; headers: Headers } | undefined;
    const consumer = new ApiConsumer({
      ...baseConfig(),
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, headers: new Headers(init.headers) };
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await consumer.request({ method: "GET", url: "https://gateway.example.com/ping" });
    expect(seen?.headers.get("authorization")).toBeNull();
  });

  test("API_KEY applies the key as a header", async () => {
    let seen: Headers | undefined;
    const consumer = new ApiConsumer({
      ...baseConfig({
        auth: { method: "API_KEY" as const, header_name: "X-API-KEY" },
        credentials: { apiKey: "key-123" },
      }),
      fetch: (async (_url: string, init: RequestInit) => {
        seen = new Headers(init.headers);
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await consumer.request({ method: "GET", url: "https://gateway.example.com/ping" });
    expect(seen?.get("x-api-key")).toBe("key-123");
  });

  test("PERMANENT_TOKEN applies a bearer token", async () => {
    let seen: Headers | undefined;
    const consumer = new ApiConsumer({
      ...baseConfig({
        auth: { method: "PERMANENT_TOKEN" as const },
        credentials: { token: "tok-1" },
      }),
      fetch: (async (_url: string, init: RequestInit) => {
        seen = new Headers(init.headers);
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await consumer.request({ method: "GET", url: "https://gateway.example.com/ping" });
    expect(seen?.get("authorization")).toBe("Bearer tok-1");
  });

  test("BASIC applies base64 credentials", async () => {
    let seen: Headers | undefined;
    const consumer = new ApiConsumer({
      ...baseConfig({
        auth: { method: "BASIC" as const },
        credentials: { username: "user", password: "pass" },
      }),
      fetch: (async (_url: string, init: RequestInit) => {
        seen = new Headers(init.headers);
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await consumer.request({ method: "GET", url: "https://gateway.example.com/ping" });
    expect(seen?.get("authorization")).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
  });

  test("REQUEST_SIGNATURE signs the timestamp and body", async () => {
    let seen: Headers | undefined;
    const consumer = new ApiConsumer({
      ...baseConfig({
        auth: { method: "REQUEST_SIGNATURE" as const, signature_header: "X-Signature", timestamp_header: "X-Timestamp" },
        credentials: { secret: "sig-secret" },
      }),
      fetch: (async (_url: string, init: RequestInit) => {
        seen = new Headers(init.headers);
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await consumer.request({
      method: "POST",
      url: "https://gateway.example.com/pay",
      body: { amount: "100" },
    });
    const timestamp = seen?.get("x-timestamp") ?? "";
    const signature = seen?.get("x-signature") ?? "";
    expect(timestamp.length).toBeGreaterThan(0);
    expect(signature).toHaveLength(64);
  });

  test("TOKEN_ENDPOINT obtains and applies an access token", async () => {
    const seen: string[] = [];
    const consumer = new ApiConsumer({
      ...baseConfig({
        auth: { method: "TOKEN_ENDPOINT" as const, token_endpoint: "https://gateway.example.com/token" },
        credentials: { clientId: "id", clientSecret: "secret" },
      }),
      fetch: (async (url: string, init: RequestInit) => {
        seen.push(url);
        if (url.endsWith("/token")) {
          return jsonResponse({ access_token: "access-1", expires_in: 600 });
        }
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const response = await consumer.request({ method: "GET", url: "https://gateway.example.com/ping" });
    expect(response.data).toEqual({ ok: true });
    expect(seen[0]).toContain("/token");
    expect(consumer.auth?.accessToken).toBe("access-1");
  });

  test("OAUTH2_CLIENT_CREDENTIALS requests a client credentials token", async () => {
    let tokenBody = "";
    const consumer = new ApiConsumer({
      ...baseConfig({
        auth: { method: "OAUTH2_CLIENT_CREDENTIALS" as const, token_endpoint: "https://gateway.example.com/oauth/token" },
        credentials: { clientId: "id", clientSecret: "secret" },
      }),
      fetch: (async (url: string, init: RequestInit) => {
        if (url.endsWith("/oauth/token")) {
          tokenBody = String(init.body ?? "");
          return jsonResponse({ access_token: "access-2", expires_in: 600 });
        }
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await consumer.request({ method: "GET", url: "https://gateway.example.com/ping" });
    expect(tokenBody).toContain("grant_type=client_credentials");
  });

  test("REFRESH_TOKEN rotates and persists the refresh token before resolving", async () => {
    const persisted: string[] = [];
    let tokenCalls = 0;
    const consumer = new ApiConsumer({
      ...baseConfig({
        auth: {
          method: "REFRESH_TOKEN" as const,
          refresh_url: "https://gateway.example.com/refresh",
          new_refresh_token_selector: "refresh_token",
        },
        credentials: { refreshToken: "refresh-1" },
        rotatingRefreshTokenPersistence: async ({ newRefreshToken }: { newRefreshToken: string }) => {
          persisted.push(newRefreshToken);
        },
      }),
      fetch: (async (url: string) => {
        if (url.endsWith("/refresh")) {
          tokenCalls += 1;
          return jsonResponse({ access_token: "access-3", refresh_token: "refresh-2" });
        }
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await consumer.request({ method: "GET", url: "https://gateway.example.com/ping" });
    expect(tokenCalls).toBe(1);
    expect(persisted).toEqual(["refresh-2"]);
    expect(consumer.auth?.refreshToken).toBe("refresh-2");
  });

  test("USERNAME_PASSWORD uses the password grant", async () => {
    let tokenBody = "";
    const consumer = new ApiConsumer({
      ...baseConfig({
        auth: { method: "USERNAME_PASSWORD" as const, token_endpoint: "https://gateway.example.com/token" },
        credentials: { username: "u", password: "p" },
      }),
      fetch: (async (url: string, init: RequestInit) => {
        if (url.endsWith("/token")) {
          tokenBody = String(init.body ?? "");
          return jsonResponse({ access_token: "access-4", expires_in: 600 });
        }
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await consumer.request({ method: "GET", url: "https://gateway.example.com/ping" });
    expect(tokenBody).toContain("grant_type=password");
  });

  test("MUTUAL_TLS supplies the client certificate material", async () => {
    let init: RequestInit | undefined;
    const consumer = new ApiConsumer({
      ...baseConfig({
        auth: { method: "MUTUAL_TLS" as const },
        credentials: { certificate: "CERT", privateKey: "KEY", ca: "CA" },
      }),
      fetch: (async (_url: string, requestInit: RequestInit) => {
        init = requestInit;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await consumer.request({ method: "GET", url: "https://gateway.example.com/ping" });
    const tls = (init as unknown as { tls?: { cert: string; key: string } }).tls;
    expect(tls?.cert).toBe("CERT");
    expect(tls?.key).toBe("KEY");
  });
});

describe("ApiConsumer safety controls", () => {
  test("blocks a host outside the allow list", async () => {
    const consumer = new ApiConsumer({
      ...baseConfig(),
      fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    await expect(consumer.request({ method: "GET", url: "https://evil.example.net/ping" })).rejects.toThrow();
  });

  test("blocks a private DNS resolution", async () => {
    const consumer = new ApiConsumer({
      ...baseConfig({ dnsLookup: async () => ["10.0.0.5"] }),
      fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    await expect(consumer.request({ method: "GET", url: "https://gateway.example.com/ping" })).rejects.toThrow();
  });

  test("blocks a loopback literal address", async () => {
    const consumer = new ApiConsumer({
      ...baseConfig({ allowedHosts: ["127.0.0.1"] }),
      fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    await expect(consumer.request({ method: "GET", url: "https://127.0.0.1/ping" })).rejects.toThrow();
  });

  test("classifies private and public IP addresses", () => {
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("10.1.2.3")).toBe(false);
    expect(isPublicIpAddress("172.16.0.1")).toBe(false);
    expect(isPublicIpAddress("192.168.1.1")).toBe(false);
    expect(isPublicIpAddress("169.254.1.1")).toBe(false);
    expect(isPublicIpAddress("::1")).toBe(false);
    expect(isPublicIpAddress("fd00::1")).toBe(false);
    expect(isPublicIpAddress("2606:4700::1111")).toBe(true);
  });

  test("never retries a MOVES_MONEY request after a 401", async () => {
    let calls = 0;
    const consumer = new ApiConsumer({
      ...baseConfig(),
      fetch: (async () => {
        calls += 1;
        return jsonResponse({ error: "unauthorized" }, 401);
      }) as unknown as typeof fetch,
    });
    await expect(
      consumer.request({
        method: "POST",
        url: "https://gateway.example.com/pay",
        sideEffect: "MOVES_MONEY",
        pointOfNoReturn: true,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("retries a safe pre-money request once after a 401", async () => {
    let calls = 0;
    const consumer = new ApiConsumer({
      ...baseConfig(),
      fetch: (async () => {
        calls += 1;
        return calls === 1 ? jsonResponse({ error: "unauthorized" }, 401) : jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const response = await consumer.request({
      method: "GET",
      url: "https://gateway.example.com/ping",
      sideEffect: "READ_ONLY",
    });
    expect(response.data).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("rejects a response larger than the configured cap", async () => {
    const consumer = new ApiConsumer({
      ...baseConfig({ maxResponseBytes: 32 }),
      fetch: (async () => new Response("x".repeat(1024), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(consumer.request({ method: "GET", url: "https://gateway.example.com/ping" })).rejects.toThrow();
  });

  test("rejects a redirect response", async () => {
    const consumer = new ApiConsumer({
      ...baseConfig(),
      fetch: (async () => new Response(null, { status: 302, headers: { location: "https://evil.example.net" } })) as unknown as typeof fetch,
    });
    await expect(consumer.request({ method: "GET", url: "https://gateway.example.com/ping" })).rejects.toThrow();
  });

  test("identifies authentication errors", () => {
    const error = new ApiConsumerError("unauthorized", { status: 401 });
    expect(isAuthenticationError(error)).toBe(true);
    expect(isAuthenticationError(new ApiConsumerError("boom", { status: 500 }))).toBe(false);
  });
});

describe("ConsumerRegistry", () => {
  test("caches the consumer promise synchronously and reuses it", async () => {
    let loads = 0;
    const registry = new ConsumerRegistry({
      loadConfig: async () => {
        loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return baseConfig();
      },
    });
    const key = { gatewayId: "gw-1", env: "SANDBOX", credentialSetId: "cs-1" };
    const first = registry.getConsumer(key);
    const second = registry.getConsumer(key);
    expect(first).toBe(second);
    expect(registry.consumersMap.size).toBe(1);
    await Promise.all([first, second]);
    expect(loads).toBe(1);
  });

  test("invalidates a consumer by credential set", async () => {
    const registry = new ConsumerRegistry({
      loadConfig: async () => baseConfig(),
    });
    const key = { gatewayId: "gw-1", env: "SANDBOX", credentialSetId: "cs-1" };
    await registry.getConsumer(key);
    expect(registry.consumersMap.size).toBe(1);
    await registry.invalidateCredential("cs-1");
    expect(registry.consumersMap.size).toBe(0);
  });
});

describe("InvalidationBus", () => {
  test("publishes a namespaced event to local subscribers", async () => {
    const bus = new InvalidationBus({ namespace: "test-ns" });
    const received: unknown[] = [];
    const unsubscribe = bus.subscribe("credential:cs-1", (event) => {
      received.push(event);
    });
    await bus.invalidateCredential("cs-1", "test");
    expect(received).toHaveLength(1);
    expect((received[0] as { namespace: string }).namespace).toBe("test-ns");
    unsubscribe();
  });

  test("publishes to a Redis compatible publisher", async () => {
    const published: Array<{ channel: string; message: string }> = [];
    const bus = new InvalidationBus({
      namespace: "test-ns",
      publisher: {
        publish: (channel, message) => {
          published.push({ channel, message });
          return 1;
        },
      },
    });
    await bus.invalidateCredential("cs-2");
    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe("test-ns:invalidation:credential:cs-2");
  });

  test("receives events from a Redis compatible subscriber", async () => {
    const handlers = new Map<string, (message: string) => void>();
    const bus = new InvalidationBus({
      namespace: "test-ns",
      subscriber: {
        subscribe: (channel, listener) => {
          handlers.set(channel, listener);
        },
        unsubscribe: (channel) => {
          handlers.delete(channel);
        },
      },
    });
    const received: unknown[] = [];
    bus.subscribe("credential:cs-3", (event) => {
      received.push(event);
    });
    const handler = handlers.get("test-ns:invalidation:credential:cs-3");
    handler?.(JSON.stringify({
      id: "evt-1",
      namespace: "test-ns",
      topic: "credential:cs-3",
      payload: { credentialSetId: "cs-3" },
      publishedAt: new Date().toISOString(),
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(received).toHaveLength(1);
  });
});
