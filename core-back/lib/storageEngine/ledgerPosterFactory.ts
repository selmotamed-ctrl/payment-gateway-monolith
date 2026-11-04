import { LedgerPoster, type LedgerPrismaClient, type LedgerTransactionRunner } from "../../engine/ledger/LedgerPoster";
import { env } from "../env";
import { createLedgerShardWriter } from "./ledgerShardWriter";
import { enqueueOutboxEvent } from "./outbox";

export interface LedgerPosterOptions {
  transactionRunner?: LedgerTransactionRunner;
  shardCount?: number;
  /**
   * Emit `ledger.entry_posted` in the posting transaction. Off by default since
   * 2026-11-04: the topic has no consumer (its relay handler is a no-op), so
   * every posting paid one extra INSERT plus relay work for nothing. Wallet
   * balances are read from `gl_account_shards`, which is written
   * synchronously in the same transaction.
   */
  emitOutbox?: boolean;
}

/**
 * Builds the production ledger poster with the account-shard writer and the
 * transactional ledger outbox writer. Tests that need the bare append-only
 * ledger keep constructing LedgerPoster directly.
 */
export const createLedgerPoster = (
  client: LedgerPrismaClient,
  options: LedgerPosterOptions = {},
): LedgerPoster => {
  const shardCount = options.shardCount ?? env.STORAGE_SHARD_COUNT;
  return new LedgerPoster(
    client,
    options.transactionRunner,
    createLedgerShardWriter(shardCount),
    options.emitOutbox !== true
      ? undefined
      : async (transaction, entry) => {
          await enqueueOutboxEvent(transaction, {
            topic: "ledger.entry_posted",
            aggregateType: "JOURNAL_ENTRY",
            aggregateId: entry.id,
            payload: {
              entryId: entry.id,
              refType: entry.refType,
              refId: entry.refId,
            },
          });
        },
  );
};
