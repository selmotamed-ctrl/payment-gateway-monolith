/**
 * Moves journal lines that landed in `journal_lines_default` into their own monthly partitions (AUTO-01).
 *
 *   bun run repair-journal-default-partition            # dry run: what is stranded, per month
 *   bun run repair-journal-default-partition --apply    # move the rows, in ONE transaction
 *
 * This edits ledger rows, which the append-only guard forbids unless the transaction sets the ledger maintenance flag
 * AND the connecting role is a superuser or a member of `pgw_ledger_maintenance`. The application role is neither, so
 * run it with a privileged connection:
 *
 *   DATABASE_URL=postgresql://<maintenance role>@host/db bun run repair-journal-default-partition --apply
 *
 * Rows keep their ids, `created_at`, shard and sequence, so no balance, checkpoint or sequence changes. The default
 * partition is locked ACCESS EXCLUSIVE for the duration (seconds) with a 5 s lock timeout: run it in a quiet moment.
 * Resolve the operator case `ledger.partition.default_rows` afterwards.
 */
import { client } from "../prisma/client";
import { repairDefaultPartition } from "../engine/ledger/partitionMaintenance";
import { writeSystemAudit } from "../engine/ledger/ledgerAlerts";

const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply");
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: bun run repair-journal-default-partition [--apply]");
    return;
  }
  const result = await repairDefaultPartition(client, { dryRun: !apply });
  if (result.totalRows === 0) {
    console.log("journal_lines_default is empty: nothing to repair.");
    return;
  }
  for (const entry of result.months) {
    console.log(`${entry.month}: ${entry.found} row(s)${apply ? ` -> moved ${entry.moved}` : ""}`);
  }
  if (!apply) {
    console.log(`\nDry run: ${result.totalRows} row(s) would move. Re-run with --apply to repair.`);
    return;
  }
  await writeSystemAudit(client as never, {
    action: "JOURNAL_DEFAULT_PARTITION_REPAIRED",
    entityType: "LEDGER",
    entityId: "journal_lines_default",
    after: { months: result.months, totalRows: result.totalRows },
  });
  console.log(`\nRepaired: ${result.totalRows} row(s) moved. Resolve the operator case ledger.partition.default_rows.`);
};

main()
  .catch((error) => {
    console.error(`repair-journal-default-partition: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.$disconnect();
  });
