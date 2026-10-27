import { describe, expect, test } from "bun:test";
import { AttemptGuardPipeline } from "../../engine/guards/AttemptGuardPipeline";
import {
  CachedScreeningProvider,
  InternalWatchlistProvider,
} from "../../engine/guards/ScreeningProvider";
import { DynamicRailEngine, type DynamicAttempt, type SlotReservationStore } from "../../engine/flow/DynamicRailEngine";
import { PrismaSlotReservationStore } from "../../engine/runtime/slotStore";
import { createGuardFixture, linkRow, type GuardFixture } from "../helpers/guardsFake";
import { createSlotHarness } from "../edge-cases/helpers";

const NOW = new Date("2026-03-01T12:00:00.000Z");

const guardRequest = (overrides: Record<string, unknown> = {}) => ({
  linkKey: "link-key-1",
  railCode: "edfali",
  applicationId: "application-1",
  merchantId: "merchant-1",
  env: "SANDBOX" as const,
  channel: "WEB" as const,
  mode: "OTP_PULL",
  idempotencyKey: "idem-slot-1",
  ...overrides,
});

const pipelineFor = (fixture: GuardFixture): AttemptGuardPipeline =>
  new AttemptGuardPipeline({
    db: fixture.db,
    repositories: fixture.repositories,
    screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
    clock: () => NOW,
  });

/**
 * Composes the guard and the engine the same way the checkout route does:
 * the guard creates the attempt and reserves the link slot atomically, then
 * the engine initiates with `slotReserved` so it does not reserve a second
 * time.
 */
const composeRoute = (fixture: GuardFixture) => {
  const reserved: string[] = [];
  const released: string[] = [];
  const slots: SlotReservationStore = {
    reserveSlot: async (attempt) => {
      const link = fixture.state.link;
      if (!link.infiniteUse && link.confirmedCount + link.activeLockedCount >= link.useCount) {
        throw new Error("PAYMENT_LINK_SLOT_UNAVAILABLE");
      }
      link.activeLockedCount += 1;
      reserved.push(attempt.id);
      return { reservationId: `${link.id}:${attempt.id}`, linkId: link.id };
    },
    releaseSlot: async (attempt, reason) => {
      fixture.state.link.activeLockedCount = Math.max(0, fixture.state.link.activeLockedCount - 1);
      released.push(`${attempt.id}:${reason}`);
    },
    commitSlot: async () => ({ outcome: "COMMITTED" as const }),
  };
  const attempts = {
    getAttempt: async (id: string) => {
      const row = fixture.state.createdAttempts.find((attempt) => attempt.id === id);
      return row ? (row as unknown as DynamicAttempt) : null;
    },
    updateAttempt: async (id: string, patch: Partial<DynamicAttempt>) => {
      const row = fixture.state.createdAttempts.find((attempt) => attempt.id === id);
      if (!row) {
        throw new Error("attempt not found");
      }
      Object.assign(row, patch);
      return row as unknown as DynamicAttempt;
    },
  };
  const engine = new DynamicRailEngine({
    attempts,
    slots,
    flowProvider: { getSteps: async () => [] },
    stepExecutor: { execute: async () => ({ output: { state: {}, public: {} } }) } as never,
  });
  return { engine, reserved, released };
};

describe("checkout initiate composition (guard + engine)", () => {
  test("a single-use link is reserved exactly once and the initiation succeeds", async () => {
    const fixture = createGuardFixture({
      link: linkRow({
        useCount: 1,
        infiniteUse: false,
        confirmedCount: 0,
        activeLockedCount: 0,
        state: "PENDING",
      }),
    });
    // The guard reservation is the repository's atomic counter increment, so
    // the fixture has to apply it to the shared link row.
    fixture.repositories.payments.updateLinkSlotCount = async (_tx, _linkId, delta) => {
      fixture.state.slotDeltas.push(delta);
      fixture.state.link.activeLockedCount += delta;
    };
    const { engine, reserved, released } = composeRoute(fixture);

    const decision = await pipelineFor(fixture).guard(guardRequest());

    expect(decision.outcome).toBe("ALLOW");
    expect(decision.slotReserved).toBe(true);
    expect(fixture.state.slotDeltas).toEqual([1]);
    expect(fixture.state.link.activeLockedCount).toBe(1);

    const attempt = fixture.state.createdAttempts.find((row) => row.id === decision.attemptId);
    expect(attempt).toBeDefined();

    const result = await engine.initiate(
      attempt as unknown as DynamicAttempt,
      {},
      { slotReserved: decision.slotReserved === true },
    );

    expect(result.status).toBe("AWAITING_CUSTOMER");
    // The engine did not take a second reservation and did not release the
    // guard's reservation.
    expect(reserved).toEqual([]);
    expect(released).toEqual([]);
    expect(fixture.state.link.activeLockedCount).toBe(1);
    expect(fixture.state.slotDeltas).toEqual([1]);
  });

  test("the engine keeps its own reservation for callers that did not pre-reserve", async () => {
    const fixture = createGuardFixture({
      link: linkRow({
        useCount: 2,
        infiniteUse: false,
        confirmedCount: 0,
        activeLockedCount: 0,
        state: "PENDING",
      }),
    });
    fixture.repositories.payments.updateLinkSlotCount = async (_tx, _linkId, delta) => {
      fixture.state.slotDeltas.push(delta);
      fixture.state.link.activeLockedCount += delta;
    };
    const { engine, reserved } = composeRoute(fixture);

    const decision = await pipelineFor(fixture).guard(guardRequest());
    const attempt = fixture.state.createdAttempts.find((row) => row.id === decision.attemptId);

    const result = await engine.initiate(attempt as unknown as DynamicAttempt, {});

    expect(result.status).toBe("AWAITING_CUSTOMER");
    expect(decision.attemptId).toBeTruthy();
    expect(reserved).toEqual([decision.attemptId as string]);
    expect(fixture.state.link.activeLockedCount).toBe(2);
  });
});

describe("infinite-use link lifecycle", () => {
  test("an infinite-use link stays PENDING after a payment and accepts further payments", async () => {
    const harness = createSlotHarness({
      infinite_use: 1,
      use_count: 1,
      confirmed_count: 0,
      active_locked_count: 1,
      state: "PENDING",
    });
    const store = new PrismaSlotReservationStore(harness.client);

    const first = await store.commitSlot({ id: "attempt-1", linkId: harness.link.id } as never);
    expect(first).toMatchObject({ outcome: "COMMITTED" });
    expect(harness.link.state).toBe("PENDING");
    expect(harness.link.confirmed_count).toBe(1);
    expect(harness.link.active_locked_count).toBe(0);

    const reservation = await store.reserveSlot(
      { id: "attempt-2", linkId: harness.link.id } as never,
    );
    expect(reservation.linkId).toBe(harness.link.id);
    expect(harness.link.active_locked_count).toBe(1);

    const second = await store.commitSlot({ id: "attempt-2", linkId: harness.link.id } as never);
    expect(second).toMatchObject({ outcome: "COMMITTED" });
    expect(harness.link.state).toBe("PENDING");
    expect(harness.link.confirmed_count).toBe(2);
    expect(harness.link.active_locked_count).toBe(0);
  });
});
