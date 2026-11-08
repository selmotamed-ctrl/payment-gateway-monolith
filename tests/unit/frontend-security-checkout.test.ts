// Regression tests for the checkout-front security fixes (F1-F6). They import the REAL modules.
import { describe, expect, test } from "vitest";
import { urlsMap } from "../../checkout-front/src/constants/urlsMap";
import { isAllowedRedirect } from "../../checkout-front/src/utils/redirect";
import {
  DEFAULT_SANDBOX,
  createBridgeHandler,
  getEmbedAllowlist,
  isAllowedEmbedUrl,
  normalizeOrigins,
  planEmbedScripts,
  sanitizeBridgePayload,
  sanitizeSandbox,
} from "../../checkout-front/src/utils/security/embedPolicy";
import { safeDeepLink } from "../../checkout-front/src/utils/security/deepLink";
import {
  clearAttemptId,
  getOrCreateIdempotencyKey,
  loadAttemptId,
  saveAttemptId,
  type StorageLike,
} from "../../checkout-front/src/utils/security/idempotency";
import { ERROR_CATALOGUE_KEYS, errorKeyForCode } from "../../checkout-front/src/utils/security/errorMessages";
import { isTerminalStatus, nextPollDelay, startStatusPolling } from "../../checkout-front/src/utils/security/statusPolling";
import { appCatalogue } from "../../checkout-front/src/constants/i18nCatalogue";

const memoryStorage = (): StorageLike => {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("F1 status stream URL is absolute under the API base", () => {
  test("payStatusStream resolves under /api/v1/pay", () => {
    const resolved = new URL(urlsMap.payStatusStream("ABC123", "att1"), "https://pay.example.com/pay/ABC123");
    expect(resolved.pathname).toBe("/api/v1/pay/ABC123/logs/att1/status");
  });
  test("link key and attempt id are encoded", () => {
    expect(urlsMap.payStatusStream("a/b", "c?d")).toContain("a%2Fb/logs/c%3Fd/status");
  });
  test("polling fallback endpoint exists (payLogs)", () => {
    expect(urlsMap.payLogs("K", "A")).toBe("v1/pay/K/logs/A");
  });
});

describe("F1 polling fallback", () => {
  test("backoff grows and is capped", () => {
    expect(nextPollDelay(1)).toBeLessThan(nextPollDelay(4));
    expect(nextPollDelay(50)).toBe(15000);
  });
  test("stops on a terminal status and schedules nothing afterwards", async () => {
    const statuses = ["AUTHORIZING", "VERIFYING", "SUCCEEDED"];
    const seen: string[] = [];
    const scheduled: (() => void)[] = [];
    let i = 0;
    startStatusPolling({
      fetchSnapshot: async () => ({ status: statuses[i++] }),
      onSnapshot: (s) => seen.push(String(s.status)),
      schedule: (fn) => {
        scheduled.push(fn);
        return scheduled.length;
      },
      cancel: () => undefined,
    });
    for (let n = 0; n < 5; n++) {
      await flush();
      scheduled.shift()?.();
    }
    await flush();
    expect(seen).toEqual(["AUTHORIZING", "VERIFYING", "SUCCEEDED"]);
    expect(scheduled).toHaveLength(0);
  });
  test("retries with backoff after failures and stop() halts it", async () => {
    let calls = 0;
    const scheduled: { fn: () => void; ms: number }[] = [];
    const poller = startStatusPolling({
      fetchSnapshot: async () => {
        calls++;
        throw new Error("net");
      },
      onSnapshot: () => undefined,
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return 1;
      },
      cancel: () => undefined,
    });
    await flush();
    expect(calls).toBe(1);
    expect(scheduled).toHaveLength(1);
    poller.stop();
    scheduled[0]!.fn();
    await flush();
    expect(calls).toBe(1);
  });
  test("terminal status set", () => {
    for (const s of ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED"]) expect(isTerminalStatus(s)).toBe(true);
    expect(isTerminalStatus("VERIFYING")).toBe(false);
  });
});

describe("F2/F13 embed allow-list (exact origins, https only, no test host in production)", () => {
  const prod = getEmbedAllowlist(false);
  const dev = getEmbedAllowlist(true);
  test("legit script from an allow-listed origin is accepted", () => {
    expect(isAllowedEmbedUrl("https://payments.moamalat.ly/sdk.js", prod)).toBe(true);
  });
  test("subdomains, lookalikes and suffix tricks are rejected", () => {
    expect(isAllowedEmbedUrl("https://evil.payments.moamalat.ly/x.js", prod)).toBe(false);
    expect(isAllowedEmbedUrl("https://evilpayments.moamalat.ly/x.js", prod)).toBe(false);
    expect(isAllowedEmbedUrl("https://payments.moamalat.ly.evil.com/x.js", prod)).toBe(false);
    expect(isAllowedEmbedUrl("https://payments.moamalat.ly@evil.com/x.js", prod)).toBe(false);
  });
  test("http, other ports and credentials are rejected", () => {
    expect(isAllowedEmbedUrl("http://payments.moamalat.ly/x.js", prod)).toBe(false);
    expect(isAllowedEmbedUrl("https://payments.moamalat.ly:8443/x.js", prod)).toBe(false);
    expect(isAllowedEmbedUrl("https://u:p@payments.moamalat.ly/x.js", prod)).toBe(false);
  });
  test("the test host is only allowed in non-production builds", () => {
    expect(isAllowedEmbedUrl("https://test.mpgmerchant.test/x.js", prod)).toBe(false);
    expect(isAllowedEmbedUrl("https://test.mpgmerchant.test/x.js", dev)).toBe(true);
  });
  test("iframe_src uses the same allow-list", () => {
    expect(isAllowedEmbedUrl("https://secure.moamalat.ly/frame", prod)).toBe(true);
    expect(isAllowedEmbedUrl("https://evil.example/frame", prod)).toBe(false);
    expect(isAllowedEmbedUrl("javascript:alert(1)", prod)).toBe(false);
    expect(isAllowedEmbedUrl(null, prod)).toBe(false);
  });
});

describe("F2 SRI is matched per script, never falling back to hash[0]", () => {
  const A = "sha384-AAAA";
  const B = "sha384-BBBB";
  const allow = getEmbedAllowlist(false);
  test("hash i belongs to script i of the server list", () => {
    const plan = planEmbedScripts(["https://js.numo-pay.com/a.js", "https://pay.evowallet.net/b.js"], [A, B], allow);
    expect(plan).toEqual([
      { url: "https://js.numo-pay.com/a.js", integrity: A },
      { url: "https://pay.evowallet.net/b.js", integrity: B },
    ]);
  });
  test("index is the position in the unfiltered server list", () => {
    const plan = planEmbedScripts(["https://evil.example/x.js", "https://pay.evowallet.net/b.js"], [A, B], allow);
    expect(plan).toEqual([{ url: "https://pay.evowallet.net/b.js", integrity: B }]);
  });
  test("a script without its own hash is rejected", () => {
    expect(planEmbedScripts(["https://js.numo-pay.com/a.js", "https://pay.evowallet.net/b.js"], [A], allow)).toEqual([
      { url: "https://js.numo-pay.com/a.js", integrity: A },
    ]);
    expect(planEmbedScripts(["https://js.numo-pay.com/a.js"], [], allow)).toEqual([]);
  });
  test("malformed hashes are rejected", () => {
    expect(planEmbedScripts(["https://js.numo-pay.com/a.js"], ["md5-xx"], allow)).toEqual([]);
  });
});

describe("F2 iframe sandbox is forced into a safe set", () => {
  test("dangerous flags are stripped", () => {
    const out = sanitizeSandbox(
      "allow-scripts allow-same-origin allow-top-navigation allow-popups-to-escape-sandbox allow-forms",
    );
    expect(out.split(" ").sort()).toEqual(["allow-forms", "allow-scripts"]);
    expect(out).not.toContain("same-origin");
    expect(out).not.toContain("top-navigation");
  });
  test("missing, empty or unknown falls back to the default", () => {
    expect(sanitizeSandbox(undefined)).toBe(DEFAULT_SANDBOX);
    expect(sanitizeSandbox("")).toBe(DEFAULT_SANDBOX);
    expect(sanitizeSandbox("allow-top-navigation")).toBe(DEFAULT_SANDBOX);
  });
});

describe("F3 postMessage bridge fails closed and verifies the source window", () => {
  const iframeWindow = { id: "iframe" };
  const collect = (allowedOrigins: unknown) => {
    const got: unknown[] = [];
    const handler = createBridgeHandler({
      allowedOrigins,
      getIframeWindow: () => iframeWindow,
      onCallback: (p) => got.push(p),
    });
    return { got, handler };
  };
  test("empty allowed_origins accepts nothing", () => {
    const { got, handler } = collect([]);
    handler({ origin: "https://evil.com", source: iframeWindow, data: { event: "payment_success" } });
    expect(got).toHaveLength(0);
  });
  test("wrong origin rejected", () => {
    const { got, handler } = collect(["https://ok.com"]);
    handler({ origin: "https://evil.com", source: iframeWindow, data: { event: "x" } });
    expect(got).toHaveLength(0);
  });
  test("right origin but foreign source window rejected", () => {
    const { got, handler } = collect(["https://ok.com"]);
    handler({ origin: "https://ok.com", source: { foreign: true }, data: { type: "x" } });
    expect(got).toHaveLength(0);
  });
  test("a script/SDK widget without an iframe is accepted only from an allowed origin", () => {
    const got: unknown[] = [];
    const handler = createBridgeHandler({
      allowedOrigins: ["https://ok.com"],
      getIframeWindow: () => null,
      onCallback: (p) => got.push(p),
    });
    handler({ origin: "https://evil.com", source: null, data: { event: "x" } });
    expect(got).toHaveLength(0);
    handler({ origin: "https://ok.com", source: null, data: { event: "x" } });
    expect(got).toHaveLength(1);
  });
  test("valid message is forwarded with a whitelisted payload shape", () => {
    const { got, handler } = collect(["https://ok.com/"]);
    handler({
      origin: "https://ok.com",
      source: iframeWindow,
      data: { event: "complete", status: "PAID", nested: { a: 1 }, "bad key": 1, fn: () => 1 },
    });
    expect(got).toEqual([{ event: "complete", data: { status: "PAID" } }]);
  });
  test("non-https and invalid origins are dropped from the list", () => {
    expect(normalizeOrigins(["http://ok.com", "*", "https://ok.com", "nonsense"])).toEqual(["https://ok.com"]);
    expect(normalizeOrigins("https://ok.com")).toEqual([]);
  });
  test("payload sanitizer rejects non-objects and bad event names and caps strings", () => {
    expect(sanitizeBridgePayload("str")).toBeNull();
    expect(sanitizeBridgePayload([1])).toBeNull();
    expect(sanitizeBridgePayload({ event: "<script>" })).toBeNull();
    expect(sanitizeBridgePayload({ event: "a".repeat(100) })).toBeNull();
    expect((sanitizeBridgePayload({ foo: "a".repeat(1000) })!.data.foo as string).length).toBe(256);
  });
});

describe("F4 redirect allow-list", () => {
  const allow = ["allowed.example"];
  test("bare * is never accepted", () => expect(isAllowedRedirect("https://evil.com", ["*"], false)).toBe(false));
  test("http rejected for non-local hosts", () => {
    expect(isAllowedRedirect("http://allowed.example", allow, false)).toBe(false);
    expect(isAllowedRedirect("http://allowed.example", allow, true)).toBe(false);
  });
  test("http allowed only for localhost in dev", () => {
    expect(isAllowedRedirect("http://localhost:3000/x", ["localhost"], true)).toBe(true);
    expect(isAllowedRedirect("http://localhost:3000/x", ["localhost"], false)).toBe(false);
  });
  test("ftp rejected", () => expect(isAllowedRedirect("ftp://allowed.example/x", allow, false)).toBe(false));
  test("lookalikes, subdomains and suffix tricks rejected", () => {
    for (const u of [
      "https://allowed.example.evil.com",
      "https://evilallowed.example",
      "https://evil.allowed.example",
    ])
      expect(isAllowedRedirect(u, allow, false)).toBe(false);
  });
  test("userinfo rejected", () => {
    expect(isAllowedRedirect("https://allowed.example@evil.com", allow, false)).toBe(false);
    expect(isAllowedRedirect("https://user:pw@allowed.example/", allow, false)).toBe(false);
  });
  test("protocol-relative and relative URLs rejected", () => {
    expect(isAllowedRedirect("//evil.com/x", allow, false)).toBe(false);
    expect(isAllowedRedirect("/relative", allow, false)).toBe(false);
  });
  test("exact https host accepted", () =>
    expect(isAllowedRedirect("https://allowed.example/path?q=1", allow, false)).toBe(true));
});

describe("F5 deep link sanitiser", () => {
  test("javascript, data, vbscript and http are rejected", () => {
    for (const u of [
      "javascript:alert(document.domain)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "http://x.example",
      " javascript:alert(1)",
    ])
      expect(safeDeepLink(u)).toBeNull();
  });
  test("https and listed app schemes accepted", () => {
    expect(safeDeepLink("https://wallet.example/pay?x=1")).toBe("https://wallet.example/pay?x=1");
    expect(safeDeepLink("moamalat://pay?id=1")).toBe("moamalat://pay?id=1");
    expect(safeDeepLink("unknownapp://x")).toBeNull();
  });
  test("credentials and empty or non-string values rejected", () => {
    expect(safeDeepLink("https://u:p@wallet.example/")).toBeNull();
    expect(safeDeepLink("")).toBeNull();
    expect(safeDeepLink(undefined)).toBeNull();
  });
});

describe("F6 idempotency key and attempt resume", () => {
  test("same intent gives the same key across calls; another scope gives another key", () => {
    const st = memoryStorage();
    const a = getOrCreateIdempotencyKey("initiate", "linkA", st);
    expect(getOrCreateIdempotencyKey("initiate", "linkA", st)).toBe(a);
    expect(getOrCreateIdempotencyKey("initiate", "linkB", st)).not.toBe(a);
  });
  test("key is a crypto UUID", () => {
    expect(getOrCreateIdempotencyKey("initiate", "x", memoryStorage())).toMatch(
      /^chk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  test("works without storage", () => {
    expect(getOrCreateIdempotencyKey("initiate", "x", null)).toMatch(/^chk-/);
  });
  test("attempt id persists for resume and can be cleared", () => {
    const st = memoryStorage();
    expect(loadAttemptId("L", st)).toBeNull();
    saveAttemptId("L", "att-1", st);
    expect(loadAttemptId("L", st)).toBe("att-1");
    clearAttemptId("L", st);
    expect(loadAttemptId("L", st)).toBeNull();
  });
});

describe("error display never shows raw server text", () => {
  test("codes map to catalogue keys; unknown codes map to the generic message", () => {
    expect(errorKeyForCode("RATE_LIMITED")).toBe("Too Many Requests");
    expect(errorKeyForCode("some-unknown-code", 500)).toBe("Something went wrong");
    expect(errorKeyForCode(undefined, 429)).toBe("Too Many Requests");
    expect(errorKeyForCode("network-error", 0)).toBe("Network Error Try Again");
  });
  test("every mapped key exists in the EN and AR catalogue", () => {
    for (const key of ERROR_CATALOGUE_KEYS) {
      const entry = appCatalogue[key];
      expect(entry, key).toBeDefined();
      expect(entry![0].trim().length).toBeGreaterThan(0);
      expect(entry![1].trim().length).toBeGreaterThan(0);
    }
  });
});
