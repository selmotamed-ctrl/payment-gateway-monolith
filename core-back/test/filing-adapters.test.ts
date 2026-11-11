import { describe, expect, test } from "bun:test";
import { assertFilingEndpoint, dispatchFiling } from "../lib/filing/adapters";

describe("external filing adapters", () => {
  test("accepts only public HTTPS endpoints", () => {
    expect(assertFilingEndpoint("https://fiu.example.gov/reports").hostname).toBe("fiu.example.gov");
    expect(() => assertFilingEndpoint("http://fiu.example.gov/reports")).toThrow();
    expect(() => assertFilingEndpoint("https://127.0.0.1/reports")).toThrow();
    expect(() => assertFilingEndpoint("https://192.168.1.5/reports")).toThrow();
    expect(() => assertFilingEndpoint("https://user:pass@fiu.example.gov/reports")).toThrow();
  });

  test("manual adapters never dispatch", async () => {
    const result = await dispatchFiling({ kind: "MANUAL", endpointUrl: null, authHeaderName: null, secret: null, timeoutSeconds: 30, request: { report: { id: "r", reportCode: "INC", reportType: "INCIDENT", authority: "CBL", periodKey: null, payloadSha256: "a".repeat(64) }, artifacts: [] } });
    expect(result.status).toBe("FAILED");
  });

  test("HTTP adapters send the auth header and capture a reference", async () => {
    const seen = { url: "", init: {} as RequestInit };
    const result = await dispatchFiling({
      kind: "HTTP",
      endpointUrl: "https://fiu.example.gov/reports",
      authHeaderName: "X-Api-Key",
      secret: "secret",
      timeoutSeconds: 10,
      request: { report: { id: "r", reportCode: "INC", reportType: "INCIDENT", authority: "CBL", periodKey: null, payloadSha256: "a".repeat(64) }, artifacts: [] },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.url = String(url);
        seen.init = init ?? {};
        return new Response(JSON.stringify({ reference: "FIU-123" }), { status: 202 });
      }) as typeof fetch,
    });
    expect(result.status).toBe("SUBMITTED");
    expect(result.externalRef).toBe("FIU-123");
    expect((seen.init.headers as Record<string, string>)["X-Api-Key"]).toBe("secret");
    expect(seen.init.redirect).toBe("manual");
  });
});
