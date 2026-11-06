import { describe, expect, test } from "vitest";
import { commerceCatalogue } from "@/constants/i18n/commerce";
import { COMMERCE_ERROR_HINTS, reasonProblemMessage } from "@/pages/merchants/commerceGovernance";
import { APPROVAL_ACTION_LABELS, describeApprovalPayload } from "@/pages/merchants/approvalPayload";
import { KYB_DOC_TYPE_LABELS, validateRevalidation } from "@/pages/merchants/revalidation";
import { emptyOwnerForm, validateOwnerForm, OWNER_ROLES, OWNER_IDENTITY_TYPES } from "@/pages/merchants/ownerForm";
import { walletActionsFor } from "@/pages/wallets/walletActions";
import {
  addRedirectDomains,
  applicationActionsFor,
  buildPolicyPatch,
  buildRailWhitelist,
  normalizeRedirectDomain,
  paymentLinkActionsFor,
  posActionsFor,
  tokenActionsFor,
} from "@/pages/applications/applicationActions";

const ARABIC = /[؀-ۿ]/;
const entries = Object.entries(commerceCatalogue);

describe("commerce catalogue (EN/AR sync)", () => {
  test("is not empty", () => {
    expect(entries.length).toBeGreaterThan(200);
  });

  test("every key has a non-empty English and Arabic value", () => {
    for (const [key, pair] of entries) {
      expect(pair, key).toHaveLength(2);
      expect(pair[0].trim(), `${key} (EN)`).not.toBe("");
      expect(pair[1].trim(), `${key} (AR)`).not.toBe("");
    }
  });

  test("Arabic values are real Arabic (not a copy of the English text)", () => {
    const allowedSame = new Set(["MFA", "POS"]);
    for (const [key, pair] of entries) {
      if (allowedSame.has(key)) continue;
      expect(ARABIC.test(pair[1]), `${key} has no Arabic letters`).toBe(true);
      expect(pair[1], `${key} is untranslated`).not.toBe(pair[0]);
    }
  });

  test("the English value equals the key unless the key is an enum token", () => {
    for (const [key, pair] of entries) {
      if (/^[A-Z0-9_]+$/.test(key) && key.length > 3) continue;
      expect(pair[0], key).toBe(key);
    }
  });

  test("numbers and placeholders survive translation", () => {
    for (const [key, pair] of entries) {
      const digits = (value: string) => (value.match(/\d+/g) ?? []).join(",");
      expect(digits(pair[1]), key).toBe(digits(pair[0]));
    }
  });
});

describe("every message key produced by the commerce logic is catalogued", () => {
  const messages = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value) messages.add(value);
  };

  add(reasonProblemMessage("required"));
  add(reasonProblemMessage("too_short"));
  add(reasonProblemMessage("too_long"));
  for (const hint of Object.values(COMMERCE_ERROR_HINTS)) add(hint);
  for (const label of Object.values(APPROVAL_ACTION_LABELS)) add(label);
  for (const label of Object.values(KYB_DOC_TYPE_LABELS)) add(label);
  add("Change request");
  add("Current status");
  add("Requested status");
  add("New settlement wallet");
  add("All active rails allowed");
  add("No rails allowed");
  add("No redirect domains");

  for (const status of ["ACTIVE", "FROZEN", "PENDING", "CLOSED"]) {
    for (const action of walletActionsFor(status, { canWrite: true, hasPendingApproval: true })) {
      add(action.label);
      add(action.disabledReason);
    }
  }
  for (const status of ["ACTIVE", "SUSPENDED", "CLOSED"]) {
    for (const action of applicationActionsFor(status, { canWrite: true, hasPendingApproval: true })) {
      add(action.label);
      add(action.disabledReason);
    }
  }
  for (const action of tokenActionsFor("ACTIVE", true)) add(action.label);
  for (const action of paymentLinkActionsFor("PENDING", true)) add(action.label);
  for (const status of ["ACTIVE", "INACTIVE", "BLOCKED"]) for (const action of posActionsFor(status, true)) add(action.label);

  for (const bad of ["", "x".repeat(300), "http://x.ly", "not a domain"]) {
    const result = normalizeRedirectDomain(bad);
    if (!result.ok) add(result.error);
  }
  add(addRedirectDomains(Array.from({ length: 100 }, (_, i) => `d${i}.example.ly`), "extra.example.ly").errors[0]?.error);
  const noRails = buildRailWhitelist("LIST", []);
  if (!noRails.ok) add(noRails.error);
  const tooMany = buildRailWhitelist("LIST", Array.from({ length: 201 }, (_, i) => `R${i}`));
  if (!tooMany.ok) add(tooMany.error);
  const unchanged = buildPolicyPatch({ assignedWalletId: "w", railWhitelist: null, redirectDomains: [] }, { assignedWalletId: "w", railMode: "ALL", railCodes: [], redirectDomains: [] });
  if (!unchanged.ok) add(unchanged.error);

  for (const error of Object.values(validateRevalidation({ docType: "", dueAt: "bad", message: "" }))) add(error);
  add(validateRevalidation({ docType: "OTHER", dueAt: "2000-01-01", message: "ok ok" }).dueAt);
  add(validateRevalidation({ docType: "OTHER", dueAt: "2999-01-01", message: "x".repeat(1001) }).message);
  for (const error of Object.values(validateOwnerForm(emptyOwnerForm(), false))) add(error);
  const invalid = { ...emptyOwnerForm(), fullName: "ab", fullNameEn: "x", identityNumber: "1", nationality: "LBY", dateOfBirth: "bad", ownershipPercent: "abc" };
  for (const error of Object.values(validateOwnerForm(invalid, false))) add(error);
  add(validateOwnerForm({ ...emptyOwnerForm(), fullName: "Ahmed", identityNumber: "123456", ownershipPercent: "150" }, false).ownershipPercent);
  add(validateOwnerForm({ ...emptyOwnerForm(), fullName: "x".repeat(161), identityNumber: "123456" }, false).fullName);
  for (const role of OWNER_ROLES) add(role);
  for (const type of OWNER_IDENTITY_TYPES) add(type);
  for (const row of describeApprovalPayload({ action: "APPLICATION_UPDATE", fromStatus: "SUSPENDED", toStatus: "ACTIVE", assignedWalletId: "w", railWhitelist: null, redirectDomainAllowlist: [] })) {
    add(row.label);
    if (row.kind === "text") add(row.value);
    if (row.kind === "chips") add(row.emptyLabel);
  }

  test.each([...messages].sort())("%s", (message) => {
    expect(commerceCatalogue[message], `missing catalogue entry: ${message}`).toBeDefined();
  });
});
