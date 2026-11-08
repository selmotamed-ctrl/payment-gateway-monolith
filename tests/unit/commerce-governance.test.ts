import { describe, expect, test } from "vitest";
import {
  COMMERCE_ERROR_HINTS,
  REASON_MIN_LENGTH,
  errorCodeOf,
  errorHintFor,
  isReasonValid,
  isRestricted,
  outcomeOfResponse,
  reasonProblem,
  reasonProblemMessage,
} from "@/pages/merchants/commerceGovernance";
import { approvalActionLabel, describeApprovalPayload } from "@/pages/merchants/approvalPayload";

describe("reason validation (matches the server minimum)", () => {
  test("requires a trimmed reason of at least 10 characters", () => {
    expect(REASON_MIN_LENGTH).toBe(10);
    expect(reasonProblem("")).toBe("required");
    expect(reasonProblem("   ")).toBe("required");
    expect(reasonProblem(null)).toBe("required");
    expect(reasonProblem("too short")).toBe("too_short");
    expect(reasonProblem("   nine char ")).toBe("too_short");
    expect(reasonProblem("exactly 10")).toBeNull();
    expect(isReasonValid("a perfectly fine reason")).toBe(true);
  });

  test("rejects reasons over 500 characters", () => {
    expect(reasonProblem("x".repeat(500))).toBeNull();
    expect(reasonProblem("x".repeat(501))).toBe("too_long");
  });

  test("every problem has a message and a valid state has none", () => {
    expect(reasonProblemMessage("required")).not.toBe("");
    expect(reasonProblemMessage("too_short")).not.toBe("");
    expect(reasonProblemMessage("too_long")).not.toBe("");
    expect(reasonProblemMessage(null)).toBe("");
  });
});

describe("HTTP 202 handling", () => {
  test("202 means submitted for approval, not applied", () => {
    expect(outcomeOfResponse(202, { approvalRequestId: "apr_1", state: "PENDING_REVIEW" })).toEqual({
      kind: "approval",
      approvalRequestId: "apr_1",
      state: "PENDING_REVIEW",
    });
  });

  test("unwraps an enveloped body and tolerates a missing one", () => {
    expect(outcomeOfResponse(202, { data: { approvalRequestId: "apr_2", state: "PENDING_REVIEW" } })).toMatchObject({ kind: "approval", approvalRequestId: "apr_2" });
    expect(outcomeOfResponse(202, undefined)).toEqual({ kind: "approval", approvalRequestId: null, state: null });
  });

  test("200 and 201 are applied immediately", () => {
    expect(outcomeOfResponse(200, { wallet: {} })).toEqual({ kind: "applied" });
    expect(outcomeOfResponse(201, { revalidation: {} })).toEqual({ kind: "applied" });
  });
});

describe("error codes", () => {
  test("reads the code from the response body or the error itself", () => {
    expect(errorCodeOf({ response: { data: { code: "WALLET_INVALID_TRANSITION" } } })).toBe("WALLET_INVALID_TRANSITION");
    expect(errorCodeOf({ response: { data: { CODE: "TOKEN_ALREADY_REVOKED" } } })).toBe("TOKEN_ALREADY_REVOKED");
    expect(errorCodeOf({ code: "ERR_NETWORK" })).toBe("ERR_NETWORK");
    expect(errorCodeOf(null)).toBeNull();
    expect(errorCodeOf({ response: { data: { code: "" } } })).toBeNull();
  });

  test("tailored hints exist for every documented stable code, unknown codes fall through", () => {
    for (const code of [
      "WALLET_INVALID_TRANSITION",
      "WALLET_APPROVAL_PENDING",
      "APPLICATION_SUSPEND_MUST_BE_ALONE",
      "APPLICATION_INVALID_TRANSITION",
      "APPLICATION_NO_CHANGE",
      "APPLICATION_APPROVAL_PENDING",
      "RAIL_NOT_FOUND",
      "REDIRECT_DOMAIN_INVALID",
      "WALLET_CURRENCY_MISMATCH",
      "TOKEN_ALREADY_REVOKED",
      "PAYMENT_LINK_INVALID_TRANSITION",
      "POS_TERMINAL_INVALID_TRANSITION",
      "OWNERSHIP_PERCENT_EXCEEDED",
      "KYB_REVALIDATION_ALREADY_OPEN",
    ]) {
      expect(COMMERCE_ERROR_HINTS[code], code).toBeTruthy();
    }
    expect(errorHintFor({ response: { data: { code: "RAIL_NOT_FOUND" } } })).toBe(COMMERCE_ERROR_HINTS.RAIL_NOT_FOUND);
    expect(errorHintFor({ response: { data: { code: "SOMETHING_ELSE" } } })).toBeNull();
    expect(errorHintFor(new Error("boom"))).toBeNull();
  });
});

describe("restricted placeholder rule", () => {
  test("a field is restricted when listed or null, never when it is a real zero", () => {
    expect(isRestricted(["liveBalance"], "liveBalance", "0.0000")).toBe(true);
    expect(isRestricted([], "liveBalance", null)).toBe(true);
    expect(isRestricted(undefined, "liveBalance", null)).toBe(true);
    expect(isRestricted([], "liveBalance", "0.0000")).toBe(false);
    expect(isRestricted(["other"], "liveBalance", "12.5000")).toBe(false);
    expect(isRestricted([], "shards")).toBe(false);
  });
});

describe("approval payload rows (no raw JSON)", () => {
  test("renders a wallet unfreeze request as labelled rows without reason or action", () => {
    const rows = describeApprovalPayload({ action: "WALLET_UNFREEZE", fromStatus: "FROZEN", toStatus: "ACTIVE", reason: "customer cleared the review" });
    expect(rows.map((row) => row.key)).toEqual(["fromStatus", "toStatus"]);
    expect(rows[1]).toMatchObject({ kind: "status", value: "ACTIVE", label: "Requested status" });
  });

  test("renders an application policy change with rail and domain chips", () => {
    const rows = describeApprovalPayload({
      action: "APPLICATION_UPDATE",
      assignedWalletId: "wal_9",
      railWhitelist: ["MOCK_CARD", "BANK_TRANSFER"],
      redirectDomainAllowlist: [],
      reason: "policy refresh",
    });
    expect(rows.find((row) => row.key === "railWhitelist")).toMatchObject({ kind: "chips", value: ["MOCK_CARD", "BANK_TRANSFER"] });
    expect(rows.find((row) => row.key === "redirectDomainAllowlist")).toMatchObject({ kind: "chips", value: [], emptyLabel: "No redirect domains" });
    expect(rows.find((row) => row.key === "assignedWalletId")).toMatchObject({ kind: "mono", value: "wal_9" });
  });

  test("null rail whitelist means every rail", () => {
    const rows = describeApprovalPayload({ action: "APPLICATION_UPDATE", railWhitelist: null });
    expect(rows[0]).toMatchObject({ key: "railWhitelist", kind: "text", value: "All active rails allowed" });
  });

  test("unknown scalar keys are humanised, objects are dropped, junk input yields nothing", () => {
    const rows = describeApprovalPayload({ action: "X", someNewField: 7, nested: { a: 1 } });
    expect(rows).toEqual([{ key: "someNewField", label: "Some New Field", kind: "text", value: "7" }]);
    expect(describeApprovalPayload(null)).toEqual([]);
    expect(describeApprovalPayload([1, 2])).toEqual([]);
  });

  test("action labels are friendly with a humanised fallback", () => {
    expect(approvalActionLabel("WALLET_UNFREEZE")).toBe("Unfreeze wallet");
    expect(approvalActionLabel("POS_TERMINAL_REACTIVATE")).toBe("Reactivate POS terminal");
    expect(approvalActionLabel("SOMETHING_NEW")).toBe("Something New");
    expect(approvalActionLabel(undefined)).toBe("Change request");
  });
});
