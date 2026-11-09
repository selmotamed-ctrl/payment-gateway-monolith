import { LedgerPoster, type LedgerPrismaClient, type LedgerTransactionRunner } from "../../engine/ledger/LedgerPoster";
import { createLedgerShardWriter } from "./ledgerShardWriter";
import { enqueueOutboxEvent } from "./outbox";

export interface LedgerPosterOptions {
  transactionRunner?: LedgerTransactionRunner;
  /**
   * Emit `ledger.entry_posted` in the posting transaction. Off by default since
   * 2026-11-04: the topic has no consumer (its relay handler is a no-op), so
   * every posting paid one extra INSERT plus relay work for nothing. Wallet
   * balances are read from `gl_account_shards`, which is written
   * synchronously in the same transaction.
   */
  emitOutbox?: boolean;
  /**
   * Raw-SQL posting and a short-lived cache of resolved accounts (see `LedgerPosterOptions.rawSql`). On by default
   * in production; `LEDGER_RAW_SQL=false` is the kill switch that returns to the ORM path without a deploy.
   */
  rawSql?: boolean;
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
  return new LedgerPoster(
    client,
    options.transactionRunner,
    createLedgerShardWriter(),
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
    { rawSql: options.rawSql ?? process.env.LEDGER_RAW_SQL !== "false" },
  );
};
