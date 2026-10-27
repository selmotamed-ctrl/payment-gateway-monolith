import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RETENTION_DAYS,
  RETENTION_SETTING_KEY,
  RetentionWorker,
  retentionDaysFromSetting,
} from "../engine/workers/RetentionWorker";
import { PrismaRepositories } from "../engine/db/repositories";
import { InvariantVerifier } from "../engine/ledger/InvariantVerifier";
import { createProductionWorkerRuntime } from "../engine/workers/productionRuntime";
import type { WorkerLogger } from "../engine/workers/workerRuntime";
import { createRetentionFake, type FakeRow } from "./helpers/retentionFake";

/**
 * The proof that the record retention worker (OD-4) keeps the regulatory
 * evidence for five years and purges nothing before that.
 *
 * The suite runs against an in-memory stand-in for the Prisma client, so no
 * database is involved: the statements of the worker are parsed and evaluated
 * by the fake, which means the test exercises the real SQL of the worker.
 */

const NOW = new Date("2026-10-27T00:00:00.000Z");
const DAY_MS = 86_400_000;

const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

const recordingLogger = (): WorkerLogger & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    info: (message, meta) => {
      lines.push(`${message} ${JSON.stringify(meta ?? {})}`);
    },
    warn: (message, meta) => {
      lines.push(`${message} ${JSON.stringify(meta ?? {})}`);
    },
    error: (message, meta) => {
      lines.push(`${message} ${JSON.stringify(meta ?? {})}`);
    },
  };
};

const buildWorker = (
  fake: ReturnType<typeof createRetentionFake>,
  options: { dryRun?: boolean; retentionDays?: number } = {},
) => {
  const logger = recordingLogger();
  const worker = new RetentionWorker({
    db: fake.db,
    repositories: new PrismaRepositories(fake.db),
    clock: () => NOW,
    logger,
    batchSize: 50,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
  });
  return { worker, logger };
};

const ids = (rows: FakeRow[]): string[] => rows.map((row) => String(row.id));

describe("RetentionWorker", () => {
  test("purges a row that is older than the retention period and keeps a newer one", async () => {
    const fake = createRetentionFake();
    fake.seed("notifications", [
      { id: "old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 1) },
      { id: "fresh", created_at: daysAgo(10) },
    ]);
    fake.seed("audit_log", [
      { id: "audit-old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 30) },
      { id: "audit-fresh", created_at: daysAgo(30) },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    expect(ids(fake.rows("notifications"))).toEqual(["fresh"]);
    expect(ids(fake.rows("audit_log"))).toEqual(["audit-fresh"]);
  });

  test("keeps the rows that are exactly on the retention period", async () => {
    const fake = createRetentionFake();
    fake.seed("notifications", [
      { id: "edge", created_at: daysAgo(DEFAULT_RETENTION_DAYS) },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    expect(ids(fake.rows("notifications"))).toEqual(["edge"]);
  });

  test("purges a terminal attempt but keeps its journal entry and lines", async () => {
    const fake = createRetentionFake();
    fake.seed("payment_attempts", [
      {
        id: "attempt-old",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        terminal_at: daysAgo(DEFAULT_RETENTION_DAYS + 9),
        status: "SUCCEEDED",
        ledger_entry_id: "entry-old",
        attempt_group_id: "group-old",
      },
    ]);
    fake.seed("journal_entries", [
      { id: "entry-old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10) },
    ]);
    fake.seed("journal_lines", [
      { id: "line-old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10), entry_id: "entry-old" },
    ]);
    fake.seed("attempt_step_logs", [
      {
        id: "step-old",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        attempt_id: "attempt-old",
      },
    ]);
    fake.seed("attempt_groups", [
      { id: "group-old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 11) },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    // The attempt and its non-ledger evidence go, but the immutable ledger
    // stays: deleting it would silently change the GL balances.
    expect(ids(fake.rows("payment_attempts"))).toEqual([]);
    expect(ids(fake.rows("journal_entries"))).toEqual(["entry-old"]);
    expect(ids(fake.rows("journal_lines"))).toEqual(["line-old"]);
    expect(ids(fake.rows("attempt_step_logs"))).toEqual([]);
    expect(ids(fake.rows("attempt_groups"))).toEqual([]);
  });

  test("a purge preserves every GL balance and the system-wide invariant", async () => {
    const fake = createRetentionFake();
    fake.seed("gl_accounts", [
      {
        id: "gl-clearing",
        accountType: "GATEWAY_CLEARING",
        currency: "LYD",
        checkpoint_balance: "0.0000",
        checkpoint_at: null,
      },
      {
        id: "gl-wallet",
        accountType: "MERCHANT_WALLET",
        currency: "LYD",
        checkpoint_balance: "0.0000",
        checkpoint_at: null,
      },
    ]);
    fake.seed("payment_attempts", [
      {
        id: "attempt-old",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        terminal_at: daysAgo(DEFAULT_RETENTION_DAYS + 9),
        status: "SUCCEEDED",
        ledger_entry_id: "entry-old",
        attempt_group_id: "group-old",
      },
    ]);
    fake.seed("journal_entries", [
      { id: "entry-old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10) },
    ]);
    fake.seed("journal_lines", [
      {
        id: "line-debit",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        entry_id: "entry-old",
        gl_account_id: "gl-clearing",
        direction: "DEBIT",
        amount: "100.0000",
      },
      {
        id: "line-credit",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        entry_id: "entry-old",
        gl_account_id: "gl-wallet",
        direction: "CREDIT",
        amount: "100.0000",
      },
    ]);

    const verifier = new InvariantVerifier(fake.db as never);
    const before = await verifier.verify();
    const balanceOf = (result: typeof before, accountId: string): string =>
      result.accountBalances.find((account) => account.accountId === accountId)?.liveBalance.toFixed(4) ?? "";
    expect(before.drift.toFixed(4)).toBe("0.0000");
    const walletBefore = balanceOf(before, "gl-wallet");
    const clearingBefore = balanceOf(before, "gl-clearing");

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    // The attempt went, the ledger did not.
    expect(ids(fake.rows("payment_attempts"))).toEqual([]);
    expect(ids(fake.rows("journal_lines"))).toEqual(["line-debit", "line-credit"]);

    const after = await verifier.verify();
    expect(after.drift.toFixed(4)).toBe("0.0000");
    expect(balanceOf(after, "gl-wallet")).toBe(walletBefore);
    expect(balanceOf(after, "gl-clearing")).toBe(clearingBefore);
    expect(walletBefore).toBe("-100.0000");
  });

  test("keeps a non-terminal attempt and its journal entry", async () => {
    const fake = createRetentionFake();
    fake.seed("payment_attempts", [
      {
        id: "attempt-live",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        terminal_at: null,
        status: "AWAITING_CUSTOMER",
        ledger_entry_id: "entry-live",
        attempt_group_id: "group-live",
      },
    ]);
    fake.seed("journal_entries", [
      { id: "entry-live", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10) },
    ]);
    fake.seed("journal_lines", [
      { id: "line-live", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10), entry_id: "entry-live" },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    expect(ids(fake.rows("payment_attempts"))).toEqual(["attempt-live"]);
    expect(ids(fake.rows("journal_entries"))).toEqual(["entry-live"]);
    expect(ids(fake.rows("journal_lines"))).toEqual(["line-live"]);
  });

  test("keeps the step log of an attempt that is still inside the retention period", async () => {
    const fake = createRetentionFake();
    fake.seed("payment_attempts", [
      {
        id: "attempt-fresh",
        created_at: daysAgo(10),
        terminal_at: null,
        status: "CREATED",
        ledger_entry_id: null,
        attempt_group_id: "group-fresh",
      },
    ]);
    fake.seed("attempt_step_logs", [
      {
        id: "step-old",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        attempt_id: "attempt-fresh",
      },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    // The log is old, but the attempt it belongs to is still inside the
    // retention period, so the log stays.
    expect(ids(fake.rows("attempt_step_logs"))).toEqual(["step-old"]);
  });

  test("keeps a journal entry and purges only the attempt that is past retention", async () => {
    const fake = createRetentionFake();
    fake.seed("payment_attempts", [
      {
        id: "attempt-old",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        terminal_at: daysAgo(DEFAULT_RETENTION_DAYS + 9),
        status: "SUCCEEDED",
        ledger_entry_id: "entry-shared",
        attempt_group_id: "group-old",
      },
      {
        id: "attempt-live",
        created_at: daysAgo(5),
        terminal_at: null,
        status: "CREATED",
        ledger_entry_id: "entry-shared",
        attempt_group_id: "group-live",
      },
    ]);
    fake.seed("journal_entries", [
      { id: "entry-shared", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10) },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    // The ledger entry survives, but the expired attempt no longer has to:
    // deleting an attempt never touches the entry it references.
    expect(ids(fake.rows("journal_entries"))).toEqual(["entry-shared"]);
    expect(ids(fake.rows("payment_attempts"))).toEqual(["attempt-live"]);
  });

  test("purges the expired step logs of an expired attempt and keeps the others", async () => {
    const fake = createRetentionFake();
    fake.seed("payment_attempts", [
      {
        id: "attempt-old",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        terminal_at: null,
        status: "UNKNOWN",
        ledger_entry_id: null,
        attempt_group_id: "group-old",
      },
      {
        id: "attempt-fresh",
        created_at: daysAgo(2),
        terminal_at: null,
        status: "CREATED",
        ledger_entry_id: null,
        attempt_group_id: "group-fresh",
      },
    ]);
    fake.seed("attempt_step_logs", [
      { id: "step-old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10), attempt_id: "attempt-old" },
      { id: "step-fresh", created_at: daysAgo(2), attempt_id: "attempt-fresh" },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    expect(ids(fake.rows("attempt_step_logs"))).toEqual(["step-fresh"]);
  });

  test("purges the expired inbound events and detail change logs", async () => {
    const fake = createRetentionFake();
    fake.seed("inbound_events", [
      { id: "event-old", received_at: daysAgo(DEFAULT_RETENTION_DAYS + 5) },
      { id: "event-fresh", received_at: daysAgo(5) },
    ]);
    fake.seed("detail_change_logs", [
      { id: "change-old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 5) },
      { id: "change-fresh", created_at: daysAgo(5) },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    expect(ids(fake.rows("inbound_events"))).toEqual(["event-fresh"]);
    expect(ids(fake.rows("detail_change_logs"))).toEqual(["change-fresh"]);
  });

  test("keeps a journal entry that no attempt references any more", async () => {
    const fake = createRetentionFake();
    fake.seed("journal_entries", [
      { id: "entry-orphan", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10) },
      { id: "entry-fresh", created_at: daysAgo(10) },
    ]);
    fake.seed("journal_lines", [
      {
        id: "line-orphan",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        entry_id: "entry-orphan",
      },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    // The ledger is out of the retention scope even when no attempt points at
    // the entry: it carries the balance of an adjustment or a sweep.
    expect(ids(fake.rows("journal_entries"))).toEqual(["entry-orphan", "entry-fresh"]);
    expect(ids(fake.rows("journal_lines"))).toEqual(["line-orphan"]);
  });

  test("keeps a journal entry that an AML case holds", async () => {
    const fake = createRetentionFake();
    fake.seed("journal_entries", [
      { id: "entry-held", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10) },
    ]);
    fake.seed("aml_cases", [
      {
        id: "case-held",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        hold_journal_entry_id: "entry-held",
      },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    expect(ids(fake.rows("journal_entries"))).toEqual(["entry-held"]);
  });

  test("the dry run reports what it would purge and deletes nothing", async () => {
    const fake = createRetentionFake();
    fake.seed("notifications", [
      { id: "old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 1) },
      { id: "fresh", created_at: daysAgo(10) },
    ]);
    fake.seed("payment_attempts", [
      {
        id: "attempt-old",
        created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10),
        terminal_at: daysAgo(DEFAULT_RETENTION_DAYS + 9),
        status: "SUCCEEDED",
        ledger_entry_id: "entry-old",
        attempt_group_id: "group-old",
      },
    ]);
    fake.seed("journal_entries", [
      { id: "entry-old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10) },
    ]);
    fake.seed("journal_lines", [
      { id: "line-old", created_at: daysAgo(DEFAULT_RETENTION_DAYS + 10), entry_id: "entry-old" },
    ]);

    const { worker, logger } = buildWorker(fake, { dryRun: true });
    await worker.runOnce();

    expect(ids(fake.rows("notifications"))).toEqual(["old", "fresh"]);
    expect(ids(fake.rows("payment_attempts"))).toEqual(["attempt-old"]);
    expect(ids(fake.rows("journal_entries"))).toEqual(["entry-old"]);
    expect(ids(fake.rows("journal_lines"))).toEqual(["line-old"]);

    const report = logger.lines.find((line) => line.includes("the retention pass is over"));
    expect(report).toBeDefined();
    expect(report).toContain('"dryRun":true');
    expect(report).toContain('"notifications":1');
    expect(report).toContain('"paymentAttempts":1');
    // The dry run never schedules a ledger deletion any more.
    expect(report).toContain('"journalEntries":0');
  });

  test("the platform setting overrides the default retention period", async () => {
    const fake = createRetentionFake();
    fake.seed("platformSetting", [
      {
        id: "setting-1",
        key: RETENTION_SETTING_KEY,
        scope: "PLATFORM",
        version: 1,
        valueJson: { kybYears: 1, description: "One year of evidence." },
      },
    ]);
    fake.seed("notifications", [
      { id: "two-years", created_at: daysAgo(800) },
      { id: "fresh", created_at: daysAgo(10) },
    ]);

    const { worker, logger } = buildWorker(fake);
    await worker.runOnce();

    // With the default of five years the row would have survived.
    expect(ids(fake.rows("notifications"))).toEqual(["fresh"]);
    expect(logger.lines.join("\n")).toContain('"retentionDays":365');
  });

  test("the retention period of the platform setting is read in days and in years", () => {
    expect(retentionDaysFromSetting({ kybYears: 5 })).toBe(DEFAULT_RETENTION_DAYS);
    expect(retentionDaysFromSetting({ retentionDays: 90 })).toBe(90);
    expect(retentionDaysFromSetting({ retentionYears: 7 })).toBe(7 * 365);
    expect(retentionDaysFromSetting({ kybYears: 0 })).toBeNull();
    expect(retentionDaysFromSetting({ kybYears: 1.5 })).toBeNull();
    expect(retentionDaysFromSetting(null)).toBeNull();
    expect(retentionDaysFromSetting("five years")).toBeNull();
  });

  test("a missing platform setting falls back to the default of five years", async () => {
    const fake = createRetentionFake();
    fake.seed("notifications", [
      { id: "four-years", created_at: daysAgo(4 * 365) },
      { id: "six-years", created_at: daysAgo(6 * 365) },
    ]);

    const { worker } = buildWorker(fake);
    await worker.runOnce();

    expect(ids(fake.rows("notifications"))).toEqual(["four-years"]);
  });

  test("the worker is registered in the production runtime and gated by its flag", () => {
    const fake = createRetentionFake();
    const enabled = createProductionWorkerRuntime({ db: fake.db, retentionEnabled: true });
    expect(enabled.workers.map((worker) => worker.constructor.name)).toContain("RetentionWorker");

    const disabled = createProductionWorkerRuntime({ db: fake.db, retentionEnabled: false });
    expect(disabled.workers.map((worker) => worker.constructor.name)).not.toContain(
      "RetentionWorker",
    );
  });

  test("the worker purges in bounded batches", async () => {
    const fake = createRetentionFake();
    const rows: FakeRow[] = [];
    for (let index = 0; index < 120; index += 1) {
      rows.push({ id: `old-${index}`, created_at: daysAgo(DEFAULT_RETENTION_DAYS + 1) });
    }
    fake.seed("notifications", rows);

    const logger = recordingLogger();
    const worker = new RetentionWorker({
      db: fake.db,
      repositories: new PrismaRepositories(fake.db),
      clock: () => NOW,
      logger,
      batchSize: 50,
    });
    await worker.runOnce();

    expect(fake.rows("notifications")).toHaveLength(0);
    expect(logger.lines.filter((line) => line.includes("purged the expired rows of notifications"))).toHaveLength(3);
  });
});
