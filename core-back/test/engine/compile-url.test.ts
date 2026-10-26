import { describe, expect, test } from "bun:test";
import {
  assertNoControlCharacters,
  compileUrl,
  encodeForDestination,
  validateFinalUrl,
} from "../../engine/apiConsumer/compileUrl";

describe("compileUrl CRLF rejection", () => {
  test("rejects CR in the URL", () => {
    expect(() => compileUrl("https://gateway.example.com/pay\r\nX-Injected: 1")).toThrow();
  });

  test("rejects LF in the URL", () => {
    expect(() => compileUrl("https://gateway.example.com/pay\nSet-Cookie: a=b")).toThrow();
  });

  test("rejects NUL in the URL", () => {
    expect(() => compileUrl("https://gateway.example.com/pay\0")).toThrow();
  });

  test("rejects CR or LF in query keys and values", () => {
    expect(() => compileUrl("https://gateway.example.com/pay", { "a\r\nb": "1" })).toThrow();
    expect(() => compileUrl("https://gateway.example.com/pay", { a: "1\r\nX-Evil: 2" })).toThrow();
  });

  test("assertNoControlCharacters rejects header injection payloads", () => {
    expect(() => assertNoControlCharacters("value\r\nInjected: header", "header")).toThrow();
    expect(() => assertNoControlCharacters("clean-value", "header")).not.toThrow();
  });
});

describe("compileUrl host pinning", () => {
  test("accepts an allow-listed host", () => {
    const url = compileUrl("https://pay.example.com/api", undefined, {
      allowedHosts: ["pay.example.com"],
    });
    expect(url.startsWith("https://pay.example.com/api")).toBe(true);
  });

  test("rejects a host outside the allow list", () => {
    expect(() =>
      compileUrl("https://evil.example.net/api", undefined, {
        allowedHosts: ["pay.example.com"],
      }),
    ).toThrow();
  });

  test("rejects a host that merely ends with the allow-listed host", () => {
    expect(() =>
      compileUrl("https://pay.example.com.evil.net/api", undefined, {
        allowedHosts: ["pay.example.com"],
      }),
    ).toThrow();
  });

  test("rejects plain HTTP by default", () => {
    expect(() => compileUrl("http://pay.example.com/api")).toThrow();
  });

  test("rejects userinfo in the URL", () => {
    expect(() => compileUrl("https://user:pass@pay.example.com/api")).toThrow();
  });

  test("rejects path traversal and encoded separators", () => {
    expect(() => compileUrl("https://pay.example.com/../secret")).toThrow();
    expect(() => compileUrl("https://pay.example.com/a%2f..%2fb")).toThrow();
    expect(() => compileUrl("https://pay.example.com/a\\b")).toThrow();
  });

  test("rejects fragments on gateway URLs", () => {
    expect(() => compileUrl("https://pay.example.com/api#fragment")).toThrow();
  });

  test("validateFinalUrl enforces the allow list", () => {
    expect(() =>
      validateFinalUrl("https://other.example.net/api", { allowedHosts: ["pay.example.com"] }),
    ).toThrow();
    expect(
      validateFinalUrl("https://pay.example.com/api", { allowedHosts: ["pay.example.com"] }).hostname,
    ).toBe("pay.example.com");
  });
});

describe("compileUrl query encoding", () => {
  test("encodes nested objects and arrays with the indices format", () => {
    const url = compileUrl("https://pay.example.com/api", {
      filter: { status: "PAID" },
      ids: ["a", "b"],
    });
    expect(url).toContain("filter[status]=PAID");
    expect(url).toContain("ids[0]=a");
    expect(url).toContain("ids[1]=b");
  });

  test("can percent encode brackets", () => {
    const url = compileUrl("https://pay.example.com/api", { ids: ["a"] }, { encodeBrackets: true });
    expect(url).toContain("ids%5B0%5D=a");
  });

  test("supports the repeat array format", () => {
    const url = compileUrl("https://pay.example.com/api", { ids: ["a", "b"] }, {
      arrayFormat: "repeat",
    });
    expect(url).toContain("ids=a");
    expect(url).toContain("ids=b");
  });

  test("percent encodes reserved characters", () => {
    const url = compileUrl("https://pay.example.com/api", { note: "a b&c=d" });
    expect(url).toContain("note=a%20b%26c%3Dd");
  });

  test("drops null and undefined values", () => {
    const url = compileUrl("https://pay.example.com/api", { a: null, b: undefined, c: "1" });
    expect(url).toContain("c=1");
    expect(url).not.toContain("a=");
    expect(url).not.toContain("b=");
  });
});

describe("compileUrl path parameter substitution", () => {
  test("encodes path parameters and validates the final URL", () => {
    const url = compileUrl("https://pay.example.com/orders/{id}/confirm", undefined, {
      parameters: { id: "a b" },
    });
    expect(url).toBe("https://pay.example.com/orders/a%20b/confirm");
  });

  test("rejects a path parameter that carries a path separator", () => {
    expect(() =>
      compileUrl("https://pay.example.com/orders/{id}", undefined, { parameters: { id: "a/b" } }),
    ).toThrow();
    expect(() =>
      compileUrl("https://pay.example.com/orders/{id}", undefined, { parameters: { id: "a\\b" } }),
    ).toThrow();
  });

  test("rejects a missing path parameter", () => {
    expect(() =>
      compileUrl("https://pay.example.com/orders/{id}", undefined, { parameters: {} }),
    ).toThrow();
  });
});

describe("destination aware encoding", () => {
  test("encodes per destination", () => {
    expect(encodeForDestination("a<b>&c", "XML")).toBe("a&lt;b&gt;&amp;c");
    expect(encodeForDestination("a b", "URL")).toBe("a%20b");
    expect(encodeForDestination("a b", "FORM")).toBe("a%20b");
    expect(encodeForDestination({ a: 1 }, "JSON")).toBe('{"a":1}');
  });

  test("rejects control characters for header destinations", () => {
    expect(() => encodeForDestination("a\r\nb", "HEADER")).toThrow();
  });
});
