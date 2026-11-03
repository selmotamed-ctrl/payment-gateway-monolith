import { LedgerPoster, type LedgerPrismaClient, type LedgerTransactionRunner } from "../../engine/ledger/LedgerPoster";
import { env } from "../env";
import { createLedgerShardWriter } from "./ledgerShardWriter";
import { enqueueOutboxEvent } from "./outbox";

export interface LedgerPosterOptions {
  transactionRunner?: LedgerTransactionRunner;
  shardCount?: number;
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
    options.emitOutbox === false
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
