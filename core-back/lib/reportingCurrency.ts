import { env } from "./env";

/** A requested reporting currency, falling back to the deploy-configured base. */
export const resolveReportingCurrency = (requested?: unknown): string => {
  const value = typeof requested === "string" ? requested.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(value) ? value : env.BASE_CURRENCY;
};

/** True when the caller explicitly requested a valid currency. */
export const isExplicitCurrency = (requested?: unknown): boolean =>
  typeof requested === "string" && /^[A-Z]{3}$/.test(requested.trim().toUpperCase());

/** A mixed scalar is never meaningful; callers expose the per-currency breakdown instead. */
export const MIXED_CURRENCY = "MIXED";
