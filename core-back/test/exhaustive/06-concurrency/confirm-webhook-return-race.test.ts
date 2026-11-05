/**
 * Suite 06.2 — triple-confirmation and duplicate-webhook races.
 *
 * Proves the atomic claim (exactly one SUBMIT winner), the single-use slot
 * commit race (one normal credit, the rest routed to SUSPENSE) and the
 * idempotency of the journal posting under concurrent duplicate deliveries.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertZeroDrift,
  databaseIsReachable,
  exhaustiveClient,
  verifyInvariant,
} from "../_harness";
import { createRow } from "../_dbFactory";
import { withLedgerMaintenance } from "../../helpers/ledgerMaintenance";
import { PrismaSlotReservationStore } from "../../../engine/runtime/slotStore";
import { LedgerPoster, buildLedgerTemplate, type LedgerPostContext } from "../../../engine/ledger/LedgerPoster";
import type { DynamicAttempt } from "../../../engine/flow/DynamicRailEngine";

const db = exhaustiveClient();
const describeDb = databaseIsReachable ? describe : describe.skip;
const store = new PrismaSlotReservationStore(db as never);
const poster = new LedgerPoster(db as never);
const PREFIX = `race6-${crypto.randomUUID()}`;
const placeholders = (count: number): string =>
  Array.from({ length: count }, (_value, index) => `$${index + 1}`).join(",");

const linkIds: string[] = [];
const attemptIds: string[] = [];
const accountIds: string[] = [];
const accounts: LedgerPostContext["accounts"] = {};

beforeAll(async () => {
  if (!databaseIsReachable) {
    return;
  }
  for (const accountType of ["TREASURY", "MERCHANT_WALLET", "PLATFORM_INCOME", "GATEWAY_CLEARING", "SUSPENSE"] as const) {
    const row = await createRow("gl_accounts", { account_type: accountType, currency: "LYD" });
    accounts[accountType] = String(row.id);
    accountIds.push(String(row.id));
  }
});

afterAll(async () => {
  if (!databaseIsReachable) {
    return;
  }
  // journal tables are append-only (GAP-013): fixture cleanup runs under the maintenance flag.
  await withLedgerMaintenance(db, async (tx) => {
    await tx.$executeRawUnsafe(
      'DELETE FROM "journal_lines" WHERE "entry_id" IN (SELECT "id" FROM "journal_entries" WHERE "ref_id" LIKE $1)',
      `${PREFIX}%`,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM "journal_entries" WHERE "ref_id" LIKE $1',
      `${PREFIX}%`,
    );
  });
  await db.$executeRawUnsafe(
    'DELETE FROM "adjustments" WHERE "source_attempt_id" IN (SELECT "id" FROM "payment_attempts" WHERE "link_id" IN (SELECT "id" FROM "payment_links" WHERE "key" LIKE $1))',
    `${PREFIX}%`,
  ).catch(() => undefined);
  await db.$executeRawUnsafe(
    'DELETE FROM "operator_cases" WHERE "attempt_id" IN (SELECT "id" FROM "payment_attempts" WHERE "link_id" IN (SELECT "id" FROM "payment_links" WHERE "key" LIKE $1))',
    `${PREFIX}%`,
  ).catch(() => undefined);
  if (attemptIds.length > 0) {
    await db.$executeRawUnsafe(
      `DELETE FROM "payment_attempts" WHERE "id" IN (${placeholders(attemptIds.length)})`,
      ...attemptIds,
    );
  }
  if (linkIds.length > 0) {
    await db.$executeRawUnsafe(
      `DELETE FROM "payment_links" WHERE "id" IN (${placeholders(linkIds.length)})`,
      ...linkIds,
    );
  }
  if (accountIds.length > 0) {
    await db.$executeRawUnsafe(
      `DELETE FROM "gl_account_shards" WHERE "gl_account_id" IN (${placeholders(accountIds.length)})`,
      ...accountIds,
    ).catch(() => undefined);
    await db.$executeRawUnsafe(
      `DELETE FROM "gl_accounts" WHERE "id" IN (${placeholders(accountIds.length)})`,
      ...accountIds,
    );
  }
  await assertZeroDrift(db);
  await db.$disconnect();
});

const makeLink = async (): Promise<string> => {
  const row = await createRow("payment_links", {
    key: `${PREFIX}-link-${crypto.randomUUID()}`,
    use_count: 1,
    infinite_use: false,
    confirmed_count: 0,
    active_locked_count: 1,
  });
  linkIds.push(String(row.id));
  return String(row.id);
};

const makeAttempt = async (linkId: string, status = "AWAITING_CUSTOMER"): Promise<DynamicAttempt> => {
  const row = await createRow("payment_attempts", {
    link_id: linkId,
    reference: `${PREFIX}-PA-${crypto.randomUUID()}`,
    status,
  });
  attemptIds.push(String(row.id));
  return {
    id: String(row.id),
    linkId,
    reference: String(row.reference),
    status: status as DynamicAttempt["status"],
    env: "SANDBOX",
    currency: "LYD",
    requestedAmount: "100.0000",
    totalChargedAmount: "100.0000",
    platformCommissionAmount: "3.0000",
    netMerchantAmount: "97.0000",
    ownershipMode: "PLATFORM_CLEARING",
    merchantId: String(row.merchant_id),
  };
};

describeDb("Suite 06 · confirmation races", () => {
  test("50 concurrent confirm claims: exactly one SUBMIT winner", async () => {
    const linkId = await makeLink();
    const attempt = await makeAttempt(linkId, "AWAITING_CUSTOMER");
    const claim = async (): Promise<number> => {
      const affected = await db.$executeRawUnsafe(
        'UPDATE "payment_attempts" SET "status" = \'AUTHORIZING\', "point_of_no_return" = true, "updated_at" = now() WHERE "id" = $1 AND "status" = \'AWAITING_CUSTOMER\'',
        attempt.id,
      );
      return Number(affected ?? 0);
    };
    const results = await Promise.all(Array.from({ length: 50 }, () => claim()));
    expect(results.reduce((total, value) => total + value, 0)).toBe(1);
    const rows = (await db.$queryRawUnsafe(
      'SELECT "status", "point_of_no_return" FROM "payment_attempts" WHERE "id" = $1',
      attempt.id,
    )) as Array<{ status: string; point_of_no_return: boolean }>;
    expect(rows[0]?.status).toBe("AUTHORIZING");
    expect(Number(rows[0]?.point_of_no_return)).toBe(1);
  }, 120_000);

  test("10 concurrent slot commits on a single-use link: one credit, nine SUSPENSE", async () => {
    const linkId = await makeLink();
    const attempt = await makeAttempt(linkId);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.commitSlot(attempt)),
    );
    const committed = results.filter((result) => result.outcome === "COMMITTED");
    const suspense = results.filter((result) => result.outcome === "SUSPENSE");
    expect(committed).toHaveLength(1);
    expect(suspense).toHaveLength(9);
    const link = (await db.$queryRawUnsafe(
      'SELECT "confirmed_count", "active_locked_count" FROM "payment_links" WHERE "id" = $1',
      linkId,
    )) as Array<{ confirmed_count: number; active_locked_count: number }>;
    expect(Number(link[0]?.confirmed_count)).toBe(1);
    expect(Number(link[0]?.active_locked_count)).toBe(0);
  }, 120_000);

  test("a duplicate journal posting is idempotent", async () => {
    const template = buildLedgerTemplate("INTERNAL_CONFIRMATION", {
      amount: "10.0000",
      commissionAmount: "0.3000",
    });
    template.refId = `${PREFIX}-journal-idempotent`;
    const first = await poster.post(template, { accounts });
    const second = await poster.post(template, { accounts });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.idempotent).toBe(true);
    const rows = (await db.$queryRawUnsafe(
      'SELECT COUNT(*) AS count FROM "journal_entries" WHERE "ref_type" = $1 AND "ref_id" = $2',
      template.refType,
      template.refId,
    )) as Array<{ count: bigint }>;
    expect(Number(rows[0]?.count)).toBe(1);
  });

  test("20 concurrent duplicate webhook postings create exactly one journal entry", async () => {
    const template = buildLedgerTemplate("INTERNAL_CONFIRMATION", {
      amount: "20.0000",
      commissionAmount: "0.6000",
    });
    template.refId = `${PREFIX}-journal-race`;
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => poster.post(template, { accounts })),
    );
    const results = settled
      .filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof poster.post>>> => entry.status === "fulfilled")
      .map((entry) => entry.value);
    // A unique-key race may reject a loser at the transaction boundary; the
    // durable guarantee is that the database holds exactly one entry.
    expect(results.filter((result) => result.created).length).toBeLessThanOrEqual(1);
    const rows = (await db.$queryRawUnsafe(
      'SELECT COUNT(*) AS count FROM "journal_entries" WHERE "ref_type" = $1 AND "ref_id" = $2',
      template.refType,
      template.refId,
    )) as Array<{ count: bigint }>;
    expect(Number(rows[0]?.count)).toBe(1);
    const snapshot = await verifyInvariant(db);
    expect(snapshot.drift).toBe("0.0000");
  });
});
