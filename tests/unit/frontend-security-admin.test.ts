// Regression tests for the admin-front security fixes (F7, F8, blob previews, backups page helpers).
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTHORITY_ALIASES,
  PUBLIC_FOR_AUTHENTICATED,
  normalizeAuthorities,
  resolveRouteRequirement,
  routesAuthorities,
} from "../../admin-front/src/utils/routeAuthorities";
import { safePreviewMime, safeRasterImageMime } from "../../admin-front/src/utils/safeBlob";
import {
  canRunBackupActions,
  clipServerText,
  needsExtraConfirm,
  validatePolicyForm,
} from "../../admin-front/src/utils/backupsGuard";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

describe("F7 no VITE_AUTHORIZED auth bypass", () => {
  test("admin user state no longer reads VITE_AUTHORIZED", () => {
    const src = read("admin-front/src/state/user/index.ts");
    expect(src).not.toContain("VITE_AUTHORIZED");
    expect(src).toContain("export const isAuthenticated = () => !!user.value?.token && !!user.value?.userInfo;");
  });
  test("no frontend source or committed env file defines it", () => {
    for (const a of ["admin-front", "merchant-front", "checkout-front"]) {
      for (const f of [`${a}/src/state/user/index.ts`]) {
        try {
          expect(read(f)).not.toContain("VITE_AUTHORIZED");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
    }
  });
});

describe("F8 route authority coverage (default-deny)", () => {
  const router = read("admin-front/src/router/index.ts");
  const names = [...router.matchAll(/^\s*name:\s*"([A-Za-z]+)"/gm)].map((m) => m[1]!);
  const publicRoutes = new Set(["Login", "NotFound"]); // outside the requiresAuth layout

  test("the router was parsed", () => {
    expect(names.length).toBeGreaterThan(30);
    expect(names).toContain("AdminUserDetail");
  });
  test("every named authenticated route has an explicit entry or is explicitly login-only", () => {
    const missing = names.filter(
      (n) => !publicRoutes.has(n) && !(n in routesAuthorities) && !PUBLIC_FOR_AUTHENTICATED.includes(n),
    );
    expect(missing).toEqual([]);
  });
  test("table entries are non-empty and refer to existing routes", () => {
    for (const [name, list] of Object.entries(routesAuthorities)) {
      expect(list.length, name).toBeGreaterThan(0);
      expect(names, name).toContain(name);
    }
  });
  test("previously unguarded routes now require an authority", () => {
    for (const n of [
      "AdminUserDetail",
      "AdminPlatformSettings",
      "AdminUsers",
      "PricingControls",
      "GatewayAiImport",
      "AdminCheckoutHelp",
    ]) {
      const r = resolveRouteRequirement(n);
      expect(r.allowed, n).toBe(true);
      expect(r.authorities.length, n).toBeGreaterThan(0);
    }
  });
  test("an unlisted route name is denied, listed login-only routes are allowed", () => {
    expect(resolveRouteRequirement("SomeNewRoute")).toEqual({ allowed: false, authorities: [] });
    expect(resolveRouteRequirement("Dashboard")).toEqual({ allowed: true, authorities: [] });
  });
  test("the router guard uses the default-deny resolver", () => {
    expect(router).toContain("resolveRouteRequirement(routeName)");
    expect(router).not.toContain("requiredAuthorities?.length &&");
  });
  test("authority naming is normalised through the alias map", () => {
    const all = Object.values(routesAuthorities).flat();
    const colon = [...new Set(all.filter((a) => a.includes(":")))];
    for (const a of colon) expect(a in AUTHORITY_ALIASES, `${a} must be in AUTHORITY_ALIASES`).toBe(true);
    expect(normalizeAuthorities(["gateway:read"])).toEqual(["gateway:read", "gateways.edit"]);
    // raw server names stay valid
    expect(resolveRouteRequirement("SystemBackups").authorities).toContain("security:read");
  });
});

describe("blob previews only allow png / jpeg / pdf", () => {
  test("safePreviewMime", () => {
    expect(safePreviewMime("image/png")).toBe("image/png");
    expect(safePreviewMime("IMAGE/JPEG; charset=x")).toBe("image/jpeg");
    expect(safePreviewMime("application/pdf")).toBe("application/pdf");
    for (const m of ["image/svg+xml", "text/html", "application/xhtml+xml", "application/javascript", "", undefined])
      expect(safePreviewMime(m)).toBeNull();
  });
  test("ApiImage never accepts svg", () => {
    expect(safeRasterImageMime("image/svg+xml")).toBeNull();
    expect(safeRasterImageMime("image/webp")).toBe("image/webp");
  });
  test("components use the whitelist and do not render <object>", () => {
    expect(read("admin-front/src/components/ApiImage/index.tsx")).not.toContain("<object");
    expect(read("merchant-front/src/components/ApiImage/index.tsx")).not.toContain("<object");
    const join = read("admin-front/src/pages/join-requests/[id].tsx");
    expect(join).toContain("safePreviewMime(document.mime)");
    expect(join).toContain('"noopener,noreferrer"');
    expect(read("admin-front/src/pages/kyb/components/KybDocumentPreview.tsx")).toContain("safePreviewMime(document.mime)");
  });
});

describe("no raw console.log of DOM/headers/query data in admin-front", () => {
  test("console.log calls are gated through devLog", () => {
    for (const f of [
      "admin-front/src/App.tsx",
      "admin-front/src/components/ApiImage/index.tsx",
      "admin-front/src/components/Table/ApiTable.tsx",
      "admin-front/src/utils/printJsx/index.tsx",
    ]) {
      expect(read(f), f).not.toContain("console.log(");
    }
    expect(read("admin-front/src/utils/devLog.ts")).toContain("import.meta.env.DEV");
  });
});

describe("backups page helpers", () => {
  test("actions need a configured, reachable daemon", () => {
    expect(canRunBackupActions({ configured: true, daemonReachable: true })).toBe(true);
    expect(canRunBackupActions({ configured: false, daemonReachable: true })).toBe(false);
    expect(canRunBackupActions({ configured: true, daemonReachable: false })).toBe(false);
    expect(canRunBackupActions(null)).toBe(false);
  });
  test("full + all needs an extra confirmation", () => {
    expect(needsExtraConfirm({ kind: "full", target: "all" })).toBe(true);
    expect(needsExtraConfirm({ kind: "delta", target: "all" })).toBe(false);
    expect(needsExtraConfirm({ kind: "full", target: "redis" })).toBe(false);
  });
  const good = {
    fullCron: "0 2 * * *",
    deltaCron: "*/15 * * * *",
    drillCron: "0 4 * * 0",
    fullRetentionDays: "30",
    walRetentionDays: "7",
    alertLagSeconds: "300",
  };
  test("valid policy passes and is converted to integers", () => {
    const r = validatePolicyForm(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fullRetentionDays).toBe(30);
  });
  test("invalid policies are rejected", () => {
    for (const bad of [
      { ...good, fullCron: "" },
      { ...good, deltaCron: "not a cron at all really" },
      { ...good, fullRetentionDays: "0" },
      { ...good, fullRetentionDays: "-5" },
      { ...good, walRetentionDays: "1.5" },
      { ...good, alertLagSeconds: "99999999" },
      { ...good, alertLagSeconds: "" },
    ])
      expect(validatePolicyForm(bad).ok).toBe(false);
  });
  test("server text is clipped and stripped of control characters", () => {
    expect(clipServerText("a\nb\u0000c")).toBe("a b c");
    expect(clipServerText("x".repeat(500)).length).toBe(200);
  });
  test("trigger and drill send an Idempotency-Key header", () => {
    const src = read("admin-front/src/pages/system/backups/index.tsx");
    expect(src.match(/"Idempotency-Key"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain("disabled={!actionsReady.value}");
  });
});
