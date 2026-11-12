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
import { LedgerPoster, decimal } from "../../engine/ledger/LedgerPoster";
import { createLedgerShardWriter } from "../../lib/storageEngine/ledgerShardWriter";
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

/** A router, or a router mounted under a path prefix (as production mounts it). */
export type Mount = Router | readonly [string, Router];

export const startApp = async (routers: Mount[]): Promise<TestApp> => {
  let current: Principal | undefined;
  const app = express();
  app.use(express.json());
  app.use((request: Request, _response: Response, next: NextFunction) => {
    request.principal = current;
    next();
  });
  for (const mount of routers) {
    if (Array.isArray(mount)) app.use(mount[0] as string, mount[1] as Router);
    else app.use(mount as Router);
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
 * Posts one journal entry the way production does, so the rows stay shard-consistent (every line carries its shard and
 * a real per-shard sequence, and the shard balances / `line_seq` move with it).
 *
 *  - A BALANCED entry goes through `LedgerPoster.post` (it validates the template and projects the shards).
 *  - A deliberately UNBALANCED entry (the "unbalanced entry" detection tests) cannot pass the poster's template
 *    validation, so it reserves the shard sequences with the same shard writer and inserts the lines itself.
 */
export interface EntryLine {
  glAccountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
}

export const postEntry = async (
  lines: EntryLine[],
  refType = "ADJUSTMENT",
  description = "test entry",
  refId: string = uid("ref"),
): Promise<{ id: string; refId: string }> => {
  const accounts = await client.glAccount.findMany({
    where: { id: { in: [...new Set(lines.map((line) => line.glAccountId))] } },
    select: { id: true, accountType: true },
  });
  const typeOf = new Map(accounts.map((account) => [account.id, account.accountType]));
  const total = (direction: "DEBIT" | "CREDIT") =>
    lines.filter((line) => line.direction === direction).reduce((sum, line) => sum.plus(line.amount), decimal(0));
  if (total("DEBIT").equals(total("CREDIT"))) {
    const result = await new LedgerPoster(client as never).post({
      refType: refType as never,
      refId,
      description,
      lines: lines.map((line) => ({
        direction: line.direction,
        amount: line.amount,
        account: { accountType: typeOf.get(line.glAccountId) as never, accountId: line.glAccountId },
      })),
    });
    return { id: result.entry.id, refId };
  }
  return client.$transaction(async (tx) => {
    const assignments = await createLedgerShardWriter()(
      tx as never,
      lines.map((line) => ({
        entryId: "pending",
        refType,
        refId,
        glAccountId: line.glAccountId,
        accountType: typeOf.get(line.glAccountId) as never,
        direction: line.direction,
        amount: line.amount,
      })),
    );
    const entry = await tx.journalEntry.create({
      data: {
        refType: refType as never,
        refId,
        description,
        journalLines: {
          create: lines.map((line, index) => ({
            glAccountId: line.glAccountId,
            direction: line.direction,
            amount: line.amount,
            shardId: assignments[index]!.shardId,
            shardSeq: assignments[index]!.shardSeq,
          })),
        },
      },
    });
    return { id: entry.id, refId };
  });
};

/**
 * Hygiene for suites that share one database with the global-invariant suites
 * (test/exhaustive/*, the relay/shipper/queue workers).
 *
 * `purgeSince` deletes the rows a suite created in tables that allow it
 * (outbox, jobs, notifications...). The ledger is append-only by design, so
 * `neutraliseLedgerSince` cannot delete: for every GL account created since
 * `since` it posts one offsetting entry (net zero per account) through the same
 * write path as production, so system-wide debits still equal credits and the
 * rows stay shard-consistent. If the suite itself forged a shard balance, the
 * shards of those accounts are finally re-derived from their journal lines.
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
  const net = new Map<string, ReturnType<typeof decimal>>();
  for (const row of sums) {
    const amount = decimal(row._sum.amount?.toString() ?? "0");
    net.set(row.glAccountId, (net.get(row.glAccountId) ?? decimal(0)).plus(row.direction === "DEBIT" ? amount : amount.negated()));
  }
  const lines: EntryLine[] = [...net.entries()]
    .filter(([, value]) => !value.isZero())
    .map(([glAccountId, value]) => ({
      glAccountId,
      direction: value.greaterThan(0) ? ("CREDIT" as const) : ("DEBIT" as const),
      amount: value.abs().toFixed(4),
    }));
  if (lines.length > 0) {
    await postEntry(lines, "ADJUSTMENT", "test hygiene: offsets the suite's own lines", uid("neutralise"));
  }
  await client.$executeRawUnsafe(
    `UPDATE gl_account_shards s SET current_balance = COALESCE((
       SELECT SUM(CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END)
       FROM journal_lines jl WHERE jl.gl_account_id = s.gl_account_id AND jl.shard_id = s.shard_id), 0)
     WHERE s.gl_account_id = ANY($1::uuid[])`,
    ids,
  );
};
