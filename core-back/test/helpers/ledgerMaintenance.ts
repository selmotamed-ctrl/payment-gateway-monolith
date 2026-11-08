/**
 * journal_entries, journal_lines and audit_log are append-only at the database
 * (migration 20261105090000_append_only_ledger_guards, GAP-013). Database-backed
 * tests that clean up the rows they created run the cleanup through this helper:
 * it sets the transaction-local maintenance flag, which the guard only honours
 * for a superuser or a member of pgw_ledger_maintenance (the test database owner).
 */
export interface LedgerMaintenanceClient {
  $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

export const withLedgerMaintenance = async <T>(
  client: LedgerMaintenanceClient,
  fn: (tx: any) => Promise<T>,
): Promise<T> =>
  client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('pgw.ledger_maintenance', 'on', true)");
    return fn(tx);
  });

/**
 * Deletes the journal lines of the entries selected by `entrySubquery` AND undoes their shard projection (balance and
 * `line_seq`) in the same maintenance transaction.
 *
 * A test that posts through the real poster to a shared account (the seeded system accounts, which the cleanup cannot
 * delete) must give the shard back what the lines added, otherwise the shard balances no longer equal the journal and
 * the system-wide invariant (which sums the SHARD balances) drifts for every later suite. The lines of a test are the
 * newest of their shard, so subtracting the count keeps the per-shard sequence gapless.
 *
 *   await withLedgerMaintenance(client, (tx) =>
 *     deleteJournalLinesAndUndoShards(tx, "SELECT id FROM journal_entries WHERE ref_id = ANY($1::text[])", [refIds]));
 */
export const deleteJournalLinesAndUndoShards = async (
  tx: { $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number> },
  entrySubquery: string,
  params: unknown[] = [],
): Promise<void> => {
  await tx.$executeRawUnsafe(
    `WITH deleted AS (
       DELETE FROM journal_lines WHERE entry_id IN (${entrySubquery})
       RETURNING gl_account_id, shard_id, direction, amount
     ), folded AS (
       SELECT gl_account_id, shard_id, COUNT(*)::bigint AS n,
              SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) AS delta
       FROM deleted GROUP BY gl_account_id, shard_id
     )
     UPDATE gl_account_shards s
        SET current_balance = s.current_balance - f.delta, line_seq = s.line_seq - f.n
       FROM folded f
      WHERE s.gl_account_id = f.gl_account_id AND s.shard_id = f.shard_id`,
    ...params,
  );
};
