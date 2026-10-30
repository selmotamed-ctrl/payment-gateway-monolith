/**
 * Suite 05.2 — admin RBAC / granular authority matrix.
 *
 * Exercises the real edge `authorityGuard` and the UI authority projection
 * across every platform role and a representative set of endpoint authorities.
 */
import { describe, expect, test } from "bun:test";
import type { NextFunction, Request, Response } from "express";
import {
  buildAdminUserInfo,
  buildMerchantUiAuthoritiesMap,
  buildUiAuthoritiesMap,
} from "../../../lib/auth/uiAuthorities";
import { USER_ROLES, errorCode, errorStatus } from "../_harness";

// The edge filters the required authority against this allow-list. Configure
// the complete vocabulary so the guard actually enforces every endpoint
// authority in this matrix.
process.env.CORE_BACK_URL = process.env.CORE_BACK_URL ?? "https://127.0.0.1:4000";
process.env.MTLS_CLIENT_CERT_PATH = process.env.MTLS_CLIENT_CERT_PATH ?? "./certs/admin-back-client.crt";
process.env.MTLS_CLIENT_KEY_PATH = process.env.MTLS_CLIENT_KEY_PATH ?? "./certs/admin-back-client.key";
process.env.ADMIN_AUTHORITY_HINTS = [
  ...USER_ROLES,
  "aml:read",
  "aml:write",
  "gateway:read",
  "gateway:write",
  "gateway:test",
  "merchant:read",
  "merchant:write",
  "user:write",
  "credential:write",
  "security:read",
  "security:write",
  "finance:read",
  "finance:write",
  "cashout:read",
  "cashout:review",
  "commission:read",
  "commission:write",
  "operator:read",
  "operator:write",
  "case:read",
  "case:write",
  "kyb:read",
  "kyb:write",
  "compliance:read",
  "compliance:write",
  "report:review",
  "report:approve",
  "approval:check",
  "approval:write",
  "reconciliation:read",
  "reconciliation:write",
  "payment:read",
].join(",");

const {
  extractAuthorityHints,
  requireAuthorities,
  requireSession,
} = await import("../../../../admin-back/api/middleware/authorityGuard");

const ROLE_AUTHORITIES: Record<string, string[]> = {
  GATEWAY_ADMIN: [
    "gateway:read",
    "gateway:write",
    "gateway:test",
    "merchant:read",
    "merchant:write",
    "user:write",
    "credential:write",
    "approval:write",
  ],
  SECURITY_ADMIN: [
    "security:read",
    "security:write",
    "user:write",
    "approval:write",
    "gateway:read",
    "credential:write",
  ],
  FINANCE: [
    "finance:read",
    "finance:write",
    "cashout:read",
    "cashout:review",
    "commission:read",
    "commission:write",
    "reconciliation:read",
    "reconciliation:write",
    "approval:write",
  ],
  OPERATOR: [
    "merchant:read",
    "operator:read",
    "operator:write",
    "case:read",
    "case:write",
    "kyb:read",
    "reconciliation:read",
  ],
  COMPLIANCE: [
    "compliance:read",
    "compliance:write",
    "aml:read",
    "aml:write",
    "kyb:read",
    "kyb:write",
    "report:review",
  ],
  MLRO: [
    "compliance:read",
    "compliance:write",
    "aml:read",
    "aml:write",
    "report:review",
    "report:approve",
    "approval:check",
  ],
  SUPPORT: ["merchant:read", "operator:read", "case:read", "cashout:read"],
  MERCHANT_ADMIN: ["merchant:read", "merchant:write"],
  MERCHANT_STAFF: ["merchant:read"],
  MERCHANT_CASHIER: ["payment:read"],
};

const ENDPOINT_AUTHORITIES = [
  "gateway:read",
  "gateway:write",
  "gateway:test",
  "merchant:read",
  "merchant:write",
  "user:write",
  "credential:write",
  "security:read",
  "security:write",
  "finance:read",
  "finance:write",
  "cashout:read",
  "cashout:review",
  "commission:read",
  "commission:write",
  "operator:read",
  "operator:write",
  "case:read",
  "case:write",
  "kyb:read",
  "kyb:write",
  "compliance:read",
  "compliance:write",
  "aml:read",
  "aml:write",
  "report:review",
  "report:approve",
  "approval:check",
  "approval:write",
  "reconciliation:read",
  "reconciliation:write",
  "payment:read",
] as const;

const ROLE_ALIASES: Record<string, string[]> = {
  COMPLIANCE: ["AML:READ", "AML:WRITE"],
  MLRO: ["AML:READ", "AML:WRITE"],
};

const tokenFor = (role: string, authorities: readonly string[]): string => {
  const payload = {
    sub: `user-${role}`,
    typ: "session",
    iss: "payment-gateway-core",
    aud: "payment-gateway-edge",
    role,
    authorities,
  };
  return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;
};

const requestWith = (authorization?: string): Request =>
  ({ headers: authorization ? { authorization } : {} }) as Request;

const runGuard = (required: string, authorization?: string) => {
  let nextCalled = false;
  try {
    requireAuthorities(required)(requestWith(authorization), {} as Response, (() => {
      nextCalled = true;
    }) as NextFunction);
    return { nextCalled, error: undefined as unknown };
  } catch (error) {
    return { nextCalled, error };
  }
};

describe("Suite 05 · admin role × endpoint authority matrix", () => {
  for (const role of USER_ROLES) {
    const authorities = ROLE_AUTHORITIES[role] ?? [];
    for (const required of ENDPOINT_AUTHORITIES) {
      const normalized = required.toUpperCase();
      const granted = authorities.map((entry) => entry.toUpperCase());
      const expected = granted.includes(normalized)
        || (ROLE_ALIASES[role] ?? []).includes(normalized);
      test(`${role} ${expected ? "may" : "may not"} call ${required}`, () => {
        const outcome = runGuard(required, `Bearer ${tokenFor(role, authorities)}`);
        if (expected) {
          expect(outcome.nextCalled).toBe(true);
          expect(outcome.error).toBeUndefined();
        } else {
          expect(outcome.nextCalled).toBe(false);
          expect(errorCode(outcome.error)).toBe("EDGE_AUTHORITY_DENIED");
          expect(errorStatus(outcome.error)).toBe(403);
        }
      });
    }
  }

  test("an unauthenticated request is refused with 401", () => {
    const outcome = runGuard("gateway:read", undefined);
    expect(errorCode(outcome.error)).toBe("AUTH_REQUIRED");
    expect(errorStatus(outcome.error)).toBe(401);
  });

  test("an empty authorities_map grants no access", () => {
    for (const required of ENDPOINT_AUTHORITIES) {
      const outcome = runGuard(required, `Bearer ${tokenFor("GATEWAY_ADMIN", [])}`);
      expect(outcome.nextCalled).toBe(false);
      expect(errorCode(outcome.error)).toBe("EDGE_AUTHORITY_DENIED");
    }
  });

  test("an unreadable credential is denied rather than trusted", () => {
    const outcome = runGuard("gateway:read", "Bearer not-a-jwt");
    expect(errorCode(outcome.error)).toBe("EDGE_AUTHORITY_DENIED");
  });
});

describe("Suite 05 · authority hint extraction", () => {
  test("reads role and authorities from a session token", () => {
    const hints = extractAuthorityHints(`Bearer ${tokenFor("FINANCE", ["finance:read"])}`);
    expect(hints?.roles).toContain("FINANCE");
    expect(hints?.authorities).toContain("finance:read");
  });

  test("reads the legacy roles array and authorities_map object", () => {
    const payload = {
      typ: "session",
      iss: "payment-gateway-core",
      aud: "payment-gateway-edge",
      roles: ["OPERATOR", "SUPPORT"],
      authorities_map: {
        "merchant:read": true,
        "gateway:read": ["read"],
      },
    };
    const token = `x.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.y`;
    const hints = extractAuthorityHints(`Bearer ${token}`);
    expect(hints?.roles).toEqual(["OPERATOR", "SUPPORT"]);
    expect(hints?.authorities).toContain("merchant:read");
    expect(hints?.authorities).toContain("read");
  });

  test("ignores an MFA challenge token", () => {
    const payload = {
      typ: "mfa",
      iss: "payment-gateway-core",
      aud: "payment-gateway-edge",
      role: "MLRO",
      authorities: ["aml:read"],
    };
    const token = `x.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.y`;
    expect(extractAuthorityHints(`Bearer ${token}`)).toBeNull();
  });

  test("ignores a token from a foreign issuer", () => {
    const payload = {
      typ: "session",
      iss: "someone-else",
      aud: "payment-gateway-edge",
      role: "MLRO",
    };
    const token = `x.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.y`;
    expect(extractAuthorityHints(`Bearer ${token}`)).toBeNull();
  });

  test("ignores a token for a foreign audience", () => {
    const payload = {
      typ: "session",
      iss: "payment-gateway-core",
      aud: "another-service",
      role: "MLRO",
    };
    const token = `x.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.y`;
    expect(extractAuthorityHints(`Bearer ${token}`)).toBeNull();
  });

  test("requireSession refuses a missing bearer token", () => {
    let nextCalled = false;
    try {
      requireSession(requestWith(), {} as Response, (() => {
        nextCalled = true;
      }) as NextFunction);
    } catch (error) {
      expect(errorCode(error)).toBe("AUTH_REQUIRED");
    }
    expect(nextCalled).toBe(false);
  });
});

describe("Suite 05 · UI authority projection", () => {
  const backendAuthorities = Object.keys(ROLE_AUTHORITIES).length > 0
    ? [...new Set(Object.values(ROLE_AUTHORITIES).flat())]
    : [];

  for (const authority of backendAuthorities) {
    test(`admin UI projection keeps the raw authority '${authority}'`, () => {
      const map = buildUiAuthoritiesMap([authority]);
      expect(map[authority]).toBe(true);
      expect(Object.keys(map).length).toBeGreaterThanOrEqual(1);
    });
  }

  test("merchant:read projects the merchant read screens", () => {
    const map = buildUiAuthoritiesMap(["merchant:read"]);
    for (const key of ["merchants.read", "support.read_merchant"]) {
      expect(map[key]).toBe(true);
    }
  });

  test("compliance:write projects the confidential AML screens", () => {
    const map = buildUiAuthoritiesMap(["compliance:write"]);
    for (const key of ["aml.read_confidential", "aml.review", "aml.propose", "reports.draft"]) {
      expect(map[key]).toBe(true);
    }
  });

  test("approval:check projects the checker screens", () => {
    const map = buildUiAuthoritiesMap(["approval:check"]);
    for (const key of ["approvals.approve", "approvals.reject", "users_admin.propose"]) {
      expect(map[key]).toBe(true);
    }
  });

  test("an unknown authority is still exposed verbatim", () => {
    expect(buildUiAuthoritiesMap(["custom:authority"])["custom:authority"]).toBe(true);
  });

  test("buildAdminUserInfo carries role, maker/checker flags and the projection", () => {
    const info = buildAdminUserInfo(
      {
        id: "u1",
        email: "mlro@example.com",
        phone: null,
        role: "MLRO",
        isMaker: true,
        isChecker: true,
      },
      ["aml:read", "report:approve"],
    );
    expect(info.username).toBe("mlro@example.com");
    expect(info.role).toBe("MLRO");
    expect(info.isMaker).toBe(true);
    expect(info.isChecker).toBe(true);
    expect(info.authoritiesMap["aml:read"]).toBe(true);
  });

  test("merchant projection maps merchant:write to the portal screens", () => {
    const map = buildMerchantUiAuthoritiesMap(["merchant:write"]);
    for (const key of ["wallets.read", "links.create", "cashout.request", "users.manage"]) {
      expect(map[key]).toBe(true);
    }
  });

  test("merchant projection maps link:write to link screens only", () => {
    const map = buildMerchantUiAuthoritiesMap(["link:write"]);
    expect(map["links.create"]).toBe(true);
    expect(map["links.cancel"]).toBe(true);
    expect(map["users.manage"]).toBeUndefined();
  });
});
