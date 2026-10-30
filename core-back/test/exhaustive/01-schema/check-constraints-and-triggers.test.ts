/**
 * Suite 01.3 — database-level domain invariants.
 *
 * Three CHECK constraints and two Maker != Checker triggers are exercised
 * against the live server with real INSERT / UPDATE statements.
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
  // one-legged journal entry.
  const opposite = direction === "DEBIT" ? "CREDIT" : "DEBIT";
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO journal_lines (id, created_at, updated_at, entry_id, gl_account_id, direction, amount) VALUES
        (?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?)`,
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
  await db.$executeRawUnsafe("DELETE FROM journal_lines WHERE entry_id = ?", journalEntryId);
};

const tryUpdateLink = async (
  linkId: string,
  fields: { infiniteUse: boolean; useCount: number; confirmed: number; locked: number },
): Promise<boolean> => {
  try {
    await db.$executeRawUnsafe(
      "UPDATE payment_links SET infinite_use = ?, use_count = ?, confirmed_count = ?, active_locked_count = ? WHERE id = ?",
      fields.infiniteUse ? 1 : 0,
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
    infinite_use: 1,
    use_count: 1,
    confirmed_count: 500,
    active_locked_count: 25,
  });
  infiniteLinkId = String(infinite.id);
  for (const useCount of [1, 5, 10]) {
    const link = await createRow("payment_links", {
      infinite_use: 0,
      use_count: useCount,
      confirmed_count: 0,
      active_locked_count: 0,
    });
    finiteLinkIds.set(useCount, String(link.id));
  }

  const maker = await createRow("users", { role: "GATEWAY_ADMIN", is_maker: 1, is_checker: 1 });
  const checker = await createRow("users", { role: "FINANCE", is_maker: 1, is_checker: 1 });
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
    "attempt_groups_single_success",
    "payment_links_slot_reservation_invariant",
  ];

  for (const name of expected) {
    test(`CHECK constraint ${name} exists on the live server`, () => {
      expect(checks.some((check) => check.constraintName === name)).toBe(true);
    });
  }

  test("the approval_requests Maker != Checker triggers exist for INSERT and UPDATE", () => {
    const insertTrigger = triggers.find(
      (trigger) =>
        trigger.eventObjectTable === "approval_requests"
        && trigger.actionTiming === "BEFORE"
        && trigger.eventManipulation === "INSERT",
    );
    const updateTrigger = triggers.find(
      (trigger) =>
        trigger.eventObjectTable === "approval_requests"
        && trigger.actionTiming === "BEFORE"
        && trigger.eventManipulation === "UPDATE",
    );
    expect(insertTrigger?.triggerName).toBe("approval_requests_checker_not_maker");
    expect(updateTrigger?.triggerName).toBe("approval_requests_checker_not_maker_update");
    expect(updateTrigger?.actionStatement).toContain("45000");
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

  test("INSERT with checker = maker is rejected with SQLSTATE 45000", async () => {
    let message = "";
    try {
      await insertRow("approval_requests", {
        id: crypto.randomUUID(),
        ...base(),
        checker_user_id: makerId,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("checker_user_id must differ from maker_user_id");
  });

  test("INSERT with checker = NULL is accepted", async () => {
    const row = await createRow("approval_requests", base());
    expect(row.id).toBeDefined();
  });

  test("INSERT with a distinct checker is accepted", async () => {
    const row = await createRow("approval_requests", { ...base(), checker_user_id: checkerId });
    expect(row.id).toBeDefined();
  });

  test("UPDATE setting checker = maker is rejected with SQLSTATE 45000", async () => {
    const row = await createRow("approval_requests", { ...base(), checker_user_id: checkerId });
    let message = "";
    try {
      await db.$executeRawUnsafe(
        "UPDATE approval_requests SET checker_user_id = ? WHERE id = ?",
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
      "UPDATE approval_requests SET checker_user_id = ? WHERE id = ?",
      checkerId,
      row.id,
    );
    const rows = (await db.$queryRawUnsafe(
      "SELECT checker_user_id AS checker FROM approval_requests WHERE id = ?",
      row.id,
    )) as Array<{ checker: string }>;
    expect(rows[0]?.checker).toBe(checkerId);
  });

  test("UPDATE clearing the checker to NULL is accepted", async () => {
    const row = await createRow("approval_requests", { ...base(), checker_user_id: checkerId });
    await db.$executeRawUnsafe(
      "UPDATE approval_requests SET checker_user_id = NULL WHERE id = ?",
      row.id,
    );
    const rows = (await db.$queryRawUnsafe(
      "SELECT checker_user_id AS checker FROM approval_requests WHERE id = ?",
      row.id,
    )) as Array<{ checker: string | null }>;
    expect(rows[0]?.checker).toBeNull();
  });
});
