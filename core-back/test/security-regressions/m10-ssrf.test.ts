import { describe, expect, test } from "bun:test";
import { compileUrl, validateFinalUrl } from "../../engine/apiConsumer/compileUrl";
import { isPublicIpAddress } from "../../engine/apiConsumer/ApiConsumer";

const tryCompile = (url: string, options?: Parameters<typeof compileUrl>[2]): string => {
  try {
    return compileUrl(url, undefined, options);
  } catch {
    return "";
  }
};

describe("M10 compileUrl fails closed on an empty allowlist", () => {
  test("an empty allowlist does not accept an arbitrary https host", () => {
    expect(tryCompile("https://attacker.example/steal", { allowedHosts: [] })).toBe("");
  });

  test("undefined allowedHosts does not accept it either", () => {
    expect(tryCompile("https://attacker.example/x")).toBe("");
  });

  test("explicit opt-out (allowAnyHost) is the only way to run without an allowlist", () => {
    expect(tryCompile("https://partner.example/x", { allowAnyHost: true })).toBe("https://partner.example/x");
  });

  test("control: a listed host passes and an unlisted host is refused", () => {
    expect(tryCompile("https://api.partner.example/pay", { allowedHosts: ["api.partner.example"] })).toBe("https://api.partner.example/pay");
    expect(tryCompile("https://other.example/pay", { allowedHosts: ["api.partner.example"] })).toBe("");
  });

  for (const url of [
    "https://127.0.0.1/", "https://10.0.0.5/", "https://169.254.169.254/latest/meta-data",
    "https://[::1]/", "https://192.168.1.1/", "https://localhost/", "https://172.16.0.1/",
  ]) {
    test(`private literal ${url} is rejected even with allowAnyHost`, () => {
      expect(tryCompile(url, { allowAnyHost: true })).toBe("");
    });

    test(`private literal ${url} is rejected even when allowlisted`, () => {
      const host = new URL(url).host;
      expect(tryCompile(url, { allowedHosts: [host] })).toBe("");
    });
  }

  test("the scoped Fake Rails relaxation (allowPrivateHosts + allowlisted host) still works", () => {
    expect(tryCompile("http://127.0.0.1:4000/x", { allowedHosts: ["127.0.0.1:4000"], allowPrivateHosts: true, requireHttps: false }))
      .toBe("http://127.0.0.1:4000/x");
  });

  test("validateFinalUrl enforces the same rules", () => {
    expect(() => validateFinalUrl("https://attacker.example/x", { allowedHosts: [] })).toThrow();
  });

  test("downstream guard isPublicIpAddress still blocks private literals", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "192.168.1.1", "::ffff:127.0.0.1"]) {
      expect(isPublicIpAddress(ip)).toBe(false);
    }
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
  });
});
