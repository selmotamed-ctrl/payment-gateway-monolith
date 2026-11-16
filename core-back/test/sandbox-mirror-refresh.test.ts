import { describe, expect, test } from "bun:test";
import { shouldRefreshSandboxMirror } from "../api/middleware/authDoubleCheck";

const existing = {
  status: "ACTIVE",
  role: "MLRO",
  merchantId: null,
  authoritiesMap: ["case:read"],
  appScopeIds: [],
  updatedAt: new Date("2026-11-16T14:20:00.000Z"),
};

const claims = (issuedAt: number, authorities = ["case:read", "finance:read"]) => ({
  role: "MLRO",
  merchantId: null,
  authorities,
  appScopeIds: [],
  issuedAt,
});

describe("sandbox mirror refresh", () => {
  test("refreshes an existing mirror from a newer token", () => {
    expect(shouldRefreshSandboxMirror(existing, claims(Math.floor(existing.updatedAt.getTime() / 1000) + 1))).toBe(true);
  });

  test("does not let an older token overwrite a newer mirror", () => {
    expect(shouldRefreshSandboxMirror(existing, claims(Math.floor(existing.updatedAt.getTime() / 1000) - 1))).toBe(false);
  });

  test("does not refresh when the newer token has the same identity", () => {
    expect(shouldRefreshSandboxMirror(existing, claims(Math.floor(existing.updatedAt.getTime() / 1000) + 1, ["case:read"]))).toBe(false);
  });

  test("never refreshes an inactive mirror", () => {
    expect(shouldRefreshSandboxMirror({ ...existing, status: "DISABLED" }, claims(Math.floor(existing.updatedAt.getTime() / 1000) + 1))).toBe(false);
  });
});
