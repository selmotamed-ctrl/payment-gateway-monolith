/**
 * Pure planning helpers for the development superuser CLI.
 *
 * The module has no database or environment imports so the tests can import it
 * without a configured DATABASE_URL or KMS_MASTER_KEY.
 */

import { validatePassword } from "./createAdminPlan";

export const DEV_ADMIN_EMAIL = "dev-admin@payment-gateway.local";
export const DEV_CHECKER_EMAIL = "dev-checker@payment-gateway.local";
export const DEV_MERCHANT_EMAIL = "dev-merchant@payment-gateway.local";
export const DEV_MERCHANT_NAME = "Development Test Merchant";
export const DEV_APPLICATION_NAME = "Development Store";

/**
 * Every authority the admin core checks, plus the wildcard. The wildcard is
 * honoured by core's requireAuthorities, while the explicit names are needed
 * by the admin edge and by the UI authority projection.
 */
export const ADMIN_ALL_AUTHORITIES = [
  "*",
  "aml:read",
  "aml:release",
  "aml:review",
  "aml:write",
  "approval:check",
  "approval:read",
  "approval:write",
  "attempt:inquire",
  "attempt:read",
  "case:read",
  "case:write",
  "cashout:read",
  "cashout:review",
  "commission:read",
  "commission:write",
  "compliance:read",
  "compliance:write",
  "credential:read",
  "credential:write",
  "dispute:read",
  "dispute:write",
  "finance:read",
  "finance:write",
  "gateway:read",
  "gateway:test",
  "gateway:write",
  "kyb:read",
  "kyb:write",
  "merchant:read",
  "merchant:write",
  "operator:read",
  "operator:write",
  "reconciliation:read",
  "reconciliation:write",
  "report:approve",
  "report:review",
  "security:read",
  "security:write",
  "settings:read",
  "settings:write",
  "user:read",
  "user:write",
  "velocity:read",
  "velocity:write",
] as const;

/** The coarse merchant authorities plus the wildcard. */
export const MERCHANT_ALL_AUTHORITIES = [
  "*",
  "link:write",
  "merchant:read",
  "merchant:write",
  "payment:read",
] as const;

export interface DevUsersArgs {
  password: string;
  adminEmail: string;
  checkerEmail: string;
  merchantEmail: string;
  merchantName: string;
  allowProduction: boolean;
}

const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export const parseDevUsersArgs = (
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): { ok: true; args: DevUsersArgs } | { ok: false; error: string } => {
  let password = env.DEV_PASSWORD ?? "";
  let adminEmail = env.DEV_ADMIN_EMAIL?.trim() ?? DEV_ADMIN_EMAIL;
  let checkerEmail = env.DEV_CHECKER_EMAIL?.trim() ?? DEV_CHECKER_EMAIL;
  let merchantEmail = env.DEV_MERCHANT_EMAIL?.trim() ?? DEV_MERCHANT_EMAIL;
  let merchantName = env.DEV_MERCHANT_NAME?.trim() ?? DEV_MERCHANT_NAME;
  let allowProduction = (env.DEV_USERS_ALLOW_PRODUCTION ?? "").toLowerCase() === "true";

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
      if (flag === "--password") {
        password = next();
      } else if (flag === "--admin-email") {
        adminEmail = next().trim();
      } else if (flag === "--checker-email") {
        checkerEmail = next().trim();
      } else if (flag === "--merchant-email") {
        merchantEmail = next().trim();
      } else if (flag === "--merchant-name") {
        merchantName = next().trim();
      } else if (flag === "--allow-production") {
        allowProduction = true;
      } else if (flag === "--help" || flag === "-h") {
        return { ok: false, error: "help" };
      } else {
        return { ok: false, error: `unknown option '${flag}'` };
      }
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  if (!password) return { ok: false, error: "a password is required (--password or DEV_PASSWORD)" };
  const passwordProblem = validatePassword(password);
  if (passwordProblem) return { ok: false, error: passwordProblem };
  for (const [label, email] of [
    ["admin email", adminEmail],
    ["checker email", checkerEmail],
    ["merchant email", merchantEmail],
  ] as const) {
    if (!isEmail(email)) return { ok: false, error: `'${email}' is not a valid ${label}` };
  }
  if (merchantName.length < 2) return { ok: false, error: "the merchant name must be at least 2 characters" };
  const normalizedAdminEmail = adminEmail.toLowerCase();
  const normalizedCheckerEmail = checkerEmail.toLowerCase();
  const normalizedMerchantEmail = merchantEmail.toLowerCase();
  const emails = [normalizedAdminEmail, normalizedCheckerEmail, normalizedMerchantEmail];
  if (new Set(emails).size !== emails.length) {
    return { ok: false, error: "the admin, checker and merchant emails must be distinct" };
  }

  return {
    ok: true,
    args: {
      password,
      adminEmail: normalizedAdminEmail,
      checkerEmail: normalizedCheckerEmail,
      merchantEmail: normalizedMerchantEmail,
      merchantName,
      allowProduction,
    },
  };
};

/**
 * Returns an error when the dev users would be created in production without
 * the deliberate opt-in. The default is safe: production never gets them.
 */
export const devUsersGuardError = (
  nodeEnv: string | undefined,
  allowProduction: boolean,
): string | null => {
  if ((nodeEnv ?? "development") !== "production") return null;
  if (allowProduction) return null;
  return "refusing to create development superusers in production; pass --allow-production or set DEV_USERS_ALLOW_PRODUCTION=true to opt in";
};

export interface DevAdminUserData {
  email: string;
  passwordHash: string;
  role: "COMPLIANCE" | "MLRO";
  authoritiesMap: string[];
  isMaker: boolean;
  isChecker: boolean;
  mfaRequired: boolean;
  status: "ACTIVE";
}

export const buildDevAdminUser = (
  email: string,
  role: "COMPLIANCE" | "MLRO",
  passwordHash: string,
): DevAdminUserData => ({
  email,
  passwordHash,
  role,
  authoritiesMap: [...ADMIN_ALL_AUTHORITIES],
  isMaker: true,
  isChecker: true,
  mfaRequired: false,
  status: "ACTIVE",
});

export interface DevMerchantUserData {
  email: string;
  passwordHash: string;
  role: "MERCHANT_ADMIN";
  authoritiesMap: string[];
  isMaker: boolean;
  isChecker: boolean;
  mfaRequired: boolean;
  status: "ACTIVE";
}

export const buildDevMerchantUser = (email: string, passwordHash: string): DevMerchantUserData => ({
  email,
  passwordHash,
  role: "MERCHANT_ADMIN",
  authoritiesMap: [...MERCHANT_ALL_AUTHORITIES],
  isMaker: true,
  isChecker: false,
  mfaRequired: false,
  status: "ACTIVE",
});

export const USAGE = `Usage: bun run create-dev-users --password <password> [options]

Creates or re-provisions the development-only test users:
  - admin maker  (role COMPLIANCE, all authorities)
  - admin checker (role MLRO, all authorities)
  - merchant admin (role MERCHANT_ADMIN) attached to a dev merchant

Options:
  --password <password>       Required unless DEV_PASSWORD is set
  --admin-email <email>       Default: ${DEV_ADMIN_EMAIL}
  --checker-email <email>     Default: ${DEV_CHECKER_EMAIL}
  --merchant-email <email>    Default: ${DEV_MERCHANT_EMAIL}
  --merchant-name <name>      Default: ${DEV_MERCHANT_NAME}
  --allow-production          Required when NODE_ENV=production

Environment equivalents: DEV_PASSWORD, DEV_ADMIN_EMAIL, DEV_CHECKER_EMAIL,
DEV_MERCHANT_EMAIL, DEV_MERCHANT_NAME, DEV_USERS_ALLOW_PRODUCTION=true.

Password: at least 12 characters with a lowercase letter, an uppercase letter and a digit.`;
