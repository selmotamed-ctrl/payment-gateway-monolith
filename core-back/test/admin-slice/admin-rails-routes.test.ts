import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { client } from "../../prisma/client";
import { adminInternalRouter } from "../../api/internal";
import { signSession } from "../../lib/auth";
import { isApiError, toErrorEnvelope } from "../../lib/error";
import { createRow } from "../exhaustive/_dbFactory";
import { auditRows, dbAvailable, uid } from "./harness";

/**
 * Drives the REAL admin router (including its authentication) with real signed
 * admin sessions for two users: a gateway admin and a read-only gateway user.
 */
let server: http.Server;
let base = "";
let writerToken = "";
let readerToken = "";
let current = "";

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${current}`, "x-real-client-ip": "10.1.1.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};

const makeUser = async (authorities: string[]): Promise<string> => {
  const user = await client.user.create({
    data: {
      email: `${uid("rails")}@rails-routes.invalid`,
      role: "GATEWAY_ADMIN",
      status: "ACTIVE",
      authoritiesMap: Object.fromEntries(authorities.map((authority) => [authority, true])),
      appScopeIds: [],
      isMaker: false,
      isChecker: false,
      mfaRequired: false,
    },
  });
  return signSession({ sub: user.id, role: "GATEWAY_ADMIN", merchantId: null, authorities, appScopeIds: [], mfa: true }, "admin");
};

beforeAll(async () => {
  if (!dbAvailable) return;
  writerToken = await makeUser(["gateway:write", "gateway:read"]);
  readerToken = await makeUser(["gateway:read"]);
  const app = express();
  app.use(express.json());
  app.use("/", adminInternalRouter);
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (isApiError(error)) {
      response.status(error.statusCode).json(toErrorEnvelope(error));
      return;
    }
    response.status(500).json({ code: "SERVER_ERROR", message: error instanceof Error ? error.message : "unknown" });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

const app = {
  as: (token: string) => {
    current = token;
  },
  request: call,
};
const gatewayAdmin = () => app.as(writerToken);
const reader = () => app.as(readerToken);

describe.skipIf(!dbAvailable)("rail logo assignment (PATCH /rails/:id)", () => {
  test("sets, validates and clears the logo asset; audits it; needs gateway:write", async () => {
    const rail = await createRow("rails", { code: uid("rail") });
    const asset = await createRow("assets", {});
    gatewayAdmin();

    const unknown = await app.request("PATCH", `/rails/${rail.id}`, { logoAssetId: randomUUID() });
    expect(unknown.status).toBe(404);
    expect(unknown.json.code).toBe("ASSET_NOT_FOUND");

    const set = await app.request("PATCH", `/rails/${rail.id}`, { logoAssetId: asset.id });
    expect(set.status).toBe(200);
    expect(set.json.logoAssetId).toBe(asset.id);
    expect((await client.rail.findUniqueOrThrow({ where: { id: rail.id as string } })).logoAssetId).toBe(asset.id as string);

    const untouched = await app.request("PATCH", `/rails/${rail.id}`, { displayOrder: 7 });
    expect(untouched.status).toBe(200);
    expect((await client.rail.findUniqueOrThrow({ where: { id: rail.id as string } })).logoAssetId).toBe(asset.id as string);

    const cleared = await app.request("PATCH", `/rails/${rail.id}`, { logoAssetId: null });
    expect(cleared.status).toBe(200);
    expect((await client.rail.findUniqueOrThrow({ where: { id: rail.id as string } })).logoAssetId).toBeNull();

    const bad = await app.request("PATCH", `/rails/${rail.id}`, { logoAssetId: "not-a-uuid" });
    expect(bad.status).toBe(400);

    const audits = await auditRows("RAIL_UPDATED", rail.id as string);
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audits[0])).toContain("logoAssetId");

    reader();
    expect((await app.request("PATCH", `/rails/${rail.id}`, { logoAssetId: asset.id })).status).toBe(403);
  });
});

describe.skipIf(!dbAvailable)("route mismatch policy and maintenance windows (PATCH /routes/:id)", () => {
  const route = async () => createRow("rail_routes", {});
  const reload = async (id: string) => client.railRoute.findUniqueOrThrow({ where: { id } });

  test("stores valid windows and a tolerance, rejects invalid ones, clears with empty values", async () => {
    const row = await route();
    const id = row.id as string;
    gatewayAdmin();
    const windows = [{ start: "2026-12-01T01:00:00.000Z", end: "2026-12-01T03:00:00.000Z" }];

    const saved = await app.request("PATCH", `/routes/${id}`, { maintenanceWindows: windows, mismatchPolicy: { tolerance_amount: "0.5000", note: "kept" } });
    expect(saved.status).toBe(200);
    const stored = await reload(id);
    expect(stored.maintenanceWindows).toEqual(windows);
    expect(stored.mismatchPolicy).toEqual({ tolerance_amount: "0.5000", note: "kept" });

    // an unrelated update leaves both untouched
    expect((await app.request("PATCH", `/routes/${id}`, { priority: 9 })).status).toBe(200);
    const after = await reload(id);
    expect(after.priority).toBe(9);
    expect(after.maintenanceWindows).toEqual(windows);
    expect(after.mismatchPolicy).toEqual({ tolerance_amount: "0.5000", note: "kept" });

    const reversed = await app.request("PATCH", `/routes/${id}`, { maintenanceWindows: [{ start: windows[0]!.end, end: windows[0]!.start }] });
    expect(reversed.status).toBe(400);
    expect(reversed.json.code).toBe("MAINTENANCE_WINDOW_INVALID");
    const garbage = await app.request("PATCH", `/routes/${id}`, { maintenanceWindows: [{ start: "not a date at all", end: "still not a date" }] });
    expect(garbage.status).toBe(400);
    expect(garbage.json.code).toBe("MAINTENANCE_WINDOW_INVALID");
    const tolerance = await app.request("PATCH", `/routes/${id}`, { mismatchPolicy: { tolerance_amount: "-1" } });
    expect(tolerance.status).toBe(400);
    expect(tolerance.json.code).toBe("MISMATCH_TOLERANCE_INVALID");
    const tooMany = await app.request("PATCH", `/routes/${id}`, { maintenanceWindows: Array.from({ length: 51 }, () => windows[0]) });
    expect(tooMany.status).toBe(400);
    // a rejected request changed nothing
    expect((await reload(id)).maintenanceWindows).toEqual(windows);

    const cleared = await app.request("PATCH", `/routes/${id}`, { maintenanceWindows: [], mismatchPolicy: {} });
    expect(cleared.status).toBe(200);
    const empty = await reload(id);
    expect(empty.maintenanceWindows).toEqual([]);
    expect(empty.mismatchPolicy).toEqual({});
  });

  test("camelCase toleranceAmount is validated the same way", async () => {
    const row = await route();
    gatewayAdmin();
    expect((await app.request("PATCH", `/routes/${row.id}`, { mismatchPolicy: { toleranceAmount: "abc" } })).status).toBe(400);
    expect((await app.request("PATCH", `/routes/${row.id}`, { mismatchPolicy: { toleranceAmount: "1.25" } })).status).toBe(200);
  });
});
