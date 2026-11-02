export interface AuthenticatedAdminActor {
  id: string;
  email?: string | null;
  role: string;
  authorities: readonly string[] | ReadonlySet<string>;
}

const normalizeAuthorities = (actor: AuthenticatedAdminActor | null | undefined): Set<string> => {
  if (!actor || !actor.authorities) {
    return new Set();
  }
  return actor.authorities instanceof Set
    ? new Set(actor.authorities)
    : new Set(actor.authorities);
};

export function hasAuthority(
  actor: AuthenticatedAdminActor,
  required: string,
): boolean {
  const authorities = normalizeAuthorities(actor);
  return authorities.has("*") || authorities.has(required);
}

export function hasAnyAuthority(
  actor: AuthenticatedAdminActor,
  requiredList: readonly string[],
): boolean {
  return requiredList.some((required) => hasAuthority(actor, required));
}

export function hasAllAuthorities(
  actor: AuthenticatedAdminActor,
  requiredList: readonly string[],
): boolean {
  return requiredList.every((required) => hasAuthority(actor, required));
}

export function hasConfidentialAmlAccess(
  actor: AuthenticatedAdminActor | null | undefined,
): boolean {
  if (!actor) {
    return false;
  }
  const role = (actor.role ?? "").toUpperCase();
  if (role === "COMPLIANCE" || role === "MLRO") {
    return true;
  }
  return hasAnyAuthority(actor, ["aml:read", "aml:write"]);
}

export function hasMerchantSensitiveAccess(
  actor: AuthenticatedAdminActor | null | undefined,
): boolean {
  if (!actor) {
    return false;
  }
  const role = (actor.role ?? "").toUpperCase();
  if (role === "SUPPORT") {
    return false;
  }
  return hasAnyAuthority(actor, [
    "merchant:write",
    "compliance:read",
    "compliance:write",
  ]);
}
