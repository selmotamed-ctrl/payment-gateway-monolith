import express, { type Request, type Response } from "express";
import { z } from "zod";
import { client } from "../../prisma/client";
import { ApiError, parseOrThrow } from "../../lib/error";
import { buildListQuery, countUnlessSkipped, listResponse } from "../../lib/listQuery";
import { requireAuthorities } from "../middleware/authDoubleCheck";
import { writeAudit } from "../../lib/audit/writeAudit";
import { CheckpointService } from "../../engine/ledger/CheckpointService";
import { applyShardWidth } from "../../engine/ledger/shardScaling";
import { applyShardRepair, planShardRepair, serializeRepairPlan } from "../../engine/ledger/ShardRepair";
import { APPROVAL_PENDING_STATES, approvalSubjectTypeVariants } from "../../lib/approvalQueue";
import { listAccountLines } from "./ledgerLines";
import { naturalBalance } from "../../engine/ledger/InvariantVerifier";
import { decimal } from "../../engine/ledger/LedgerPoster";
import { loadAccountCheckpointSummary, loadLiveAccountBalances } from "../../lib/storageEngine/shardBalances";
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
  // journal_lines is monthly range-partitioned by created_at. A page can span months (and an
  // entry's lines are inserted in its own transaction), so bound the lookup by the page's
  // oldest/newest entry timestamp plus a small margin: PostgreSQL then prunes every monthly
  // partition outside that window instead of probing all of them for each entry id.
  const entryTimes = entries.map((entry) => entry.createdAt.getTime());
  const lines = entries.length === 0
    ? []
    : await client.journalLine.findMany({
        where: {
          entryId: { in: entries.map((entry) => entry.id) },
          createdAt: {
            gte: new Date(Math.min(...entryTimes) - 5 * 60 * 1000),
            lte: new Date(Math.max(...entryTimes) + 5 * 60 * 1000),
          },
        },
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
  // journal_lines is partitioned: always address it by entry_id (indexed) AND a createdAt
  // window derived from the parent entry (lines are inserted in the entry's transaction),
  // never by id alone, so PostgreSQL prunes every monthly partition outside the window.
  const lines = await client.journalLine.findMany({
    where: {
      entryId: id,
      createdAt: {
        gte: new Date(entry.createdAt.getTime() - 5 * 60 * 1000),
        lte: new Date(entry.createdAt.getTime() + 5 * 60 * 1000),
      },
    },
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

/**
 * Snapshot of one GL account. `liveBalance` is debit-positive (the sign the shards and the shard
 * checkpoints are stored in), `naturalBalance` is the natural sign of the account type. Both are the sum
 * of the account's shard rows. The account itself stores no checkpoint: `account.checkpointBalance` and
 * `account.checkpointAt` are DERIVED from its shard checkpoints (sum, and the oldest checkpoint time),
 * and every shard carries its own checkpoint, pending-line count and status. Sequence numbers are
 * strings (they are 64-bit).
 */
const glAccountSnapshot = async (id: string): Promise<Record<string, unknown>> => {
  const account = await client.glAccount.findUnique({ where: { id } });
  if (!account) {
    throw new ApiError(404, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  }
  const [balances, shards, summaries] = await Promise.all([
    loadLiveAccountBalances(client, [id]),
    client.glAccountShard.findMany({ where: { glAccountId: id }, orderBy: { shardId: "asc" }, include: { checkpoint: true } }),
    loadAccountCheckpointSummary(client, [id]),
  ]);
  const live = balances[0];
  const summary = summaries[0];
  const natural = decimal(live?.balance ?? "0");
  return {
    account: {
      id: account.id,
      accountType: account.accountType,
      ownerId: account.ownerId,
      currency: account.currency,
      gatewayId: account.gatewayId,
      checkpointBalance: money4(summary?.checkpointBalance ?? 0),
      checkpointAt: summary?.checkpointAt ?? null,
      shardCount: account.shardCount,
      shardScaledAt: account.shardScaledAt,
    },
    liveBalance: naturalBalance(account.accountType, natural).toFixed(4),
    naturalBalance: natural.toFixed(4),
    balanceSource: live?.source ?? "shards",
    checkpoint: {
      status: summary?.status ?? "OK",
      pendingLines: summary?.pendingLines ?? "0",
      shardsBehind: summary?.shardsBehind ?? 0,
    },
    shards: shards.map((shard) => {
      const checkpointSeq = shard.checkpoint?.checkpointSeq ?? 0n;
      return {
        shardId: shard.shardId,
        currentBalance: money4(shard.currentBalance),
        lineSeq: shard.lineSeq.toString(),
        checkpointBalance: money4(shard.checkpoint?.checkpointBalance ?? 0),
        checkpointSeq: checkpointSeq.toString(),
        checkpointAt: shard.checkpoint?.checkpointAt ?? null,
        pendingLines: (shard.lineSeq - checkpointSeq).toString(),
        status: shard.checkpoint?.status ?? "OK",
        failureKind: shard.checkpoint?.failureKind ?? null,
        consecutiveFailures: shard.checkpoint?.consecutiveFailures ?? 0,
        updatedAt: shard.updatedAt,
      };
    }),
  };
};

/**
 * Paginated posting lines of one GL account (the drawer's "Lines" table). The list is a
 * separate call so the snapshot stays small whatever the account's history; filters are
 * `direction`, `refType`, `search` and the shared `from`/`to` range.
 */
router.get("/finance/gl-accounts/:id/lines", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const id = requireUuidParam(request.params.id, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  const exists = await client.glAccount.findUnique({ where: { id }, select: { id: true } });
  if (!exists) {
    throw new ApiError(404, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  }
  response.json(await listAccountLines(id, request.query as Record<string, unknown>));
});

router.get("/finance/gl-accounts/:id", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const id = requireUuidParam(request.params.id, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  response.json(await glAccountSnapshot(id));
});

const checkpointBodySchema = z.object({ reason: reasonSchema });

/**
 * "Checkpoint now": captures every shard of the account with the same verified, O(delta) routine the
 * automatic worker uses (no lock on the account, postings keep flowing). A shard whose lines do not add up
 * is NOT advanced and the call answers 409 naming that shard; the shards that were fine have moved.
 */
router.post("/finance/gl-accounts/:id/checkpoint", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:write"]);
  const actor = auditActor(request);
  const id = requireUuidParam(request.params.id, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  const body = parseOrThrow(checkpointBodySchema, request.body ?? {});
  const account = await client.glAccount.findUnique({ where: { id }, select: { id: true, accountType: true, currency: true } });
  if (!account) {
    throw new ApiError(404, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  }
  const [before] = await loadAccountCheckpointSummary(client, [id]);
  const results = await new CheckpointService(client as never).captureAccount(id);
  const failed = results.find((result) => result.status === "GAP" || result.status === "PARITY");
  const advanced = results.filter((result) => result.status === "ADVANCED");
  const [after] = await loadAccountCheckpointSummary(client, [id]);
  await writeAudit(client, {
    data: {
      ...auditBase(actor),
      action: "GL_ACCOUNT_CHECKPOINT_TRIGGERED",
      entityType: "GL_ACCOUNT",
      entityId: id,
      beforeJson: {
        checkpointBalance: money4(before?.checkpointBalance ?? 0),
        checkpointAt: before?.checkpointAt?.toISOString() ?? null,
        pendingLines: before?.pendingLines ?? "0",
      },
      afterJson: {
        checkpointBalance: money4(after?.checkpointBalance ?? 0),
        checkpointAt: after?.checkpointAt?.toISOString() ?? null,
        pendingLines: after?.pendingLines ?? "0",
        shardsAdvanced: advanced.length,
        linesCovered: advanced.reduce((sum, result) => sum + result.linesCovered, 0n).toString(),
        failedShard: failed ? { shardId: failed.shardId, kind: failed.status, drift: failed.drift.toFixed(4) } : null,
        accountType: account.accountType,
        currency: account.currency,
        reason: body.reason,
      },
    } as never,
  });
  if (failed) {
    throw new ApiError(
      409,
      "LEDGER_SHARD_PARITY_MISMATCH",
      failed.status === "GAP"
        ? "A shard's journal lines are not gapless; its checkpoint was refused"
        : "The shard total differs from the journal total; its checkpoint was refused",
      {
        glAccountId: id,
        shardId: failed.shardId,
        kind: failed.status,
        shardTotal: failed.balance.toFixed(4),
        journalTotal: failed.balance.minus(failed.drift).toFixed(4),
        drift: failed.drift.toFixed(4),
        linesFound: failed.linesFound.toString(),
        linesExpected: (failed.lineSeq - failed.previousSeq).toString(),
      },
    );
  }
  const snapshot = (await glAccountSnapshot(id)) as { checkpoint: Record<string, unknown> };
  response.json({
    ...snapshot,
    checkpoint: {
      ...snapshot.checkpoint,
      shardsAdvanced: advanced.length,
      linesCovered: advanced.reduce((sum, result) => sum + result.linesCovered, 0n).toString(),
    },
  });
});

const scaleBodySchema = z.object({ width: z.number().int().min(1).max(256), reason: reasonSchema }).strict();

/**
 * Manual shard-width override: routes the account's NEW lines over `width` shards (1..256). Widening creates the
 * missing shard rows; narrowing only changes where new lines go (the old shards keep summing and checkpointing).
 * Audited with the operator's reason; the automatic scaler uses the same operation.
 */
router.post("/finance/gl-accounts/:id/shards/scale", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:write"]);
  const actor = auditActor(request);
  const id = requireUuidParam(request.params.id, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  const body = parseOrThrow(scaleBodySchema, request.body ?? {});
  const account = await client.glAccount.findUnique({ where: { id }, select: { id: true, accountType: true, currency: true } });
  if (!account) {
    throw new ApiError(404, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  }
  const outcome = await applyShardWidth(client, {
    glAccountId: id,
    newWidth: body.width,
    audit: {
      actorId: actor.actorId,
      role: actor.role,
      action: "GL_ACCOUNT_SHARDS_SCALED",
      extra: { reason: body.reason, automatic: false, accountType: account.accountType, currency: account.currency },
    },
  });
  if (!outcome.changed) {
    throw new ApiError(409, "SHARD_WIDTH_UNCHANGED", "The account already routes over that many shards", { shardCount: outcome.oldWidth });
  }
  response.json({ ...(await glAccountSnapshot(id)), scaled: { from: outcome.oldWidth, to: outcome.newWidth } });
});

const shardIdParam = (value: unknown): number => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0 || id > 255) {
    throw new ApiError(404, "GL_SHARD_NOT_FOUND", "The shard does not exist");
  }
  return id;
};

const repairBodySchema = z.object({ reason: reasonSchema, planHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/**
 * Preview of what repairing one shard would do, computed from the whole journal of that shard. Read only.
 * `kind` is RECOMPUTE (intact sequence: the stored balance/checkpoint is recomputed from the journal) or REBASELINE
 * (damaged sequence: needs a second person's approval); `needsRepair` is false for a healthy shard.
 */
router.get("/finance/gl-accounts/:id/shards/:shardId/repair-plan", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:read"]);
  const id = requireUuidParam(request.params.id, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  const shardId = shardIdParam(request.params.shardId);
  response.json(serializeRepairPlan(await planShardRepair(client, id, shardId)));
});

/**
 * Manual repair of a shard whose sequence is intact: recompute its balance and checkpoint from the journal, now.
 * This performs exactly what the automatic repair does (without its waiting period and amount limit). The call must carry
 * the `planHash` of the preview; if the shard moved since, it is refused and must be previewed again. A damaged
 * sequence is never repaired here: answer `409 SHARD_REPAIR_NEEDS_APPROVAL` and use the approval request below.
 */
router.post("/finance/gl-accounts/:id/shards/:shardId/repair", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:write"]);
  const actor = auditActor(request);
  const id = requireUuidParam(request.params.id, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  const shardId = shardIdParam(request.params.shardId);
  const body = parseOrThrow(repairBodySchema, request.body ?? {});
  const result = await applyShardRepair(client, {
    glAccountId: id,
    shardId,
    mode: "MANUAL",
    allowedKinds: ["RECOMPUTE"],
    expectedPlanHash: body.planHash,
    reason: body.reason,
    actor: { actorId: actor.actorId, role: actor.role },
  });
  if (!result.repaired) {
    throw new ApiError(409, "SHARD_REPAIR_NOT_NEEDED", "The shard already matches its journal", { planHash: result.plan.planHash });
  }
  response.json({ repaired: true, repairId: result.repairId, plan: serializeRepairPlan(result.plan), ...(await glAccountSnapshot(id)) });
});

/**
 * Asks a second person to approve repairing a shard (required for REBASELINE, allowed for RECOMPUTE). The approval is
 * bound to the previewed `planHash`: when the approver accepts it the repair is re-planned under the shard lock and
 * refused if the shard changed meanwhile. Maker and checker must be different users (enforced by the approvals flow).
 */
router.post("/finance/gl-accounts/:id/shards/:shardId/repair/request", async (request: Request, response: Response) => {
  requireAuthorities(request, ["finance:write"]);
  const actor = auditActor(request);
  const id = requireUuidParam(request.params.id, "GL_ACCOUNT_NOT_FOUND", "The GL account does not exist");
  const shardId = shardIdParam(request.params.shardId);
  const body = parseOrThrow(repairBodySchema, request.body ?? {});
  const plan = await planShardRepair(client, id, shardId);
  if (!plan.needsRepair || plan.kind === null) {
    throw new ApiError(409, "SHARD_REPAIR_NOT_NEEDED", "The shard already matches its journal");
  }
  if (plan.planHash !== body.planHash) {
    throw new ApiError(409, "SHARD_REPAIR_PLAN_CHANGED", "The shard changed since the repair was previewed; preview it again", { planHash: plan.planHash });
  }
  const subjectId = `${id}:${shardId}`;
  const pending = await client.approvalRequest.findFirst({
    where: { subjectType: { in: approvalSubjectTypeVariants("GL_SHARD_REPAIR") }, subjectId, state: { in: [...APPROVAL_PENDING_STATES] } },
    select: { id: true },
  });
  if (pending) {
    throw new ApiError(409, "SHARD_REPAIR_APPROVAL_PENDING", "A repair of this shard is already awaiting a checker", { approvalRequestId: pending.id });
  }
  const approval = await client.$transaction(async (tx) => {
    const created = await tx.approvalRequest.create({
      data: {
        subjectType: "GL_SHARD_REPAIR",
        subjectId,
        payloadDiffJson: {
          action: "GL_SHARD_REPAIR",
          glAccountId: id,
          shardId,
          kind: plan.kind,
          planHash: plan.planHash,
          fromBalance: plan.before.balance.toFixed(4),
          toBalance: plan.after.balance.toFixed(4),
          delta: plan.delta.toFixed(4),
          reason: body.reason,
        } as never,
        makerReason: body.reason,
        mode: "STANDARD",
        makerUserId: actor.actorId,
        state: "PENDING_REVIEW",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    await writeAudit(tx, {
      data: {
        ...auditBase(actor),
        action: "GL_SHARD_REPAIR_REQUESTED",
        entityType: "GL_ACCOUNT",
        entityId: id,
        approvalRequestId: created.id,
        beforeJson: { shardId, balance: plan.before.balance.toFixed(4) },
        afterJson: { shardId, kind: plan.kind, toBalance: plan.after.balance.toFixed(4), delta: plan.delta.toFixed(4), planHash: plan.planHash, reason: body.reason },
      } as never,
    });
    return created;
  });
  response.status(202).json({ approvalRequestId: approval.id, state: approval.state, plan: serializeRepairPlan(plan) });
});

export const adminLedgerRouter = router;
