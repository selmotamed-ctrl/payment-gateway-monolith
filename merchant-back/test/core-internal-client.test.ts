import { afterAll, afterEach, describe, expect, test } from "bun:test";
import express from "express";
import {
  assertCorePath,
  buildCoreHeaders,
  callCoreRaw,
  CORE_CHANNEL_PREFIX,
  CORE_FAILURE_THRESHOLD,
  CORE_SERVICE_NAME,
  consistencyHeader,
  openCoreStream,
  proxyCoreStream,
  request,
  resetCoreAgent,
  resetCoreClock,
  setCoreClock,
} from "../lib/coreInternalClient";
import { coreBackUrls, parseCoreBackUrls, resetEnvCache } from "../lib/env";
import { ApiError } from "../lib/error";
import { createTestPki } from "./helpers/core";
import {
  respondJson,
  startUpstream,
  type TestUpstream,
} from "./helpers/upstream";

const pki = createTestPki(CORE_SERVICE_NAME);

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  CORE_BACK_URL: process.env.CORE_BACK_URL,
  CORE_BACK_URLS: process.env.CORE_BACK_URLS,
  CORE_REQUEST_TIMEOUT_MS: process.env.CORE_REQUEST_TIMEOUT_MS,
  MTLS_CLIENT_CERT_PATH: process.env.MTLS_CLIENT_CERT_PATH,
  MTLS_CLIENT_KEY_PATH: process.env.MTLS_CLIENT_KEY_PATH,
  MTLS_CA_CERT_PATH: process.env.MTLS_CA_CERT_PATH,
};

const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
  resetCoreAgent();
  resetCoreClock();
};

const configure = (urls: string[]): void => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = urls[0] ?? "https://core-fallback.internal:4000";
  process.env.CORE_BACK_URLS = urls.join(",");
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.CORE_REQUEST_TIMEOUT_MS = "5000";
  resetEnvCache();
  resetCoreAgent();
};

const closeUpstreams = async (...upstreams: TestUpstream[]): Promise<void> => {
  resetCoreAgent();
  await Promise.all(upstreams.map((upstream) => upstream.close()));
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met before the deadline");
};

const readStream = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
};

afterEach(() => {
  resetCoreClock();
});

afterAll(() => {
  restoreEnv();
});

describe("core back URL configuration", () => {
  test("falls back to CORE_BACK_URL when CORE_BACK_URLS is absent or empty", () => {
    process.env.NODE_ENV = "test";
    process.env.CORE_BACK_URL = "https://core-one.internal:4000";
    delete process.env.CORE_BACK_URLS;
    process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
    process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
    process.env.MTLS_CA_CERT_PATH = pki.caCert;
    resetEnvCache();
    expect(coreBackUrls()).toEqual(["https://core-one.internal:4000"]);
    process.env.CORE_BACK_URLS = "   ";
    resetEnvCache();
    expect(coreBackUrls()).toEqual(["https://core-one.internal:4000"]);
  });

  test("parses multiple URLs, trims whitespace and deduplicates", () => {
    process.env.NODE_ENV = "test";
    process.env.CORE_BACK_URL = "https://core-fallback.internal:4000";
    process.env.CORE_BACK_URLS =
      " https://core-a.internal:4000 , https://core-b.internal:4000,https://core-a.internal:4000/ ";
    process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
    process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
    process.env.MTLS_CA_CERT_PATH = pki.caCert;
    resetEnvCache();
    expect(coreBackUrls()).toEqual([
      "https://core-a.internal:4000",
      "https://core-b.internal:4000",
    ]);
  });

  test("rejects malformed and non-https URLs", () => {
    expect(() => parseCoreBackUrls("http://core-a.internal:4000", "https://fallback.internal")).toThrow();
    expect(() => parseCoreBackUrls("not-a-url", "https://fallback.internal")).toThrow();
    expect(() =>
      parseCoreBackUrls("https://core-a.internal:4000,,https://core-b.internal:4000", "https://fallback.internal"),
    ).toThrow();
  });
});

describe("multi-upstream selection and failover", () => {
  test("selects the least in-flight node and uses the other node for concurrent work", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = await startUpstream(pki, async (_request, response) => {
      await gate;
      respondJson(response, 200, { node: "slow" });
    });
    const fast = await startUpstream(pki, (_request, response) => {
      respondJson(response, 200, { node: "fast" });
    });
    configure([slow.url, fast.url]);
    try {
      const first = request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/selection` });
      await waitFor(() => slow.requests.length === 1);
      const second = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/selection` });
      expect(second.statusCode).toBe(200);
      expect(fast.requests.length).toBe(1);
      release();
      const firstResponse = await first;
      expect(firstResponse.statusCode).toBe(200);
      expect(slow.requests.length).toBe(1);
    } finally {
      release();
      await closeUpstreams(slow, fast);
    }
  });

  test("round-robins among nodes with equal in-flight counts", async () => {
    const first = await startUpstream(pki);
    const second = await startUpstream(pki);
    configure([first.url, second.url]);
    try {
      await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/rr/1` });
      expect(first.requests.length).toBe(1);
      expect(second.requests.length).toBe(0);
      await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/rr/2` });
      expect(second.requests.length).toBe(1);
      await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/rr/3` });
      expect(first.requests.length).toBe(2);
      await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/rr/4` });
      expect(second.requests.length).toBe(2);
    } finally {
      await closeUpstreams(first, second);
    }
  });

  test("fails over on ECONNREFUSED and skips the unhealthy node during cooldown", async () => {
    const refused = await startUpstream(pki);
    const refusedUrl = refused.url;
    await refused.close();
    const healthy = await startUpstream(pki);
    configure([refusedUrl, healthy.url]);
    try {
      const response = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/refused` });
      expect(response.statusCode).toBe(200);
      expect(healthy.requests.length).toBe(1);
      const next = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/refused-next` });
      expect(next.statusCode).toBe(200);
      expect(healthy.requests.length).toBe(2);
    } finally {
      await closeUpstreams(healthy);
    }
  });

  test("fails over on request timeout", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stalled = await startUpstream(pki, async (_request, response) => {
      await gate;
      respondJson(response, 200, { node: "stalled" });
    });
    const healthy = await startUpstream(pki);
    configure([stalled.url, healthy.url]);
    try {
      const response = await request({
        method: "GET",
        path: `${CORE_CHANNEL_PREFIX}/timeout`,
        timeoutMs: 150,
        maxAttempts: 2,
      });
      expect(response.statusCode).toBe(200);
      expect(healthy.requests.length).toBe(1);
    } finally {
      release();
      await closeUpstreams(stalled, healthy);
    }
  });

  test("does not fail over on 400 or 401", async () => {
    const first = await startUpstream(pki, (_request, response) => {
      respondJson(response, 400, { code: "BAD_INPUT" });
    });
    const second = await startUpstream(pki);
    try {
      configure([first.url, second.url]);
      const badRequest = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/bad` });
      expect(badRequest.statusCode).toBe(400);
      expect(second.requests.length).toBe(0);

      first.setHandler((_request, response) => {
        respondJson(response, 401, { code: "UNAUTHORIZED" });
      });
      configure([first.url, second.url]);
      const unauthorized = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/unauthorized` });
      expect(unauthorized.statusCode).toBe(401);
      expect(second.requests.length).toBe(0);
    } finally {
      await closeUpstreams(first, second);
    }
  });

  test("fails over on 502 and 503", async () => {
    const first = await startUpstream(pki, (_request, response) => {
      respondJson(response, 502, { code: "BAD_GATEWAY" });
    });
    const second = await startUpstream(pki);
    try {
      configure([first.url, second.url]);
      const badGateway = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/502` });
      expect(badGateway.statusCode).toBe(200);
      expect(second.requests.length).toBe(1);

      first.setHandler((_request, response) => {
        respondJson(response, 503, { code: "UNAVAILABLE" });
      });
      configure([first.url, second.url]);
      const unavailable = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/503` });
      expect(unavailable.statusCode).toBe(200);
      expect(second.requests.length).toBe(2);
    } finally {
      await closeUpstreams(first, second);
    }
  });

  test("does not retry non-idempotent POST unless the caller opts in", async () => {
    const first = await startUpstream(pki, (_request, response) => {
      respondJson(response, 502, { code: "BAD_GATEWAY" });
    });
    const second = await startUpstream(pki);
    try {
      configure([first.url, second.url]);
      const response = await request({
        method: "POST",
        path: `${CORE_CHANNEL_PREFIX}/post`,
        body: JSON.stringify({ value: 1 }),
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(502);
      expect(second.requests.length).toBe(0);

      configure([first.url, second.url]);
      const retried = await request({
        method: "POST",
        path: `${CORE_CHANNEL_PREFIX}/post`,
        body: JSON.stringify({ value: 1 }),
        headers: { "content-type": "application/json" },
        retryIfUnavailable: true,
      });
      expect(retried.statusCode).toBe(200);
      expect(second.requests.length).toBe(1);
    } finally {
      await closeUpstreams(first, second);
    }
  });

  test("retries an idempotent GET on the next healthy node", async () => {
    const first = await startUpstream(pki, (_request, response) => {
      respondJson(response, 502, { code: "BAD_GATEWAY" });
    });
    const second = await startUpstream(pki);
    configure([first.url, second.url]);
    try {
      const response = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/idempotent` });
      expect(response.statusCode).toBe(200);
      expect(first.requests.length).toBe(1);
      expect(second.requests.length).toBe(1);
    } finally {
      await closeUpstreams(first, second);
    }
  });

  test("allows one half-open probe after the cooldown", async () => {
    let available = false;
    const upstream = await startUpstream(pki, (_request, response) => {
      if (available) respondJson(response, 200, { ok: true });
      else respondJson(response, 503, { code: "UNAVAILABLE" });
    });
    let now = 1000;
    configure([upstream.url]);
    setCoreClock(() => now);
    try {
      // GAP-021: the node only leaves rotation after CORE_FAILURE_THRESHOLD consecutive failures.
      for (let i = 0; i < CORE_FAILURE_THRESHOLD; i += 1) {
        const failed = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/half-open`, maxAttempts: 1 });
        expect(failed.statusCode).toBe(503);
      }
      const tripped = upstream.requests.length;
      expect(tripped).toBe(CORE_FAILURE_THRESHOLD);

      available = true;
      let unavailable: ApiError | undefined;
      try {
        await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/half-open` });
      } catch (error) {
        unavailable = error as ApiError;
      }
      expect(unavailable?.code).toBe("CORE_UNAVAILABLE");
      expect(upstream.requests.length).toBe(tripped);

      now += 5000;
      const probe = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/half-open` });
      expect(probe.statusCode).toBe(200);
      expect(upstream.requests.length).toBe(tripped + 1);

      const recovered = await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/half-open` });
      expect(recovered.statusCode).toBe(200);
      expect(upstream.requests.length).toBe(tripped + 2);
    } finally {
      await closeUpstreams(upstream);
    }
  });

  test("reports CORE_UNAVAILABLE when every node is down", async () => {
    const first = await startUpstream(pki);
    const second = await startUpstream(pki);
    const urls = [first.url, second.url];
    await closeUpstreams(first, second);
    configure(urls);
    let error: ApiError | undefined;
    for (let i = 0; i < CORE_FAILURE_THRESHOLD; i += 1) {
      error = undefined;
      try {
        await request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/down`, maxAttempts: 2 });
      } catch (caught) {
        error = caught as ApiError;
      }
      // Below the threshold the transport error surfaces; at the threshold the pool is exhausted.
      if (i < CORE_FAILURE_THRESHOLD - 1) expect(error?.code).not.toBe("CORE_UNAVAILABLE");
    }
    expect(error).toBeInstanceOf(ApiError);
    expect(error?.code).toBe("CORE_UNAVAILABLE");
    expect(error?.statusCode).toBe(503);
  });
});

describe("headers and path confinement", () => {
  test("propagates x-pg-min-lsn through buildCoreHeaders, consistencyHeader and real calls", async () => {
    const upstream = await startUpstream(pki);
    configure([upstream.url]);
    try {
      const headers = buildCoreHeaders({
        method: "GET",
        path: `${CORE_CHANNEL_PREFIX}/lsn`,
        requestId: "req-lsn",
        clientIp: "10.0.0.1",
        minLsn: "0/16B6C50",
      });
      expect(headers["x-pg-min-lsn"]).toBe("0/16B6C50");
      expect(consistencyHeader("0/16B6C50")).toEqual({ "x-pg-min-lsn": "0/16B6C50" });
      expect(consistencyHeader()).toEqual({});

      await callCoreRaw({
        method: "GET",
        path: `${CORE_CHANNEL_PREFIX}/lsn`,
        requestId: "req-lsn",
        clientIp: "10.0.0.1",
        minLsn: "0/16B6C50",
      });
      expect(upstream.requests.at(-1)?.headers["x-pg-min-lsn"]).toBe("0/16B6C50");

      await request({
        method: "GET",
        path: `${CORE_CHANNEL_PREFIX}/lsn`,
        headers: { "x-pg-min-lsn": "0/DEADBEEF" },
      });
      expect(upstream.requests.at(-1)?.headers["x-pg-min-lsn"]).toBe("0/DEADBEEF");
    } finally {
      await closeUpstreams(upstream);
    }
  });

  test("keeps channel confinement and rejects traversal, backslashes and protocol-relative paths", async () => {
    expect(assertCorePath(`${CORE_CHANNEL_PREFIX}/merchants`)).toBe(`${CORE_CHANNEL_PREFIX}/merchants`);
    for (const path of [
      "/internal/other/channel",
      "https://evil.example/x",
      "//evil.example/x",
      `${CORE_CHANNEL_PREFIX}/../other`,
      `${CORE_CHANNEL_PREFIX}/%2e%2e/other`,
      `${CORE_CHANNEL_PREFIX}\\other`,
      "internal/admin/relative",
    ]) {
      expect(() => assertCorePath(path)).toThrow(ApiError);
    }

    const upstream = await startUpstream(pki);
    configure([upstream.url]);
    try {
      await expect(
        request({ method: "GET", path: `${CORE_CHANNEL_PREFIX}/../escape` }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(upstream.requests.length).toBe(0);
    } finally {
      await closeUpstreams(upstream);
    }
  });
});

describe("stream proxy", () => {
  test("fails over to a healthy node for a proxied stream", async () => {
    const failing = await startUpstream(pki, (_request, response) => {
      respondJson(response, 503, { code: "UNAVAILABLE" });
    });
    const streaming = await startUpstream(pki, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {\"node\":\"recovered\"}\n\n");
      response.end();
    });
    configure([failing.url, streaming.url]);
    const app = express();
    app.get("/proxy-stream", async (req, res, next) => {
      try {
        await proxyCoreStream(req, res, {
          method: "GET",
          path: `${CORE_CHANNEL_PREFIX}/stream`,
          requestId: "req-stream",
          clientIp: "10.0.0.7",
          timeoutMs: 5000,
        });
      } catch (error) {
        next(error);
      }
    });
    const proxyServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => proxyServer.once("listening", resolve));
    const address = proxyServer.address();
    const proxyPort = typeof address === "object" && address ? address.port : 0;
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/proxy-stream`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("recovered");
      expect(failing.requests.length).toBe(1);
      expect(streaming.requests.length).toBe(1);

      const direct = await openCoreStream({
        method: "GET",
        path: `${CORE_CHANNEL_PREFIX}/stream-direct`,
        requestId: "req-stream-direct",
        clientIp: "10.0.0.8",
      });
      expect(direct.statusCode).toBe(200);
      expect(await readStream(direct.stream)).toContain("recovered");
    } finally {
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
      await closeUpstreams(failing, streaming);
    }
  });
});
