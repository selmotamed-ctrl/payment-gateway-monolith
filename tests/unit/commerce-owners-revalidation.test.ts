import { describe, expect, test } from "vitest";
import {
  activeOwnershipTotal,
  buildOwnerBody,
  emptyOwnerForm,
  ownerFormFrom,
  validateOwnerForm,
  type MerchantOwnerRecord,
} from "@/pages/merchants/ownerForm";
import { buildRevalidationBody, emptyRevalidationForm, validateRevalidation } from "@/pages/merchants/revalidation";

const owner = (overrides: Partial<MerchantOwnerRecord> = {}): MerchantOwnerRecord => ({
  id: "o1",
  fullNameAr: "أحمد علي",
  fullNameEn: "Ahmed Ali",
  role: "OWNER",
  ownershipPercent: "40.00",
  nationality: "LY",
  pepDeclared: false,
  screeningStatus: "CLEAR",
  active: true,
  dateOfBirth: "1980-01-31T00:00:00.000Z",
  ...overrides,
});

describe("beneficial owner form", () => {
  test("a new owner needs a name and an identity number", () => {
    const errors = validateOwnerForm(emptyOwnerForm(), false);
    expect(errors.fullName).toBeTruthy();
    expect(errors.identityNumber).toBeTruthy();
  });

  test("a valid owner passes", () => {
    const form = { ...emptyOwnerForm(), fullName: "أحمد علي", identityNumber: "119800123456", ownershipPercent: "25.5", dateOfBirth: "1980-01-31" };
    expect(validateOwnerForm(form, false)).toEqual({});
  });

  test("validates percent, nationality and birth date shape", () => {
    const base = { ...emptyOwnerForm(), fullName: "Ahmed", identityNumber: "123456" };
    expect(validateOwnerForm({ ...base, ownershipPercent: "101" }, false).ownershipPercent).toBeTruthy();
    expect(validateOwnerForm({ ...base, ownershipPercent: "12.345" }, false).ownershipPercent).toBeTruthy();
    expect(validateOwnerForm({ ...base, ownershipPercent: "abc" }, false).ownershipPercent).toBeTruthy();
    expect(validateOwnerForm({ ...base, nationality: "LBY" }, false).nationality).toBeTruthy();
    expect(validateOwnerForm({ ...base, dateOfBirth: "31/01/1980" }, false).dateOfBirth).toBeTruthy();
    expect(validateOwnerForm({ ...base, ownershipPercent: "100" }, false)).toEqual({});
  });

  test("editing never echoes the identity number and does not require it", () => {
    const form = ownerFormFrom(owner());
    expect(form.identityNumber).toBe("");
    expect(form.fullName).toBe("أحمد علي");
    expect(form.dateOfBirth).toBe("1980-01-31");
    expect(validateOwnerForm(form, true)).toEqual({});
    const body = buildOwnerBody(form, true);
    expect(body).not.toHaveProperty("identityNumber");
    expect(body).not.toHaveProperty("identityType");
  });

  test("a new identity number on edit replaces the stored one", () => {
    const body = buildOwnerBody({ ...ownerFormFrom(owner()), identityNumber: "998877665" }, true);
    expect(body).toMatchObject({ identityType: "NATIONAL_ID", identityNumber: "998877665" });
  });

  test("create body trims, uppercases the country and drops blank optionals", () => {
    const body = buildOwnerBody({ ...emptyOwnerForm(), fullName: " Ahmed ", fullNameEn: "", nationality: "ly", identityNumber: " 123456 ", ownershipPercent: "", dateOfBirth: "" }, false);
    expect(body).toEqual({ fullName: "Ahmed", nationality: "LY", role: "OWNER", pepDeclared: false, identityType: "NATIONAL_ID", identityNumber: "123456" });
  });

  test("unknown roles fall back to OWNER", () => {
    expect(ownerFormFrom(owner({ role: "MYSTERY" })).role).toBe("OWNER");
  });

  test("active ownership total ignores deactivated owners and the excluded one", () => {
    const owners = [owner({ id: "a", ownershipPercent: "40.00" }), owner({ id: "b", ownershipPercent: "35.50" }), owner({ id: "c", active: false, ownershipPercent: "90" }), owner({ id: "d", ownershipPercent: null })];
    expect(activeOwnershipTotal(owners)).toBeCloseTo(75.5, 5);
    expect(activeOwnershipTotal(owners, "b")).toBeCloseTo(40, 5);
  });
});

describe("KYB revalidation request", () => {
  const now = new Date("2026-06-01T10:00:00Z");

  test("defaults to a due date two weeks out", () => {
    expect(emptyRevalidationForm(now).dueAt).toBe("2026-06-15");
  });

  test("requires a document type, a future due date and a message", () => {
    const errors = validateRevalidation({ docType: "", dueAt: "2026-05-01", message: "" }, now);
    expect(Object.keys(errors).sort()).toEqual(["docType", "dueAt", "message"]);
  });

  test("rejects malformed dates and over-long messages", () => {
    expect(validateRevalidation({ docType: "TAX_CERTIFICATE", dueAt: "15/06/2026", message: "Please upload" }, now).dueAt).toBeTruthy();
    expect(validateRevalidation({ docType: "TAX_CERTIFICATE", dueAt: "2026-06-15", message: "x".repeat(1001) }, now).message).toBeTruthy();
  });

  test("a complete form is valid and produces the request body", () => {
    const form = { docType: "COMMERCIAL_REGISTRY" as const, dueAt: "2026-06-20", message: "  Please upload the renewed registry  " };
    expect(validateRevalidation(form, now)).toEqual({});
    expect(buildRevalidationBody(form)).toEqual({ docType: "COMMERCIAL_REGISTRY", dueAt: "2026-06-20", message: "Please upload the renewed registry" });
  });
});
