/**
 * Shared harness of the ledger / operations / system admin route tests.
 *
 * It mounts the REAL routers on a throwaway express app against a real
 * PostgreSQL database (DATABASE_URL, the scratch test database) and lets a
 * test swap the principal between requests. Nothing here stands in for
 * production behaviour; it only provisions the request context.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { client } from "../../prisma/client";
import { isApiError, toErrorEnvelope } from "../../lib/error";
import type { Principal } from "../../api/middleware/authDoubleCheck";

export const uid = (prefix = "t"): string => `${prefix}-${randomUUID().slice(0, 8)}`;

export const createStaffUser = async (role: "SECURITY_ADMIN" | "SUPPORT" | "FINANCE" | "OPERATOR" = "SECURITY_ADMIN"): Promise<string> => {
  const id = randomUUID();
  await client.user.create({
    data: { id, email: `${uid("staff")}@admin-slice.invalid`, role: role as never, authoritiesMap: {} },
  });
  return id;
};

export const makePrincipal = (
  userId: string,
  authorities: string[],
  role = "SECURITY_ADMIN",
): Principal => ({
  kind: "session",
  userId,
  role,
  merchantId: null,
  applicationId: null,
  authorities,
  scopes: [],
  tokenId: null,
  sessionId: null,
});

export interface TestApp {
  setPrincipal(principal: Principal): void;
  request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
}

export const startApp = async (routers: Router[]): Promise<TestApp> => {
  let current: Principal | undefined;
  const app = express();
  app.use(express.json());
  app.use((request: Request, _response: Response, next: NextFunction) => {
    request.principal = current;
    next();
  });
  for (const router of routers) {
    app.use(router);
  }
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (isApiError(error)) {
      response.status(error.statusCode).json(toErrorEnvelope(error));
      return;
    }
    response.status(500).json({ code: "SERVER_ERROR", message: error instanceof Error ? error.message : "unknown" });
  });
  const server: http.Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    setPrincipal: (principal) => {
      current = principal;
    },
    request: async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null; // express default 404 page for an unmounted route
      }
      return { status: response.status, json };
    },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

export const auditRows = (action: string, entityId: string) =>
  client.auditLog.findMany({ where: { action, entityId } });

/** The tests need a migrated PostgreSQL (DATABASE_URL); without one the suites are skipped, like the other DB suites. */
export const dbAvailable: boolean = await client
  .$queryRaw`SELECT 1 FROM "schema_versions" LIMIT 1`
  .then(() => true)
  .catch(() => false);

/**
 * Hygiene for suites that share one database with the global-invariant suites
 * (test/exhaustive/*, the relay/shipper/queue workers).
 *
 * `purgeSince` deletes the rows a suite created in tables that allow it
 * (outbox, jobs, notifications...). The ledger is append-only by design, so
 * `neutraliseLedgerSince` cannot delete: for every GL account created since
 * `since` it posts one offsetting entry (net zero per account) and resets the
 * account's shards and checkpoint, so system-wide debits still equal credits.
 */
export const purgeSince = async (since: Date, tables: string[]): Promise<void> => {
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`invalid table name ${table}`);
    await client.$executeRawUnsafe(`DELETE FROM "${table}" WHERE created_at >= $1`, since);
  }
};

export const neutraliseLedgerSince = async (since: Date): Promise<void> => {
  const accounts = await client.glAccount.findMany({ where: { createdAt: { gte: since } }, select: { id: true } });
  if (accounts.length === 0) return;
  const ids = accounts.map((account) => account.id);
  const sums = await client.journalLine.groupBy({
    by: ["glAccountId", "direction"],
    where: { glAccountId: { in: ids } },
    _sum: { amount: true },
  });
  const net = new Map<string, number>();
  for (const row of sums) {
    const amount = Number(row._sum.amount ?? 0);
    net.set(row.glAccountId, (net.get(row.glAccountId) ?? 0) + (row.direction === "DEBIT" ? amount : -amount));
  }
  const lines = [...net.entries()]
    .filter(([, value]) => Math.abs(value) > 0.00005)
    .map(([glAccountId, value]) => ({
      glAccountId,
      direction: value > 0 ? ("CREDIT" as const) : ("DEBIT" as const),
      amount: Math.abs(value).toFixed(4),
    }));
  if (lines.length > 0) {
    await client.journalEntry.create({
      data: { refType: "ADJUSTMENT", refId: uid("neutralise"), description: "test hygiene: offsets the suite's own lines", journalLines: { create: lines } },
    });
  }
  await client.glAccountShard.updateMany({ where: { glAccountId: { in: ids } }, data: { currentBalance: 0 } });
  await client.glAccount.updateMany({ where: { id: { in: ids } }, data: { checkpointBalance: 0 } });
};
