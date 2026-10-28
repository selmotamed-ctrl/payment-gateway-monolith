/**
 * Pure planning helpers for the `create-admin` bootstrap CLI.
 *
 * Keeping them free of the database and env imports lets the unit tests import
 * them without a configured `DATABASE_URL`/`KMS_MASTER_KEY`.
 */

export const ADMIN_ROLES = [
  "GATEWAY_ADMIN",
  "SECURITY_ADMIN",
  "FINANCE",
  "COMPLIANCE",
  "MLRO",
  "OPERATOR",
  "SUPPORT",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Mirrors the seeded role definitions (core-back/prisma/seed.ts). */
export const ROLE_AUTHORITIES: Record<AdminRole, readonly string[]> = {
  GATEWAY_ADMIN: ["gateway:read", "gateway:write", "gateway:test", "settings:read", "settings:write"],
  SECURITY_ADMIN: ["security:read", "security:write", "credential:write"],
  FINANCE: ["finance:read", "finance:write", "commission:write", "cashout:review"],
  COMPLIANCE: ["compliance:read", "compliance:write", "aml:review", "report:review"],
  MLRO: ["aml:read", "aml:write", "aml:release", "report:approve"],
  OPERATOR: ["attempt:read", "attempt:inquire", "case:read"],
  SUPPORT: ["merchant:read", "attempt:read", "case:read"],
};

export const ROLE_FLAGS: Record<AdminRole, { isMaker: boolean; isChecker: boolean }> = {
  GATEWAY_ADMIN: { isMaker: true, isChecker: false },
  SECURITY_ADMIN: { isMaker: true, isChecker: true },
  FINANCE: { isMaker: false, isChecker: true },
  COMPLIANCE: { isMaker: false, isChecker: true },
  MLRO: { isMaker: false, isChecker: true },
  OPERATOR: { isMaker: true, isChecker: false },
  SUPPORT: { isMaker: false, isChecker: false },
};

export const PASSWORD_POLICY =
  "at least 12 characters with a lowercase letter, an uppercase letter and a digit";

export const validatePassword = (password: string): string | null => {
  if (password.length < 12 || password.length > 128) {
    return `the password must be ${PASSWORD_POLICY}`;
  }
  if (!/[a-z]/.test(password)) return `the password must be ${PASSWORD_POLICY}`;
  if (!/[A-Z]/.test(password)) return `the password must be ${PASSWORD_POLICY}`;
  if (!/\d/.test(password)) return `the password must be ${PASSWORD_POLICY}`;
  return null;
};

export interface CreateAdminArgs {
  email: string;
  password: string;
  role: AdminRole;
  mfaRequired: boolean;
  roleProvided: boolean;
}

export const parseCreateAdminArgs = (
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): { ok: true; args: CreateAdminArgs } | { ok: false; error: string } => {
  let email = env.ADMIN_EMAIL?.trim() ?? "";
  let password = env.ADMIN_PASSWORD ?? "";
  let role: string = env.ADMIN_ROLE?.trim().toUpperCase() ?? "GATEWAY_ADMIN";
  let mfaRequired = (env.ADMIN_MFA ?? "").toLowerCase() === "true";
  let roleProvided = Boolean(env.ADMIN_ROLE);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${flag} requires a value`);
      }
      index += 1;
      return value;
    };
    try {
      if (flag === "--email") {
        email = next().trim();
      } else if (flag === "--password") {
        password = next();
      } else if (flag === "--role") {
        role = next().trim().toUpperCase();
        roleProvided = true;
      } else if (flag === "--mfa") {
        mfaRequired = true;
      } else if (flag === "--no-mfa") {
        mfaRequired = false;
      } else if (flag === "--help" || flag === "-h") {
        return { ok: false, error: "help" };
      } else {
        return { ok: false, error: `unknown option '${flag}'` };
      }
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  if (!email) return { ok: false, error: "an email is required (--email or ADMIN_EMAIL)" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: `'${email}' is not a valid email address` };
  if (!password) return { ok: false, error: "a password is required (--password or ADMIN_PASSWORD)" };
  const passwordProblem = validatePassword(password);
  if (passwordProblem) return { ok: false, error: passwordProblem };
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) {
    return { ok: false, error: `'${role}' is not a valid role (${ADMIN_ROLES.join(", ")})` };
  }

  return {
    ok: true,
    args: { email: email.toLowerCase(), password, role: role as AdminRole, mfaRequired, roleProvided },
  };
};

export interface AdminUserData {
  email: string;
  passwordHash: string;
  role: AdminRole;
  authoritiesMap: string[];
  isMaker: boolean;
  isChecker: boolean;
  mfaRequired: boolean;
  status: "ACTIVE";
}

export const buildAdminUserData = (args: CreateAdminArgs, passwordHash: string): AdminUserData => ({
  email: args.email,
  passwordHash,
  role: args.role,
  authoritiesMap: [...ROLE_AUTHORITIES[args.role]],
  isMaker: ROLE_FLAGS[args.role].isMaker,
  isChecker: ROLE_FLAGS[args.role].isChecker,
  mfaRequired: args.mfaRequired,
  status: "ACTIVE",
});

export const USAGE = `Usage: bun run create-admin --email <email> --password <password> [--role <ROLE>] [--mfa]

Creates or re-provisions an administrator. The account is set to ACTIVE and its
password is set to the supplied value. MFA is OFF unless --mfa is passed.

Environment equivalents: ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_ROLE, ADMIN_MFA=true.

Roles: ${ADMIN_ROLES.join(", ")}
Password: ${PASSWORD_POLICY}.`;
