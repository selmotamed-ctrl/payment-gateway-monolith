import { describe, expect, test } from "bun:test";
import { ExpirySweeperWorker, type InquiryOutcome, type InquiryPort } from "../engine/workers/ExpirySweeperWorker";
import { createFakeRepositories } from "./helpers/fakeRepositories";
import { createRecordingDb } from "./edge-cases/helpers";

/**
 * Regression: the expiry sweeper treated AUTHORIZING and VERIFYING like any open session. A crash
 * after the confirm claim leaves a money-moving attempt in AUTHORIZING with point_of_no_return set;
 * when its route has no status check (or the inquiry is not definitive) the sweeper wrote EXPIRED,
 * released the link slot and the PollWorker never looked at it again, although the gateway may
 * have charged the payer. Such an attempt must become UNKNOWN and stay with the PollWorker
 * (polling, then one keyed operator case), keeping its slot.
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const EXPIRED_AT = new Date("2026-05-31T00:00:00.000Z");

const attemptRow = (overrides: Record<string, unknown> = {}) => ({
  id: "attempt-1",
  status: "AUTHORIZING",
  substatus: null,
  expires_at: EXPIRED_AT,
  terminal_at: null,
  route_id: "route-1",
  link_id: "link-1",
  point_of_no_return: true,
  ...overrides,
});

const createWorker = (
  queryRows: unknown[],
  options: {
    supportsStatusCheck?: boolean;
    inquiry?: InquiryPort;
    onExecute?: (sql: string, args: unknown[]) => number | undefined;
  } = {},
) => {
  const releases: Array<{ linkId: string; delta: number }> = [];
  const audits: Array<{ action: string; afterJson?: unknown }> = [];
  const { db, calls } = createRecordingDb({
    queryRows,
    onExecute: options.onExecute ?? (() => 1),
  });
  const worker = new ExpirySweeperWorker({
    db,
    repositories: createFakeRepositories({
      payments: {
        listRouteInquirySupport: async () =>
          options.supportsStatusCheck ? [{ routeId: "route-1", supportsStatusCheck: true }] : [],
        updateLinkSlotCount: async (_tx, linkId, delta) => {
          releases.push({ linkId, delta });
        },
        updateAttempt: async () => ({}) as never,
      },
      governance: {
        writeAuditLog: async (_tx, data) => {
          audits.push(data);
        },
      },
    }),
    clock: () => NOW,
    inquiry: options.inquiry,
  });
  const attemptUpdates = () =>
    calls.filter((call) => call.kind === "execute" && call.sql.includes("UPDATE payment_attempts"));
  return { worker, releases, audits, attemptUpdates };
};

const inquiryAnswering = (outcome: InquiryOutcome): InquiryPort => ({ inquire: async () => outcome });

describe("expiry sweeper and attempts past the point of no return", () => {
  for (const status of ["AUTHORIZING", "VERIFYING"]) {
    test(`an expired ${status} attempt past the point of no return becomes UNKNOWN, not EXPIRED`, async () => {
      const { worker, releases, audits, attemptUpdates } = createWorker([attemptRow({ status })]);

      await worker.runOnce();

      const updates = attemptUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0]?.sql).toContain("status = 'UNKNOWN'");
      // Conditional on the observed status and on the attempt still being open.
      expect(updates[0]?.sql).toContain("terminal_at IS NULL AND status = $3");
      expect(updates[0]?.args).toEqual([NOW, "attempt-1", status]);
      expect(updates.some((call) => call.args.includes("EXPIRED"))).toBe(false);
      // The money may have moved: the slot stays reserved.
      expect(releases).toEqual([]);
      expect(audits.map((audit) => audit.action)).toEqual(["ATTEMPT_EXPIRY_HELD_UNKNOWN"]);
    });
  }

  test("a non-definitive inquiry also leaves it UNKNOWN", async () => {
    const { worker, releases, attemptUpdates } = createWorker([attemptRow()], {
      supportsStatusCheck: true,
      inquiry: inquiryAnswering({ status: "AUTHORIZING", definitive: false }),
    });

    await worker.runOnce();

    const updates = attemptUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toContain("status = 'UNKNOWN'");
    expect(releases).toEqual([]);
  });

  test("a definitive gateway answer still wins: FAILED terminates and releases the slot", async () => {
    const { worker, releases, attemptUpdates } = createWorker([attemptRow()], {
      supportsStatusCheck: true,
      inquiry: inquiryAnswering({ status: "FAILED", definitive: true }),
    });

    await worker.runOnce();

    const updates = attemptUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args[0]).toBe("FAILED");
    expect(releases).toEqual([{ linkId: "link-1", delta: -1 }]);
  });

  test("a concurrent finalize wins the race: no audit row when the conditional update matches nothing", async () => {
    const { worker, releases, audits, attemptUpdates } = createWorker([attemptRow()], { onExecute: () => 0 });

    await worker.runOnce();

    expect(attemptUpdates().map((call) => call.sql.includes("status = 'UNKNOWN'"))).toEqual([true]);
    expect(audits).toEqual([]);
    expect(releases).toEqual([]);
  });

  test("an attempt before the point of no return is still expired and its slot released", async () => {
    const { worker, releases, attemptUpdates } = createWorker([attemptRow({ point_of_no_return: false })]);

    await worker.runOnce();

    const updates = attemptUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args[0]).toBe("EXPIRED");
    expect(releases).toEqual([{ linkId: "link-1", delta: -1 }]);
  });
});
