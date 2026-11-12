import { describe, expect, test } from "bun:test";
import { reportEngineRouter } from "../api/protected/reportEngine";

type RegisteredRoute = { path: string; method: string; index: number };

const registered = (): RegisteredRoute[] =>
  ((reportEngineRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack)
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

describe("merchant report-engine edge route ordering", () => {
  test("every static route is registered before an earlier dynamic route that could shadow it", () => {
    const routes = registered();
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
    expect(failures).toEqual([]);
  });

  test("the chrome and migration endpoints are present before their dynamic ids", () => {
    const routes = registered();
    for (const expected of [
      "get /studio/chrome/transcript",
      "get /studio/chrome/needs-migration",
      "get /studio/chrome/:id",
      "get /studio/chrome/:id/migration-prompt",
      "get /studio/needs-migration",
      "get /studio/specs/:id/migration-prompt",
    ]) {
      expect(routes.some((route) => `${route.method} ${route.path}` === expected)).toBe(true);
    }
  });
});
