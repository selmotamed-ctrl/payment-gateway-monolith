/**
 * Suite 08.2 — STRIDE exploit simulations and engineering safeguards.
 *
 * Covers the full SSRF notation catalogue, DNS rebinding / host pinning,
 * redirect refusal, XXE, oversized responses, deep JSON, response-splitting
 * and URL integrity.
 */
import { describe, expect, test } from "bun:test";
import {
  ApiConsumer,
  ApiConsumerError,
  isPublicIpAddress,
} from "../../../engine/apiConsumer/ApiConsumer";
import {
  assertNoControlCharacters,
  compileUrl,
  encodeForDestination,
  validateFinalUrl,
} from "../../../engine/apiConsumer/compileUrl";

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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

const request = (consumer: ApiConsumer, url = "https://gateway.example.com/ping") =>
  consumer.request({ method: "POST", url, body: { amount: "100" } });

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("Suite 08 · SSRF address catalogue", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "fc00::1",
    "fe80::1",
    "fd00::1",
    "ff02::1",
  ];
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ];

  for (const address of blocked) {
    test(`${address} is not a public target`, () => {
      expect(isPublicIpAddress(address)).toBe(false);
    });
  }
  for (const address of allowed) {
    test(`${address} is a public target`, () => {
      expect(isPublicIpAddress(address)).toBe(true);
    });
  }

  for (const invalid of ["", "not-an-ip", "999.999.999.999", "localhost"]) {
    test(`${JSON.stringify(invalid)} is refused`, () => {
      expect(isPublicIpAddress(invalid)).toBe(false);
    });
  }
});

describe("Suite 08 · DNS rebinding and host pinning", () => {
  test("a hostname that resolves to a private address is refused before fetch", async () => {
    let fetched = false;
    const consumer = new ApiConsumer(baseConfig({
      dnsLookup: async () => ["127.0.0.1"],
      fetch: (async () => {
        fetched = true;
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    }));
    const error = await rejection(request(consumer));
    expect(error).toBeInstanceOf(ApiConsumerError);
    expect(String((error as Error).message)).toContain("non-public");
    expect(fetched).toBe(false);
  });

  test("an unresolvable hostname is refused", async () => {
    const consumer = new ApiConsumer(baseConfig({ dnsLookup: async () => [] }));
    const error = await rejection(request(consumer));
    expect(String((error as Error).message)).toContain("did not resolve");
  });

  test("a custom dnsGuard can veto the connection-time lookup", async () => {
    const consumer = new ApiConsumer(baseConfig({
      dnsGuard: async () => {
        throw new ApiConsumerError("DNS rebinding detected", { retryable: false });
      },
    }));
    const error = await rejection(request(consumer));
    expect(String((error as Error).message)).toContain("DNS rebinding");
  });

  test("a host outside the allowlist is refused before DNS", async () => {
    let lookedUp = false;
    const consumer = new ApiConsumer(baseConfig({
      dnsLookup: async () => {
        lookedUp = true;
        return ["93.184.216.34"];
      },
    }));
    const error = await rejection(request(consumer, "https://evil.example.com/pay"));
    expect(String((error as Error).message)).toContain("not allowed");
    expect(lookedUp).toBe(false);
  });

  test("localhost and *.local are refused", async () => {
    for (const host of ["https://localhost/pay", "https://api.local/pay"]) {
      const consumer = new ApiConsumer(baseConfig({ allowedHosts: [new URL(host).hostname] }));
      const error = await rejection(request(consumer, host));
      expect(error).toBeDefined();
    }
  });

  test("an IP literal in the URL is checked directly", async () => {
    const consumer = new ApiConsumer(baseConfig({ allowedHosts: ["127.0.0.1"] }));
    const error = await rejection(request(consumer, "https://127.0.0.1/pay"));
    expect(String((error as Error).message)).toContain("not public");
  });
});

describe("Suite 08 · response hardening", () => {
  test("a redirect is refused", async () => {
    const consumer = new ApiConsumer(baseConfig({
      fetch: (async () => jsonResponse({}, 302, { location: "https://evil.example.com" })) as unknown as typeof fetch,
    }));
    const error = await rejection(request(consumer));
    expect(String((error as Error).message)).toContain("redirects are forbidden");
  });

  test("a declared oversized response is refused", async () => {
    const consumer = new ApiConsumer(baseConfig({
      maxResponseBytes: 1024,
      fetch: (async () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "5000000" },
      })) as unknown as typeof fetch,
    }));
    const error = await rejection(request(consumer));
    expect(String((error as Error).message)).toContain("exceeds");
  });

  test("a streamed 5 MB body is refused even without content-length", async () => {
    const big = JSON.stringify({ data: "x".repeat(5 * 1024 * 1024) });
    const consumer = new ApiConsumer(baseConfig({
      maxResponseBytes: 4096,
      fetch: (async () => new Response(big, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    }));
    const error = await rejection(request(consumer));
    expect(String((error as Error).message)).toContain("exceeds");
  });

  test("an XML DOCTYPE entity bomb is refused", async () => {
    const consumer = new ApiConsumer(baseConfig({
      fetch: (async () => new Response(
        '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>',
        { status: 200, headers: { "content-type": "application/xml" } },
      )) as unknown as typeof fetch,
    }));
    const error = await rejection(request(consumer));
    expect(String((error as Error).message)).toContain("DTD");
  });

  test("a deeply nested JSON response is refused", async () => {
    let body: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 100; index += 1) {
      body = { child: body };
    }
    const consumer = new ApiConsumer(baseConfig({
      maxJsonDepth: 64,
      fetch: (async () => jsonResponse(body)) as unknown as typeof fetch,
    }));
    const error = await rejection(request(consumer));
    expect(String((error as Error).message)).toContain("depth");
  });

  test("a request header with CRLF is refused", async () => {
    const consumer = new ApiConsumer(baseConfig());
    const error = await rejection(consumer.request({
      method: "POST",
      url: "https://gateway.example.com/ping",
      headers: { "X-Test": "value\r\nX-Injected: yes" },
    }));
    expect(String((error as Error).message)).toContain("CR, LF");
  });

  test("a query value with CRLF is refused", async () => {
    const consumer = new ApiConsumer(baseConfig());
    const error = await rejection(consumer.request({
      method: "POST",
      url: "https://gateway.example.com/ping",
      query: { note: "a\r\nb" },
      body: {},
    }));
    expect(error).toBeDefined();
  });

  test("a valid JSON response still parses", async () => {
    const consumer = new ApiConsumer(baseConfig({
      fetch: (async () => jsonResponse({ status: "SUCCESS", amount: "100.0000" })) as unknown as typeof fetch,
    }));
    const response = await request(consumer);
    expect((response.data as { status: string }).status).toBe("SUCCESS");
  });
});

describe("Suite 08 · URL integrity & response splitting", () => {
  test("header injection in a header value is blocked", () => {
    expect(() => assertNoControlCharacters("a\r\nb", "header")).toThrow();
    expect(() => assertNoControlCharacters("a\nb", "header")).toThrow();
    expect(() => assertNoControlCharacters("a\0b", "header")).toThrow();
  });

  test("path parameters cannot contain separators", () => {
    expect(() => compileUrl("https://gateway.example.com/a/{id}", undefined, {
      parameters: { id: "a/b" },
      allowedHosts: ["gateway.example.com"],
    })).toThrow();
  });

  test("path traversal segments are refused", () => {
    expect(() => validateFinalUrl("https://gateway.example.com/a/../b")).toThrow();
  });

  test("encoded path separators are refused", () => {
    expect(() => validateFinalUrl("https://gateway.example.com/a%2fb")).toThrow();
  });

  test("URL userinfo is refused", () => {
    expect(() => validateFinalUrl("https://user:pass@gateway.example.com/pay")).toThrow();
  });

  test("URL fragments are refused by default", () => {
    expect(() => validateFinalUrl("https://gateway.example.com/pay#frag")).toThrow();
  });

  test("plain HTTP is refused when HTTPS is required", () => {
    expect(() => validateFinalUrl("http://gateway.example.com/pay", { requireHttps: true })).toThrow();
  });

  test("an allowlisted host with a trailing dot normalizes", () => {
    const parsed = validateFinalUrl("https://gateway.example.com./pay", {
      allowedHosts: ["gateway.example.com"],
    });
    expect(parsed.hostname.replace(/\.$/, "")).toBe("gateway.example.com");
  });

  test("the query array formats expand correctly", () => {
    const indices = compileUrl("https://gateway.example.com/p", { a: ["1", "2"] }, {
      allowedHosts: ["gateway.example.com"],
      arrayFormat: "indices",
    });
    expect(indices).toContain("a[0]=1");
    const brackets = compileUrl("https://gateway.example.com/p", { a: ["1", "2"] }, {
      allowedHosts: ["gateway.example.com"],
      arrayFormat: "brackets",
    });
    expect(brackets).toContain("a[]=1");
    const repeat = compileUrl("https://gateway.example.com/p", { a: ["1", "2"] }, {
      allowedHosts: ["gateway.example.com"],
      arrayFormat: "repeat",
    });
    expect(repeat).toContain("a=1&a=2");
  });

  test("destination encoding escapes XML and JSON", () => {
    expect(encodeForDestination('<a>&"', "XML")).toBe("&lt;a&gt;&amp;&quot;");
    expect(encodeForDestination({ a: 1 }, "JSON")).toBe('{"a":1}');
    expect(encodeForDestination("a b", "FORM")).toBe("a%20b");
  });

  test("a control character in the base URL is refused", () => {
    expect(() => compileUrl("https://gateway.example.com/a\r\nb")).toThrow();
  });
});
