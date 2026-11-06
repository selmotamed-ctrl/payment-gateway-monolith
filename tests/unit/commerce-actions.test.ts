import { describe, expect, test } from "vitest";
import { walletActionsFor } from "@/pages/wallets/walletActions";
import {
  addRedirectDomains,
  applicationActionsFor,
  buildPolicyPatch,
  buildRailWhitelist,
  normalizeRedirectDomain,
  paymentLinkActionsFor,
  posActionsFor,
  railChoices,
  railCodeFromOptionTitle,
  railWhitelistModeOf,
  splitDomainInput,
  tokenActionsFor,
} from "@/pages/applications/applicationActions";

describe("wallet containment governance", () => {
  test("freezing an active wallet is immediate", () => {
    const [action] = walletActionsFor("ACTIVE", { canWrite: true });
    expect(action).toMatchObject({ key: "freeze", targetStatus: "FROZEN", mode: "immediate", danger: true, disabled: false });
  });

  test("unfreezing needs approval and is blocked while one is pending", () => {
    const [free] = walletActionsFor("FROZEN", { canWrite: true });
    expect(free).toMatchObject({ key: "unfreeze", targetStatus: "ACTIVE", mode: "approval", disabled: false });
    const [blocked] = walletActionsFor("FROZEN", { canWrite: true, hasPendingApproval: true });
    expect(blocked.disabled).toBe(true);
    expect(blocked.disabledReason).toBeTruthy();
  });

  test("no actions without merchant:write or for pending/closed wallets", () => {
    expect(walletActionsFor("ACTIVE", { canWrite: false })).toEqual([]);
    expect(walletActionsFor("PENDING", { canWrite: true })).toEqual([]);
    expect(walletActionsFor("CLOSED", { canWrite: true })).toEqual([]);
  });
});

describe("application / token / link / POS governance", () => {
  test("suspend is immediate, reactivate and policy edits are approvals", () => {
    const active = applicationActionsFor("ACTIVE", { canWrite: true });
    expect(active.map((action) => [action.key, action.mode])).toEqual([
      ["suspend", "immediate"],
      ["editPolicy", "approval"],
    ]);
    const suspended = applicationActionsFor("SUSPENDED", { canWrite: true });
    expect(suspended.map((action) => [action.key, action.mode, action.target])).toEqual([
      ["reactivate", "approval", "ACTIVE"],
      ["editPolicy", "approval", "SUSPENDED"],
    ]);
  });

  test("a pending approval disables the approval actions only", () => {
    const actions = applicationActionsFor("ACTIVE", { canWrite: true, hasPendingApproval: true });
    expect(actions.find((action) => action.key === "suspend")?.disabled).toBe(false);
    expect(actions.find((action) => action.key === "editPolicy")?.disabled).toBe(true);
  });

  test("closed applications and read-only users get nothing", () => {
    expect(applicationActionsFor("CLOSED", { canWrite: true })).toEqual([]);
    expect(applicationActionsFor("ACTIVE", { canWrite: false })).toEqual([]);
  });

  test("token revocation is immediate, irreversible and unavailable once revoked", () => {
    expect(tokenActionsFor("ACTIVE", true)[0]).toMatchObject({ mode: "immediate", irreversible: true, danger: true });
    expect(tokenActionsFor("REVOKED", true)).toEqual([]);
    expect(tokenActionsFor("ACTIVE", false)).toEqual([]);
  });

  test("only a pending payment link can be cancelled", () => {
    expect(paymentLinkActionsFor("PENDING", true)[0]).toMatchObject({ target: "CANCELLED", mode: "immediate" });
    for (const state of ["COMPLETED", "EXPIRED", "CANCELLED"]) expect(paymentLinkActionsFor(state, true)).toEqual([]);
  });

  test("POS: tighten immediately, loosen via approval", () => {
    expect(posActionsFor("ACTIVE", true).map((action) => [action.target, action.mode])).toEqual([
      ["INACTIVE", "immediate"],
      ["BLOCKED", "immediate"],
    ]);
    expect(posActionsFor("INACTIVE", true).map((action) => [action.target, action.mode])).toEqual([
      ["BLOCKED", "immediate"],
      ["ACTIVE", "approval"],
    ]);
    expect(posActionsFor("BLOCKED", true).map((action) => [action.target, action.mode])).toEqual([["ACTIVE", "approval"]]);
    expect(posActionsFor("ACTIVE", false)).toEqual([]);
  });
});

describe("redirect domains", () => {
  test("accepts hostnames and https origins, normalised to lowercase", () => {
    expect(normalizeRedirectDomain("Shop.Example.LY")).toEqual({ ok: true, value: "shop.example.ly" });
    expect(normalizeRedirectDomain("https://Shop.Example.ly")).toEqual({ ok: true, value: "https://shop.example.ly" });
    expect(normalizeRedirectDomain("https://shop.example.ly/")).toEqual({ ok: true, value: "https://shop.example.ly" });
    expect(normalizeRedirectDomain("localhost")).toEqual({ ok: true, value: "localhost" });
  });

  test("rejects paths, http, credentials, queries and junk", () => {
    for (const bad of ["http://shop.example.ly", "https://shop.example.ly/path", "https://u:p@shop.example.ly", "https://shop.example.ly?x=1", "not a domain", "-bad.example.ly", ""]) {
      expect(normalizeRedirectDomain(bad).ok, bad).toBe(false);
    }
  });

  test("splits pasted input on commas, whitespace and newlines", () => {
    expect(splitDomainInput("a.ly, b.ly\nc.ly;  d.ly")).toEqual(["a.ly", "b.ly", "c.ly", "d.ly"]);
  });

  test("adds valid entries, de-duplicates and reports each rejected one", () => {
    const result = addRedirectDomains(["a.example.ly"], "A.example.ly, b.example.ly, http://bad.example.ly");
    expect(result.domains).toEqual(["a.example.ly", "b.example.ly"]);
    expect(result.added).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].input).toBe("http://bad.example.ly");
  });

  test("caps the list at 100 domains", () => {
    const current = Array.from({ length: 100 }, (_, index) => `d${index}.example.ly`);
    const result = addRedirectDomains(current, "extra.example.ly");
    expect(result.domains).toHaveLength(100);
    expect(result.errors).toHaveLength(1);
  });
});

describe("rail whitelist", () => {
  test("null = all rails, [] = none, list = unique codes", () => {
    expect(railWhitelistModeOf(null)).toBe("ALL");
    expect(railWhitelistModeOf(undefined)).toBe("ALL");
    expect(railWhitelistModeOf([])).toBe("NONE");
    expect(railWhitelistModeOf(["A"])).toBe("LIST");
    expect(buildRailWhitelist("ALL", ["A"])).toEqual({ ok: true, value: null });
    expect(buildRailWhitelist("NONE", ["A"])).toEqual({ ok: true, value: [] });
    expect(buildRailWhitelist("LIST", ["A", " A ", "B", ""])).toEqual({ ok: true, value: ["A", "B"] });
    expect(buildRailWhitelist("LIST", []).ok).toBe(false);
  });

  test("extracts the rail code from the option title, falls back to whitelisted codes", () => {
    expect(railCodeFromOptionTitle("Mock Card (MOCK_CARD)")).toBe("MOCK_CARD");
    expect(railCodeFromOptionTitle("No code here")).toBeNull();
    expect(railChoices([{ title: "Bank Transfer (BANK_TRANSFER)" }, { title: "Mock Card (MOCK_CARD)" }, { title: "Broken" }], ["LEGACY"])).toEqual([
      { code: "BANK_TRANSFER", title: "Bank Transfer (BANK_TRANSFER)" },
      { code: "LEGACY", title: "LEGACY" },
      { code: "MOCK_CARD", title: "Mock Card (MOCK_CARD)" },
    ]);
  });
});

describe("policy patch", () => {
  const current = { assignedWalletId: "w1", railWhitelist: ["A", "B"] as string[] | null, redirectDomains: ["a.example.ly"] };

  test("sends only what changed", () => {
    const result = buildPolicyPatch(current, { assignedWalletId: "w2", railMode: "LIST", railCodes: ["B", "A"], redirectDomains: ["a.example.ly"] });
    expect(result).toEqual({ ok: true, patch: { assignedWalletId: "w2" }, changed: ["assignedWalletId"] });
  });

  test("whitelist order does not count as a change, mode switch does", () => {
    expect(buildPolicyPatch(current, { assignedWalletId: "w1", railMode: "LIST", railCodes: ["B", "A"], redirectDomains: ["a.example.ly"] }).ok).toBe(false);
    const all = buildPolicyPatch(current, { assignedWalletId: "w1", railMode: "ALL", railCodes: [], redirectDomains: ["a.example.ly"] });
    expect(all).toMatchObject({ ok: true, patch: { railWhitelist: null } });
    const none = buildPolicyPatch(current, { assignedWalletId: "w1", railMode: "NONE", railCodes: [], redirectDomains: ["a.example.ly"] });
    expect(none).toMatchObject({ ok: true, patch: { railWhitelist: [] } });
  });

  test("detects a domain change and deduplicates the list", () => {
    const result = buildPolicyPatch(current, { assignedWalletId: "w1", railMode: "LIST", railCodes: ["A", "B"], redirectDomains: ["a.example.ly", "b.example.ly", "b.example.ly"] });
    expect(result).toMatchObject({ ok: true, patch: { redirectDomainAllowlist: ["a.example.ly", "b.example.ly"] } });
  });

  test("rejects an empty change set and an empty LIST selection", () => {
    expect(buildPolicyPatch(current, { assignedWalletId: "w1", railMode: "LIST", railCodes: ["A", "B"], redirectDomains: ["a.example.ly"] }).ok).toBe(false);
    expect(buildPolicyPatch(current, { assignedWalletId: "w1", railMode: "LIST", railCodes: [], redirectDomains: ["a.example.ly"] }).ok).toBe(false);
  });

  test("treats null and ALL as equal", () => {
    const allRails = { assignedWalletId: "w1", railWhitelist: null, redirectDomains: [] as string[] };
    expect(buildPolicyPatch(allRails, { assignedWalletId: "w1", railMode: "ALL", railCodes: [], redirectDomains: [] }).ok).toBe(false);
  });
});
