import { describe, expect, test } from "bun:test";
import { adminReportEngineRouter } from "../../api/internal/adminReportEngine";
import { merchantReportEngineRouter } from "../../api/internal/merchantReportEngine";

type RegisteredRoute = { path: string; method: string; index: number };

const registered = (router: unknown): RegisteredRoute[] =>
  ((router as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack)
    .filter((layer) => layer.route)
    .flatMap((layer, index) =>
      Object.entries(layer.route!.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => ({ path: layer.route!.path, method, index })),
    );

const dynamicMatches = (pattern: string, path: string): boolean => {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
};

const shadowedStatics = (router: unknown): string[] => {
  const routes = registered(router);
  const failures: string[] = [];
  for (const route of routes) {
    if (route.path.includes(":")) continue;
    for (const earlier of routes) {
      if (earlier.method !== route.method || earlier.index >= route.index) continue;
      if (earlier.path.includes(":") && dynamicMatches(earlier.path, route.path)) {
        failures.push(`${earlier.method.toUpperCase()} ${earlier.path} shadows ${route.path}`);
      }
    }
  }
  return failures;
};

describe("report engine core route ordering", () => {
  test("admin static routes are not shadowed by dynamic routes", () => {
    expect(shadowedStatics(adminReportEngineRouter)).toEqual([]);
  });

  test("merchant static routes are not shadowed by dynamic routes", () => {
    expect(shadowedStatics(merchantReportEngineRouter)).toEqual([]);
  });

  test("migration endpoints are registered", () => {
    const admin = registered(adminReportEngineRouter);
    const merchant = registered(merchantReportEngineRouter);
    for (const expected of [
      "get /report-engine/specs/needs-migration",
      "get /report-engine/specs/:id/migration-prompt",
      "get /report-engine/merchant-reports/:id/migration-prompt",
      "get /report-engine/chrome/needs-migration",
      "get /report-engine/chrome/:id/migration-prompt",
      "post /report-engine/chrome/reconcile-defaults",
    ]) {
      expect(admin.some((route) => `${route.method} ${route.path}` === expected)).toBe(true);
    }
    for (const expected of [
      "get /report-engine/studio/needs-migration",
      "get /report-engine/studio/specs/:id/migration-prompt",
      "get /report-engine/studio/chrome/transcript",
      "get /report-engine/studio/chrome/needs-migration",
      "get /report-engine/studio/chrome/:id",
      "get /report-engine/studio/chrome/:id/migration-prompt",
    ]) {
      expect(merchant.some((route) => `${route.method} ${route.path}` === expected)).toBe(true);
    }
  });
});
