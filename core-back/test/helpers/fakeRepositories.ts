import type {
  AmlCaseRow,
  AmlScreeningMatchRow,
  AmlScreeningRow,
  BeneficialOwnerRow,
  JoinRequestRow,
  MerchantRow,
  PrismaLike,
  Repositories,
  Tx,
} from "../../engine/db/ports";

/**
 * The repositories of a test that never touches a database.
 *
 * Every port is implemented, so a test can inject the few ports it cares
 * about and leave the rest as inert stubs.
 */
export const emptyRepositories = (): Repositories => ({
  identity: {
    createUser: async () => { throw new Error("unused"); },
    findUserById: async () => null,
    findUserByEmail: async () => null,
    findUserByPhone: async () => null,
    createIdentity: async () => { throw new Error("unused"); },
    findIdentityByKind: async () => null,
    findIdentityByProviderSubject: async () => null,
    listIdentitiesByUser: async () => [],
    markIdentityVerified: async () => undefined,
  },
  merchants: {
    createMerchant: async () => { throw new Error("unused"); },
    findMerchantById: async () => null,
    findMerchantByApplication: async () => null,
    updateMerchant: async () => { throw new Error("unused"); },
    lockMerchantById: async () => null,
    findMerchantsByDuplicateSignals: async () => [],
    getWalletBalance: async () => 0n,
    getNegativeBalanceCeiling: async () => 0n,
  },
  onboarding: {
    createJoinRequest: async () => { throw new Error("unused"); },
    findJoinRequestById: async () => null,
    findOpenJoinRequestByMerchant: async () => null,
    listJoinRequests: async () => [],
    updateJoinRequest: async () => { throw new Error("unused"); },
    createKybDocument: async () => { throw new Error("unused"); },
    findKybDocumentById: async () => null,
    findKybDocumentsBySha256: async () => [],
    listKybDocumentsByMerchant: async () => [],
    updateKybDocument: async () => { throw new Error("unused"); },
    createBeneficialOwner: async () => { throw new Error("unused"); },
    findBeneficialOwnerById: async () => null,
    listBeneficialOwners: async () => [],
    updateBeneficialOwner: async () => { throw new Error("unused"); },
  },
  risk: {
    listActiveVelocityRules: async () => [],
    listActiveAmlRules: async () => [],
    findAmlRuleById: async () => null,
    createAmlRule: async () => { throw new Error("unused"); },
    listAmlRules: async () => [],
    createAmlCase: async () => { throw new Error("unused"); },
    findAmlCaseById: async () => null,
    listAmlCases: async () => [],
    updateAmlCase: async () => { throw new Error("unused"); },
    countOpenAmlCases: async () => 0,
    createScreening: async () => { throw new Error("unused"); },
    createScreeningMatch: async () => { throw new Error("unused"); },
    findScreeningById: async () => null,
    listScreenings: async () => [],
    listScreeningMatches: async () => [],
    findScreeningMatchById: async () => null,
    updateScreeningMatch: async () => { throw new Error("unused"); },
    listReportingRules: async () => [],
    createReportingRule: async () => { throw new Error("unused"); },
    listRegulatoryReports: async () => [],
    findRegulatoryReportById: async () => null,
    createRegulatoryReport: async () => { throw new Error("unused"); },
    updateRegulatoryReport: async () => { throw new Error("unused"); },
    createOperatorCase: async () => { throw new Error("unused"); },
  },
  payments: {
    lockLinkByKey: async () => null,
    findLinkByKey: async () => null,
    findLinkById: async () => null,
    updateLinkSlotCount: async () => undefined,
    resolveSettlementTarget: async () => "PLATFORM_CLEARING",
    createAttempt: async () => { throw new Error("unused"); },
    findAttemptById: async () => null,
    findAttemptByReference: async () => null,
    findAttemptByIdempotencyKey: async () => null,
    findAttemptByProviderReference: async () => null,
    updateAttempt: async () => { throw new Error("unused"); },
    collectWindowStats: async () => ({ count: 0, totalAmount: 0n, amounts: [] }),
    sumSucceededAmountByRouteInWindow: async () => new Map(),
    listSettledAttemptsInWindow: async () => [],
    listPollPolicies: async () => [],
    listRouteInquirySupport: async () => [],
  },
  disputes: {
    findDisputeByGatewayRef: async () => null,
    createDispute: async () => { throw new Error("unused"); },
    findDisputeById: async () => null,
    listDisputes: async () => [],
    updateDispute: async () => { throw new Error("unused"); },
    createAdjustment: async () => { throw new Error("unused"); },
    findAdjustmentById: async () => null,
    findAdjustmentByDispute: async () => null,
    listAdjustments: async () => [],
    updateAdjustment: async () => { throw new Error("unused"); },
    sumExecutedRefundsForAttempt: async () => 0n,
  },
  governance: {
    createApprovalRequest: async () => { throw new Error("unused"); },
    findApprovalRequestById: async () => null,
    listApprovalRequests: async () => [],
    updateApprovalRequest: async () => { throw new Error("unused"); },
    writeAuditLog: async () => undefined,
    getPlatformSetting: async () => null,
    listPlatformSettings: async () => [],
  },
  notifications: {
    findTemplate: async () => null,
    listTemplates: async () => [],
    enqueueNotification: async () => { throw new Error("unused"); },
    updateNotification: async () => { throw new Error("unused"); },
  },
  reconciliation: {
    findStatementSourceById: async () => null,
    listStatementSources: async () => [],
    findRunByFileHash: async () => null,
    createRun: async () => { throw new Error("unused"); },
    updateRunStats: async () => undefined,
    createItem: async () => { throw new Error("unused"); },
    listItemsByRun: async () => [],
  },
});

type RepositoryOverrides = {
  [K in keyof Repositories]?: Partial<Repositories[K]>;
};

export const createFakeRepositories = (overrides: RepositoryOverrides = {}): Repositories => {
  const base = emptyRepositories() as unknown as Record<string, Record<string, unknown>>;
  const output: Record<string, Record<string, unknown>> = { ...base };
  const patches = overrides as unknown as Record<string, Record<string, unknown>>;
  for (const key of Object.keys(patches)) {
    output[key] = { ...base[key], ...patches[key] };
  }
  return output as unknown as Repositories;
};

export interface FakeScreeningState {
  screenings: AmlScreeningRow[];
  matches: AmlScreeningMatchRow[];
  cases: AmlCaseRow[];
  joinRequests: JoinRequestRow[];
  merchants: MerchantRow[];
  owners: BeneficialOwnerRow[];
  auditLogs: Array<{ action: string; entityType: string; entityId: string; afterJson?: unknown }>;
}

export const createScreeningState = (): FakeScreeningState => ({
  screenings: [],
  matches: [],
  cases: [],
  joinRequests: [],
  merchants: [],
  owners: [],
  auditLogs: [],
});

let sequence = 0;
const nextId = (prefix: string): string => {
  sequence += 1;
  return `${prefix}-${sequence}`;
};

/**
 * The repositories of the screening layers, backed by an in-memory state.
 */
export const createScreeningRepositories = (
  state: FakeScreeningState,
  now: Date = new Date(),
): Repositories =>
  createFakeRepositories({
    merchants: {
      lockMerchantById: async (_tx: Tx, id: string) =>
        state.merchants.find((merchant) => merchant.id === id) ?? null,
      updateMerchant: async (_tx: Tx, id: string, patch: Partial<MerchantRow>) => {
        const merchant = state.merchants.find((entry) => entry.id === id);
        if (!merchant) {
          throw new Error(`Unknown merchant '${id}'`);
        }
        Object.assign(merchant, patch);
        return merchant;
      },
    },
    onboarding: {
      listBeneficialOwners: async (_tx: Tx, merchantId: string) =>
        state.owners.filter((owner) => owner.merchantId === merchantId),
      updateBeneficialOwner: async (_tx: Tx, id: string, patch: Partial<BeneficialOwnerRow>) => {
        const owner = state.owners.find((entry) => entry.id === id);
        if (!owner) {
          throw new Error(`Unknown beneficial owner '${id}'`);
        }
        Object.assign(owner, patch);
        return owner;
      },
      updateJoinRequest: async (_tx: Tx, id: string, patch: Partial<JoinRequestRow>) => {
        const joinRequest = state.joinRequests.find((entry) => entry.id === id);
        if (!joinRequest) {
          throw new Error(`Unknown join request '${id}'`);
        }
        Object.assign(joinRequest, patch);
        return joinRequest;
      },
    },
    risk: {
      createScreening: async (_tx: Tx, data: Partial<AmlScreeningRow>) => {
        const row = {
          id: nextId("screening"),
          listVersionsJson: {},
          matchCount: 0,
          highestScore: null,
          requestedAt: now,
          completedAt: null,
          ...data,
        } as AmlScreeningRow;
        state.screenings.push(row);
        return row;
      },
      createScreeningMatch: async (_tx: Tx, data: Partial<AmlScreeningMatchRow>) => {
        const row = {
          id: nextId("match"),
          disposition: "UNREVIEWED",
          dispositionBy: null,
          dispositionNotes: null,
          suppressFuture: false,
          suppressUntil: null,
          ...data,
        } as AmlScreeningMatchRow;
        state.matches.push(row);
        return row;
      },
      createAmlCase: async (_tx: Tx, data: Partial<AmlCaseRow>) => {
        const row = {
          id: nextId("case"),
          status: "OPEN",
          confidential: true,
          ...data,
        } as AmlCaseRow;
        state.cases.push(row);
        return row;
      },
      listScreenings: async (_tx: Tx, filter: { subjectId?: string; limit: number }) =>
        state.screenings
          .filter((row) => !filter.subjectId || row.subjectId === filter.subjectId)
          .sort((left, right) => right.requestedAt.getTime() - left.requestedAt.getTime())
          .slice(0, filter.limit),
      listAmlCases: async (_tx: Tx, filter: { subjectId?: string; limit: number }) =>
        state.cases
          .filter((row) => !filter.subjectId || row.subjectId === filter.subjectId)
          .slice(0, filter.limit),
    },
    governance: {
      writeAuditLog: async (
        _tx: Tx,
        data: { action: string; entityType: string; entityId: string; afterJson?: unknown },
      ) => {
        state.auditLogs.push({
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId,
          afterJson: data.afterJson,
        });
      },
    },
  });

export interface FakeDbOptions {
  /** The rows the `FOR UPDATE SKIP LOCKED` selection returns. */
  dueMerchants?: unknown[];
  /** The aggregated daily volume of the succeeded attempts. */
  dailyVolume?: unknown[];
  /** The rows of the model delegates, keyed by the model name. */
  models?: Record<string, unknown[]>;
}

export const createFakeDb = (options: FakeDbOptions = {}): PrismaLike => {
  const models = options.models ?? {};
  const delegate = (rows: unknown[]) => ({
    findMany: async () => rows,
    findFirst: async () => rows[0] ?? null,
    findUnique: async () => rows[0] ?? null,
    count: async () => rows.length,
  });
  const tx: Record<string, unknown> = {
    $transaction: async (callback: (inner: Tx) => Promise<unknown>) => callback(tx as unknown as Tx),
    $queryRaw: async (strings: TemplateStringsArray | string) => {
      const sql = typeof strings === "string" ? strings : strings.join("?");
      if (sql.includes("SUM(total_charged_amount)")) {
        return options.dailyVolume ?? [];
      }
      return [];
    },
    $executeRaw: async () => 0,
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes("FOR UPDATE SKIP LOCKED")) {
        return options.dueMerchants ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async () => 0,
  };
  for (const [name, rows] of Object.entries(models)) {
    tx[name] = delegate(rows);
  }
  return tx as unknown as PrismaLike;
};
