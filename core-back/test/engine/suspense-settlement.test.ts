import { describe, expect, test } from "bun:test";
import type { PrismaLike } from "../../engine/db/ports";
import type {
  DynamicAttempt,
  DynamicRailEngineOptions,
  SlotCommitResult,
} from "../../engine/flow/DynamicRailEngine";
import { DynamicRailEngine } from "../../engine/flow/DynamicRailEngine";
import { buildLedgerTemplate, decimal } from "../../engine/ledger/LedgerPoster";
import { PrismaSlotReservationStore } from "../../engine/runtime/slotStore";

interface LinkRow {
  id: string;
  confirmed_count: number;
  active_locked_count: number;
  use_count: number;
  infinite_use: number;
  state: string;
}

interface GlAccountRow {
  id: string;
  accountType: string;
  ownerId?: string | null;
  gatewayId?: string | null;
  credentialSetId?: string | null;
  env?: string | null;
  currency: string;
  checkpointBalance?: string;
  checkpointAt?: Date | null;
}

interface EntryRow {
  id: string;
  refType: string;
  refId: string;
  description: string;
}

interface LineRow {
  id: string;
  entryId: string;
  glAccountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
}

interface AdjustmentRow {
  id: string;
  type: string;
  targetGlAccountId: string;
  sourceAttemptId: string;
  draftedBySystem: boolean;
  amount: string;
  reverseCommission: boolean;
  reason: string;
  state: string;
}

interface OperatorCaseRow {
  id: string;
  attemptId: string;
  kind: string;
  priority: string;
  state: string;
  slaDueAt: Date;
  resolutionNotes: string;
}

interface SlotState {
  link: LinkRow;
  accounts: GlAccountRow[];
  entries: EntryRow[];
  lines: LineRow[];
  adjustments: AdjustmentRow[];
  cases: OperatorCaseRow[];
}

const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (value === null) {
      return row[key] === null || row[key] === undefined;
    }
    return row[key] === value;
  });

const createSlotClient = (options: {
  link?: Partial<LinkRow>;
  failCommitOnce?: boolean;
} = {}): { client: PrismaLike; state: SlotState } => {
  const state: SlotState = {
    link: {
      id: "link-1",
      confirmed_count: 0,
      active_locked_count: 1,
      use_count: 1,
      infinite_use: 0,
      state: "PENDING",
      ...options.link,
    },
    accounts: [
      {
        id: "acc-clearing",
        accountType: "GATEWAY_CLEARING",
        currency: "LYD",
        checkpointBalance: "0.0000",
      },
      {
        id: "acc-treasury",
        accountType: "TREASURY",
        currency: "LYD",
        checkpointBalance: "0.0000",
      },
      {
        id: "acc-suspense",
        accountType: "SUSPENSE",
        currency: "LYD",
        checkpointBalance: "0.0000",
      },
    ],
    entries: [],
    lines: [],
    adjustments: [],
    cases: [],
  };
  let sequence = 0;
  let failCommitOnce = options.failCommitOnce === true;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const client = {
    glAccount: {
      findFirst: async (args: {
        where: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) => {
        const found = state.accounts.find((account) =>
          matches(account as unknown as Record<string, unknown>, args.where),
        );
        return found ? { id: found.id } : null;
      },
      findUnique: async (args: { where: { id: string } }) =>
        state.accounts.find((account) => account.id === args.where.id) ?? null,
    },
    journalEntry: {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        state.entries.find(
          (entry) =>
            entry.refType === args.where.refType && entry.refId === args.where.refId,
        ) ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        const entry: EntryRow = {
          id: nextId("entry"),
          refType: String(args.data.refType),
          refId: String(args.data.refId),
          description: String(args.data.description ?? ""),
        };
        state.entries.push(entry);
        return entry;
      },
    },
    journalLine: {
      create: async (args: { data: Record<string, unknown> }) => {
        const line: LineRow = {
          id: nextId("line"),
          entryId: String(args.data.entryId),
          glAccountId: String(args.data.glAccountId),
          direction: args.data.direction as "DEBIT" | "CREDIT",
          amount: String(args.data.amount),
        };
        state.lines.push(line);
        return line;
      },
    },
    adjustment: {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        state.adjustments.find((adjustment) =>
          matches(adjustment as unknown as Record<string, unknown>, args.where),
        ) ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        const adjustment: AdjustmentRow = {
          id: nextId("adjustment"),
          type: String(args.data.type),
          targetGlAccountId: String(args.data.targetGlAccountId),
          sourceAttemptId: String(args.data.sourceAttemptId),
          draftedBySystem: args.data.draftedBySystem === true,
          amount: String(args.data.amount),
          reverseCommission: args.data.reverseCommission === true,
          reason: String(args.data.reason),
          state: String(args.data.state),
        };
        state.adjustments.push(adjustment);
        return adjustment;
      },
    },
    operatorCase: {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        state.cases.find((operatorCase) =>
          matches(operatorCase as unknown as Record<string, unknown>, args.where),
        ) ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        const operatorCase: OperatorCaseRow = {
          id: nextId("case"),
          attemptId: String(args.data.attemptId),
          kind: String(args.data.kind),
          priority: String(args.data.priority),
          state: String(args.data.state),
          slaDueAt: args.data.slaDueAt as Date,
          resolutionNotes: String(args.data.resolutionNotes),
        };
        state.cases.push(operatorCase);
        return operatorCase;
      },
    },
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes("FROM payment_links")) {
        return [{ ...state.link }];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string) => {
      if (sql.includes("confirmed_count = confirmed_count + 1")) {
        const overCapacity =
          state.link.infinite_use !== 1
          && state.link.confirmed_count + 1 > state.link.use_count;
        if (overCapacity) {
          return 0;
        }
        state.link.confirmed_count += 1;
        state.link.active_locked_count = Math.max(0, state.link.active_locked_count - 1);
        if (state.link.infinite_use === 0 && state.link.confirmed_count >= state.link.use_count) {
          state.link.state = "COMPLETED";
        }
        if (failCommitOnce) {
          failCommitOnce = false;
          throw new Error("forced slot commit failure");
        }
        return 1;
      }
      if (sql.includes("active_locked_count = GREATEST")) {
        state.link.active_locked_count = Math.max(0, state.link.active_locked_count - 1);
        if (state.link.infinite_use === 0 && state.link.confirmed_count >= state.link.use_count) {
          state.link.state = "COMPLETED";
        }
        return 1;
      }
      return 0;
    },
  } as unknown as PrismaLike;

  return { client, state };
};

const attemptRow = (overrides: Partial<DynamicAttempt> = {}): DynamicAttempt => ({
  id: "attempt-duplicate",
  reference: "PA-DUP-1",
  gatewayReference: "GW-DUP-1",
  status: "EXPIRED",
  env: "SANDBOX",
  currency: "LYD",
  requestedAmount: "100.0000",
  totalChargedAmount: "100.0000",
  platformCommissionAmount: "3.0000",
  netMerchantAmount: "97.0000",
  merchantId: "merchant-1",
  gatewayId: "gateway-1",
  credentialSetId: "cred-1",
  linkId: "link-1",
  ownershipMode: "PLATFORM_CLEARING",
  context: {},
  ...overrides,
});

const amountOf = (value: unknown): string => decimal(value as never).toFixed(4);

describe("SUSPENSE settlement template", () => {
  test("debits clearing and credits SUSPENSE for a platform-held settlement", () => {
    const template = buildLedgerTemplate("SUSPENSE_SETTLEMENT", {
      amount: "100.0000",
      ownershipMode: "PLATFORM_CLEARING",
    });
    const byAccount = new Map(template.lines.map((line) => [line.account.accountType, line]));
    expect(byAccount.get("GATEWAY_CLEARING")?.direction).toBe("DEBIT");
    expect(amountOf(byAccount.get("GATEWAY_CLEARING")?.amount)).toBe("100.0000");
    expect(byAccount.get("SUSPENSE")?.direction).toBe("CREDIT");
    expect(amountOf(byAccount.get("SUSPENSE")?.amount)).toBe("100.0000");
  });

  test("debits treasury instead of clearing for an internal settlement", () => {
    const template = buildLedgerTemplate("SUSPENSE_SETTLEMENT", {
      amount: "100.0000",
      ownershipMode: "INTERNAL",
    });
    const byAccount = new Map(template.lines.map((line) => [line.account.accountType, line]));
    expect(byAccount.get("TREASURY")?.direction).toBe("DEBIT");
    expect(byAccount.get("GATEWAY_CLEARING")).toBeUndefined();
    expect(byAccount.get("SUSPENSE")?.direction).toBe("CREDIT");
  });
});

describe("slot commit and SUSPENSE", () => {
  test("a duplicate settlement on a single-use link posts to SUSPENSE, drafts the refund and opens a P1 case", async () => {
    const { client, state } = createSlotClient({
      link: { confirmed_count: 1, active_locked_count: 0, use_count: 1, state: "COMPLETED" },
    });
    const store = new PrismaSlotReservationStore(client);
    const result = await store.commitSlot(attemptRow());

    expect(result).toBeDefined();
    expect((result as SlotCommitResult).outcome).toBe("SUSPENSE");
    // The CHECK invariant is not violated and the counters did not move.
    expect(state.link.confirmed_count).toBe(1);
    expect(state.link.active_locked_count).toBe(0);
    expect(state.link.confirmed_count + state.link.active_locked_count)
      .toBeLessThanOrEqual(state.link.use_count);
    expect(state.link.state).toBe("COMPLETED");

    // The money is in SUSPENSE, not in a merchant wallet.
    const accountOf = (id: string): string =>
      state.accounts.find((account) => account.id === id)?.accountType ?? id;
    const legs = state.lines.map((line) => ({
      type: accountOf(line.glAccountId),
      direction: line.direction,
      amount: amountOf(line.amount),
    }));
    expect(legs).toContainEqual({ type: "GATEWAY_CLEARING", direction: "DEBIT", amount: "100.0000" });
    expect(legs).toContainEqual({ type: "SUSPENSE", direction: "CREDIT", amount: "100.0000" });
    expect(legs.some((leg) => leg.type === "MERCHANT_WALLET")).toBe(false);

    expect(state.adjustments).toHaveLength(1);
    const adjustment = state.adjustments[0];
    expect(adjustment?.type).toBe("REFUND");
    expect(adjustment?.state).toBe("PENDING_REVIEW");
    expect(adjustment?.draftedBySystem).toBe(true);
    expect(adjustment?.sourceAttemptId).toBe("attempt-duplicate");
    expect(adjustment?.targetGlAccountId).toBe("acc-suspense");
    expect(amountOf(adjustment?.amount)).toBe("100.0000");

    expect(state.cases).toHaveLength(1);
    expect(state.cases[0]?.priority).toBe("P1");
    expect(state.cases[0]?.state).toBe("OPEN");
    expect(state.cases[0]?.attemptId).toBe("attempt-duplicate");
  });

  test("the duplicate path is idempotent", async () => {
    const { client, state } = createSlotClient({
      link: { confirmed_count: 1, active_locked_count: 0, use_count: 1, state: "COMPLETED" },
    });
    const store = new PrismaSlotReservationStore(client);
    await store.commitSlot(attemptRow());
    await store.commitSlot(attemptRow());

    expect(state.entries).toHaveLength(1);
    expect(state.adjustments).toHaveLength(1);
    expect(state.cases).toHaveLength(1);
    expect(state.link.confirmed_count).toBe(1);
  });

  test("the happy path still advances the slot and completes the link", async () => {
    const { client, state } = createSlotClient({
      link: { confirmed_count: 0, active_locked_count: 1, use_count: 1, state: "PENDING" },
    });
    const store = new PrismaSlotReservationStore(client);
    const result = await store.commitSlot(attemptRow());

    expect((result as SlotCommitResult).outcome).toBe("COMMITTED");
    expect(state.link.confirmed_count).toBe(1);
    expect(state.link.active_locked_count).toBe(0);
    expect(state.link.state).toBe("COMPLETED");
    expect(state.entries).toHaveLength(0);
    expect(state.adjustments).toHaveLength(0);
  });

  test("a multi-use link keeps its state until the last confirmed slot", async () => {
    const { client, state } = createSlotClient({
      link: { confirmed_count: 0, active_locked_count: 1, use_count: 2, state: "PENDING" },
    });
    const store = new PrismaSlotReservationStore(client);
    await store.commitSlot(attemptRow());

    expect(state.link.confirmed_count).toBe(1);
    expect(state.link.active_locked_count).toBe(0);
    expect(state.link.state).toBe("PENDING");
  });
});

describe("atomic slot commit and ledger posting", () => {
  const engineFor = (options: {
    failCommit?: boolean;
    failLedger?: boolean;
    link?: Partial<LinkRow>;
  }) => {
    const { client, state } = createSlotClient({
      ...(options.link ? { link: options.link } : {}),
      ...(options.failCommit ? { failCommitOnce: true } : {}),
    });
    const attempts = new Map<string, DynamicAttempt>();
    const attempt = attemptRow({ status: "AWAITING_CUSTOMER" });
    attempts.set(attempt.id, attempt);
    const attemptsRepository = {
      getAttempt: async (id: string) => attempts.get(id) ?? null,
      updateAttempt: async (id: string, patch: Partial<DynamicAttempt>) => {
        const current = attempts.get(id);
        if (!current) {
          throw new Error("attempt not found");
        }
        Object.assign(current, patch);
        return current;
      },
    };
    const entries: EntryRow[] = [];
    const ledgerPoster = {
      postPaymentConfirmation: async (refId: string) => {
        if (options.failLedger) {
          throw new Error("forced ledger failure");
        }
        const entry: EntryRow = {
          id: `posted-${refId}`,
          refType: "PAYMENT_ATTEMPT",
          refId,
          description: "confirmation",
        };
        entries.push(entry);
        return { entry };
      },
      postScenario: async () => ({ entry: { id: "scenario" } }),
    };
    const transactionRunner = async <R>(callback: (transaction: unknown) => Promise<R>): Promise<R> => {
      const snapshot = {
        link: { ...state.link },
        attempts: [...attempts.entries()].map(([id, value]) => [id, { ...value }] as const),
        entries: [...entries],
        stateEntries: [...state.entries],
        adjustments: [...state.adjustments],
        cases: [...state.cases],
        lines: [...state.lines],
      };
      try {
        return await callback(client);
      } catch (error) {
        state.link = snapshot.link;
        attempts.clear();
        for (const [id, value] of snapshot.attempts) {
          attempts.set(id, value);
        }
        entries.splice(0, entries.length, ...snapshot.entries);
        state.entries = snapshot.stateEntries;
        state.adjustments = snapshot.adjustments;
        state.cases = snapshot.cases;
        state.lines = snapshot.lines;
        throw error;
      }
    };
    const engineOptions: DynamicRailEngineOptions = {
      attempts: attemptsRepository,
      slots: new PrismaSlotReservationStore(client),
      flowProvider: {
        getSteps: async (phase: string) =>
          phase === "SUBMIT" ? [{ id: "submit", type: "HTTP", side_effect: "MOVES_MONEY" }] : [],
      },
      stepExecutor: { execute: async () => ({ output: { state: {}, public: {} } }) } as never,
      ledgerPoster,
      transactionRunner,
    };
    return { engine: new DynamicRailEngine(engineOptions), state, attempts, entries, attempt };
  };

  const successExecutor = {
    execute: async () => ({
      stepId: "submit",
      status: "SUCCEEDED" as const,
      response: {
        status: "SUCCESS",
        reference: "GW-DUP-1",
        amount: "100.0000",
        currency: "LYD",
        environment: "SANDBOX",
      },
      output: { state: {}, public: {} },
      logs: [],
    }),
  };

  test("a slot commit failure rolls the counters, the journal entry and the status back", async () => {
    const harness = engineFor({
      failCommit: true,
      link: { confirmed_count: 0, active_locked_count: 1, use_count: 1, state: "PENDING" },
    });
    const engine = new DynamicRailEngine({
      ...(harness.engine as never as { options: DynamicRailEngineOptions }).options,
      stepExecutor: successExecutor as never,
    });

    await expect(engine.confirm(harness.attempt, { otp: "123456" })).rejects.toThrow(
      "forced slot commit failure",
    );

    expect(harness.state.link.confirmed_count).toBe(0);
    expect(harness.state.link.active_locked_count).toBe(1);
    expect(harness.state.link.state).toBe("PENDING");
    expect(harness.entries).toHaveLength(0);
    // The final transaction rolled the SUCCEEDED status back; the earlier
    // AUTHORIZING transition is outside it.
    expect(harness.attempt.status).not.toBe("SUCCEEDED");
    expect(harness.attempt.ledgerEntryId).toBeUndefined();
  });

  test("a ledger failure after the slot decision rolls the counters back", async () => {
    const harness = engineFor({
      failLedger: true,
      link: { confirmed_count: 0, active_locked_count: 1, use_count: 1, state: "PENDING" },
    });
    const engine = new DynamicRailEngine({
      ...(harness.engine as never as { options: DynamicRailEngineOptions }).options,
      stepExecutor: successExecutor as never,
    });

    await expect(engine.confirm(harness.attempt, { otp: "123456" })).rejects.toThrow(
      "forced ledger failure",
    );

    expect(harness.state.link.confirmed_count).toBe(0);
    expect(harness.state.link.active_locked_count).toBe(1);
    expect(harness.entries).toHaveLength(0);
    expect(harness.attempt.status).not.toBe("SUCCEEDED");
  });

  test("a duplicate settlement is reported as SUSPENSE, not as a normal success", async () => {
    const harness = engineFor({
      link: { confirmed_count: 1, active_locked_count: 0, use_count: 1, state: "COMPLETED" },
    });
    const engine = new DynamicRailEngine({
      ...(harness.engine as never as { options: DynamicRailEngineOptions }).options,
      stepExecutor: successExecutor as never,
    });

    const result = await engine.confirm(harness.attempt, { otp: "123456" });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.settlement).toBe("SUSPENSE");
    expect(result.substatus).toBe("SUSPENSE_SETTLEMENT");
    expect(result.canonicalError).toBe("SLOT_ALREADY_SETTLED_SUSPENSE");
    expect(harness.state.link.confirmed_count).toBe(1);
    expect(harness.entries).toHaveLength(0);
    expect(harness.state.entries).toHaveLength(1);
    expect(harness.state.adjustments).toHaveLength(1);
    expect(harness.state.cases[0]?.priority).toBe("P1");
    expect(harness.attempt.status).toBe("SUCCEEDED");
    expect(harness.attempt.ledgerEntryId).toBe(harness.state.entries[0]?.id);
  });
});
