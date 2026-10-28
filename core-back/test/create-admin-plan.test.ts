import { describe, expect, test } from "bun:test";
import {
  buildAdminUserData,
  parseCreateAdminArgs,
  ROLE_AUTHORITIES,
  validatePassword,
} from "../scripts/createAdminPlan";

describe("create-admin bootstrap", () => {
  test("enforces the password policy", () => {
    expect(validatePassword("Str0ngPassword!")).toBeNull();
    expect(validatePassword("short1A")).toBe("the password must be at least 12 characters with a lowercase letter, an uppercase letter and a digit");
    expect(validatePassword("alllowercase123")).toEqual(expect.stringContaining("uppercase"));
    expect(validatePassword("ALLUPPERCASE123")).toEqual(expect.stringContaining("lowercase"));
    expect(validatePassword("NoDigitsHereAtAll")).toEqual(expect.stringContaining("digit"));
  });

  test("parses flags and environment variables", () => {
    const fromFlags = parseCreateAdminArgs(
      ["--email", "Admin@Example.com", "--password", "Str0ngPassword!", "--role", "finance", "--mfa"],
      {},
    );
    expect(fromFlags.ok).toBe(true);
    if (!fromFlags.ok) return;
    expect(fromFlags.args.email).toBe("admin@example.com");
    expect(fromFlags.args.role).toBe("FINANCE");
    expect(fromFlags.args.mfaRequired).toBe(true);
    expect(fromFlags.args.roleProvided).toBe(true);

    const fromEnv = parseCreateAdminArgs([], {
      ADMIN_EMAIL: "ops@example.com",
      ADMIN_PASSWORD: "Str0ngPassword!",
    });
    expect(fromEnv.ok).toBe(true);
    if (!fromEnv.ok) return;
    expect(fromEnv.args.role).toBe("GATEWAY_ADMIN");
    expect(fromEnv.args.mfaRequired).toBe(false);
    expect(fromEnv.args.roleProvided).toBe(false);
  });

  test("rejects an invalid email, role, missing password and unknown flag", () => {
    expect(parseCreateAdminArgs(["--email", "nope", "--password", "Str0ngPassword!"], {}).ok).toBe(false);
    expect(parseCreateAdminArgs(["--email", "a@b.co", "--password", "Str0ngPassword!", "--role", "WIZARD"], {}).ok).toBe(false);
    expect(parseCreateAdminArgs(["--email", "a@b.co"], {}).ok).toBe(false);
    expect(parseCreateAdminArgs(["--email", "a@b.co", "--password", "Str0ngPassword!", "--wat"], {}).ok).toBe(false);
    expect(parseCreateAdminArgs(["--email", "a@b.co", "--password", "weak"], {}).ok).toBe(false);
  });

  test("builds an ACTIVE user with the role authorities and four-eyes flags", () => {
    const parsed = parseCreateAdminArgs(["--email", "a@b.co", "--password", "Str0ngPassword!"], {});
    if (!parsed.ok) throw new Error("expected valid args");
    const data = buildAdminUserData(parsed.args, "$2b$12$hash");
    expect(data.status).toBe("ACTIVE");
    expect(data.role).toBe("GATEWAY_ADMIN");
    expect(data.isMaker).toBe(true);
    expect(data.isChecker).toBe(false);
    expect(data.authoritiesMap).toEqual([...ROLE_AUTHORITIES.GATEWAY_ADMIN]);
    expect(data.authoritiesMap).toContain("settings:write");
  });
});
