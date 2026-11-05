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
