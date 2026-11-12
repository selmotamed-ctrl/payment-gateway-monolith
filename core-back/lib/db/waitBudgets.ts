/**
 * How long a caller waits for a database connection before failing fast.
 *
 * Two budgets, both "wait in the queue", never "run the query":
 *  - `PG_POOL_CONNECT_TIMEOUT_MS`: node-postgres `connectionTimeoutMillis`, the wait for a pooled
 *    client (default 5,000 ms);
 *  - `PG_TX_MAX_WAIT_MS`: Prisma's interactive-transaction `maxWait`, the wait to START a
 *    transaction (P2028 when it runs out). When unset every call site keeps its own default
 *    (Prisma 2,000 ms, the unit-of-work adapter 2,500 ms, the workers 5,000 to 10,000 ms).
 *
 * Production leaves both unset: a request that cannot get a connection quickly fails fast and is
 * retried (P2028 is a transient failure). The test preload raises them, because the concurrency
 * suites start 50 transactions against a pool of 10 to 40 on a developer machine, and a busy host
 * delays the event loop enough to cross a 2 to 5 second queue budget even though the database is
 * idle. Those suites assert one winner, no deadlock, gapless sequences and exactly-once delivery;
 * none of that depends on the queue budget.
 */
const positiveIntFromEnv = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

/** `connectionTimeoutMillis` for a node-postgres pool. */
export const poolConnectTimeoutMs = (fallback = 5_000): number =>
  positiveIntFromEnv("PG_POOL_CONNECT_TIMEOUT_MS") ?? fallback;

/** `maxWait` for a Prisma interactive transaction: the override when set, else the caller's default. */
export const transactionMaxWaitMs = (fallback: number): number =>
  positiveIntFromEnv("PG_TX_MAX_WAIT_MS") ?? fallback;

/** Client-wide Prisma `transactionOptions`, only when an override is set (otherwise Prisma's defaults). */
export const prismaTransactionOptions = (): { maxWait: number } | undefined => {
  const maxWait = positiveIntFromEnv("PG_TX_MAX_WAIT_MS");
  return maxWait === undefined ? undefined : { maxWait };
};
