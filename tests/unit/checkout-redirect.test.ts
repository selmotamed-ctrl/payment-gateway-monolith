import { describe, expect, test } from "vitest";
import { isAllowedRedirect } from "../../checkout-front/src/utils/redirect";

describe("checkout redirect allowlist", () => {
  test("rejects everything when no allowlist is configured", () => {
    expect(isAllowedRedirect("https://bank.example/pay")).toBe(false);
  });

  test("rejects javascript and data schemes", () => {
    expect(isAllowedRedirect("javascript:alert(1)", ["bank.example"])).toBe(false);
    expect(isAllowedRedirect("data:text/html,<script>alert(1)</script>", ["bank.example"])).toBe(false);
  });

  test("accepts an allow-listed host and rejects another host", () => {
    expect(isAllowedRedirect("https://bank.example/3ds", ["bank.example"], false)).toBe(true);
    expect(isAllowedRedirect("https://evil.example/3ds", ["bank.example"], false)).toBe(false);
  });

  // Behaviour change: a bare `*` used to accept any real host (an allow-list entry from the
  // server could silently turn the open-redirect guard off). `*` is now never a match, and
  // subdomains only match through an explicit `*.host` entry.
  test("a bare wildcard never matches any host", () => {
    expect(isAllowedRedirect("https://anything.example", ["*"], false)).toBe(false);
    expect(isAllowedRedirect("javascript:alert(1)", ["*"], false)).toBe(false);
  });

  test("subdomains need an explicit *.host entry; exact entries do not match subdomains", () => {
    expect(isAllowedRedirect("https://sub.bank.example", ["bank.example"], false)).toBe(false);
    expect(isAllowedRedirect("https://sub.bank.example", ["*.bank.example"], false)).toBe(true);
    expect(isAllowedRedirect("https://bank.example", ["*.bank.example"], false)).toBe(false);
    expect(isAllowedRedirect("https://evilbank.example", ["*.bank.example"], false)).toBe(false);
  });
});
