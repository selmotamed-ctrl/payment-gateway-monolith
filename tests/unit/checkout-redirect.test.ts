import { describe, expect, test } from "vitest";
import { isAllowedRedirect } from "../../checkout-front/src/utils/redirect";

describe("checkout redirect allowlist", () => {
  test("rejects everything when no allowlist is configured", () => {
    expect(isAllowedRedirect("https://bank.example/pay")).toBe(false);
  });

  test("rejects javascript and data schemes", () => {
    expect(isAllowedRedirect("javascript:alert(1)", ["*"])).toBe(false);
    expect(isAllowedRedirect("data:text/html,<script>alert(1)</script>", ["*"])).toBe(false);
  });

  test("accepts an allow-listed host and rejects another host", () => {
    expect(isAllowedRedirect("https://bank.example/3ds", ["bank.example"])).toBe(true);
    expect(isAllowedRedirect("https://evil.example/3ds", ["bank.example"])).toBe(false);
  });

  test("a wildcard accepts any real host but never a script URL", () => {
    expect(isAllowedRedirect("https://anything.example", ["*"])).toBe(true);
    expect(isAllowedRedirect("https://sub.bank.example", ["bank.example"])).toBe(true);
  });
});
