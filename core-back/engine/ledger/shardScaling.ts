import { ensureAccountShards } from "../../lib/storageEngine/ledgerShardWriter";
import { clampShardWidth, clearShardWidthCache } from "../../lib/storageEngine/shardRouting";
import { inTransaction } from "./ledgerAlerts";
import { writeAudit } from "../../lib/audit/writeAudit";

type Any = Record<string, any>;

export interface ApplyShardWidthInput {
  glAccountId: string;
  newWidth: number;
  /** Optimistic guard: only change the width when it still is this value. */
  expectedOldWidth?: number;
  /** Audit identity and details of whoever asked (the scaler worker, or an admin with a reason). */
  audit: { actorId: string; role: string; action: string; extra?: Record<string, unknown>; requestFields?: Record<string, unknown> };
}

export interface ApplyShardWidthResult {
  changed: boolean;
  oldWidth: number;
  newWidth: number;
}

/**
 * Changes the routing width of a GL account in ONE transaction: the account row, the missing shard rows and the
 * audit row commit together.
 *
 * It takes `FOR NO KEY UPDATE` on the account row, which does not conflict with the `KEY SHARE` lock every journal
 * line insert takes through its foreign key, so postings keep flowing. Widening creates shard rows
 * `[old, new)` eagerly. Narrowing only changes where NEW lines go: the old shard rows keep their balances, their
 * sequences and their checkpoints, and still add up. Nothing is ever remapped, because every line stores its shard.
 */
export const applyShardWidth = async (db: Any, input: ApplyShardWidthInput): Promise<ApplyShardWidthResult> => {
  const newWidth = clampShardWidth(input.newWidth);
  const result = await inTransaction(db, async (tx): Promise<ApplyShardWidthResult> => {
    const rows = (await tx.$queryRawUnsafe(
      `SELECT shard_count FROM gl_accounts WHERE id = $1::uuid FOR NO KEY UPDATE`,
      input.glAccountId,
    )) as Array<{ shard_count: number }>;
    if (rows.length === 0) throw new Error(`GL account '${input.glAccountId}' does not exist`);
    const oldWidth = Number(rows[0]!.shard_count);
    if ((input.expectedOldWidth !== undefined && input.expectedOldWidth !== oldWidth) || oldWidth === newWidth) {
      return { changed: false, oldWidth, newWidth: oldWidth };
    }
    await tx.$executeRawUnsafe(
      `UPDATE gl_accounts SET shard_count = $2::smallint, shard_scaled_at = now(), updated_at = now() WHERE id = $1::uuid`,
      input.glAccountId,
      newWidth,
    );
    if (newWidth > oldWidth) {
      await ensureAccountShards(tx as never, input.glAccountId, newWidth, oldWidth);
    }
    await writeAudit(tx, {
      data: {
        ...(input.audit.requestFields ?? {}),
        actorId: input.audit.actorId,
        role: input.audit.role,
        action: input.audit.action,
        entityType: "GL_ACCOUNT",
        entityId: input.glAccountId,
        beforeJson: { shardCount: oldWidth },
        afterJson: { shardCount: newWidth, ...(input.audit.extra ?? {}) },
      },
    });
    return { changed: true, oldWidth, newWidth };
  });
  clearShardWidthCache();
  return result;
};
