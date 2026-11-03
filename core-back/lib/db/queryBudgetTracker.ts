import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * Per-route database query budgets from design
 * `high_scale_db_architecture_v2.md` §5.6.
 *
 * The tracker is deliberately dependency-free: routes call
 * `recordQueryBudget()` around the handful of database calls they make (or use
 * `runWithQueryBudget` / `withQueryBudget` at the handler boundary). That
 * keeps the budget visible in code review instead of hiding it behind a
 * Prisma middleware that cannot see the route.
 */
export const ROUTE_QUERY_BUDGETS = {
  "GET /pay/:key": 4,
  "POST /pay/:key/initiate": 8,
  "POST /pay/:key/confirm": 8,
  "GET /wallets/:id/balance": 2,
  "ADMIN_LIST": 3,
  "GLOBAL_SEARCH": 6,
} as const;

/** Aliases used by the design and by route tests. */
export const QUERY_BUDGETS = ROUTE_QUERY_BUDGETS;
export const DEFAULT_QUERY_BUDGETS: Record<string, number> = {
  ...ROUTE_QUERY_BUDGETS,
  "GET /pay/:key": 4,
  "POST /pay/:key/initiate": 8,
  "POST /pay/:key/confirm": 8,
  "GET /wallets/:id/balance": 2,
  "admin-list": 3,
  "global-search": 6,
};

export interface QueryBudgetSession {
  id: number;
  route: string;
  budget: number;
  queries: number;
  exceeded: boolean;
  startedAt: number;
  finishedAt?: number;
}

export interface QueryBudgetSnapshot {
  route: string;
  budget: number;
  queries: number;
  exceeded: boolean;
  remaining: number;
}

export interface QueryBudgetExceededEvent extends QueryBudgetSnapshot {
  session: QueryBudgetSession;
}

export interface QueryBudgetTrackerOptions {
  budgets?: Record<string, number>;
  now?: () => number;
  onExceeded?: (event: QueryBudgetExceededEvent) => void;
}

const normaliseMethod = (method: string): string => method.trim().toUpperCase();
const normalisePath = (path: string): string => {
  const withoutQuery = path.split("?")[0] ?? path;
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, "") : withLeadingSlash;
};


/**
 * Resolves a concrete request (`GET /api/pay/abc`) or an explicit route key
 * (`"GET /pay/:key"`) to a budget. Unknown routes return `undefined`.
 */
export const resolveQueryBudget = (
  routeOrMethod: string,
  maybePath?: string,
): number | undefined => {
  const raw = routeOrMethod.trim();
  let method: string | undefined;
  let route: string;
  if (maybePath !== undefined) {
    method = normaliseMethod(routeOrMethod);
    route = maybePath.trim();
  } else {
    const separator = raw.indexOf(" ");
    const possibleMethod = separator > 0 ? raw.slice(0, separator) : "";
    if (possibleMethod && /^[A-Za-z]+$/.test(possibleMethod)) {
      method = normaliseMethod(possibleMethod);
      route = raw.slice(separator + 1).trim();
    } else {
      route = raw;
    }
  }

  const exact = DEFAULT_QUERY_BUDGETS[method ? `${method} ${route}` : route]
    ?? DEFAULT_QUERY_BUDGETS[route];
  if (exact !== undefined) {
    return exact;
  }

  const path = normalisePath(route);
  const upperPath = path.toUpperCase();
  if (upperPath === "/ADMIN_LIST" || upperPath === "/GLOBAL_SEARCH") {
    return DEFAULT_QUERY_BUDGETS[upperPath.slice(1).toLowerCase().replace("_", "-")];
  }

  const isGet = method === "GET" || method === undefined;
  if (isGet && /\/pay\/[^/]+$/.test(path)) {
    return ROUTE_QUERY_BUDGETS["GET /pay/:key"];
  }
  if (method === "POST" && /\/initiate$/.test(path)) {
    return ROUTE_QUERY_BUDGETS["POST /pay/:key/initiate"];
  }
  if (method === "POST" && /\/confirm$/.test(path)) {
    return ROUTE_QUERY_BUDGETS["POST /pay/:key/confirm"];
  }
  if (isGet && /\/wallets\/[^/]+\/balance$/.test(path)) {
    return ROUTE_QUERY_BUDGETS["GET /wallets/:id/balance"];
  }
  if (isGet && /(?:^|\/)search(?:\/|$)/.test(path)) {
    return ROUTE_QUERY_BUDGETS.GLOBAL_SEARCH;
  }
  if (isGet && /\/admin(?:\/|$)/.test(path)) {
    return ROUTE_QUERY_BUDGETS.ADMIN_LIST;
  }
  return undefined;
};

export const routeBudgetFor = resolveQueryBudget;
export const budgetForRoute = resolveQueryBudget;
export const getQueryBudget = resolveQueryBudget;
export const queryBudgetForRoute = resolveQueryBudget;

export class QueryBudgetTracker {
  private readonly budgets: Record<string, number>;
  private readonly now: () => number;
  private readonly onExceeded?: (event: QueryBudgetExceededEvent) => void;
  private readonly sessions = new Map<number, QueryBudgetSession>();
  private nextId = 1;

  constructor(options: QueryBudgetTrackerOptions = {}) {
    this.budgets = { ...DEFAULT_QUERY_BUDGETS, ...(options.budgets ?? {}) };
    this.now = options.now ?? (() => Date.now());
    this.onExceeded = options.onExceeded;
  }

  budgetFor(routeOrMethod: string, maybePath?: string): number | undefined {
    return this.budgets[routeOrMethod.trim()]
      ?? resolveQueryBudget(routeOrMethod, maybePath);
  }

  begin(routeOrMethod: string, budget?: number): QueryBudgetSession {
    const resolvedRoute = routeOrMethod.trim();
    const resolvedBudget = budget
      ?? this.budgets[resolvedRoute]
      ?? resolveQueryBudget(resolvedRoute)
      ?? 0;
    const session: QueryBudgetSession = {
      id: this.nextId++,
      route: resolvedRoute,
      budget: Math.max(0, Math.floor(resolvedBudget)),
      queries: 0,
      exceeded: false,
      startedAt: this.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  record(session: QueryBudgetSession, count = 1): QueryBudgetSession {
    const safeCount = Math.max(0, Math.floor(count));
    session.queries += safeCount;
    if (!session.exceeded && session.queries > session.budget) {
      session.exceeded = true;
      this.onExceeded?.({ ...this.snapshot(session), session });
    }
    return session;
  }

  recordByRoute(routeOrMethod: string, count = 1, maybePath?: string): QueryBudgetSession {
    const session = this.begin(routeOrMethod, this.budgetFor(routeOrMethod, maybePath));
    return this.record(session, count);
  }

  finish(session: QueryBudgetSession): QueryBudgetSnapshot {
    if (session.finishedAt === undefined) {
      session.finishedAt = this.now();
    }
    const snapshot = this.snapshot(session);
    this.sessions.delete(session.id);
    return snapshot;
  }

  snapshot(session: QueryBudgetSession): QueryBudgetSnapshot {
    return {
      route: session.route,
      budget: session.budget,
      queries: session.queries,
      exceeded: session.exceeded || session.queries > session.budget,
      remaining: Math.max(0, session.budget - session.queries),
    };
  }

  isExceeded(session: QueryBudgetSession): boolean {
    return session.exceeded || session.queries > session.budget;
  }

  reset(): void {
    this.sessions.clear();
  }
}

export const queryBudgetTracker = new QueryBudgetTracker();
export const defaultQueryBudgetTracker = queryBudgetTracker;

const budgetStorage = new AsyncLocalStorage<QueryBudgetSession>();

export const currentQueryBudget = (): QueryBudgetSession | undefined =>
  budgetStorage.getStore();

/** Counts one (or more) database queries against the current route budget. */
export const recordQueryBudget = (count = 1): QueryBudgetSession | undefined => {
  const session = budgetStorage.getStore();
  if (!session) {
    return undefined;
  }
  return queryBudgetTracker.record(session, count);
};

export const trackQueryBudget = recordQueryBudget;
export const countQueryBudget = recordQueryBudget;
export const recordQuery = recordQueryBudget;

/**
 * Runs a callback inside a budget context. Routes normally use this helper or
 * the Express middleware below; both expose the same `recordQueryBudget()`.
 */
export const runWithQueryBudget = async <T>(
  routeOrMethod: string,
  callback: (session: QueryBudgetSession) => Promise<T> | T,
  options: { budget?: number; tracker?: QueryBudgetTracker } = {},
): Promise<T> => {
  const tracker = options.tracker ?? queryBudgetTracker;
  const session = tracker.begin(routeOrMethod, options.budget);
  try {
    return await budgetStorage.run(session, () => callback(session));
  } finally {
    tracker.finish(session);
  }
};

/**
 * Wraps an existing Express/route handler in a budget context. The returned
 * function has exactly the same arguments, so it can be dropped into a router
 * without changing behaviour.
 */
export const withQueryBudget = <TArgs extends unknown[], TResult>(
  routeOrMethod: string | ((...args: TArgs) => string),
  handler: (...args: TArgs) => Promise<TResult> | TResult,
  options: { budget?: number; tracker?: QueryBudgetTracker } = {},
): ((...args: TArgs) => Promise<TResult>) => {
  return async (...args: TArgs): Promise<TResult> => {
    const route = typeof routeOrMethod === "function" ? routeOrMethod(...args) : routeOrMethod;
    const tracker = options.tracker ?? queryBudgetTracker;
    const session = tracker.begin(route, options.budget);
    try {
      return await budgetStorage.run(session, () => handler(...args));
    } finally {
      tracker.finish(session);
    }
  };
};

export const createQueryBudgetGuard = withQueryBudget;

declare global {
  namespace Express {
    interface Request {
      queryBudget?: QueryBudgetSession;
    }
  }
}

/**
 * Express middleware integration point. It does not itself know how many SQL
 * statements a handler runs; handler code calls `recordQueryBudget()` around
 * its database work (or the query wrapper does it). The middleware guarantees
 * the context exists and reports the final budget at the end of the response.
 */
export const createQueryBudgetMiddleware = (
  options: { tracker?: QueryBudgetTracker; resolveRoute?: (request: Request) => string | undefined } = {},
) => {
  const tracker = options.tracker ?? queryBudgetTracker;
  return (request: Request, response: Response, next: NextFunction): void => {
    const route = options.resolveRoute
      ? options.resolveRoute(request)
      : resolveQueryBudget(request.method, request.originalUrl ?? request.path) === undefined
        ? undefined
        : `${normaliseMethod(request.method)} ${normalisePath(request.path)}`;
    if (!route) {
      next();
      return;
    }
    const session = tracker.begin(route);
    request.queryBudget = session;
    budgetStorage.run(session, () => {
      response.once("finish", () => {
        tracker.finish(session);
      });
      next();
    });
  };
};

export const queryBudgetMiddleware = createQueryBudgetMiddleware();

export default queryBudgetTracker;
