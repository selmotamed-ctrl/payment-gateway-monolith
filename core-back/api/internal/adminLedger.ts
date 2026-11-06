import express, { type Request, type Response } from "express";
import { z } from "zod";
import { client } from "../../prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { buildListQuery, countUnlessSkipped, listResponse } from "../../lib/listQuery";
import { requireAuthorities } from "../middleware/authDoubleCheck";
import { writeAudit } from "../../lib/audit/writeAudit";
import { CheckpointService, ShardParityError } from "../../engine/ledger/CheckpointService";
import { naturalBalance } from "../../engine/ledger/InvariantVerifier";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { loadLiveAccountBalances } from "../../lib/storageEngine/shardBalances";
import { JournalRefType } from "../../generated/prisma/enums";
import {
  andWhere,
  auditActor,
  auditBase,
  enumListFilter,
  money4,
  reasonSchema,
  queryString,
  queryWithout,
  requireUuidParam,
  searchClause,
  uuidListFilter,
} from "./adminSliceHelpers";

/**
 * Ledger views of the admin console: journal entries and GL account detail.
 * Mounted under `/internal/admin` (see admin.ts). Balances never come from
 * hand-rolled arithmetic: shard sums (`loadLiveAccountBalances`) and the
 * existing `CheckpointService` are the only sources.
 */
const router = express.Router();

const REF_TYPES = Object.values(JournalRefType) as JournalRefType[];
const UNBALANCED_WINDOW_DAYS = 7;

/** Where the operator should look at the record a journal entry was posted for. */
const REFERENCE_ROUTES: Record<JournalRefType, string> = {
  PAYMENT_ATTEMPT: "attempt",
  ADJUSTMENT: "adjustment",
  AML_RELEASE: "aml-case",
  AML_VOID: "aml-case",
  SETTLEMENT_SWEEP: "settlement",
  FEE_VARIANCE: "reconciliation",
  COMMISSION_NETTING: "commission",
  DISPUTE_OUTCOME: "dispute",
};

interface LineTotals {
  lineCount: number;
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
  currency: string | null;
}

const totalsOf = (
  lines: ReadonlyArray<{ direction: "DEBIT" | "CREDIT"; amount: unknown; currency?: string | null }>,
): LineTotals => {
  let debit = decimal(0);
  let credit = decimal(0);
  const currencies = new Set<string>();
  for (const line of lines) {
    const amount = decimal(line.amount as never);
    if (line.direction === "DEBIT") {
      debit = debit.plus(amount);
    } else {
      credit = credit.plus(amount);
    }
    if (line.currency) {
      currencies.add(line.currency);
    }
  }
  return {
    lineCount: lines.length,
    totalDebit: debit.toFixed(4),
    totalCredit: credit.toFixed(4),
    // An entry without lines is not balanced; it is broken.
    balanced: lines.length > 0 && debit.equals(credit),
    currency: currencies.size === 0 ? null : currencies.size === 1 ? [...currencies][0]! : "MIXED",
  };
};

router.get("/finance/journal-entries/summary", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const now = Date.now();
  const since24h = new Date(now - 24 * 3600 * 1000);
  const sinceWindow = new Date(now - UNBALANCED_WINDOW_DAYS * 24 * 3600 * 1000);
  const [totalEntries, entries24h, volumeRows, unbalancedRows] = await Promise.all([
    client.journalEntry.count(),
    client.journalEntry.count({ where: { createdAt: { gte: since24h } } }),
    client.$queryRawUnsafe(
      `SELECT g.currency::text AS currency, SUM(jl.amount)::text AS total
       FROM journal_lines jl
       INNER JOIN gl_accounts g ON g.id = jl.gl_account_id
       WHERE jl.direction = 'DEBIT' AND jl.created_at >= $1
       GROUP BY g.currency ORDER BY g.currency`,
      since24h,
    ) as Promise<Array<{ currency: string; total: string }>>,
    client.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT entry_id FROM journal_lines
         WHERE created_at >= $1
         GROUP BY entry_id
         HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0
       ) unbalanced`,
      sinceWindow,
    ) as Promise<Array<{ count: number }>>,
  ]);
  response.json({
    totalEntries,
    entries24h,
    volume24hByCurrency: volumeRows.map((row) => ({ currency: row.currency, total: money4(row.total) })),
    unbalancedEntries: Number(unbalancedRows[0]?.count ?? 0),
    window: `${UNBALANCED_WINDOW_DAYS}d`,
  });
});

router.get("/finance/journal-entries", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const query = request.query as Record<string, unknown>;
  const refTypes = enumListFilter(query, "refType", REF_TYPES);
  const glAccountIds = uuidListFilter(query, "glAccountId");
  const built = buildListQuery(queryWithout(query, "search", "refType", "glAccountId"), {
    dates: { createdAt: { path: "createdAt" } },
    sortable: { createdAt: "createdAt", refType: "refType", refId: "refId" },
    defaultSort: { createdAt: "desc" },
    defaultPageSize: 25,
  });
  const where = andWhere(
    built.where,
    refTypes ? { refType: { in: refTypes } } : undefined,
    glAccountIds ? { journalLines: { some: { glAccountId: { in: glAccountIds } } } } : undefined,
    searchClause(queryString(query, "search"), { text: ["refId", "description"], uuid: ["id"] }),
  );
  const [entries, total] = await Promise.all([
    client.journalEntry.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: { id: true, createdAt: true, refType: true, refId: true, description: true },
    }),
    countUnlessSkipped(built, () => client.journalEntry.count({ where: where as never })),
  ]);
  const lines = entries.length === 0
    ? []
    : await client.journalLine.findMany({
        where: { entryId: { in: entries.map((entry) => entry.id) } },
        select: { entryId: true, direction: true, amount: true, glAccount: { select: { currency: true } } },
      });
  const byEntry = new Map<string, typeof lines>();
  for (const line of lines) {
    const bucket = byEntry.get(line.entryId) ?? [];
    bucket.push(line);
    byEntry.set(line.entryId, bucket);
  }
  const items = entries.map((entry) => ({
    id: entry.id,
    refType: entry.refType,
    refId: entry.refId,
    description: entry.description,
    createdAt: entry.createdAt,
    ...totalsOf((byEntry.get(entry.id) ?? []).map((line) => ({
      direction: line.direction,
      amount: line.amount,
      currency: line.glAccount.currency,
    }))),
  }));
  response.json(listResponse("journalEntries", items, total, built));
});

router.get("/finance/journal-entries/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const id = requireUuidParam(request.params.id, "JOURNAL_ENTRY_NOT_FOUND", "The journal entry does not exist");
  const entry = await client.journalEntry.findUnique({ where: { id } });
  if (!entry) {
    throw new ApiError(404, "JOURNAL_ENTRY_NOT_FOUND", "The journal entry does not exist");
  }
  // journal_lines is partitioned: always address it by entry_id (indexed), never by id alone.
  const lines = await client.journalLine.findMany({
    where: { entryId: id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdAt: true,
      direction: true,
      amount: true,
      glAccount: { select: { id: true, accountType: true, currency: true, ownerId: true } },
    },
  });
  const totals = totalsOf(lines.map((line) => ({
    direction: line.direction,
    amount: line.amount,
    currency: line.glAccount.currency,
  })));
  response.json({
    id: entry.id,
    refType: entry.refType,
    refId: entry.refId,
    description: entry.description,
    createdAt: entry.createdAt,
    balanced: totals.balanced,
    totalDebit: totals.totalDebit,
    totalCredit: totals.totalCredit,
    currency: totals.currency,
    lines: lines.map((line) => ({
      lineId: line.id,
      direction: line.direction,
      amount: money4(line.amount),
      glAccount: line.glAccount,
      createdAt: line.createdAt,
    })),
    reference: { type: entry.refType, id: entry.refId, route: REFERENCE_ROUTES[entry.refType] },
  });
});

const RECENT_LINES = 30;

/**
 * Snapshot of one GL account. `liveBalance` is debit-positive (the sign the
 * shards and the checkpoint are stored in), `naturalBalance` is the natural
 * sign of the account type. Both come from the shard total when shard rows
 * exist, otherwise from the checkpoint plus the lines posted after it.
 */
const glAccountSnapshot = async (id: string): Promise<Record<string, unknown>> => {
  const account = await client.glAccount.findUnique({ where: { id } });
  if (!account) {
    throw new ApiError(404, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  }
  const [balances, shards, lines] = await Promise.all([
    loadLiveAccountBalances(client, [id]),
    client.glAccountShard.findMany({ where: { glAccountId: id }, orderBy: { shardId: "asc" } }),
    client.journalLine.findMany({
      where: { glAccountId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_LINES,
      select: {
        id: true,
        entryId: true,
        createdAt: true,
        direction: true,
        amount: true,
        entry: { select: { refType: true, refId: true, description: true } },
      },
    }),
  ]);
  const live = balances[0];
  const natural = decimal(live?.balance ?? "0");
  return {
    account: {
      id: account.id,
      accountType: account.accountType,
      ownerId: account.ownerId,
      currency: account.currency,
      gatewayId: account.gatewayId,
      checkpointBalance: money4(account.checkpointBalance),
      checkpointAt: account.checkpointAt,
    },
    liveBalance: naturalBalance(account.accountType, natural).toFixed(4),
    naturalBalance: natural.toFixed(4),
    balanceSource: live?.source ?? "journal",
    shards: shards.map((shard) => ({
      shardId: shard.shardId,
      currentBalance: money4(shard.currentBalance),
      updatedAt: shard.updatedAt,
    })),
    recentLines: lines.map((line) => ({
      lineId: line.id,
      entryId: line.entryId,
      direction: line.direction,
      amount: money4(line.amount),
      createdAt: line.createdAt,
      refType: line.entry.refType,
      refId: line.entry.refId,
      description: line.entry.description,
    })),
  };
};

router.get("/finance/gl-accounts/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const id = requireUuidParam(request.params.id, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  response.json(await glAccountSnapshot(id));
});

const checkpointBodySchema = z.object({ reason: reasonSchema });

router.post("/finance/gl-accounts/:id/checkpoint", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:write"]);
  const actor = auditActor(request);
  const id = requireUuidParam(request.params.id, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  const body = parseOrThrow(checkpointBodySchema, request.body ?? {});
  const before = await client.glAccount.findUnique({
    where: { id },
    select: { id: true, accountType: true, currency: true, checkpointBalance: true, checkpointAt: true },
  });
  if (!before) {
    throw new ApiError(404, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  }
  let record;
  try {
    record = await new CheckpointService(client as never).captureCheckpoint(id);
  } catch (error) {
    if (error instanceof ShardParityError) {
      throw new ApiError(
        409,
        "LEDGER_SHARD_PARITY_MISMATCH",
        "The shard total differs from the journal total; the checkpoint was refused",
        {
          glAccountId: id,
          shardTotal: error.mismatch.shardTotal.toFixed(4),
          journalTotal: error.mismatch.journalTotal.toFixed(4),
          drift: error.mismatch.drift.toFixed(4),
        },
      );
    }
    throw error;
  }
  await writeAudit(client, {
    data: {
      ...auditBase(actor),
      action: "GL_ACCOUNT_CHECKPOINT_TRIGGERED",
      entityType: "GL_ACCOUNT",
      entityId: id,
      beforeJson: {
        checkpointBalance: money4(before.checkpointBalance),
        checkpointAt: before.checkpointAt?.toISOString() ?? null,
      },
      afterJson: {
        checkpointBalance: money4(record.balance),
        checkpointAt: record.asOf.toISOString(),
        accountType: before.accountType,
        currency: before.currency,
        reason: body.reason,
      },
    } as never,
  });
  response.json({
    ...(await glAccountSnapshot(id)),
    checkpoint: { id: record.id, asOf: record.asOf, balance: money4(record.balance) },
  });
});

export const adminLedgerRouter = router;
