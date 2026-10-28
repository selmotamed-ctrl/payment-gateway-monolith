import { describe, expect, test } from "bun:test";
import { buildAdminUserInfo, buildUiAuthoritiesMap } from "../lib/auth/uiAuthorities";

describe("admin UI authority projection", () => {
  test("keeps the raw backend authorities and adds the portal vocabulary", () => {
    const map = buildUiAuthoritiesMap(["merchant:read", "gateway:write"]);
    expect(map["merchant:read"]).toBe(true);
    expect(map["gateway:write"]).toBe(true);
    expect(map["merchants.read"]).toBe(true);
    expect(map["gateways.edit"]).toBe(true);
    expect(map["aml.read_confidential"]).toBeUndefined();
  });

  test("projects confidential AML only from a compliance authority", () => {
    expect(buildUiAuthoritiesMap(["aml:read"])["aml.read_confidential"]).toBeUndefined();
    expect(buildUiAuthoritiesMap(["compliance:read"])["aml.read_confidential"]).toBe(true);
  });

  test("builds the userInfo the portal stores", () => {
    const info = buildAdminUserInfo(
      { id: "u1", email: "admin@example.com", phone: null, role: "GATEWAY_ADMIN", isMaker: true, isChecker: false },
      ["gateway:read"],
    );
    expect(info).toMatchObject({
      id: "u1",
      username: "admin@example.com",
      name: "admin",
      role: "GATEWAY_ADMIN",
      isMaker: true,
      isChecker: false,
    });
    expect(info.authoritiesMap["gateways.edit"]).toBe(true);
  });
});
