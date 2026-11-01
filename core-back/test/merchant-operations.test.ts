import { describe, expect, test } from "bun:test";
import {
  MERCHANT_CLOSE_REASON_CODES,
  MERCHANT_PATCH_FIELD_SET,
  MERCHANT_SENSITIVE_FIELD_SET,
  MERCHANT_SUSPENSION_REASON_CODES,
  assertMerchantClosable,
  assertMerchantPatchFields,
  assertMerchantReinstatable,
  assertMerchantSuspendable,
  assertMerchantVersion,
  merchantPatchOperations,
  merchantVersion,
  topLevelMerchantField,
} from "../lib/merchantOps";

describe("merchant operations rules", () => {
  test("merchant versions default safely and reject stale writes", () => {
    expect(merchantVersion({ version: 3 })).toBe(3);
    expect(merchantVersion({})).toBe(1);
    expect(() => assertMerchantVersion({ version: 3 }, 2)).toThrow();
    expect(() => assertMerchantVersion({ version: 3 }, 3)).not.toThrow();
  });

  test("lifecycle actions have closed reason codes", () => {
    expect(MERCHANT_SUSPENSION_REASON_CODES).toContain("AML");
    expect(MERCHANT_CLOSE_REASON_CODES).toContain("MERCHANT_REQUEST");
    expect(() => assertMerchantSuspendable("ACTIVE")).not.toThrow();
    expect(() => assertMerchantSuspendable("PENDING")).toThrow();
    expect(() => assertMerchantReinstatable("SUSPENDED")).not.toThrow();
    expect(() => assertMerchantReinstatable("ACTIVE")).toThrow();
    expect(() => assertMerchantClosable("SUSPENDED")).not.toThrow();
    expect(() => assertMerchantClosable("CLOSED")).toThrow();
  });

  test("sensitive edit routes reject non-sensitive fields", () => {
    const operations = merchantPatchOperations({
      patch: [{ op: "replace", path: "/tradeName", value: "Not sensitive" }],
    });
    expect(MERCHANT_SENSITIVE_FIELD_SET.has("taxId")).toBe(true);
    expect(MERCHANT_PATCH_FIELD_SET.has("tradeName")).toBe(true);
    expect(() => assertMerchantPatchFields(operations, MERCHANT_SENSITIVE_FIELD_SET)).toThrow();
    expect(() => assertMerchantPatchFields(
      merchantPatchOperations({ patch: [{ op: "replace", path: "/taxId", value: "T-1" }] }),
      MERCHANT_SENSITIVE_FIELD_SET,
    )).not.toThrow();
  });

  test("nested merchant patches are rejected", () => {
    expect(topLevelMerchantField("/payoutBankDetailsJson/iban")).toBe("payoutBankDetailsJson");
    expect(() => assertMerchantPatchFields(
      merchantPatchOperations({ patch: [{ op: "replace", path: "/payoutBankDetailsJson/iban", value: "x" }] }),
      MERCHANT_SENSITIVE_FIELD_SET,
    )).toThrow();
  });
});
