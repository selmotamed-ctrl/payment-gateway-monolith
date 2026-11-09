/**
 * Suite 01.3 — database-level domain invariants on PostgreSQL 18.
 *
 * Three CHECK constraints plus the Maker != Checker INSERT CHECK constraint
 * and UPDATE trigger are exercised against the live server with real INSERT /
 * UPDATE statements.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertZeroDrift,
  databaseIsReachable,
  exhaustiveClient,
  listCheckConstraints,
  listTriggers,
} from "../_harness";
import { createRow, insertRow } from "../_dbFactory";
import { withLedgerMaintenance } from "../../helpers/ledgerMaintenance";

const db = exhaustiveClient();
const describeDb = databaseIsReachable ? describe : describe.skip;

const checks = databaseIsReachable ? await listCheckConstraints(db) : [];
const triggers = databaseIsReachable ? await listTriggers(db) : [];

let glDebitId = "";
let glCreditId = "";
let journalEntryId = "";
let infiniteLinkId = "";
const finiteLinkIds = new Map<number, string>();
let makerId = "";
let checkerId = "";

const makeJournalLine = async (direction: "DEBIT" | "CREDIT", amount: string): Promise<boolean> => {
  // The tested line is inserted atomically together with its opposite leg, so
  // a peer suite that verifies the continuous invariant never observes a
  // one-legged journal entry. Every new line must carry its shard and a real per-shard sequence (>= 1,
  // `journal_lines_shard_seq_positive`); the two legs sit on different accounts, so both are seq 1 of shard 0.
  const opposite = direction === "DEBIT" ? "CREDIT" : "DEBIT";
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "journal_lines" ("id", "created_at", "updated_at", "entry_id", "gl_account_id", "direction", "amount", "shard_id", "shard_seq") VALUES
        ($1, $2, $3, $4, $5, $6, $7, 0, 1),
        ($8, $9, $10, $11, $12, $13, $14, 0, 1)`,
      crypto.randomUUID(),
      new Date(),
      new Date(),
      journalEntryId,
      direction === "DEBIT" ? glDebitId : glCreditId,
      direction,
      amount,
      crypto.randomUUID(),
      new Date(),
      new Date(),
      journalEntryId,
      opposite === "DEBIT" ? glDebitId : glCreditId,
      opposite,
      amount,
    );
    return true;
  } catch {
    return false;
  }
};

const removeJournalLines = async (): Promise<void> => {
  await withLedgerMaintenance(db as never, (tx) =>
    tx.$executeRawUnsafe('DELETE FROM "journal_lines" WHERE "entry_id" = $1', journalEntryId),
  );
};

const tryUpdateLink = async (
  linkId: string,
  fields: { infiniteUse: boolean; useCount: number; confirmed: number; locked: number },
): Promise<boolean> => {
  try {
    await db.$executeRawUnsafe(
      'UPDATE "payment_links" SET "infinite_use" = $1, "use_count" = $2, "confirmed_count" = $3, "active_locked_count" = $4 WHERE "id" = $5',
      fields.infiniteUse,
      fields.useCount,
      fields.confirmed,
      fields.locked,
      linkId,
    );
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  if (!databaseIsReachable) {
    return;
  }
  const debit = await createRow("gl_accounts", { account_type: "TREASURY", currency: "LYD" });
  const credit = await createRow("gl_accounts", { account_type: "PLATFORM_INCOME", currency: "LYD" });
  glDebitId = String(debit.id);
  glCreditId = String(credit.id);
  const entry = await createRow("journal_entries", {
    ref_type: "ADJUSTMENT",
    ref_id: `check-${crypto.randomUUID()}`,
  });
  journalEntryId = String(entry.id);

  const infinite = await createRow("payment_links", {
    infinite_use: true,
    use_count: 1,
    confirmed_count: 500,
    active_locked_count: 25,
  });
  infiniteLinkId = String(infinite.id);
  for (const useCount of [1, 5, 10]) {
    const link = await createRow("payment_links", {
      infinite_use: false,
      use_count: useCount,
      confirmed_count: 0,
      active_locked_count: 0,
    });
    finiteLinkIds.set(useCount, String(link.id));
  }

  const maker = await createRow("users", { role: "GATEWAY_ADMIN", is_maker: true, is_checker: true });
  const checker = await createRow("users", { role: "FINANCE", is_maker: true, is_checker: true });
  makerId = String(maker.id);
  checkerId = String(checker.id);
});

afterAll(async () => {
  if (!databaseIsReachable) {
    return;
  }
  await removeJournalLines();
  await assertZeroDrift(db);
  await db.$disconnect();
});

describeDb("Suite 01 · CHECK constraint metadata", () => {
  const expected = [
    "journal_lines_amount_positive",
    "journal_lines_shard_seq_positive",
    "journal_lines_shard_id_range",
    "gl_account_shards_shard_id_range",
    "gl_accounts_shard_count_range",
    "gl_shard_checkpoints_status_check",
    "attempt_groups_single_success",
    "payment_links_slot_reservation_invariant",
    "approval_requests_checker_not_maker_insert",
  ];

  for (const name of expected) {
    test(`CHECK constraint ${name} exists on the live server`, () => {
      expect(checks.some((check) => check.constraintName === name)).toBe(true);
    });
  }

  test("the shard range checks match the code's 256-shard limit (0..255 / 1..256)", () => {
    const shardId = checks.find((check) => check.constraintName === "gl_account_shards_shard_id_range");
    const lineShardId = checks.find((check) => check.constraintName === "journal_lines_shard_id_range");
    const shardCount = checks.find((check) => check.constraintName === "gl_accounts_shard_count_range");
    expect(shardId?.checkClause).toMatch(/shard_id\s*<\s*256/);
    expect(shardId?.checkClause).not.toMatch(/shard_id\s*<\s*16/);
    expect(lineShardId?.checkClause).toMatch(/shard_id\s*<\s*256/);
    expect(shardCount?.checkClause).toMatch(/shard_count\s*<=\s*256/);
  });

  test("the approval_requests Maker != Checker INSERT check and UPDATE trigger exist", () => {
    const insertCheck = checks.find(
      (check) =>
        check.tableName === "approval_requests"
        && check.constraintName === "approval_requests_checker_not_maker_insert",
    );
    const updateTrigger = triggers.find(
      (trigger) =>
        trigger.eventObjectTable === "approval_requests"
        && trigger.actionTiming === "BEFORE"
        && trigger.eventManipulation === "UPDATE",
    );
    expect(insertCheck?.checkClause).toContain("checker_user_id");
    expect(insertCheck?.checkClause).toContain("maker_user_id");
    expect(updateTrigger?.triggerName).toBe("approval_requests_checker_not_maker_update");
    expect(updateTrigger?.actionStatement).toContain("approval_requests_checker_not_maker");
  });
});

describeDb("Suite 01 · journal_lines_amount_positive", () => {
  const invalid = ["0.0000", "-0.0001", "-100.0000", "-1.0000", "-99999999999999.9999"];
  const valid = ["0.0001", "1.0000", "99999999999999.9999"];

  for (const direction of ["DEBIT", "CREDIT"] as const) {
    for (const amount of invalid) {
      test(`journal_lines ${direction} amount ${amount} is rejected`, async () => {
        await removeJournalLines();
        expect(await makeJournalLine(direction, amount)).toBe(false);
      });
    }
    for (const amount of valid) {
      test(`journal_lines ${direction} amount ${amount} is accepted`, async () => {
        await removeJournalLines();
        expect(await makeJournalLine(direction, amount)).toBe(true);
        await removeJournalLines();
      });
    }
  }
});

describeDb("Suite 01 · sequenced shard ledger constraints", () => {
  /** Inserts a balanced pair of lines (the two legs sit on different accounts) with explicit shard columns. */
  const insertPair = async (shardId: number | null, shardSeq: number | string | null): Promise<boolean> => {
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO "journal_lines" ("id", "created_at", "updated_at", "entry_id", "gl_account_id", "direction", "amount", "shard_id", "shard_seq") VALUES
          ($1, now(), now(), $2, $3, 'DEBIT', 1, $4, $5),
          ($6, now(), now(), $2, $7, 'CREDIT', 1, $4, $5)`,
        crypto.randomUUID(),
        journalEntryId,
        glDebitId,
        shardId,
        shardSeq,
        crypto.randomUUID(),
        glCreditId,
      );
      return true;
    } catch {
      return false;
    }
  };

  for (const seq of [0, -1, -9_000_000_000]) {
    test(`a new journal line with shard_seq ${seq} is rejected (pre-genesis rows are exempt, new rows are not)`, async () => {
      await removeJournalLines();
      expect(await insertPair(0, seq)).toBe(false);
    });
  }
  for (const seq of [1, 2, "9223372036854775807"]) {
    test(`a new journal line with shard_seq ${seq} is accepted`, async () => {
      await removeJournalLines();
      expect(await insertPair(0, seq)).toBe(true);
      await removeJournalLines();
    });
  }
  for (const shardId of [-1, 256, 1000]) {
    test(`a journal line on shard ${shardId} is rejected`, async () => {
      await removeJournalLines();
      expect(await insertPair(shardId, 1)).toBe(false);
    });
  }
  for (const shardId of [0, 1, 255]) {
    test(`a journal line on shard ${shardId} is accepted`, async () => {
      await removeJournalLines();
      expect(await insertPair(shardId, 1)).toBe(true);
      await removeJournalLines();
    });
  }
  test("shard_id and shard_seq have no defaults: a line without them is rejected", async () => {
    await removeJournalLines();
    expect(await insertPair(null, 1)).toBe(false);
    expect(await insertPair(0, null)).toBe(false);
    let omitted = true;
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO "journal_lines" ("id", "created_at", "updated_at", "entry_id", "gl_account_id", "direction", "amount") VALUES
          ($1, now(), now(), $2, $3, 'DEBIT', 1), ($4, now(), now(), $2, $5, 'CREDIT', 1)`,
        crypto.randomUUID(),
        journalEntryId,
        glDebitId,
        crypto.randomUUID(),
        glCreditId,
      );
    } catch {
      omitted = false;
    }
    expect(omitted).toBe(false);
  });

  for (const width of [0, -1, 257]) {
    test(`gl_accounts.shard_count ${width} is rejected`, async () => {
      let rejected = false;
      try {
        await createRow("gl_accounts", { account_type: "TREASURY", currency: "LYD", shard_count: width });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });
  }
  for (const width of [1, 16, 256]) {
    test(`gl_accounts.shard_count ${width} is accepted and the trigger creates shard rows 0..${width - 1}`, async () => {
      const account = await createRow("gl_accounts", { account_type: "TREASURY", currency: "LYD", shard_count: width });
      const shards = (await db.$queryRawUnsafe(
        `SELECT shard_id, current_balance::text AS balance, line_seq::text AS seq FROM gl_account_shards WHERE gl_account_id = $1::uuid ORDER BY shard_id`,
        account.id,
      )) as Array<{ shard_id: number; balance: string; seq: string }>;
      expect(shards.map((shard) => Number(shard.shard_id))).toEqual(Array.from({ length: width }, (_, index) => index));
      expect(shards.every((shard) => Number(shard.balance) === 0 && shard.seq === "0")).toBe(true);
    });
  }

  test("gl_account_shards refuses shard ids outside 0..255", async () => {
    for (const shardId of [-1, 256]) {
      let rejected = false;
      try {
        await createRow("gl_account_shards", { shard_id: shardId });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
  });

  test("gl_shard_checkpoints: status must be OK, GAP or PARITY and the shard row must exist", async () => {
    const account = await createRow("gl_accounts", { account_type: "TREASURY", currency: "LYD", shard_count: 2 });
    const insert = async (shardId: number, status: string): Promise<boolean> => {
      try {
        await db.$executeRawUnsafe(
          `INSERT INTO "gl_shard_checkpoints" ("gl_account_id", "shard_id", "status") VALUES ($1::uuid, $2, $3)`,
          account.id,
          shardId,
          status,
        );
        return true;
      } catch {
        return false;
      }
    };
    expect(await insert(0, "BROKEN")).toBe(false);
    expect(await insert(5, "OK")).toBe(false); // composite FK: shard 5 does not exist
    expect(await insert(1, "PARITY")).toBe(true);
    expect(await insert(1, "OK")).toBe(false); // primary key (gl_account_id, shard_id)
    const rows = (await db.$queryRawUnsafe(
      `SELECT checkpoint_balance::text AS balance, checkpoint_seq::text AS seq, consecutive_failures FROM gl_shard_checkpoints WHERE gl_account_id = $1::uuid AND shard_id = 1`,
      account.id,
    )) as Array<{ balance: string; seq: string; consecutive_failures: number }>;
    // a shard without checkpoint data is at (0, seq 0)
    expect([rows[0]?.balance, rows[0]?.seq, Number(rows[0]?.consecutive_failures)]).toEqual(["0.0000", "0", 0]);
    await db.$executeRawUnsafe(`DELETE FROM "gl_shard_checkpoints" WHERE gl_account_id = $1::uuid`, account.id);
  });
});

describeDb("Suite 01 · attempt_groups_single_success", () => {
  test("success_count = 0 is accepted", async () => {
    const row = await createRow("attempt_groups", { success_count: 0 });
    expect(row.success_count).toBe(0);
  });

  test("success_count = 1 is accepted", async () => {
    const row = await createRow("attempt_groups", { success_count: 1 });
    expect(row.success_count).toBe(1);
  });

  for (const count of [2, 3, 100]) {
    test(`success_count = ${count} is rejected`, async () => {
      let rejected = false;
      try {
        await createRow("attempt_groups", { success_count: count });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });
  }
});

describeDb("Suite 01 · payment_links_slot_reservation_invariant", () => {
  test("infinite_use = true accepts (confirmed=500, locked=25)", async () => {
    expect(await tryUpdateLink(infiniteLinkId, {
      infiniteUse: true,
      useCount: 1,
      confirmed: 500,
      locked: 25,
    })).toBe(true);
  });

  for (const useCount of [1, 5, 10]) {
    for (let confirmed = 0; confirmed <= useCount + 1; confirmed += 1) {
      for (let locked = 0; locked <= useCount + 1; locked += 1) {
        const withinCap = confirmed + locked <= useCount;
        test(`use_count=${useCount} confirmed=${confirmed} locked=${locked} -> ${withinCap ? "accepted" : "rejected"}`, async () => {
          const linkId = finiteLinkIds.get(useCount) ?? "";
          expect(await tryUpdateLink(linkId, {
            infiniteUse: false,
            useCount,
            confirmed,
            locked,
          })).toBe(withinCap);
        });
      }
    }
  }
});

describeDb("Suite 01 · approval_requests_checker_not_maker trigger", () => {
  const base = () => ({
    subject_type: "MERCHANT",
    subject_id: crypto.randomUUID(),
    payload_diff_json: JSON.stringify({}),
    state: "PENDING_REVIEW",
    maker_user_id: makerId,
  });

  test("INSERT with checker = maker is rejected by the CHECK constraint", async () => {
    let message = "";
    try {
      await insertRow("approval_requests", {
        id: crypto.randomUUID(),
        updated_at: new Date(),
        ...base(),
        checker_user_id: makerId,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/approval_requests_checker_not_maker_insert|violates check constraint/);
  });

  test("INSERT with checker = NULL is accepted", async () => {
    const row = await createRow("approval_requests", base());
    expect(row.id).toBeDefined();
  });

  test("INSERT with a distinct checker is accepted", async () => {
    const row = await createRow("approval_requests", { ...base(), checker_user_id: checkerId });
    expect(row.id).toBeDefined();
  });

  test("UPDATE setting checker = maker is rejected by the trigger", async () => {
    const row = await createRow("approval_requests", { ...base(), checker_user_id: checkerId });
    let message = "";
    try {
      await db.$executeRawUnsafe(
        'UPDATE "approval_requests" SET "checker_user_id" = $1 WHERE "id" = $2',
        makerId,
        row.id,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("checker_user_id must differ from maker_user_id");
  });

  test("UPDATE with a distinct checker is accepted", async () => {
    const row = await createRow("approval_requests", base());
    await db.$executeRawUnsafe(
      'UPDATE "approval_requests" SET "checker_user_id" = $1 WHERE "id" = $2',
      checkerId,
      row.id,
    );
    const rows = (await db.$queryRawUnsafe(
      'SELECT "checker_user_id" AS checker FROM "approval_requests" WHERE "id" = $1',
      row.id,
    )) as Array<{ checker: string }>;
    expect(rows[0]?.checker).toBe(checkerId);
  });

  test("UPDATE clearing the checker to NULL is accepted", async () => {
    const row = await createRow("approval_requests", { ...base(), checker_user_id: checkerId });
    await db.$executeRawUnsafe(
      'UPDATE "approval_requests" SET "checker_user_id" = NULL WHERE "id" = $1',
      row.id,
    );
    const rows = (await db.$queryRawUnsafe(
      'SELECT "checker_user_id" AS checker FROM "approval_requests" WHERE "id" = $1',
      row.id,
    )) as Array<{ checker: string | null }>;
    expect(rows[0]?.checker).toBeNull();
  });
});
