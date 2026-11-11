import { describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { assertFilingEndpoint, dispatchFiling, type FilingPoster } from "../lib/filing/adapters";
import { postPinned } from "../lib/webhooks/egress";

const request = { report: { id: "r", reportCode: "INC", reportType: "INCIDENT", authority: "CBL", periodKey: null, payloadSha256: "a".repeat(64) }, artifacts: [] };
const dispatch = (overrides: Partial<Parameters<typeof dispatchFiling>[0]> = {}) =>
  dispatchFiling({ kind: "HTTP", endpointUrl: "https://fiu.example.gov/reports", authHeaderName: "X-Api-Key", secret: "secret", timeoutSeconds: 10, request, ...overrides });

describe("external filing adapters", () => {
  test("accepts only public HTTPS endpoints", () => {
    expect(assertFilingEndpoint("https://fiu.example.gov/reports").hostname).toBe("fiu.example.gov");
    expect(() => assertFilingEndpoint("http://fiu.example.gov/reports")).toThrow("HTTPS");
    expect(() => assertFilingEndpoint("https://127.0.0.1/reports")).toThrow("public");
    expect(() => assertFilingEndpoint("https://192.168.1.5/reports")).toThrow("public");
    expect(() => assertFilingEndpoint("https://user:pass@fiu.example.gov/reports")).toThrow("credentials");
  });

  // Each of these slipped past the previous hostname-string check (only a few literal strings and prefixes).
  test("rejects every literal private, loopback, link-local and local form", () => {
    for (const host of [
      "127.0.0.2", "127.255.255.254", "0.0.0.0", "100.64.0.1", "169.254.169.254", "172.31.0.9",
      "[::1]", "[fc00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::]",
      "localhost", "localhost.", "app.localhost", "metadata.internal", "printer.local",
    ]) {
      expect(() => assertFilingEndpoint(`https://${host}/reports`), host).toThrow();
    }
  });

  test("manual adapters never dispatch", async () => {
    const result = await dispatch({ kind: "MANUAL", endpointUrl: null, authHeaderName: null, secret: null });
    expect(result.status).toBe("FAILED");
  });

  test("HTTP adapters send the auth header through the pinned transport and capture a reference", async () => {
    const seen: Array<Parameters<FilingPoster>[0]> = [];
    const post: FilingPoster = async (input) => {
      seen.push(input);
      return { status: 202, latencyMs: 5, body: JSON.stringify({ reference: "FIU-123" }) };
    };
    const result = await dispatch({ post });
    expect(result.status).toBe("SUBMITTED");
    expect(result.externalRef).toBe("FIU-123");
    expect(result.responseCode).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers).toEqual({ "X-Api-Key": "secret" });
    expect(seen[0]?.url).toBe("https://fiu.example.gov/reports");
    expect(seen[0]?.captureBody).toBe(true);
    expect(seen[0]?.allowInsecure).toBeUndefined();
    expect(seen[0]?.deadlineMs).toBe(10_000);
    expect(seen[0]?.maxResponseBytes).toBe(16_000);
  });

  test("a non-2xx answer is a failed submission with the stored text capped", async () => {
    const post: FilingPoster = async () => ({ status: 500, latencyMs: 1, body: "x".repeat(9000) });
    const result = await dispatch({ post });
    expect(result.status).toBe("FAILED");
    expect(result.responseCode).toBe(500);
    expect(result.responseBody).toHaveLength(4000);
    expect(result.errorMessage).toBe("The filing endpoint returned HTTP 500");
  });

  test("a name that resolves to an internal address is never contacted (DNS rebinding)", async () => {
    for (const internal of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "::ffff:10.1.2.3", "100.64.0.9"]) {
      const result = await dispatch({
        endpointUrl: "https://rebind.attacker.example/reports",
        resolver: async () => ["93.184.216.34", internal],
      });
      expect(result.status, internal).toBe("FAILED");
      expect(result.responseCode).toBeNull();
      expect(result.responseBody).toBeNull();
      expect(result.errorMessage, internal).toBe("A filing endpoint must be a public HTTPS address");
    }
  });

  test("an unresolvable host fails without a request", async () => {
    const result = await dispatch({ endpointUrl: "https://nowhere.example.gov/reports", resolver: async () => { throw new Error("NXDOMAIN"); } });
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("did not resolve");
  });

  test("the endpoint is re-validated at dispatch time, whatever was stored", async () => {
    const post: FilingPoster = async () => { throw new Error("must not be reached"); };
    expect(() => dispatch({ endpointUrl: "https://[::ffff:7f00:1]/reports", post })).toThrow("public");
  });
});

describe("postPinned body capture and deadline (real sockets)", () => {
  const serve = async (handler: http.RequestListener) => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/file`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
  };

  test("captures the first bytes of the answer, no more, and sends the filing agent", async () => {
    let agent = "";
    const server = await serve((req, res) => { agent = String(req.headers["user-agent"]); res.writeHead(200); res.end("y".repeat(50_000)); });
    try {
      const result = await postPinned({ url: server.url, body: "{}", headers: {}, allowInsecure: true, captureBody: true, maxResponseBytes: 1000, userAgent: "PaymentGateway-Filing/1" });
      expect(result.status).toBe(200);
      expect(result.body).toHaveLength(1000);
      expect(agent).toBe("PaymentGateway-Filing/1");
    } finally { await server.close(); }
  });

  test("keeps discarding the body when capture is not requested (the webhook sender)", async () => {
    const server = await serve((_req, res) => { res.writeHead(204); res.end(); });
    try {
      const result = await postPinned({ url: server.url, body: "{}", headers: {}, allowInsecure: true });
      expect(result.status).toBe(204);
      expect("body" in result).toBe(false);
    } finally { await server.close(); }
  });

  test("a slow-drip answer is cut by the overall deadline, not only by the idle timeout", async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const server = await serve((_req, res) => {
      res.writeHead(200);
      timer = setInterval(() => res.write("."), 50); // never idle for the 1 s socket timeout
    });
    try {
      const started = Date.now();
      const error = await postPinned({ url: server.url, body: "{}", headers: {}, allowInsecure: true, captureBody: true, timeoutMs: 1000, deadlineMs: 300 }).catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe("TIMEOUT");
      expect(Date.now() - started).toBeLessThan(900);
    } finally { if (timer) clearInterval(timer); await server.close(); }
  });
});
