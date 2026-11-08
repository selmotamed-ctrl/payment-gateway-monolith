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
      ["--email", "Admin@Example.com", "--role", "finance", "--mfa", "--phone", "+218 91 123 4567"],
      { ADMIN_PASSWORD: "Str0ngPassword!" },
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
      ADMIN_PHONE: "+218911234567",
    });
    expect(fromEnv.ok).toBe(true);
    if (!fromEnv.ok) return;
    expect(fromEnv.args.role).toBe("GATEWAY_ADMIN");
    expect(fromEnv.args.mfaRequired).toBe(true); // MFA is on by default
    expect(fromEnv.args.phone).toBe("+218911234567");
    expect(fromEnv.args.roleProvided).toBe(false);
  });

  test("rejects an invalid email, role, missing password and unknown flag", () => {
    const env = { ADMIN_PASSWORD: "Str0ngPassword!" };
    expect(parseCreateAdminArgs(["--email", "nope"], env).ok).toBe(false);
    expect(parseCreateAdminArgs(["--email", "a@b.co", "--role", "WIZARD"], env).ok).toBe(false);
    expect(parseCreateAdminArgs(["--email", "a@b.co"], {}).ok).toBe(false);
    expect(parseCreateAdminArgs(["--email", "a@b.co", "--wat"], env).ok).toBe(false);
    expect(parseCreateAdminArgs(["--email", "a@b.co"], { ADMIN_PASSWORD: "weak" }).ok).toBe(false);
  });

  test("refuses a password on the command line and keeps MFA switchable only explicitly", () => {
    const argvPassword = parseCreateAdminArgs(["--email", "a@b.co", "--password", "Str0ngPassword!"], {});
    expect(argvPassword.ok).toBe(false);
    const off = parseCreateAdminArgs(["--email", "a@b.co", "--no-mfa"], { ADMIN_PASSWORD: "Str0ngPassword!" });
    expect(off.ok && off.args.mfaRequired).toBe(false);
    expect(off.ok && off.args.phone).toBeNull();
  });

  test("requires a phone number while MFA is enabled", () => {
    const noPhone = parseCreateAdminArgs(["--email", "a@b.co"], { ADMIN_PASSWORD: "Str0ngPassword!" });
    expect(noPhone.ok).toBe(false);
    const withPhone = parseCreateAdminArgs(["--email", "a@b.co", "--phone", "+218911234567"], {
      ADMIN_PASSWORD: "Str0ngPassword!",
    });
    expect(withPhone.ok).toBe(true);
    if (withPhone.ok) expect(withPhone.args.phone).toBe("+218911234567");
  });

  test("builds an ACTIVE user with the role authorities and four-eyes flags", () => {
    const parsed = parseCreateAdminArgs(["--email", "a@b.co", "--phone", "+218911234567"], { ADMIN_PASSWORD: "Str0ngPassword!" });
    if (!parsed.ok) throw new Error("expected valid args");
    const data = buildAdminUserData(parsed.args, "$2b$12$hash");
    expect(data.status).toBe("ACTIVE");
    expect(data.phone).toBe("+218911234567");
    expect(data.role).toBe("GATEWAY_ADMIN");
    expect(data.isMaker).toBe(true);
    expect(data.isChecker).toBe(false);
    expect(data.authoritiesMap).toEqual([...ROLE_AUTHORITIES.GATEWAY_ADMIN]);
    expect(data.authoritiesMap).toContain("settings:write");
  });
});
