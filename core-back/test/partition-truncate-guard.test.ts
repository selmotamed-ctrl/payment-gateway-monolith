/**
 * Every `journal_lines` partition carries the TRUNCATE guard, including the ones created later by
 * `ensure_journal_line_partitions` (statement triggers are not cloned from the parent). Runs against
 * a real PostgreSQL 18 test database and is skipped when it is unreachable.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { client } from "../prisma/client";

const DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const reachable = await (async (): Promise<boolean> => {
  try {
    if (!/test/i.test(new URL(DATABASE_URL).pathname.replace(/^\//, ""))) return false;
    await client.$queryRawUnsafe("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  if (reachable) await client.$disconnect().catch(() => undefined);
});

const unguardedPartitions = async (): Promise<string[]> => {
  const rows = await client.$queryRawUnsafe<Array<{ partition: string }>>(`
    SELECT c.relname AS partition
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'journal_lines'::regclass
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = c.oid AND t.tgname = 'pgw_journal_lines_no_truncate' AND NOT t.tgisinternal
      )
    ORDER BY 1`);
  return rows.map((row) => row.partition);
};

describe.skipIf(!reachable)("journal_lines partitions are guarded against TRUNCATE", () => {
  test("every existing partition has the guard", async () => {
    expect(await unguardedPartitions()).toEqual([]);
  });

  test("a partition created by ensure_journal_line_partitions gets the guard and refuses TRUNCATE", async () => {
    // Far enough ahead that it is created fresh by this call (the migration pre-creates 18 months).
    await client.$executeRawUnsafe("SELECT ensure_journal_line_partitions(40)");
    expect(await unguardedPartitions()).toEqual([]);
    const last = await client.$queryRawUnsafe<Array<{ name: string }>>(`
      SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'journal_lines'::regclass AND c.relname ~ '^journal_lines_[0-9]{4}_[0-9]{2}$'
      ORDER BY 1 DESC LIMIT 1`);
    const name = last[0]!.name;
    await expect((async () => client.$executeRawUnsafe(`TRUNCATE TABLE "${name}"`))()).rejects.toThrow(/append-only|truncate/i);
  });

  test("a partition created by the superuser cron gives the application role read and insert, never mutation", async () => {
    // Default privileges only follow the role that creates an object, and the cron is not the migration owner:
    // without the explicit grant the application role could not write the first ledger line of a new month.
    const roles = await client.$queryRawUnsafe<Array<{ n: number }>>("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'pgw_app'");
    if (roles[0]!.n === 0) return;
    const name = "journal_lines_9999_01";
    await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${name}`);
    try {
      await client.$executeRawUnsafe(
        `CREATE TABLE ${name} PARTITION OF journal_lines FOR VALUES FROM ('9999-01-01') TO ('9999-02-01')`,
      );
      await client.$executeRawUnsafe(`SELECT pgw_guard_journal_line_partition('${name}'::regclass)`);
      const privilege = async (kind: string): Promise<boolean> =>
        (await client.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT has_table_privilege('pgw_app', '${name}', '${kind}') AS ok`))[0]!.ok;
      expect(await privilege("SELECT")).toBe(true);
      expect(await privilege("INSERT")).toBe(true);
      for (const kind of ["UPDATE", "DELETE", "TRUNCATE"]) expect([kind, await privilege(kind)]).toEqual([kind, false]);
    } finally {
      await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${name}`);
    }
  });

  test("the guard is installed once: re-running the function leaves a single trigger per partition", async () => {
    await client.$executeRawUnsafe("SELECT ensure_journal_line_partitions(18)");
    const duplicates = await client.$queryRawUnsafe<Array<{ n: number }>>(`
      SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgname = 'pgw_journal_lines_no_truncate' AND NOT tgisinternal
      GROUP BY tgrelid HAVING count(*) > 1`);
    expect(duplicates).toEqual([]);
  });
});
