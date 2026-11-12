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
  GATEWAY_ADMIN: ["gateway:read", "gateway:write", "gateway:test", "settings:read", "settings:write", "report_engine:run"],
  SECURITY_ADMIN: ["security:read", "security:write", "credential:write", "system:storage:read", "system:storage:admin", "system:storage:legal-hold", "report_engine:run"],
  FINANCE: ["finance:read", "finance:write", "commission:write", "cashout:review", "approval:read", "approval:check", "approval:write", "report_engine:run"],
  COMPLIANCE: ["compliance:read", "compliance:write", "aml:review", "report:review", "aml.read_confidential", "approval:read", "approval:check", "approval:write", "report_engine:run"],
  MLRO: ["aml:read", "aml:write", "aml:release", "report:approve", "aml.read_confidential", "approval:read", "approval:check", "approval:write", "report_engine:run"],
  OPERATOR: ["attempt:read", "attempt:inquire", "case:read", "case:write", "report_engine:run"],
  SUPPORT: ["merchant:read", "attempt:read", "case:read", "report_engine:run"],
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
  phone: string | null;
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
  let phone = env.ADMIN_PHONE?.trim() || null;
  let role: string = env.ADMIN_ROLE?.trim().toUpperCase() ?? "GATEWAY_ADMIN";
  // MFA is ON unless it is switched off explicitly (--no-mfa or ADMIN_MFA=false).
  let mfaRequired = (env.ADMIN_MFA ?? "true").toLowerCase() !== "false";
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
      } else if (flag === "--phone") {
        phone = next().trim();
      } else if (flag === "--password") {
        // A password on the command line leaks through the process list and the shell history.
        return { ok: false, error: "--password is not accepted: pass the password in the ADMIN_PASSWORD environment variable" };
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
  if (!password) return { ok: false, error: "a password is required (ADMIN_PASSWORD environment variable)" };
  const passwordProblem = validatePassword(password);
  if (passwordProblem) return { ok: false, error: passwordProblem };
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) {
    return { ok: false, error: `'${role}' is not a valid role (${ADMIN_ROLES.join(", ")})` };
  }
  if (phone !== null && !/^\+?[0-9][0-9 .()-]{5,19}$/.test(phone)) {
    return { ok: false, error: `'${phone}' is not a valid phone number` };
  }
  if (mfaRequired && !phone) {
    return {
      ok: false,
      error: "MFA is enabled but no phone number was provided (--phone or ADMIN_PHONE); pass --no-mfa only when SMS delivery is not configured",
    };
  }

  return {
    ok: true,
    args: { email: email.toLowerCase(), password, phone, role: role as AdminRole, mfaRequired, roleProvided },
  };
};

export interface AdminUserData {
  email: string;
  phone: string | null;
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
  phone: args.phone,
  passwordHash,
  role: args.role,
  authoritiesMap: [...ROLE_AUTHORITIES[args.role]],
  isMaker: ROLE_FLAGS[args.role].isMaker,
  isChecker: ROLE_FLAGS[args.role].isChecker,
  mfaRequired: args.mfaRequired,
  status: "ACTIVE",
});

export const USAGE = `Usage: ADMIN_PASSWORD=<password> bun run create-admin --email <email> --phone <phone> [--role <ROLE>] [--no-mfa]

Creates or re-provisions an administrator. The account is set to ACTIVE and its
password is set to the value of ADMIN_PASSWORD (never a command line argument).
MFA is ON unless --no-mfa (or ADMIN_MFA=false) is passed; because the code is
delivered by SMS, a phone number is required while MFA is on.

Environment equivalents: ADMIN_EMAIL, ADMIN_PHONE, ADMIN_ROLE, ADMIN_MFA=false.

Roles: ${ADMIN_ROLES.join(", ")}
Password: ${PASSWORD_POLICY}.`;
