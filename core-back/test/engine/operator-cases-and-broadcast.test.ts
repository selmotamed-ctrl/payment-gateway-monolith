import { describe, expect, test } from "bun:test";
import type { PrismaLike } from "../../engine/db/ports";
import {
  ATTEMPT_TRANSITION_TOPIC,
  DynamicRailEngine,
  type DynamicAttempt,
  type DynamicRailEngineOptions,
  type OperatorCaseOpenInput,
} from "../../engine/flow/DynamicRailEngine";
import type { FlowStep } from "../../engine/flow/StepExecutor";
import { PrismaOperatorCaseSink } from "../../engine/compliance/OperatorCaseSink";
import { invalidationBus } from "../../lib/invalidationBus";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const VERIFY_STEP: FlowStep = { id: "verify", type: "HTTP", side_effect: "READ_ONLY" };

const attemptRow = (overrides: Partial<DynamicAttempt> = {}): DynamicAttempt => ({
  id: "attempt-1",
  reference: "PA-1",
  gatewayReference: "GW-1",
  status: "VERIFYING",
  env: "SANDBOX",
  currency: "LYD",
  requestedAmount: "100.0000",
  totalChargedAmount: "100.0000",
  settledAmount: "100.0000",
  platformCommissionAmount: "3.0000",
  netMerchantAmount: "97.0000",
  maxOtpAttempts: 3,
  otpAttempts: 0,
  ownershipMode: "PLATFORM_CLEARING",
  merchantId: "merchant-1",
  gatewayId: "gateway-1",
  credentialSetId: "credential-1",
  context: {},
  ...overrides,
});

const createEngine = (options: {
  attempt: DynamicAttempt;
  executor: (step: FlowStep) => unknown;
  cases?: OperatorCaseOpenInput[];
}) => {
  const attempts = new Map<string, DynamicAttempt>([[options.attempt.id, options.attempt]]);
  const cases = options.cases ?? [];
  const engineOptions: DynamicRailEngineOptions = {
    attempts: {
      getAttempt: async (id) => attempts.get(id) ?? null,
      updateAttempt: async (id, patch) => {
        const attempt = attempts.get(id);
        if (!attempt) {
          throw new Error("attempt not found");
        }
        Object.assign(attempt, patch);
        return attempt;
      },
    },
    slots: {
      reserveSlot: async (attempt) => ({ reservationId: `slot-${attempt.id}` }),
      releaseSlot: async () => undefined,
      commitSlot: async () => ({ outcome: "COMMITTED", journalEntryId: "journal-1" }),
    },
    flowProvider: {
      getSteps: async (phase) => (phase === "VERIFY" ? [VERIFY_STEP] : []),
    },
    stepExecutor: {
      execute: async (step: FlowStep) => options.executor(step),
    } as never,
    ledgerPoster: {
      postPaymentConfirmation: async () => ({ entry: { id: "journal-1" } }),
    },
    operatorCaseSink: {
      open: async (input) => {
        cases.push(input);
        return { id: `case-${cases.length}`, created: true };
      },
    },
    now: () => NOW,
  };
  return { engine: new DynamicRailEngine(engineOptions), attempts, cases };
};

describe("operator cases for conflicting signals and late success", () => {
  test("a conflicting inquiry freezes the attempt in UNKNOWN and opens a P1 CONFLICT case", async () => {
    const attempt = attemptRow({ context: { trustedSuccessObserved: true } });
    const harness = createEngine({
      attempt,
      executor: () => ({
        stepId: "verify",
        status: "FAILED" as const,
        canonicalError: "DECLINED",
        output: { state: {}, public: {} },
        logs: [],
      }),
    });

    const result = await harness.engine.inquire(attempt);

    expect(result.status).toBe("UNKNOWN");
    expect(result.canonicalError).toBe("CONFLICTING_TRUSTED_SIGNALS");
    expect(attempt.status).toBe("UNKNOWN");
    expect(harness.cases).toHaveLength(1);
    expect(harness.cases[0]).toMatchObject({
      kind: "CONFLICT",
      priority: "P1",
      attemptId: "attempt-1",
    });
    expect(harness.cases[0]?.slaDueAt.toISOString()).toBe("2026-06-01T04:00:00.000Z");
  });

  test("a late success from EXPIRED opens a P2 LATE_SUCCESS case", async () => {
    const attempt = attemptRow({ status: "EXPIRED" });
    const harness = createEngine({
      attempt,
      executor: () => ({
        stepId: "verify",
        status: "SUCCEEDED" as const,
        response: {
          status: "SUCCESS",
          reference: "GW-1",
          amount: "100.0000",
          currency: "LYD",
          environment: "SANDBOX",
        },
        output: { state: {}, public: {} },
        logs: [],
      }),
    });

    const result = await harness.engine.inquire(attempt);

    expect(result.status).toBe("SUCCEEDED");
    expect(attempt.status).toBe("SUCCEEDED");
    expect(harness.cases).toHaveLength(1);
    expect(harness.cases[0]).toMatchObject({
      kind: "LATE_SUCCESS",
      priority: "P2",
      attemptId: "attempt-1",
    });
    expect(harness.cases[0]?.slaDueAt.toISOString()).toBe("2026-06-02T00:00:00.000Z");
    expect(result.settlement).toBe("NORMAL");
  });

  test("a transition is published on the attempt:transition topic", async () => {
    const attempt = attemptRow({ id: "attempt-transition-bus", status: "CREATED" });
    const harness = createEngine({ attempt, executor: () => ({ output: { state: {}, public: {} } }) });
    const events: Array<{ attemptId: string; status: string; substatus?: string }> = [];
    const unsubscribe = invalidationBus.subscribe(ATTEMPT_TRANSITION_TOPIC, (event) => {
      events.push(event.payload as { attemptId: string; status: string; substatus?: string });
    });

    try {
      await harness.engine.transition(attempt, "INITIATING", { substatus: "STARTED" });
    } finally {
      unsubscribe();
    }

    expect(events).toContainEqual({
      attemptId: "attempt-transition-bus",
      status: "INITIATING",
      substatus: "STARTED",
    });
  });

  test("opening the same operator case twice is idempotent", async () => {
    const rows: Array<Record<string, unknown>> = [];
    let sequence = 0;
    const client = {
      operatorCase: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          const where = args.where;
          const stateFilter = where.state as { in?: string[] } | undefined;
          return rows.find((row) =>
            row.attemptId === where.attemptId
            && row.kind === where.kind
            && Boolean(stateFilter?.in?.includes(String(row.state))),
          ) ?? null;
        },
        create: async (args: { data: Record<string, unknown> }) => {
          sequence += 1;
          const row = { id: `case-${sequence}`, ...args.data };
          rows.push(row);
          return row;
        },
      },
    } as unknown as PrismaLike;
    const sink = new PrismaOperatorCaseSink(client);
    const input: OperatorCaseOpenInput = {
      kind: "CONFLICT",
      priority: "P1",
      attemptId: "attempt-1",
      title: "Conflicting trusted signals",
      detail: "A conflict needs operator review.",
      slaDueAt: new Date("2026-06-01T04:00:00.000Z"),
    };

    const first = await sink.open(input);
    const second = await sink.open(input);

    expect(first).toEqual({ id: "case-1", created: true });
    expect(second).toEqual({ id: "case-1", created: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.priority).toBe("P1");
    expect(rows[0]?.state).toBe("OPEN");
  });
});
