import { describe, expect, test } from "bun:test";
import { ROLE_AUTHORITIES } from "../scripts/createAdminPlan";
import {
  ADMIN_ALL_AUTHORITIES,
  buildDevAdminUser,
  buildDevMerchantUser,
  DEV_ADMIN_EMAIL,
  DEV_CHECKER_EMAIL,
  DEV_MERCHANT_EMAIL,
  devUsersGuardError,
  MERCHANT_ALL_AUTHORITIES,
  parseDevUsersArgs,
} from "../scripts/devUsersPlan";

describe("development superuser planning", () => {
  test("admin authorities cover every seeded role and the wildcard", () => {
    expect(ADMIN_ALL_AUTHORITIES).toContain("*");
    for (const authorities of Object.values(ROLE_AUTHORITIES)) {
      for (const authority of authorities) {
        expect(ADMIN_ALL_AUTHORITIES as readonly string[]).toContain(authority);
      }
    }
    expect(ADMIN_ALL_AUTHORITIES).toContain("aml:read");
    expect(ADMIN_ALL_AUTHORITIES).toContain("report:approve");
    expect(ADMIN_ALL_AUTHORITIES).toContain("user:write");
    expect(new Set(ADMIN_ALL_AUTHORITIES).size).toBe(ADMIN_ALL_AUTHORITIES.length);
  });

  test("merchant authorities cover the merchant UI projection sources", () => {
    expect(MERCHANT_ALL_AUTHORITIES).toContain("*");
    for (const authority of ["merchant:read", "merchant:write", "link:write", "payment:read"]) {
      expect(MERCHANT_ALL_AUTHORITIES as readonly string[]).toContain(authority);
    }
  });

  test("parses defaults and overrides", () => {
    const defaults = parseDevUsersArgs([], { DEV_PASSWORD: "DevPassword123!" });
    expect(defaults.ok).toBe(true);
    if (!defaults.ok) return;
    expect(defaults.args.adminEmail).toBe(DEV_ADMIN_EMAIL);
    expect(defaults.args.checkerEmail).toBe(DEV_CHECKER_EMAIL);
    expect(defaults.args.merchantEmail).toBe(DEV_MERCHANT_EMAIL);
    expect(defaults.args.merchantName).toBe("Development Test Merchant");
    expect(defaults.args.allowProduction).toBe(false);

    const overridden = parseDevUsersArgs(
      [
        "--password",
        "DevPassword123!",
        "--admin-email",
        "maker@dev.local",
        "--checker-email",
        "checker@dev.local",
        "--merchant-email",
        "shop@dev.local",
        "--merchant-name",
        "Dev Shop",
        "--allow-production",
      ],
      {},
    );
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;
    expect(overridden.args).toMatchObject({
      adminEmail: "maker@dev.local",
      checkerEmail: "checker@dev.local",
      merchantEmail: "shop@dev.local",
      merchantName: "Dev Shop",
      allowProduction: true,
    });
  });

  test("rejects a weak password, duplicate emails and unknown flags", () => {
    expect(parseDevUsersArgs(["--password", "weak"], {}).ok).toBe(false);
    expect(
      parseDevUsersArgs(["--password", "DevPassword123!", "--admin-email", "same@dev.local", "--checker-email", "same@dev.local"], {}).ok,
    ).toBe(false);
    expect(parseDevUsersArgs(["--password", "DevPassword123!", "--wat"], {}).ok).toBe(false);
    expect(parseDevUsersArgs([], {}).ok).toBe(false);
  });

  test("refuses production unless explicitly allowed", () => {
    expect(devUsersGuardError("production", false)).toContain("refusing");
    expect(devUsersGuardError("production", true)).toBeNull();
    expect(devUsersGuardError("development", false)).toBeNull();
    expect(devUsersGuardError("test", false)).toBeNull();
  });

  test("builds active MFA-free users with all authorities", () => {
    const admin = buildDevAdminUser("maker@dev.local", "COMPLIANCE", "$2b$12$hash");
    expect(admin).toMatchObject({
      role: "COMPLIANCE",
      isMaker: true,
      isChecker: true,
      mfaRequired: false,
      status: "ACTIVE",
    });
    expect(admin.authoritiesMap).toEqual([...ADMIN_ALL_AUTHORITIES]);

    const checker = buildDevAdminUser("checker@dev.local", "MLRO", "$2b$12$hash");
    expect(checker.role).toBe("MLRO");

    const merchant = buildDevMerchantUser("shop@dev.local", "$2b$12$hash");
    expect(merchant).toMatchObject({
      role: "MERCHANT_ADMIN",
      isMaker: true,
      isChecker: false,
      mfaRequired: false,
      status: "ACTIVE",
    });
    expect(merchant.authoritiesMap).toEqual([...MERCHANT_ALL_AUTHORITIES]);
  });
});
