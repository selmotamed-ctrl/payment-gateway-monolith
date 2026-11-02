import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-route query budgets from the high-scale plan (Pillar 9).
 *
 * The map is intentionally explicit: a route that is not listed has no hard
 * budget, so enabling enforcement in CI can never fail unrelated endpoints.
 */
export const DEFAULT_QUERY_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  "GET /internal/checkout/pay/:linkKey": 4,
  "POST /internal/checkout/pay/:linkKey/initiate": 8,
  "POST /internal/checkout/pay/:linkKey/confirm": 8,
  "POST /internal/checkout/pay/:linkKey/logs/:attemptId/confirm": 8,
  "GET /internal/merchant/wallets/:id/balance": 2,
  "GET /internal/merchant/stats/overview": 2,
  "POST /internal/admin/search": 3,
  "GET /internal/admin/*": 3,
});

export const QUERY_BUDGETS = DEFAULT_QUERY_BUDGETS;
export const ROUTE_QUERY_BUDGETS = DEFAULT_QUERY_BUDGETS;

export interface QueryBudgetContext {
  route: string;
  budget: number;
  count: number;
  exceeded: boolean;
  reported: boolean;
  startedAt: number;
}

export interface QueryBudgetSnapshot {
  route: string;
  budget: number;
  count: number;
  exceeded: boolean;
  startedAt: number;
}

export interface QueryBudgetOptions {
  route: string;
  budget?: number;
  /** Override the test/CI detection for a single call. */
  enforce?: boolean;
  onExceeded?: (snapshot: QueryBudgetSnapshot) => void;
}

export class QueryBudgetExceededError extends Error {
  readonly code = "QUERY_BUDGET_EXCEEDED";
  readonly snapshot: QueryBudgetSnapshot;

  constructor(snapshot: QueryBudgetSnapshot) {
    super(
      `Query budget exceeded for ${snapshot.route}: ${snapshot.count} queries (budget ${snapshot.budget})`,
    );
    this.name = "QueryBudgetExceededError";
    this.snapshot = snapshot;
  }
}

const storage = new AsyncLocalStorage<QueryBudgetContext>();
const instrumentedClients = new WeakSet<object>();

const snapshotOf = (context: QueryBudgetContext): QueryBudgetSnapshot => ({
  route: context.route,
  budget: context.budget,
  count: context.count,
  exceeded: context.exceeded,
  startedAt: context.startedAt,
});

const isEnabledFlag = (value: string | undefined): boolean =>
  value === "1" || value === "true" || value === "yes";

/**
 * Enforcement is opt-in outside tests/CI and is never enabled implicitly in
 * production: missing a budget must not take a live payment switch down.
 */
export const queryBudgetEnforcementEnabled = (): boolean => {
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  if (process.env.NODE_ENV === "production") {
    return isEnabledFlag(process.env.QUERY_BUDGET_ENFORCE);
  }
  return isEnabledFlag(process.env.QUERY_BUDGET_ENFORCE) || isEnabledFlag(process.env.CI);
};

export const resolveQueryBudget = (route: string): number | undefined => {
  const direct = DEFAULT_QUERY_BUDGETS[route];
  if (direct !== undefined) {
    return direct;
  }
  for (const [pattern, budget] of Object.entries(DEFAULT_QUERY_BUDGETS)) {
    if (!pattern.endsWith("/*")) {
      continue;
    }
    const prefix = pattern.slice(0, -1);
    if (route.startsWith(prefix)) {
      return budget;
    }
  }
  return undefined;
};

export const recordQuery = (): void => {
  const context = storage.getStore();
  if (!context) {
    return;
  }
  context.count += 1;
  if (context.count > context.budget && !context.exceeded) {
    context.exceeded = true;
  }
};

export const currentQueryBudget = (): QueryBudgetSnapshot | undefined => {
  const context = storage.getStore();
  return context ? snapshotOf(context) : undefined;
};

export const getQueryCount = (): number => storage.getStore()?.count ?? 0;

/**
 * Runs work with query counting active. When enforcement is on (tests/CI),
 * the callback rejects after it finishes if the route exceeded its budget.
 */
export const runWithQueryBudget = async <T>(
  options: QueryBudgetOptions,
  callback: () => T | Promise<T>,
): Promise<T> => {
  const budget = options.budget ?? resolveQueryBudget(options.route);
  const context: QueryBudgetContext = {
    route: options.route,
    budget: budget ?? Number.POSITIVE_INFINITY,
    count: 0,
    exceeded: false,
    reported: false,
    startedAt: Date.now(),
  };
  const enforce = options.enforce ?? queryBudgetEnforcementEnabled();

  const result = await storage.run(context, async () => callback());
  const snapshot = snapshotOf(context);
  if (snapshot.exceeded && !context.reported) {
    context.reported = true;
    options.onExceeded?.(snapshot);
  }
  if (snapshot.exceeded && budget !== undefined && enforce) {
    throw new QueryBudgetExceededError(snapshot);
  }
  return result as T;
};

export const withQueryBudget = runWithQueryBudget;

export const assertQueryBudget = (
  route: string,
  count: number,
  budget = resolveQueryBudget(route),
): void => {
  if (budget === undefined || count <= budget) {
    return;
  }
  throw new QueryBudgetExceededError({
    route,
    budget,
    count,
    exceeded: true,
    startedAt: Date.now(),
  });
};

export interface QueryLogClient {
  $on?: (event: "query", callback: () => void) => unknown;
}

/**
 * Counts every Prisma query event for the current async request. Prisma only
 * emits the event when the client was constructed with a query event log, so
 * `createBaseClient` wires that in.
 */
export const installQueryBudgetInstrumentation = <T>(client: T): T => {
  const candidate = client as QueryLogClient;
  if (!candidate || typeof candidate.$on !== "function") {
    return client;
  }
  if (instrumentedClients.has(candidate as object)) {
    return client;
  }
  instrumentedClients.add(candidate as object);
  candidate.$on("query", () => {
    recordQuery();
  });
  return client;
};
