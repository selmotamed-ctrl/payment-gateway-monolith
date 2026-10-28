import { describe, expect, test } from "vitest";
import {
  buildAdminUserInfo,
  buildMerchantUserInfo,
  buildMerchantUiAuthoritiesMap,
  buildUiAuthoritiesMap,
} from "../../core-back/lib/auth/uiAuthorities";

describe("admin UI authority projection", () => {
  test("keeps raw authorities and adds the portal keys", () => {
    const map = buildUiAuthoritiesMap(["gateway:write", "settings:read"]);
    expect(map["gateway:write"]).toBe(true);
    expect(map["settings:read"]).toBe(true);
    expect(map["gateways.edit"]).toBe(true);
    expect(map["merchants.read"]).toBeUndefined();
  });

  test("confidential AML needs a compliance authority, not plain aml:read", () => {
    expect(buildUiAuthoritiesMap(["aml:read"])["aml.read_confidential"]).toBeUndefined();
    expect(buildUiAuthoritiesMap(["compliance:read"])["aml.read_confidential"]).toBe(true);
  });

  test("checker authority opens approvals and user proposals", () => {
    const map = buildUiAuthoritiesMap(["approval:check"]);
    expect(map["approvals.approve"]).toBe(true);
    expect(map["approvals.reject"]).toBe(true);
    expect(map["users_admin.propose"]).toBe(true);
  });

  test("finance read opens profitability and liquidity only", () => {
    const map = buildUiAuthoritiesMap(["finance:read"]);
    expect(map["profit.read"]).toBe(true);
    expect(map["liquidity.read"]).toBe(true);
    expect(map["cashout.process"]).toBeUndefined();
  });

  test("buildAdminUserInfo derives the display name from the email", () => {
    const info = buildAdminUserInfo(
      { id: "u1", email: "ops@example.com", phone: null, role: "GATEWAY_ADMIN", isMaker: true, isChecker: false },
      ["gateway:read"],
    );
    expect(info).toMatchObject({ id: "u1", username: "ops@example.com", name: "ops", role: "GATEWAY_ADMIN" });
    expect(info.authoritiesMap["gateways.edit"]).toBe(true);
  });
});

describe("merchant UI authority projection", () => {
  test("merchant:write expands to the full merchant admin surface", () => {
    const map = buildMerchantUiAuthoritiesMap(["merchant:write"]);
    for (const key of [
      "wallets.read",
      "links.create",
      "links.cancel",
      "payments.read",
      "cashout.request",
      "tokens.create",
      "credentials.manage",
      "users.manage",
      "applications.edit_descriptive",
    ]) {
      expect(map[key], key).toBe(true);
    }
  });

  test("merchant:read is read-only", () => {
    const map = buildMerchantUiAuthoritiesMap(["merchant:read"]);
    expect(map["wallets.read"]).toBe(true);
    expect(map["links.create"]).toBeUndefined();
    expect(map["users.manage"]).toBeUndefined();
  });

  test("link:write opens link creation without user administration", () => {
    const map = buildMerchantUiAuthoritiesMap(["link:write"]);
    expect(map["links.create"]).toBe(true);
    expect(map["users.manage"]).toBeUndefined();
  });

  test("buildMerchantUserInfo carries the merchant scope", () => {
    const info = buildMerchantUserInfo(
      {
        id: "m1",
        email: "acme@example.com",
        phone: null,
        role: "MERCHANT_ADMIN",
        merchantId: "merchant-1",
        isMaker: true,
        isChecker: false,
      },
      ["merchant:read"],
      ["app-1"],
    );
    expect(info.merchantId).toBe("merchant-1");
    expect(info.appScopeIds).toEqual(["app-1"]);
    expect(info.authoritiesMap["stats.read"]).toBe(true);
  });
});
