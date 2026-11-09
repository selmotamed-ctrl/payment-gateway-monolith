import { ApiError } from "../error";
import type { Principal } from "../../api/middleware/authDoubleCheck";

/**
 * The CLOSED catalogue of merchant authorities.
 *
 * `authoritiesMap` values and API token scopes accepted from a client are
 * validated against this list; unknown strings and the wildcard `*` are
 * rejected. Core enforces the catalogue on every merchant route
 * (`requireMerchantAuthority`), the edges and the portal only project it.
 */
export const MERCHANT_AUTHORITY_CATALOGUE = [
  // Coarse authorities issued at registration (kept for compatibility).
  "merchant:read",
  "merchant:write",
  "link:write",
  "payment:read",
  // Fine-grained authorities for the sensitive routes.
  "link:read",
  "wallet:create",
  "application:manage",
  "pos:manage",
  "onboarding:write",
  "dispute:respond",
  "cashout:read",
  "cashout:request",
  "user:manage",
  "token:manage",
  "credential:manage",
  "report_engine:run",
] as const;

export type MerchantAuthority = (typeof MERCHANT_AUTHORITY_CATALOGUE)[number];

const CATALOGUE_SET: ReadonlySet<string> = new Set(MERCHANT_AUTHORITY_CATALOGUE);

/** The scopes an API token can carry: the external API surface only. */
export const API_TOKEN_SCOPE_CATALOGUE = ["link:write", "link:read", "payment:read"] as const;
const TOKEN_SCOPE_SET: ReadonlySet<string> = new Set(API_TOKEN_SCOPE_CATALOGUE);

/**
 * Legacy token scopes that were documented before the catalogue was closed.
 * They are accepted and normalised to the canonical resource:action scope so
 * existing integrations keep working after the upgrade.
 */
const TOKEN_SCOPE_ALIASES: Readonly<Record<string, string>> = {
  "links:create": "link:write",
  "links:write": "link:write",
  "links:cancel": "link:write",
  "links:read": "link:read",
  "payments:read": "payment:read",
  "payments:write": "payment:read",
};

export const normalizeTokenScopes = (scopes: readonly string[]): string[] => {
  const normalized = scopes.map((scope) => TOKEN_SCOPE_ALIASES[scope] ?? scope);
  return [...new Set(normalized)];
};

/** Privileged authorities: never implied for anyone but a MERCHANT_ADMIN holding `merchant:write`. */
export const PRIVILEGED_MERCHANT_AUTHORITIES = [
  "user:manage",
  "token:manage",
  "credential:manage",
  "cashout:request",
] as const;

const IMPLIED_BY_MERCHANT_WRITE = [
  "link:write",
  "wallet:create",
  "application:manage",
  "pos:manage",
  "onboarding:write",
  "dispute:respond",
  "cashout:read",
  "report_engine:run",
] as const;

/**
 * The authorities a principal effectively holds: the stored ones plus the
 * implications of the legacy coarse grants. The wildcard is ignored for
 * merchant principals, and an API token holds exactly its scopes.
 */
export const effectiveMerchantAuthorities = (
  principal: Pick<Principal, "kind" | "role" | "authorities">,
): Set<string> => {
  const source = principal.kind === "apiToken"
    ? normalizeTokenScopes(principal.authorities)
    : principal.authorities;
  const held = new Set<string>(source.filter((authority) => authority !== "*"));
  if (principal.kind === "apiToken") {
    if (held.has("link:write")) held.add("link:read");
    return held;
  }
  if (held.has("merchant:write")) {
    for (const implied of IMPLIED_BY_MERCHANT_WRITE) held.add(implied);
    if (principal.role === "MERCHANT_ADMIN") {
      for (const privileged of PRIVILEGED_MERCHANT_AUTHORITIES) held.add(privileged);
    }
  }
  if (held.has("merchant:read") || held.has("link:write")) {
    held.add("link:read");
    held.add("payment:read");
    // The portal projects the cash-out screen from merchant:read; core must
    // agree, otherwise the screen is visible but its list returns 403.
    held.add("cashout:read");
    held.add("report_engine:run");
  }
  return held;
};

export const hasMerchantAuthority = (
  principal: Pick<Principal, "kind" | "role" | "authorities">,
  required: readonly string[],
): boolean => {
  const held = effectiveMerchantAuthorities(principal);
  return required.some((authority) => held.has(authority));
};

/** Deny by default: the principal must hold at least one of the required authorities. */
export const assertMerchantAuthority = (
  principal: Pick<Principal, "kind" | "role" | "authorities">,
  required: readonly string[],
): void => {
  if (!hasMerchantAuthority(principal, required)) {
    throw new ApiError(403, "AUTHORITY_REQUIRED", "The principal lacks the required authority", { required });
  }
};

/** Rejects unknown strings and the wildcard in a client supplied authority list. */
export const assertKnownMerchantAuthorities = (requested: readonly string[]): void => {
  const unknown = requested.filter((authority) => !CATALOGUE_SET.has(authority));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_AUTHORITY", "The authority list contains unknown authorities", {
      unknown,
    });
  }
};

export const assertKnownTokenScopes = (requested: readonly string[]): void => {
  const unknown = normalizeTokenScopes(requested).filter((scope) => !TOKEN_SCOPE_SET.has(scope));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_TOKEN_SCOPE", "The scope list contains unknown scopes", {
      unknown,
      allowed: [...API_TOKEN_SCOPE_CATALOGUE],
    });
  }
};

/** No self-escalation: only authorities the caller effectively holds can be handed out. */
export const assertGrantableMerchantAuthorities = (
  principal: Pick<Principal, "kind" | "role" | "authorities">,
  requested: readonly string[],
): void => {
  const held = effectiveMerchantAuthorities(principal);
  const excess = requested.filter((authority) => !held.has(authority));
  if (excess.length > 0) {
    throw new ApiError(403, "AUTHORITY_ESCALATION_FORBIDDEN", "You cannot grant authorities you do not hold", {
      authorities: excess,
    });
  }
};

/** Only a MERCHANT_ADMIN can create or promote a MERCHANT_ADMIN. */
export const assertGrantableMerchantRole = (
  principal: Pick<Principal, "role">,
  requestedRole: string,
): void => {
  if (requestedRole === "MERCHANT_ADMIN" && principal.role !== "MERCHANT_ADMIN") {
    throw new ApiError(403, "ROLE_ESCALATION_FORBIDDEN", "Only a merchant administrator can grant the administrator role");
  }
};
