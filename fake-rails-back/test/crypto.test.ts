import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  deriveOtp,
  deriveSecret,
  sign,
  verify,
} from "../engine/crypto/FakeCryptoSigner";

describe("FakeCryptoSigner", () => {
  test("canonicalizes sorted key/value pairs", () => {
    expect(canonicalize("SORTED_KEY_VALUE_AMP", { b: "2", a: "1" })).toBe("a=1&b=2");
  });

  test("canonicalizes sorted values", () => {
    expect(canonicalize("SORTED_VALUES_HASH", { b: "2", a: "1" })).toBe("12");
  });

  test("signs and verifies HMAC-SHA256 over sorted key/value", () => {
    const recipe = {
      algorithm: "HMAC_SHA256" as const,
      canonicalizationMode: "SORTED_KEY_VALUE_AMP" as const,
      secret: "top-secret",
      outputEncoding: "HEX_UPPER" as const,
    };
    const signature = sign(recipe, { amount: "10.00", reference: "PG-1" });
    expect(signature).toMatch(/^[0-9A-F]+$/);
    expect(verify(recipe, { reference: "PG-1", amount: "10.00" }, signature)).toBe(true);
    expect(verify(recipe, { reference: "PG-1", amount: "99.00" }, signature)).toBe(false);
  });

  test("timestamp-dot-raw-body covers the exact bytes", () => {
    const recipe = {
      algorithm: "HMAC_SHA256" as const,
      canonicalizationMode: "TIMESTAMP_DOT_RAW_BODY" as const,
      secret: "s3cret",
      outputEncoding: "HEX_LOWER" as const,
    };
    const raw = '{"a":1}';
    const signature = sign(recipe, {}, { rawBody: raw, timestamp: "1700000000" });
    expect(verify(recipe, {}, signature, { rawBody: raw, timestamp: "1700000000" })).toBe(true);
    expect(verify(recipe, {}, signature, { rawBody: '{"a":2}', timestamp: "1700000000" })).toBe(false);
  });

  test("derives deterministic gateway secrets and OTPs", () => {
    const secret = deriveSecret("seeder-token", "moamalat", "webhook");
    expect(secret).toBe(deriveSecret("seeder-token", "moamalat", "webhook"));
    expect(secret).not.toBe(deriveSecret("seeder-token", "moamalat", "sign"));
    expect(deriveOtp("seed", "edfali", "REF-1", 4)).toHaveLength(4);
    expect(deriveOtp("seed", "edfali", "REF-1", 4)).toBe(deriveOtp("seed", "edfali", "REF-1", 4));
  });
});
