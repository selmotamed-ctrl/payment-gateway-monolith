import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  isMerchantPrincipal,
  isStaffPrincipal,
  requireAuthorities,
  requireMerchantPrincipal,
  requireStaffPrincipal,
  type Principal,
} from "../../api/middleware/authDoubleCheck";
import {
  API_TOKEN_SCOPE_CATALOGUE,
  MERCHANT_AUTHORITY_CATALOGUE,
  assertGrantableMerchantAuthorities,
  assertGrantableMerchantRole,
  assertKnownMerchantAuthorities,
  assertKnownTokenScopes,
  assertMerchantAuthority,
  effectiveMerchantAuthorities,
} from "../../lib/auth/merchantAuthorities";

const principal = (authorities: string[], over: Partial<Principal> = {}): Principal => ({
  kind: "session",
  userId: "u",
  role: "MERCHANT_CASHIER",
  merchantId: "m1",
  applicationId: null,
  authorities,
  scopes: authorities,
  tokenId: null,
  sessionId: "u",
  ...over,
});
const staff = (authorities: string[], role = "FINANCE") => principal(authorities, { role, merchantId: null });
const token = (scopes: string[]) =>
  principal(scopes, { kind: "apiToken", userId: null, role: "MERCHANT_API", tokenId: "t1", sessionId: null });
const req = (p: Principal) => ({ principal: p }) as never;

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const runGuard = (guard: typeof requireStaffPrincipal, p: Principal): unknown => {
  let outcome: unknown = "not-called";
  guard(req(p), {} as never, ((error?: unknown) => {
    outcome = error ?? "passed";
  }) as never);
  return outcome;
};

describe("H2 principal-type separation", () => {
  test("classification of staff, merchant users and API tokens", () => {
    expect(isStaffPrincipal(staff(["a"]))).toBe(true);
    expect(isStaffPrincipal(principal(["a"]))).toBe(false);
    expect(isStaffPrincipal(token(["a"]))).toBe(false);
    expect(isMerchantPrincipal(principal(["a"], { role: "MERCHANT_ADMIN" }))).toBe(true);
    expect(isMerchantPrincipal(token(["a"]))).toBe(true);
    expect(isMerchantPrincipal(staff(["a"]))).toBe(false);
  });

  test("the admin guard refuses merchant users and API tokens that hold a matching authority string", () => {
    expect(runGuard(requireStaffPrincipal, staff(["merchant:read"]))).toBe("passed");
    for (const intruder of [principal(["merchant:read"]), token(["merchant:read"])]) {
      const outcome = runGuard(requireStaffPrincipal, intruder) as { code?: string };
      expect(outcome.code).toBe("STAFF_PRINCIPAL_REQUIRED");
    }
  });

  test("the merchant guard refuses staff principals", () => {
    expect(runGuard(requireMerchantPrincipal, principal(["x"], { role: "MERCHANT_ADMIN" }))).toBe("passed");
    expect((runGuard(requireMerchantPrincipal, staff(["*"])) as { code?: string }).code).toBe("MERCHANT_PRINCIPAL_REQUIRED");
  });

  test("the wildcard authority is honoured for staff only", () => {
    for (const required of ["gateway:write", "ledger:post", "cashout:approve"]) {
      expect(() => requireAuthorities(req(staff(["*"])), [required])).not.toThrow();
      expect(() => requireAuthorities(req(principal(["*"])), [required])).toThrow();
      expect(() => requireAuthorities(req(token(["*"])), [required])).toThrow();
    }
  });

  test("a principal without the authority is rejected (control)", () => {
    expect(() => requireAuthorities(req(staff(["a"])), ["b"])).toThrow();
  });

  test("the routers wire the guards and the previously unguarded admin routes carry authorities", () => {
    const admin = readFileSync("api/internal/admin.ts", "utf8");
    const merchant = readFileSync("api/internal/merchant.ts", "utf8");
    const afterAuth = admin.slice(admin.indexOf("router.use(requireAuthentication)"));
    expect(afterAuth.slice(0, 400)).toContain("router.use(requireStaffPrincipal)");
    expect(merchant.slice(merchant.indexOf("router.use(requireAuthentication)"))).toContain("router.use(requireMerchantPrincipal)");
    for (const signature of ['router.get("/stats/overview"', 'router.get("/options/:kind"', 'router.post("/search"']) {
      const start = admin.indexOf(signature);
      expect(start).toBeGreaterThan(-1);
      expect(admin.slice(start, start + 400)).toContain("requireAuthorities(");
    }
  });

  test("admin and merchant login refuse the other channel's users with the unknown-user answer", () => {
    const admin = readFileSync("api/internal/admin.ts", "utf8");
    const merchant = readFileSync("api/internal/merchant.ts", "utf8");
    const adminLogin = admin.slice(admin.indexOf('router.post("/auth/login"'), admin.indexOf('router.post("/auth/mfa"'));
    expect(adminLogin).toContain('startsWith("MERCHANT_")');
    expect(adminLogin).toContain("merchantId === null");
    const merchantLogin = merchant.slice(
      merchant.indexOf('router.post("/auth/login"'),
      merchant.indexOf('router.post("/auth/google"'),
    );
    expect(merchantLogin).toContain('startsWith("MERCHANT_")');
    expect(merchantLogin).toContain("merchantId !== null");
  });
});

describe("H1 merchant authorization", () => {
  const merchant = readFileSync("api/internal/merchant.ts", "utf8");

  const routeBody = (verb: string, path: string): string => {
    const start = merchant.indexOf(`router.${verb}("${path}"`);
    expect(start).toBeGreaterThan(-1);
    return merchant.slice(start, merchant.indexOf("\n});", start));
  };

  test("every sensitive merchant route checks an authority first (deny by default)", () => {
    const sensitive: Array<[string, string]> = [
      ["get", "/users"], ["post", "/users"], ["patch", "/users"], ["patch", "/users/:id"],
      ["get", "/tokens"], ["post", "/tokens"], ["put", "/tokens/:id/ips"], ["delete", "/tokens/:id"],
      ["get", "/credential-sets"], ["post", "/credential-sets"], ["put", "/credential-sets/:id"],
      ["get", "/credential-sets/:id"], ["post", "/credential-sets/:id/verify"],
      ["post", "/cashouts"], ["get", "/cashouts"], ["post", "/wallets"], ["post", "/links"],
      ["post", "/links/:id/cancel"], ["post", "/applications"], ["patch", "/applications/:id"],
      ["post", "/pos/terminals"], ["post", "/disputes/:id/evidence"], ["post", "/onboarding/submit"],
    ];
    for (const [verb, path] of sensitive) {
      expect(routeBody(verb, path).slice(0, 300)).toContain("assertMerchantAuthority(");
    }
    expect((merchant.match(/assertMerchantAuthority\(/g) ?? []).length).toBeGreaterThanOrEqual(sensitive.length);
  });

  test("the external API requires the matching token scope", () => {
    expect(routeBody("post", "/external/links")).toContain('assertMerchantAuthority(principal, ["link:write"])');
    expect(routeBody("get", "/external/payments/:reference")).toContain('["payment:read"]');
  });

  test("the catalogue is closed: unknown strings and the wildcard are rejected", () => {
    expect(codeOf(() => assertKnownMerchantAuthorities(["*"]))).toBe("UNKNOWN_AUTHORITY");
    expect(codeOf(() => assertKnownMerchantAuthorities(["merchant:read", "made:up"]))).toBe("UNKNOWN_AUTHORITY");
    expect(codeOf(() => assertKnownMerchantAuthorities([...MERCHANT_AUTHORITY_CATALOGUE]))).toBeUndefined();
    expect(codeOf(() => assertKnownTokenScopes(["gateway:write"]))).toBe("UNKNOWN_TOKEN_SCOPE");
    expect(codeOf(() => assertKnownTokenScopes([...API_TOKEN_SCOPE_CATALOGUE]))).toBeUndefined();
    expect(MERCHANT_AUTHORITY_CATALOGUE).not.toContain("*" as never);
  });

  test("a user can only grant authorities they effectively hold (no self-escalation)", () => {
    const cashier = principal(["payment:read"]);
    expect(codeOf(() => assertGrantableMerchantAuthorities(cashier, ["user:manage"]))).toBe("AUTHORITY_ESCALATION_FORBIDDEN");
    expect(codeOf(() => assertGrantableMerchantAuthorities(cashier, ["payment:read"]))).toBeUndefined();
    const admin = principal(["merchant:read", "merchant:write"], { role: "MERCHANT_ADMIN" });
    expect(codeOf(() => assertGrantableMerchantAuthorities(admin, ["user:manage", "token:manage", "cashout:request"]))).toBeUndefined();
    // merchant:write alone does not make a staff-role user a user manager.
    const writer = principal(["merchant:write"], { role: "MERCHANT_STAFF" });
    expect(effectiveMerchantAuthorities(writer).has("user:manage")).toBe(false);
    expect(effectiveMerchantAuthorities(writer).has("link:write")).toBe(true);
    expect(codeOf(() => assertGrantableMerchantRole(writer, "MERCHANT_ADMIN"))).toBe("ROLE_ESCALATION_FORBIDDEN");
    expect(codeOf(() => assertGrantableMerchantRole(admin, "MERCHANT_ADMIN"))).toBeUndefined();
  });

  test("the wildcard never counts for a merchant principal and API tokens never hold privileged authorities", () => {
    const wildcard = principal(["*"], { role: "MERCHANT_ADMIN" });
    expect(codeOf(() => assertMerchantAuthority(wildcard, ["user:manage"]))).toBe("AUTHORITY_REQUIRED");
    const apiToken = token(["link:write", "payment:read"]);
    for (const privileged of ["user:manage", "token:manage", "credential:manage", "cashout:request"]) {
      expect(codeOf(() => assertMerchantAuthority(apiToken, [privileged]))).toBe("AUTHORITY_REQUIRED");
    }
    expect(codeOf(() => assertMerchantAuthority(apiToken, ["link:read"]))).toBeUndefined();
  });

  test("an API token can only call the external API and cannot manage tokens or IP allowlists", () => {
    expect(merchant).toContain('request.path.startsWith("/external/")');
    expect(merchant).toContain("API_TOKEN_SCOPE_VIOLATION");
    for (const [verb, path] of [["post", "/tokens"], ["put", "/tokens/:id/ips"], ["delete", "/tokens/:id"], ["post", "/users"]]) {
      expect(routeBody(verb!, path!).slice(0, 300)).toContain("assertMerchantAuthority(");
    }
  });

  test("token expiry is validated, stored and enforced", () => {
    const create = routeBody("post", "/tokens");
    expect(create).toContain("TOKEN_EXPIRY_INVALID");
    expect(create).toContain("expiresAt: tokenExpiresAt");
    expect(create).toContain("assertKnownTokenScopes(body.scopes)");
    expect(create).toContain("assertGrantableMerchantAuthorities(principal, body.scopes)");
    const guard = readFileSync("api/middleware/authDoubleCheck.ts", "utf8");
    expect(guard).toContain("ACCESS_TOKEN_EXPIRED");
  });

  test("user create/patch validate the catalogue, the ceiling, self-modification and are audited", () => {
    const create = routeBody("post", "/users");
    expect(create).toContain("assertKnownMerchantAuthorities(");
    expect(create).toContain("assertGrantableMerchantAuthorities(");
    expect(create).toContain("MERCHANT_USER_CREATED");
    const patchHelper = merchant.slice(merchant.indexOf("const applyMerchantUserPatch"), merchant.indexOf('router.patch("/users"'));
    expect(patchHelper).toContain("SELF_MODIFICATION_FORBIDDEN");
    expect(patchHelper).toContain("assertGrantableMerchantAuthorities(");
    expect(patchHelper).toContain("MERCHANT_USER_UPDATED");
  });
});
