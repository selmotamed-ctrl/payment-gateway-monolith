import { describe, expect, test } from "bun:test";
import {
  DEFAULT_KYB_REFRESH_POLICY,
  daysUntilExpiry,
  duplicateJustificationRequired,
  expiryState,
  isKybDocumentActionable,
  mergeInfoRequestItems,
  nextKybReviewAt,
  parseKybRefreshPolicy,
  payoutOwnerMismatch,
} from "../lib/kybReview";
import { requiredDocumentsFromSetting } from "../lib/joinRequestOnboarding";

const now = new Date("2026-11-01T10:00:00.000Z");

describe("KYB review rules", () => {
  test("expiry state distinguishes expired, due soon, valid and no expiry", () => {
    expect(expiryState(new Date("2026-10-31T00:00:00.000Z"), now)).toBe("EXPIRED");
    expect(expiryState(new Date("2026-11-15T00:00:00.000Z"), now)).toBe("DUE_SOON");
    expect(expiryState(new Date("2027-01-01T00:00:00.000Z"), now)).toBe("VALID");
    expect(expiryState(null, now)).toBe("NONE");
    expect(daysUntilExpiry(new Date("2026-11-03T00:00:00.000Z"), now)).toBe(2);
  });

  test("only an uploaded clean unexpired document is actionable", () => {
    expect(isKybDocumentActionable({ status: "UPLOADED", avStatus: "CLEAN", expiresOn: null }, now)).toBe(true);
    expect(isKybDocumentActionable({ status: "UPLOADED", avStatus: "PENDING", expiresOn: null }, now)).toBe(false);
    expect(isKybDocumentActionable({ status: "ACCEPTED", avStatus: "CLEAN", expiresOn: null }, now)).toBe(false);
    expect(isKybDocumentActionable({ status: "UPLOADED", avStatus: "CLEAN", expiresOn: new Date("2026-10-01T00:00:00.000Z") }, now)).toBe(false);
  });

  test("accepting a duplicate requires a written justification", () => {
    expect(duplicateJustificationRequired({ decision: "ACCEPTED", duplicateMerchantCount: 1, justification: "short" })).toBe(true);
    expect(duplicateJustificationRequired({ decision: "ACCEPTED", duplicateMerchantCount: 1, justification: "The account holder is the legal entity and the bank confirmed the copy." })).toBe(false);
    expect(duplicateJustificationRequired({ decision: "REJECTED", duplicateMerchantCount: 1, justification: "" })).toBe(false);
    expect(duplicateJustificationRequired({ decision: "ACCEPTED", duplicateMerchantCount: 0, justification: "" })).toBe(false);
  });

  test("the payout holder comparison tolerates punctuation and case", () => {
    expect(payoutOwnerMismatch({
      payoutBankDetails: { holder: "Al Waha Pharmacy LLC" },
      legalName: "AL-WAHA PHARMACY, LLC",
      tradeName: null,
    })).toBe(false);
    expect(payoutOwnerMismatch({
      payoutBankDetails: { holder: "Personal Account" },
      legalName: "Al Waha Pharmacy LLC",
      tradeName: "Al Waha",
    })).toBe(true);
  });

  test("required documents can be configured by business category", () => {
    const setting = {
      default: ["COMMERCIAL_REGISTRY", "TAX_CERTIFICATE"],
      byCategory: { CRYPTO: ["COMMERCIAL_REGISTRY", "SECTOR_LICENSE", "BANK_LETTER"] },
    };
    expect(requiredDocumentsFromSetting(setting, "CRYPTO")).toEqual([
      "COMMERCIAL_REGISTRY", "SECTOR_LICENSE", "BANK_LETTER",
    ]);
    expect(requiredDocumentsFromSetting(setting, "RETAIL")).toEqual([
      "COMMERCIAL_REGISTRY", "TAX_CERTIFICATE",
    ]);
  });

  test("the refresh policy and next review are deterministic", () => {
    const policy = parseKybRefreshPolicy({ highMonths: 6, standardMonths: 12, lowMonths: 24 });
    expect(policy.highMonths).toBe(6);
    expect(policy.expiryGraceDays).toBe(DEFAULT_KYB_REFRESH_POLICY.expiryGraceDays);
    expect(nextKybReviewAt("HIGH", now, policy).toISOString()).toBe("2027-05-01T10:00:00.000Z");
    expect(nextKybReviewAt("STANDARD", now, policy).toISOString()).toBe("2027-11-01T10:00:00.000Z");
  });

  test("info-request items merge without dropping an earlier request", () => {
    const merged = mergeInfoRequestItems(
      [{ field: "TAX_CERTIFICATE", message: "Please re-upload." }],
      [{ field: "BANK_LETTER", message: "Please upload a current bank letter." }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.field)).toEqual(["TAX_CERTIFICATE", "BANK_LETTER"]);
  });
});
