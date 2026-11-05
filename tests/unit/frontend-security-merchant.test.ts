// Regression tests for the merchant-front and fake-rails-front security fixes (F9, F10, F1 POS stream, F13).
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { urlsMap } from "../../merchant-front/src/constants/urlsMap";
import { isValidPositiveAmount } from "../../merchant-front/src/utils/security/amount";
import {
  GOOGLE_REDIRECT_PATHS,
  isAllowedIdentityRedirect,
  parseIdentityHosts,
} from "../../merchant-front/src/utils/security/identityRedirect";
import { buildCheckoutUrl, resolveCheckoutBase } from "../../merchant-front/src/utils/security/checkoutUrl";
import { createSseParser, openSseStream } from "../../merchant-front/src/utils/security/sseFetch";
import { isSafeRedirectUrl, resolveCheckoutOrigin } from "../../fake-rails-front/src/utils/security";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

describe("F1 merchant POS screen stream", () => {
  test("posScreenStream resolves under /api", () => {
    const resolved = new URL(urlsMap.posScreenStream("S1"), "https://m.example.com/pos/screen/S1");
    expect(resolved.pathname).toBe("/api/v1/merchant/pos/screens/S1/stream");
  });
  test("the page streams with fetch (Authorization header), not an anonymous EventSource", () => {
    const src = read("merchant-front/src/pages/pos/screen/[code].tsx");
    expect(src).not.toContain("new EventSource");
    expect(src).toContain("Authorization");
  });
  test("SSE parser handles chunk boundaries, comments, events and CRLF", () => {
    const frames: { event: string; data: string }[] = [];
    const feed = createSseParser((f) => frames.push(f));
    feed(": keepalive\n\ndata: {\"a\"");
    feed(":1}\n\nevent: ping\r\ndata: x\r\ndata: y\r\n\r\n");
    expect(frames).toEqual([
      { event: "message", data: '{"a":1}' },
      { event: "ping", data: "x\ny" },
    ]);
  });
  test("openSseStream sends the Authorization header and delivers frames", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
        c.close();
      },
    });
    let seenHeaders: Record<string, string> = {};
    const got: string[] = [];
    await new Promise<void>((resolve) => {
      openSseStream({
        url: "/api/x",
        headers: { Authorization: "Bearer t" },
        fetchImpl: (async (_u: unknown, init: { headers: Record<string, string> }) => {
          seenHeaders = init.headers;
          return new Response(body, { status: 200 });
        }) as unknown as typeof fetch,
        onFrame: (f) => got.push(f.data),
        onClose: () => resolve(),
      });
    });
    expect(seenHeaders.Authorization).toBe("Bearer t");
    expect(got).toEqual(['{"ok":true}']);
  });
});

describe("F9 merchant api client", () => {
  const src = read("merchant-front/src/state/api/index.ts");
  test("sends its own channel", () => {
    expect(src).toContain('"X-Client-Channel"] = "merchant"');
    expect(src).not.toContain('"X-Client-Channel"] = "admin"');
  });
  test("401 handler exempts the credential endpoints", () => {
    expect(src).toContain('url.includes("/auth/login")');
    expect(src).toContain('url.includes("/auth/mfa")');
  });
  test("dead ?mat= token helper removed from admin and merchant", () => {
    expect(src).not.toContain("resolveUploadPathWithMat");
    expect(read("admin-front/src/state/api/index.ts")).not.toContain("resolveUploadPathWithMat");
  });
});

describe("F10 cash-out request", () => {
  test("amount validation (same pattern as admin adjustments)", () => {
    for (const ok of ["1", "10.5", "0.0001", "99999999999999.9999"]) expect(isValidPositiveAmount(ok), ok).toBe(true);
    for (const bad of ["", "0", "0.0000", "-1", "1e3", "1.23456", "abc", "1,5", "NaN", " ", "100000000000000", "1.", ".5"])
      expect(isValidPositiveAmount(bad), bad).toBe(false);
    expect(isValidPositiveAmount(5 as unknown as string)).toBe(false);
  });
  test("page sends an idempotency key, validates and confirms", () => {
    const src = read("merchant-front/src/pages/cashouts/index.tsx");
    expect(src).toContain("idempotencyKey:");
    expect(src).toContain("crypto.randomUUID()");
    expect(src).toContain("isValidPositiveAmount(amount.value)");
    expect(src).toContain("showConfirm(");
    expect(src).toContain("accountNumber.value");
  });
});

describe("Google sign-in redirect handling", () => {
  test("only https on an allow-listed identity host", () => {
    const hosts = parseIdentityHosts(undefined);
    expect(isAllowedIdentityRedirect("https://accounts.google.com/o/oauth2/v2/auth?x=1", hosts)).toBe(true);
    for (const bad of [
      "http://accounts.google.com/",
      "https://evil.com/",
      "https://accounts.google.com.evil.com/",
      "https://accounts.google.com@evil.com/",
      "https://u:p@accounts.google.com/",
      "javascript:alert(1)",
      "//evil.com",
      "",
      null,
    ])
      expect(isAllowedIdentityRedirect(bad, hosts), String(bad)).toBe(false);
  });
  test("hosts can be configured, comma separated", () => {
    expect(parseIdentityHosts(" Login.Example.com , sso.example.com ")).toEqual(["login.example.com", "sso.example.com"]);
    expect(parseIdentityHosts("")).toEqual(["accounts.google.com"]);
  });
  test("fixed redirectUri paths are used instead of location.href", () => {
    expect(GOOGLE_REDIRECT_PATHS).toEqual({ login: "/login", register: "/register" });
    for (const f of ["login", "register"]) {
      const src = read(`merchant-front/src/pages/public/auth/${f}/index.tsx`);
      expect(src).not.toContain("location.href");
      expect(src).toContain("isAllowedIdentityRedirect(");
    }
  });
});

describe("checkout link base URL", () => {
  test("uses the configured base, normalising trailing slashes", () => {
    expect(buildCheckoutUrl("lnk_1", "https://pay.example.ly/", "https://merchant.example.ly")).toBe(
      "https://pay.example.ly/pay/lnk_1",
    );
  });
  test("falls back to the current origin when unset or unsafe", () => {
    for (const v of [undefined, "", "javascript:alert(1)", "not a url", "https://u:p@pay.example.ly"])
      expect(resolveCheckoutBase(v, "https://merchant.example.ly/")).toBe("https://merchant.example.ly");
  });
});

describe("landing page does not leak internal names", () => {
  test("no ledger account or step action names in landing content", () => {
    const text = read("merchant-front/src/content/landing/landingModel.ts") + read("merchant-front/src/pages/public/landing/HeroDemo.tsx");
    for (const word of ["GATEWAY_CLEARING", "PLATFORM_INCOME", "MERCHANT_WALLET", "PLATFORM_CLEARING", "SHOW_OTP_FORM", "RENDER_EMBEDDED", "HTTP_REDIRECT"])
      expect(text).not.toContain(word);
  });
});

describe("F13 fake-rails-front", () => {
  test("postMessage target origin is never *", () => {
    expect(resolveCheckoutOrigin("https://checkout.example/path")).toBe("https://checkout.example");
    expect(resolveCheckoutOrigin(undefined, "https://parent.example")).toBe("https://parent.example");
    expect(resolveCheckoutOrigin(undefined, undefined, "https://ref.example/page?x=1")).toBe("https://ref.example");
    expect(resolveCheckoutOrigin("*", "", "")).toBeNull();
    expect(resolveCheckoutOrigin("javascript:x")).toBeNull();
    expect(read("fake-rails-front/src/pages/hosted/widget-frame.tsx")).not.toContain('}, "*")');
  });
  test("redirect_url is validated before navigation", () => {
    expect(isSafeRedirectUrl("https://shop.example/return?x=1")).toBe(true);
    expect(isSafeRedirectUrl("http://localhost:3000/return")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.com", "/relative", "https://u:p@x.example", "", null])
      expect(isSafeRedirectUrl(bad), String(bad)).toBe(false);
    expect(read("fake-rails-front/src/pages/hosted/redirect/[sessionId].tsx")).toContain("isSafeRedirectUrl(result.redirect_url)");
  });
});
