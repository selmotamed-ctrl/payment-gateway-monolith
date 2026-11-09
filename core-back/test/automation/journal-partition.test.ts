/**
 * AUTO-01 journal partition maintenance: the worker's logic with fakes, the hardened database function, the
 * default-partition detection and the guarded operator repair, against live PostgreSQL.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { repairDefaultPartition, inspectJournalPartitions, type PartitionInspection } from "../../engine/ledger/partitionMaintenance";
import { JOURNAL_PARTITION_CASE_KEYS, JournalPartitionWorker } from "../../engine/workers/JournalPartitionWorker";
import { createRetentionFake } from "../helpers/retentionFake";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { withLedgerMaintenance } from "../helpers/ledgerMaintenance";
import { createPrisma, databaseIsReachable, seedGlAccount } from "../storage-engine/helpers/db";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const inspection = (overrides: Partial<PartitionInspection> = {}): PartitionInspection => ({
  monthsAhead: 6,
  missing: [],
  monthlyPartitions: 40,
  defaultRows: 0,
  defaultRowsCapped: false,
  defaultMonths: [],
  ...overrides,
});

const unitWorker = (script: { inspect: PartitionInspection[]; ensureError?: Error }) => {
  const cases: string[] = [];
  const audits: string[] = [];
  let ensured = 0;
  const queue = [...script.inspect];
  const worker = new JournalPartitionWorker({
    db: createRetentionFake().db,
    repositories: createFakeRepositories(),
    logger: quiet,
    healthRegistry: null,
    monthsAhead: 6,
    inspect: async () => queue.shift() ?? script.inspect.at(-1)!,
    ensure: async () => {
      ensured += 1;
      if (script.ensureError) throw script.ensureError;
    },
    raiseCase: async (_db, input) => {
      cases.push(input.subjectKey);
      return true;
    },
    audit: async (_db, input) => {
      audits.push(input.action);
    },
  });
  return { worker, cases, audits, ensured: () => ensured };
};

describe("JournalPartitionWorker (fakes)", () => {
  test("with every month present it does nothing: no ensure call, no case, no audit", async () => {
    const run = unitWorker({ inspect: [inspection()] });
    await run.worker.runOnce();
    expect(run.ensured()).toBe(0);
    expect(run.cases).toEqual([]);
    expect(run.audits).toEqual([]);
  });

  test("missing months are created through the database function and audited once", async () => {
    const run = unitWorker({ inspect: [inspection({ missing: ["2027_05", "2027_06"] }), inspection()] });
    await run.worker.runOnce();
    expect(run.ensured()).toBe(1);
    expect(run.audits).toEqual(["JOURNAL_PARTITIONS_ENSURED"]);
    expect(run.cases).toEqual([]);
  });

  test("a failing ensure raises the ensure_failed case and never throws out of the tick", async () => {
    const run = unitWorker({
      inspect: [inspection({ missing: ["2027_05"] }), inspection({ missing: ["2027_05"], defaultRows: 3, defaultMonths: [{ month: "2027_05", rows: 3 }] })],
      ensureError: new Error("updated partition constraint for default partition would be violated by some row"),
    });
    await run.worker.runOnce();
    expect(run.cases.sort()).toEqual([JOURNAL_PARTITION_CASE_KEYS.defaultRows, JOURNAL_PARTITION_CASE_KEYS.ensureFailed].sort());
    expect(run.audits).toEqual([]);
  });

  test("rows in the default partition raise the most-urgent case even when every month exists", async () => {
    const run = unitWorker({ inspect: [inspection({ defaultRows: 2, defaultMonths: [{ month: "2020_01", rows: 2 }] })] });
    await run.worker.runOnce();
    expect(run.cases).toEqual([JOURNAL_PARTITION_CASE_KEYS.defaultRows]);
    expect(run.ensured()).toBe(0);
  });

  test("monthsAhead outside 1..60 is refused at construction", () => {
    for (const months of [0, 61, -1, 1.5 * 100]) {
      expect(() => unitWorker({ inspect: [inspection()] }) && new JournalPartitionWorker({
        db: createRetentionFake().db,
        repositories: createFakeRepositories(),
        monthsAhead: months,
      })).toThrow(/monthsAhead/);
    }
  });
});

const client = createPrisma({ max: 10 });
const describeDb = databaseIsReachable ? describe : describe.skip;
const insertedEntries: string[] = [];
let partitionsBefore: string[] | null = null;

const partitionNames = async (): Promise<string[]> =>
  (
    await client.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'journal_lines'::regclass ORDER BY 1`,
    )
  ).map((row) => row.relname);

/** A balanced two-line entry whose lines carry `createdAt` (a month with or without a partition). */
const insertStrandedEntry = async (createdAt: string): Promise<{ entryId: string; accountId: string }> => {
  const account = await seedGlAccount(client, { accountType: "TREASURY", shardCount: 1 });
  const other = await seedGlAccount(client, { accountType: "PLATFORM_INCOME", shardCount: 1 });
  const entryId = randomUUID();
  insertedEntries.push(entryId);
  await client.$executeRawUnsafe(
    `INSERT INTO journal_entries (id, created_at, updated_at, ref_type, ref_id, description)
     VALUES ($1::uuid, $2::timestamp, now(), 'ADJUSTMENT', $3, 'partition test')`,
    entryId,
    createdAt,
    `partition-test-${entryId}`,
  );
  for (const [accountId, direction, seq] of [[account.id, "DEBIT", 900_001], [other.id, "CREDIT", 900_001]] as const) {
    await client.$executeRawUnsafe(
      `INSERT INTO journal_lines (id, created_at, updated_at, entry_id, gl_account_id, direction, amount, shard_id, shard_seq)
       VALUES ($1::uuid, $2::timestamp, now(), $3::uuid, $4::uuid, $5::"JournalDirection", 1.0000, 0, $6)`,
      randomUUID(),
      createdAt,
      entryId,
      accountId,
      direction,
      seq,
    );
  }
  return { entryId, accountId: account.id };
};

afterAll(async () => {
  if (databaseIsReachable) {
    // The ledger is append-only: the test's rows go through the maintenance flag (the test role is a superuser), then
    // the partitions this suite created (and only those) are dropped.
    if (insertedEntries.length > 0) {
      await withLedgerMaintenance(client, async (tx) => {
        await tx.$executeRawUnsafe("DELETE FROM journal_lines WHERE entry_id = ANY($1::uuid[])", insertedEntries);
        await tx.$executeRawUnsafe("DELETE FROM journal_entries WHERE id = ANY($1::uuid[])", insertedEntries);
      });
    }
    if (partitionsBefore) {
      const keep = new Set(partitionsBefore);
      for (const name of await partitionNames()) {
        if (!keep.has(name) && /^journal_lines_\d{4}_\d{2}$/.test(name)) {
          await client.$executeRawUnsafe(`DROP TABLE IF EXISTS "${name}"`);
        }
      }
    }
    await client.$executeRawUnsafe(`DELETE FROM operator_cases WHERE subject_key LIKE 'ledger.partition.%'`);
  }
  await client.$disconnect();
});

describeDb("journal partitions against live PostgreSQL", () => {
  test("the database function is hardened: bounded, SECURITY DEFINER, not executable by PUBLIC", async () => {
    partitionsBefore = await partitionNames();
    for (const months of [0, 61]) {
      const outcome = await client
        .$queryRawUnsafe(`SELECT 1 FROM (SELECT ensure_journal_line_partitions(${months})) t`)
        .then(() => "ok", (error: Error) => error.message);
      expect(outcome).toMatch(/between 1 and 60/);
    }
    const [meta] = await client.$queryRawUnsafe<Array<{ secdef: boolean; config: string[] | null; public_exec: boolean }>>(
      `SELECT prosecdef AS secdef, proconfig AS config, has_function_privilege('public', 'ensure_journal_line_partitions(integer)', 'EXECUTE') AS public_exec
       FROM pg_proc WHERE proname = 'ensure_journal_line_partitions'`,
    );
    expect(meta!.secdef).toBe(true);
    expect((meta!.config ?? []).join(",")).toContain("search_path=public, pg_temp");
    expect(meta!.public_exec).toBe(false);
  });

  test("the worker keeps the next months in existence, guards every new partition, and a second tick changes nothing", async () => {
    partitionsBefore ??= await partitionNames();
    const worker = new JournalPartitionWorker({
      db: client as never,
      repositories: createFakeRepositories(),
      logger: quiet,
      healthRegistry: null,
      monthsAhead: 60, // beyond the 18 months the migration created: the worker must create the rest
    });
    await worker.runOnce();
    expect(worker.lastInspection!.missing).toEqual([]);
    const after = await partitionNames();
    expect(after.length).toBeGreaterThan(partitionsBefore.length);
    // every partition the worker created has the TRUNCATE guard
    for (const name of after.filter((entry) => !partitionsBefore!.includes(entry))) {
      const guard = await client.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = 'pgw_journal_lines_no_truncate' AND NOT tgisinternal`,
        `"${name}"`,
      );
      expect(guard[0]!.n).toBe(1);
    }
    const again = await partitionNames();
    await worker.runOnce();
    expect(await partitionNames()).toEqual(again);
    // two health-neutral ticks left no case behind
    expect(await client.operatorCase.count({ where: { subjectKey: { startsWith: "ledger.partition." } } })).toBe(0);
  });

  test("rows stranded in the default partition block their month, raise both cases once, and the repair moves them", async () => {
    partitionsBefore ??= await partitionNames();
    // The first test created every month up to 60 ahead. Drop one EMPTY month inside that window, then strand a
    // line of that month: it lands in the default partition and creating the month fails.
    await client.$executeRawUnsafe('DROP TABLE IF EXISTS "journal_lines_2030_05"');
    const stranded = await insertStrandedEntry("2030-05-14 10:00:00");
    const before = await inspectJournalPartitions(client as never, { monthsAhead: 60 });
    expect(before.defaultRows).toBe(2);
    expect(before.defaultMonths).toEqual([{ month: "2030_05", rows: 2 }]);
    expect(before.missing).toEqual(["2030_05"]);

    const worker = () =>
      new JournalPartitionWorker({ db: client as never, repositories: createFakeRepositories(), logger: quiet, healthRegistry: null, monthsAhead: 60 });
    await worker().runOnce();
    await worker().runOnce(); // a second tick (or a restart) must not duplicate the cases
    const cases = await client.operatorCase.findMany({ where: { subjectKey: { startsWith: "ledger.partition." } }, orderBy: { subjectKey: "asc" } });
    expect(cases.map((row) => row.subjectKey)).toEqual([JOURNAL_PARTITION_CASE_KEYS.defaultRows, JOURNAL_PARTITION_CASE_KEYS.ensureFailed]);
    expect(cases.every((row) => row.priority === "P1" && row.state === "OPEN")).toBe(true);
    expect(cases.find((row) => row.subjectKey === JOURNAL_PARTITION_CASE_KEYS.ensureFailed)!.resolutionNotes).toContain("repair-journal-default-partition");

    // a dry run reports and changes nothing
    const dry = await repairDefaultPartition(client, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, totalRows: 2, months: [{ month: "2030_05", found: 2, moved: 0 }] });
    expect((await inspectJournalPartitions(client as never, { monthsAhead: 1 })).defaultRows).toBe(2);

    const applied = await repairDefaultPartition(client, { dryRun: false });
    expect(applied.totalRows).toBe(2);
    expect(applied.months).toEqual([{ month: "2030_05", found: 2, moved: 2 }]);
    expect((await inspectJournalPartitions(client as never, { monthsAhead: 1 })).defaultRows).toBe(0);

    // the rows are intact in their own partition, guarded, with their ids and sequence unchanged
    const lines = await client.$queryRawUnsafe<Array<{ tableoid: string; shard_seq: string; created_at: Date }>>(
      `SELECT tableoid::regclass::text AS tableoid, shard_seq::text, created_at FROM journal_lines WHERE entry_id = $1::uuid ORDER BY direction`,
      stranded.entryId,
    );
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.tableoid === "journal_lines_2030_05" && line.shard_seq === "900001")).toBe(true);
    const guard = await client.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'journal_lines_2030_05'::regclass AND tgname = 'pgw_journal_lines_no_truncate' AND NOT tgisinternal`,
    );
    expect(guard[0]!.n).toBe(1);

    // the next tick finds nothing to complain about and the missing months can be created again
    await worker().runOnce();
    expect((await inspectJournalPartitions(client as never, { monthsAhead: 60 })).missing).toEqual([]);
  });

  test("without the maintenance privilege the repair is refused and rolls back completely", async () => {
    partitionsBefore ??= await partitionNames();
    await insertStrandedEntry("2035-07-03 09:00:00"); // beyond the 60 month window: no ensure involved
    // a client whose transaction cannot set the maintenance flag: the flag is honoured only for a superuser / member
    // of pgw_ledger_maintenance, so simulate the application role by turning the flag off right after it is set
    const refusing = {
      ...client,
      $transaction: <T>(fn: (tx: any) => Promise<T>, options?: unknown) =>
        (client as any).$transaction(async (tx: any) => {
          const patched = new Proxy(tx, {
            get(target, property) {
              if (property === "$queryRawUnsafe") {
                return async (sql: string, ...values: unknown[]) => {
                  if (sql.includes("pgw.ledger_maintenance")) return [{ set_config: "off" }];
                  return target.$queryRawUnsafe(sql, ...values);
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return fn(patched);
        }, options),
    };
    const refusal = await repairDefaultPartition(refusing, { dryRun: false }).then(() => "repaired", (error: Error) => error.message);
    expect(refusal).toMatch(/append-only table|not allowed/);
    // nothing moved, nothing lost
    const state = await inspectJournalPartitions(client as never, { monthsAhead: 1 });
    expect(state.defaultMonths).toEqual([{ month: "2035_07", rows: 2 }]);
    // clean it up for the next suites through the supported path
    expect((await repairDefaultPartition(client, { dryRun: false })).totalRows).toBe(2);
  });
});
