/**
 * Test-only maintenance helper for the append-only history guards.
 *
 * Production code never sets this flag outside an explicit maintenance job.
 * Cleanup of test-created cases/repairs must run on one connection with the
 * transaction-local flag, because the guard also covers cascaded deletes.
 */
export const withAppendOnlyMaintenance = async <T>(
  client: { $transaction: <R>(fn: (tx: any) => Promise<R>) => Promise<R> },
  fn: (tx: any) => Promise<T>,
): Promise<T> =>
  client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('pgw.append_only_maintenance', 'on', true)");
    return fn(tx);
  });

/** Delete rows (and their cascaded history) with the transaction-local maintenance flag. */
export const deleteWithAppendOnlyMaintenance = async (
  client: { $transaction: <R>(fn: (tx: any) => Promise<R>) => Promise<R> },
  sql: string,
  ...args: unknown[]
): Promise<void> =>
  withAppendOnlyMaintenance(client, async (tx) => {
    await tx.$executeRawUnsafe(sql, ...args);
  });
