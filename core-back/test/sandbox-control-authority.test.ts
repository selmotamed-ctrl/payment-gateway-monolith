import { describe, expect, test } from "bun:test";
import { assertSandboxControlAccess } from "../api/internal/sandboxControl";

/**
 * The Sandbox Studio control routes (`/internal/sandbox/*`) checked that the caller was signed in and that the
 * process was the SANDBOX plane, and nothing else: a read-only merchant user could wipe the merchant's sandbox,
 * set wallet balances and obtain a `pg_test_` API token from the demo seeder. Merchant authorities now apply
 * here as they do on the mirrored merchant routes.
 */
const merchant = (authorities: string[], role = "MERCHANT_STAFF") =>
  ({ kind: "session", role, authorities, merchantId: "11111111-1111-4111-8111-111111111111" }) as never;
const staff = (authorities: string[] = []) => ({ kind: "session", role: "OPERATOR", authorities, merchantId: null }) as never;

const refused = (run: () => void): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    return String((error as { code?: string }).code ?? (error as Error).message);
  }
};

describe("sandbox control access", () => {
  test.each(["POST", "PUT", "PATCH", "DELETE", "post"])("a %s needs merchant:write", (method) => {
    expect(refused(() => assertSandboxControlAccess(merchant(["merchant:read", "payment:read", "link:read", "pos:manage"]), method))).toBe("AUTHORITY_REQUIRED");
    expect(refused(() => assertSandboxControlAccess(merchant(["merchant:write"]), method))).toBeNull();
  });

  test("a read needs a merchant read grant", () => {
    expect(refused(() => assertSandboxControlAccess(merchant(["pos:manage"]), "GET"))).toBe("AUTHORITY_REQUIRED");
    expect(refused(() => assertSandboxControlAccess(merchant([]), "GET"))).toBe("AUTHORITY_REQUIRED");
    for (const authority of ["merchant:read", "merchant:write", "payment:read", "link:read"]) {
      expect(refused(() => assertSandboxControlAccess(merchant([authority]), "GET"))).toBeNull();
    }
  });

  test("the wildcard is not an authority for a merchant principal", () => {
    expect(refused(() => assertSandboxControlAccess(merchant(["*"]), "POST"))).toBe("AUTHORITY_REQUIRED");
  });

  test("a staff principal is left to the routes' own staff checks", () => {
    expect(refused(() => assertSandboxControlAccess(staff(), "POST"))).toBeNull();
    expect(refused(() => assertSandboxControlAccess(staff(), "GET"))).toBeNull();
  });

  test("the guard is mounted on the whole router, after authentication and the plane check, before any route", async () => {
    const source = (await Bun.file(new URL("../api/internal/sandboxControl.ts", import.meta.url)).text()).split("\r\n").join("\n");
    const guard = source.indexOf("assertSandboxControlAccess(principalOf(request), request.method);");
    expect(guard).toBeGreaterThan(source.indexOf("router.use(requireAuthentication);"));
    expect(guard).toBeGreaterThan(source.indexOf('"SANDBOX_PLANE_REQUIRED"'));
    const firstRoute = Math.min(...["router.get(", "router.post(", "router.put(", "router.delete(", "router.patch("]
      .map((signature) => source.indexOf(signature)).filter((index) => index >= 0));
    expect(guard).toBeLessThan(firstRoute);
  });
});
