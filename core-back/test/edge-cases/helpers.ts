import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import type {
  DynamicAttempt,
  DynamicRailEngineOptions,
  SlotCommitResult,
  SlotReservationStore,
} from "../../engine/flow/DynamicRailEngine";
import { DynamicRailEngine } from "../../engine/flow/DynamicRailEngine";
import type { FlowPhase } from "../../engine/flow/DynamicRailEngine";
import type { FlowStep, StepExecutionContext, StepExecutionResult } from "../../engine/flow/StepExecutor";
import type { PrismaLike, Repositories, Tx } from "../../engine/db/ports";
import { createFakeRepositories } from "../helpers/fakeRepositories";
import { PrismaRepositories } from "../../engine/db/repositories";
import { LedgerPoster } from "../../engine/ledger/LedgerPoster";
import { CryptoEngine } from "../../engine/crypto/CryptoEngine";
import { Vault } from "../../engine/crypto/Vault";
import type { GovernanceExecutionContext } from "../../engine/governance/GovernanceExecution";
import {
  createFakePrisma,
  fakeTable,
  resetFakeDatabase,
  type FakePrisma,
  type FakeRow,
} from "../helpers/governanceFake";

/* ------------------------------------------------------------------ *
 * Shipped artefacts
 * ------------------------------------------------------------------ */

export const readShipped = (relativePath: string): string =>
  readFileSync(join(import.meta.dir, "../..", relativePath), "utf8");

export const readMigrationSql = (): string =>
  readShipped("prisma/migrations/20261027000000_init/migration.sql");

export const readSource = (relativePath: string): string => readShipped(relativePath);

export const expectSql = (sql: string, ...fragments: string[]): void => {
  for (const fragment of fragments) {
    expect(sql.replace(/\s+/g, " ")).toContain(fragment.replace(/\s+/g, " "));
  }
};

/* ------------------------------------------------------------------ *
 * The universal rail engine
 * ------------------------------------------------------------------ */

export type Executor = (
  step: FlowStep,
  context: StepExecutionContext,
) => Promise<StepExecutionResult> | StepExecutionResult;

export interface EngineHarnessOptions {
  attempt?: Partial<DynamicAttempt>;
  steps?: Partial<Record<FlowPhase, FlowStep[]>>;
  executor?: Executor;
  ledger?: { entry: { id: string } };
  ledgerThrows?: Error;
  commit?: SlotCommitResult;
  transactionRunner?: DynamicRailEngineOptions["transactionRunner"];
  callbackVerifier?: DynamicRailEngineOptions["callbackVerifier"];
  callbackInbox?: DynamicRailEngineOptions["callbackInbox"];
  contextCipher?: DynamicRailEngineOptions["contextCipher"];
}

export interface EngineHarness {
  engine: DynamicRailEngine;
  attempt: DynamicAttempt;
  attempts: Map<string, DynamicAttempt>;
  reserved: string[];
  released: string[];
  committed: string[];
  stepsByPhase: Map<string, FlowStep[]>;
}

export const makeAttempt = (overrides: Partial<DynamicAttempt> = {}): DynamicAttempt => ({
  id: "attempt-1",
  reference: "PA-1",
  gatewayReference: "GW-1",
  status: "AWAITING_CUSTOMER",
  env: "SANDBOX",
  currency: "LYD",
  requestedAmount: "100.0000",
  totalChargedAmount: "100.0000",
  platformCommissionAmount: "3.0000",
  netMerchantAmount: "97.0000",
  maxOtpAttempts: 3,
  otpAttempts: 0,
  ownershipMode: "PLATFORM_CLEARING",
  context: {},
  ...overrides,
});

export const succeeded = (
  step: FlowStep,
  output: Partial<StepExecutionResult["output"]> = {},
): StepExecutionResult => ({
  stepId: step.id,
  status: "SUCCEEDED",
  output: { state: {}, public: {}, ...output },
  logs: [],
});

export const createEngineHarness = (options: EngineHarnessOptions = {}): EngineHarness => {
  const attempt = makeAttempt(options.attempt);
  const attempts = new Map<string, DynamicAttempt>([[attempt.id, attempt]]);
  const reserved: string[] = [];
  const released: string[] = [];
  const committed: string[] = [];
  const stepsByPhase = new Map<string, FlowStep[]>(
    Object.entries(options.steps ?? { SUBMIT: [{ id: "submit-step", type: "HTTP", side_effect: "MOVES_MONEY" }] }),
  );
  const executor: Executor = options.executor ?? ((step) => succeeded(step));

  const slots: SlotReservationStore = {
    reserveSlot: async (target) => {
      reserved.push(target.id);
      return { reservationId: `slot-${reserved.length}` };
    },
    releaseSlot: async (target) => {
      released.push(target.id);
    },
    commitSlot: async (target) => {
      committed.push(target.id);
      return options.commit ?? { outcome: "COMMITTED", journalEntryId: `entry-${target.id}` };
    },
  };

  const ledger = {
    postPaymentConfirmation: async () => {
      if (options.ledgerThrows) {
        throw options.ledgerThrows;
      }
      return options.ledger ?? { entry: { id: "entry-1" } };
    },
    postScenario: async () => {
      if (options.ledgerThrows) {
        throw options.ledgerThrows;
      }
      return options.ledger ?? { entry: { id: "entry-1" } };
    },
  };

  const engine = new DynamicRailEngine({
    attempts: {
      getAttempt: async (id) => attempts.get(id) ?? null,
      updateAttempt: async (id, patch) => {
        const target = attempts.get(id);
        if (!target) {
          throw new Error(`Unknown attempt '${id}'`);
        }
        Object.assign(target, patch);
        return target;
      },
    },
    slots,
    flowProvider: {
      getSteps: async (phase) => stepsByPhase.get(phase) ?? [],
    },
    stepExecutor: {
      execute: async (step: FlowStep, context: StepExecutionContext) => executor(step, context ?? {}),
    } as never,
    ledgerPoster: ledger,
    transactionRunner: options.transactionRunner,
    callbackVerifier: options.callbackVerifier,
    callbackInbox: options.callbackInbox,
    contextCipher: options.contextCipher,
    now: () => new Date("2026-06-01T00:00:00.000Z"),
  });

  return { engine, attempt, attempts, reserved, released, committed, stepsByPhase };
};

/* ------------------------------------------------------------------ *
 * Slot reservation store
 * ------------------------------------------------------------------ */

export interface SlotLinkRow {
  id: string;
  confirmed_count: number;
  active_locked_count: number;
  use_count: number;
  infinite_use: number;
  state: string;
}

export interface SlotHarness {
  client: PrismaLike;
  link: SlotLinkRow;
  statements: Array<{ sql: string; args: unknown[] }>;
  adjustments: FakeRow[];
  operatorCases: FakeRow[];
  entries: FakeRow[];
  lines: FakeRow[];
}

export const createSlotHarness = (overrides: Partial<SlotLinkRow> = {}): SlotHarness => {
  const link: SlotLinkRow = {
    id: "link-1",
    confirmed_count: 0,
    active_locked_count: 0,
    use_count: 1,
    infinite_use: 0,
    state: "PENDING",
    ...overrides,
  };
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const adjustments: FakeRow[] = [];
  const operatorCases: FakeRow[] = [];
  const entries: FakeRow[] = [];
  const lines: FakeRow[] = [];
  let sequence = 0;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const hasSlot = (): boolean =>
    link.infinite_use === 1
    || link.confirmed_count + link.active_locked_count < link.use_count;

  const client = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(client),
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      statements.push({ sql, args });
      if (sql.includes("FROM payment_links")) {
        return [{ ...link }];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      statements.push({ sql, args });
      if (sql.includes("active_locked_count = active_locked_count + 1")) {
        if (!hasSlot()) {
          return 0;
        }
        link.active_locked_count += 1;
        return 1;
      }
      if (sql.includes("confirmed_count = confirmed_count + 1")) {
        if (link.infinite_use !== 1 && link.confirmed_count + 1 > link.use_count) {
          return 0;
        }
        link.confirmed_count += 1;
        link.active_locked_count = Math.max(0, link.active_locked_count - 1);
        if (link.infinite_use === 0 && link.confirmed_count >= link.use_count) {
          link.state = "COMPLETED";
        }
        return 1;
      }
      if (sql.includes("active_locked_count = GREATEST")) {
        link.active_locked_count = Math.max(0, link.active_locked_count - 1);
        if (link.infinite_use === 0 && link.confirmed_count >= link.use_count) {
          link.state = "COMPLETED";
        }
        return 1;
      }
      return 0;
    },
    paymentAttempt: {
      findUnique: async () => ({ linkId: link.id }),
      update: async () => ({}),
    },
    glAccount: {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        args.where.accountType === "SUSPENSE"
          ? { id: "acc-suspense", accountType: "SUSPENSE", currency: "LYD" }
          : args.where.accountType === "GATEWAY_CLEARING"
            ? { id: "acc-clearing", accountType: "GATEWAY_CLEARING", currency: "LYD" }
            : args.where.accountType === "TREASURY"
              ? { id: "acc-treasury", accountType: "TREASURY", currency: "LYD" }
              : null,
    },
    journalEntry: {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        entries.find(
          (entry) => entry.refType === args.where.refType && entry.refId === args.where.refId,
        ) ?? null,
      create: async (args: { data: FakeRow }) => {
        const entry = { id: nextId("entry"), ...args.data };
        entries.push(entry);
        return entry;
      },
    },
    journalLine: {
      create: async (args: { data: FakeRow }) => {
        const row = { id: nextId("line"), ...args.data };
        lines.push(row);
        return row;
      },
    },
    adjustment: {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        adjustments.find(
          (row) => row.sourceAttemptId === args.where.sourceAttemptId && row.type === args.where.type,
        ) ?? null,
      create: async (args: { data: FakeRow }) => {
        const row = { id: nextId("adjustment"), ...args.data };
        adjustments.push(row);
        return row;
      },
    },
    operatorCase: {
      findFirst: async (args: { where: Record<string, unknown> }) =>
        operatorCases.find(
          (row) => row.attemptId === args.where.attemptId && row.kind === args.where.kind,
        ) ?? null,
      create: async (args: { data: FakeRow }) => {
        const row = { id: nextId("case"), ...args.data };
        operatorCases.push(row);
        return row;
      },
    },
  } as unknown as PrismaLike;

  return { client, link, statements, adjustments, operatorCases, entries, lines };
};

/* ------------------------------------------------------------------ *
 * Inbound callbacks
 * ------------------------------------------------------------------ */

export interface CallbackChannel {
  id: string;
  pathToken: string;
  gatewayVersionId: string;
  ipAllowlist: unknown;
  bodyFormat: string;
  timestampToleranceSec: number;
  correlationSelector: string;
  timestampSelector: string | null;
  verifyMethod: string;
  signatureHeader: string;
  eventMap: Record<string, string>;
  mustInquire: boolean;
  cryptoProfile: Record<string, unknown> | null;
  ackStatus: number;
  ackBodyTemplate: string | null;
}

export interface CallbackAttempt {
  id: string;
  reference: string;
  providerReference: string | null;
  networkReference: string | null;
  gatewayReference: string | null;
  env: string;
  credentialSetId: string;
}

export interface CallbackHarness {
  client: PrismaLike;
  channel: CallbackChannel;
  attempt: CallbackAttempt;
  queries: Array<Record<string, unknown>>;
}

export const createCallbackHarness = (options: {
  channel?: Partial<CallbackChannel>;
  attempt?: Partial<CallbackAttempt>;
  secrets?: Array<{ key: string; type: string; value: string; isSecret: boolean; secretVersion?: number }>;
} = {}): CallbackHarness => {
  const channel: CallbackChannel = {
    id: "channel-1",
    pathToken: "moamalat/live/token-1",
    gatewayVersionId: "version-1",
    ipAllowlist: [],
    bodyFormat: "JSON",
    timestampToleranceSec: 300,
    correlationSelector: "reference",
    timestampSelector: "timestamp",
    verifyMethod: "HMAC_BODY",
    signatureHeader: "x-signature",
    eventMap: { "00": "SUCCESS", "05": "FAILED" },
    mustInquire: false,
    cryptoProfile: {
      algorithm: "HMAC_SHA256",
      secretKeyEncoding: "UTF8",
      outputEncoding: "HEX_LOWER",
      canonicalizationMode: "RAW_BODY",
    },
    ackStatus: 200,
    ackBodyTemplate: null,
    ...options.channel,
  };
  const attempt: CallbackAttempt = {
    id: "attempt-1",
    reference: "PA-1",
    providerReference: "PROV-1",
    networkReference: null,
    gatewayReference: "GW-1",
    env: "LIVE",
    credentialSetId: "cred-1",
    ...options.attempt,
  };
  const queries: Array<Record<string, unknown>> = [];
  const secrets = options.secrets ?? [
    { key: "webhook", type: "HEADER", value: "secret", isSecret: false, secretVersion: 1 },
  ];

  const client = {
    confirmationChannel: {
      findUnique: async (args: { where: { pathToken: string } }) => {
        queries.push(args);
        return args.where.pathToken === channel.pathToken
          ? { ...channel, cryptoProfile: channel.cryptoProfile, gatewayVersion: { id: channel.gatewayVersionId } }
          : null;
      },
    },
    paymentAttempt: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        queries.push(args);
        const branches = (args.where.OR as Array<Record<string, unknown>> | undefined) ?? [];
        for (const branch of branches) {
          if (branch.reference !== undefined && branch.reference === attempt.reference) {
            return attempt;
          }
          if (branch.providerReference !== undefined && branch.providerReference === attempt.providerReference) {
            return attempt;
          }
          if (branch.networkReference !== undefined && branch.networkReference === attempt.networkReference) {
            return attempt;
          }
          if (branch.gatewayReference !== undefined && branch.gatewayReference === attempt.gatewayReference) {
            return attempt;
          }
        }
        return null;
      },
    },
    credentialSet: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === attempt.credentialSetId
          ? { id: attempt.credentialSetId, entriesCiphertext: secrets }
          : null,
    },
  } as unknown as PrismaLike;

  return { client, channel, attempt, queries };
};

export const signCallback = (
  secret: string,
  rawBody: string,
  algorithm: "HMAC_SHA256" | "HMAC_SHA512" = "HMAC_SHA256",
): string => {
  const crypto = new CryptoEngine();
  return algorithm === "HMAC_SHA512"
    ? crypto.hmacSha512(secret, rawBody)
    : crypto.hmacSha256(secret, rawBody);
};

/* ------------------------------------------------------------------ *
 * Governance fixture
 * ------------------------------------------------------------------ */

export interface GovernanceFixture {
  client: FakePrisma;
  context: GovernanceExecutionContext;
  repositories: Repositories;
}

export const createGovernanceFixture = (): GovernanceFixture => {
  resetFakeDatabase();
  const client = createFakePrisma();
  const repositories = new PrismaRepositories(client as never);
  const ledgerPoster = new LedgerPoster(client as never);

  const tableDelegate = (name: string) => {
    const matches = (row: FakeRow, where: Record<string, unknown>): boolean =>
      Object.entries(where).every(([key, value]) => row[key] === value);
    return {
      findUnique: async (args: { where?: Record<string, unknown> } = {}) =>
        fakeTable(name).find((row) => matches(row, args.where ?? {})) ?? null,
      findFirst: async (args: { where?: Record<string, unknown> } = {}) =>
        fakeTable(name).find((row) => matches(row, args.where ?? {})) ?? null,
      findMany: async (args: { where?: Record<string, unknown> } = {}) =>
        fakeTable(name).filter((row) => matches(row, args.where ?? {})),
    };
  };
  // The governance refund path reads the pinned rail (capabilities and refund
  // window) through the transaction client. The fake Prisma client has no
  // delegate for those catalog tables, so attach in-memory ones here.
  client.rail = tableDelegate("rail");
  client.railRoute = tableDelegate("railRoute");

  const account = (id: string, accountType: string, extra: FakeRow = {}): void => {
    fakeTable("glAccount").push({ id, accountType, currency: "LYD", ...extra });
  };
  account("acc-treasury", "TREASURY");
  account("acc-clearing", "GATEWAY_CLEARING");
  account("acc-wallet", "MERCHANT_WALLET", { ownerId: "merchant-1" });
  account("acc-income", "PLATFORM_INCOME");
  account("acc-aml-hold", "AML_HOLD");
  account("acc-chargeback", "CHARGEBACK_RESERVE");
  account("acc-gateway-fee", "GATEWAY_FEE_EXPENSE");
  account("acc-gateway-accrual", "GATEWAY_FEE_ACCRUAL");
  account("acc-suspense", "SUSPENSE");

  const user = (id: string, role: string): void => {
    fakeTable("user").push({
      id,
      email: `${id}@payment-gateway.internal`,
      role,
      authoritiesMap: {},
      appScopeIds: [],
      isMaker: true,
      isChecker: true,
      mfaRequired: false,
      status: "ACTIVE",
    });
  };
  user("user-maker", "COMPLIANCE");
  user("user-checker", "MLRO");
  user("user-finance", "FINANCE");

  fakeTable("merchant").push({
    id: "merchant-1",
    legalName: "Merchant One",
    tradeName: "Merchant One",
    status: "ACTIVE",
    kybStatus: "VERIFIED",
    riskTier: "STANDARD",
    onboardingChannel: "DIRECT",
    country: "LY",
    negativeBalanceCeiling: new Decimal(0),
    activatedAt: new Date(),
  });
  fakeTable("wallet").push({
    id: "wallet-1",
    merchantId: "merchant-1",
    glAccountId: "acc-wallet",
    currency: "LYD",
    status: "ACTIVE",
  });
  fakeTable("paymentAttempt").push({
    id: "attempt-1",
    reference: "PA-0001",
    merchantId: "merchant-1",
    applicationId: "app-1",
    currency: "LYD",
    env: "LIVE",
    status: "SUCCEEDED",
    totalChargedAmount: new Decimal(100),
    platformCommissionAmount: new Decimal(3),
    netMerchantAmount: new Decimal(97),
    settlementTarget: "PLATFORM_CLEARING",
    gatewayVersionId: "version-1",
  });
  fakeTable("gatewayVersion").push({ id: "version-1", gatewayId: "gateway-1", state: "LIVE" });
  fakeTable("gateway").push({ id: "gateway-1", code: "moamalat", kind: "DIRECT" });

  fakeTable("journalEntry").push({
    id: "settlement-entry",
    refType: "PAYMENT_ATTEMPT",
    refId: "attempt-0",
    description: "Settled payment",
  });
  fakeTable("journalLine").push({
    id: "settlement-line",
    entryId: "settlement-entry",
    glAccountId: "acc-wallet",
    direction: "CREDIT",
    amount: new Decimal(1000),
  });

  return {
    client,
    repositories,
    context: { ledgerPoster, repositories },
  };
};

/* ------------------------------------------------------------------ *
 * Reconciliation fixture
 * ------------------------------------------------------------------ */

export interface ReconciliationAttempt {
  id: string;
  reference: string;
  providerReference?: string | null;
  totalChargedAmount?: unknown;
  settledAmount?: unknown;
  gatewayFeeAmount?: unknown;
  status?: string;
}

export interface ReconciliationHarness {
  db: PrismaLike;
  repositories: Repositories;
  sources: Map<string, Record<string, unknown>>;
  runs: FakeRow[];
  items: FakeRow[];
  attempts: ReconciliationAttempt[];
}

export const createReconciliationHarness = (options: {
  parserConfig?: Record<string, unknown>;
  attempts?: ReconciliationAttempt[];
} = {}): ReconciliationHarness => {
  const sources = new Map<string, Record<string, unknown>>([
    [
      "source-1",
      {
        id: "source-1",
        gatewayId: "gateway-1",
        parserConfig: options.parserConfig ?? {
          format: "CSV",
          headerRow: true,
          columnsMap: {
            ourReference: "our_reference",
            providerReference: "provider_reference",
            amount: "amount",
            fee: "fee",
            currency: "currency",
            occurredAt: "occurred_at",
            type: "type",
          },
          dateFormat: "YYYYMMDD",
        },
        settlementLagDays: 0,
      },
    ],
  ]);
  const runs: FakeRow[] = [];
  const items: FakeRow[] = [];
  const attempts = options.attempts ?? [];
  let sequence = 0;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const db = {
    $transaction: async <R>(callback: (tx: Tx) => Promise<R>) => callback(db as unknown as Tx),
    $queryRawUnsafe: async () => [],
    $executeRawUnsafe: async () => 0,
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
  } as unknown as PrismaLike;

  const repositories = createFakeRepositories({
    reconciliation: {
      findStatementSourceById: async (_tx, id) => (sources.get(id) as never) ?? null,
      findRunByFileHash: async (_tx, fileHash) =>
        (runs.find((run) => run.fileHash === fileHash) as never) ?? null,
      findRunById: async (_tx, id) => (runs.find((run) => run.id === id) as never) ?? null,
      createRun: async (_tx, data) => {
        const run = { id: nextId("run"), ingestedAt: null, ...data };
        runs.push(run);
        return run as never;
      },
      markRunIngested: async (_tx, id, stats) => {
        const run = runs.find((entry) => entry.id === id);
        if (!run || run.ingestedAt) {
          return false;
        }
        run.ingestedAt = new Date();
        run.statsJson = stats;
        return true;
      },
      createItem: async (_tx, data) => {
        const item = { id: nextId("item"), ...data };
        items.push(item);
        return item as never;
      },
      listItemsByRun: async (_tx, runId) =>
        items.filter((item) => item.runId === runId) as never,
    },
    payments: {
      findAttemptByReference: async (_tx, reference) =>
        (attempts.find((attempt) => attempt.reference === reference) as never) ?? null,
      findAttemptByProviderReference: async (_tx, providerReference) =>
        (attempts.find((attempt) => attempt.providerReference === providerReference) as never) ?? null,
      listSettledAttemptsInWindow: async () => attempts as never,
    },
  });

  return { db, repositories, sources, runs, items, attempts };
};

/* ------------------------------------------------------------------ *
 * Raw SQL recorder for workers
 * ------------------------------------------------------------------ */

export interface SqlCall {
  kind: "query" | "execute";
  sql: string;
  args: unknown[];
}

export const createRecordingDb = (options: {
  queryRows?: unknown[];
  executeResult?: number;
  onQuery?: (sql: string, args: unknown[]) => unknown[] | undefined;
  onExecute?: (sql: string, args: unknown[]) => number | undefined;
} = {}): { db: PrismaLike; calls: SqlCall[] } => {
  const calls: SqlCall[] = [];
  const db = {
    $transaction: async <R>(callback: (tx: Tx) => Promise<R>) => callback(db as unknown as Tx),
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      calls.push({ kind: "query", sql, args });
      return options.onQuery?.(sql, args) ?? options.queryRows ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      calls.push({ kind: "execute", sql, args });
      return options.onExecute?.(sql, args) ?? options.executeResult ?? 1;
    },
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
  } as unknown as PrismaLike;
  return { db, calls };
};

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

export const money = (value: string): Decimal => new Decimal(value);

export const amountOf = (row: FakeRow | undefined): string =>
  row === undefined ? "" : new Decimal(String(row.amount)).toFixed(4);

export const vaultWith = (): Vault => new Vault({ masterKey: Buffer.alloc(32, 7) });

export const insertWalletBalance = (client: FakePrisma, amount: string): void => {
  const entryId = `wallet-balance-${fakeTable("journalEntry").length + 1}`;
  fakeTable("journalEntry").push({
    id: entryId,
    refType: "PAYMENT_ATTEMPT",
    refId: entryId,
    description: "Wallet balance",
  });
  fakeTable("journalLine").push({
    id: `wallet-balance-line-${fakeTable("journalLine").length + 1}`,
    entryId,
    glAccountId: "acc-wallet",
    direction: "CREDIT",
    amount: new Decimal(amount),
  });
};

export const seedAdjustment = (
  client: FakePrisma,
  overrides: FakeRow = {},
): FakeRow => {
  const row: FakeRow = {
    id: "adjustment-1",
    type: "REFUND",
    targetGlAccountId: "acc-wallet",
    sourceAttemptId: "attempt-1",
    draftedBySystem: false,
    amount: new Decimal(10),
    reverseCommission: true,
    reason: "test adjustment",
    state: "PENDING_REVIEW",
    ...overrides,
  };
  fakeTable("adjustment").push(row);
  return row;
};
