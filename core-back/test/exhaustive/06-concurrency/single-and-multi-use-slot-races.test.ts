/**
 * Suite 06.1 — 50-way slot reservation races against the live database.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  assertZeroDrift,
  databaseIsReachable,
  exhaustiveClient,
  errorCode,
} from "../_harness";
import { createRow } from "../_dbFactory";
import { PrismaSlotReservationStore } from "../../../engine/runtime/slotStore";
import type { DynamicAttempt } from "../../../engine/flow/DynamicRailEngine";

const db = exhaustiveClient();
const describeDb = databaseIsReachable ? describe : describe.skip;
const store = new PrismaSlotReservationStore(db as never);

const linkIds: string[] = [];
const attemptIds: string[] = [];

const makeLink = async (useCount: number): Promise<string> => {
  const row = await createRow("payment_links", {
    use_count: useCount,
    infinite_use: 0,
    confirmed_count: 0,
    active_locked_count: 0,
  });
  const id = String(row.id);
  linkIds.push(id);
  return id;
};

const makeAttempt = async (linkId: string): Promise<DynamicAttempt> => {
  const row = await createRow("payment_attempts", {
    link_id: linkId,
    reference: `RACE-${crypto.randomUUID()}`,
    status: "CREATED",
  });
  attemptIds.push(String(row.id));
  return {
    id: String(row.id),
    linkId,
    reference: String(row.reference),
    status: "CREATED",
    env: "SANDBOX",
    currency: "LYD",
    requestedAmount: "100.0000",
    totalChargedAmount: "100.0000",
    platformCommissionAmount: "3.0000",
    netMerchantAmount: "97.0000",
    ownershipMode: "PLATFORM_CLEARING",
  };
};

const readLink = async (linkId: string) => {
  const rows = (await db.$queryRawUnsafe(
    "SELECT active_locked_count, confirmed_count, use_count, infinite_use, state FROM payment_links WHERE id = ?",
    linkId,
  )) as Array<Record<string, unknown>>;
  return rows[0] as {
    active_locked_count: number | bigint;
    confirmed_count: number | bigint;
    use_count: number | bigint;
    infinite_use: number | bigint;
    state: string;
  };
};

afterAll(async () => {
  if (!databaseIsReachable) {
    return;
  }
  if (attemptIds.length > 0) {
    await db.$executeRawUnsafe(
      `DELETE FROM payment_attempts WHERE id IN (${attemptIds.map(() => "?").join(",")})`,
      ...attemptIds,
    );
  }
  if (linkIds.length > 0) {
    await db.$executeRawUnsafe(
      `DELETE FROM payment_links WHERE id IN (${linkIds.map(() => "?").join(",")})`,
      ...linkIds,
    );
  }
  await assertZeroDrift(db);
  await db.$disconnect();
});

describeDb("Suite 06 · slot reservation races", () => {
  test("50 simultaneous reservations on a single-use link: exactly one wins", async () => {
    const linkId = await makeLink(1);
    const attempts = await Promise.all(Array.from({ length: 50 }, () => makeAttempt(linkId)));
    const results = await Promise.allSettled(attempts.map((attempt) => store.reserveSlot(attempt)));
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(49);
    for (const result of rejected) {
      if (result.status === "rejected") {
        expect(["PAYMENT_LINK_SLOT_UNAVAILABLE", "SLOT_RESERVATION_FAILED"]).toContain(String(errorCode(result.reason)));
      }
    }
    const link = await readLink(linkId);
    expect(Number(link.active_locked_count)).toBe(1);
    expect(Number(link.confirmed_count)).toBe(0);
  }, 120_000);

  test("50 simultaneous reservations on a 10-use link: exactly ten win", async () => {
    const linkId = await makeLink(10);
    const attempts = await Promise.all(Array.from({ length: 50 }, () => makeAttempt(linkId)));
    const results = await Promise.allSettled(attempts.map((attempt) => store.reserveSlot(attempt)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(40);
    const link = await readLink(linkId);
    expect(Number(link.active_locked_count)).toBe(10);
  }, 120_000);

  test("releasing three slots frees exactly three more reservations", async () => {
    const linkId = await makeLink(10);
    const attempts = await Promise.all(Array.from({ length: 10 }, () => makeAttempt(linkId)));
    const firstWave = await Promise.all(attempts.map((attempt) => store.reserveSlot(attempt)));
    expect(firstWave).toHaveLength(10);

    for (const attempt of attempts.slice(0, 3)) {
      await store.releaseSlot(attempt, "CANCELLED");
    }
    let link = await readLink(linkId);
    expect(Number(link.active_locked_count)).toBe(7);

    const newAttempts = await Promise.all(Array.from({ length: 10 }, () => makeAttempt(linkId)));
    const secondWave = await Promise.allSettled(newAttempts.map((attempt) => store.reserveSlot(attempt)));
    expect(secondWave.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(secondWave.filter((result) => result.status === "rejected")).toHaveLength(7);
    link = await readLink(linkId);
    expect(Number(link.active_locked_count)).toBe(10);
  }, 120_000);

  test("an infinite-use link accepts 50 concurrent reservations", async () => {
    const row = await createRow("payment_links", {
      infinite_use: 1,
      use_count: 1,
      confirmed_count: 0,
      active_locked_count: 0,
    });
    const linkId = String(row.id);
    linkIds.push(linkId);
    const attempts = await Promise.all(Array.from({ length: 50 }, () => makeAttempt(linkId)));
    const results = await Promise.allSettled(attempts.map((attempt) => store.reserveSlot(attempt)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(50);
    const link = await readLink(linkId);
    expect(Number(link.active_locked_count)).toBe(50);
  }, 120_000);

  test("releasing below zero is clamped by GREATEST(0, ...)", async () => {
    const linkId = await makeLink(1);
    const attempt = await makeAttempt(linkId);
    await store.releaseSlot(attempt, "DOUBLE_RELEASE");
    await store.releaseSlot(attempt, "DOUBLE_RELEASE");
    const link = await readLink(linkId);
    expect(Number(link.active_locked_count)).toBe(0);
  });
});
