/**
 * Automatic retry for MariaDB deadlocks (1213) and lock-wait timeouts (1205).
 *
 * Design `high_scale_db_architecture_v2.md` §2.6:
 *   - at most 3 attempts;
 *   - 5-40 ms jittered back-off;
 *   - only for operations that are idempotent by construction (the caller
 *     owns the idempotency key or unique constraint);
 *   - every retry is counted in a metric.
 *
 * The wrapper deliberately does not retry arbitrary work by default in new
 * code: pass `idempotent: false` to make the contract explicit and run once.
 * Existing call sites that opt in by calling `withTxRetry` are asserting that
 * their operation is safe to replay.
 */

export const RETRYABLE_TRANSACTION_CODES = [1213, 1205] as const;
export type RetryableTransactionCode = (typeof RETRYABLE_TRANSACTION_CODES)[number];

export const DEFAULT_TX_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_TX_RETRY_MIN_DELAY_MS = 5;
export const DEFAULT_TX_RETRY_MAX_DELAY_MS = 40;

export interface TxRetryMetricsSnapshot {
  /** Total operation attempts, including the first try. */
  attempts: number;
  /** Attempts that followed a retryable failure. */
  retries: number;
  successes: number;
  failures: number;
  /** Retryable failures that exhausted the attempt budget. */
  exhausted: number;
  deadlocks: number;
  lockWaitTimeouts: number;
}

const metrics: TxRetryMetricsSnapshot = {
  attempts: 0,
  retries: 0,
  successes: 0,
  failures: 0,
  exhausted: 0,
  deadlocks: 0,
  lockWaitTimeouts: 0,
};

/** Live counter, exposed for a metrics exporter. */
export const txRetryMetrics = metrics;
export const txRetryCounter = metrics;

export const snapshotTxRetryMetrics = (): TxRetryMetricsSnapshot => ({ ...metrics });
export const getTxRetryMetrics = snapshotTxRetryMetrics;
export const txRetryMetricsSnapshot = snapshotTxRetryMetrics;

export const resetTxRetryMetrics = (): void => {
  metrics.attempts = 0;
  metrics.retries = 0;
  metrics.successes = 0;
  metrics.failures = 0;
  metrics.exhausted = 0;
  metrics.deadlocks = 0;
  metrics.lockWaitTimeouts = 0;
};

const readErrorCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as {
    errno?: unknown;
    code?: unknown;
    sqlState?: unknown;
    cause?: { errno?: unknown; code?: unknown };
    meta?: { code?: unknown };
  };
  const code =
    candidate.errno
    ?? candidate.code
    ?? candidate.cause?.errno
    ?? candidate.cause?.code
    ?? candidate.meta?.code;
  if (typeof code === "number") {
    return code;
  }
  if (typeof code === "string") {
    if (code === "1213" || code === "1205") {
      return Number(code);
    }
    if (/ER_LOCK_DEADLOCK/i.test(code)) {
      return 1213;
    }
    if (/ER_LOCK_WAIT_TIMEOUT/i.test(code)) {
      return 1205;
    }
  }
  if (candidate.sqlState === "40001" || (typeof candidate.code === "string" && candidate.code === "40001")) {
    return 1213;
  }
  const message = error instanceof Error ? error.message : "";
  if (/deadlock/i.test(message)) {
    return 1213;
  }
  if (/lock wait timeout/i.test(message)) {
    return 1205;
  }
  if (/\b1213\b/.test(message)) {
    return 1213;
  }
  if (/\b1205\b/.test(message)) {
    return 1205;
  }
  return undefined;
};

export const isRetryableTransactionError = (error: unknown): boolean => {
  const code = readErrorCode(error);
  return code === 1213 || code === 1205;
};

export interface TxRetryOptions {
  /**
   * The caller asserts that replaying the callback is safe. Defaults to true
   * because the wrapper is only intended for idempotent transactions; set it
   * to false to run the callback exactly once.
   */
  idempotent?: boolean;
  maxAttempts?: number;
  /** Alias used by the repository helper (`attempts`). */
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
  /** Injectable for deterministic tests. */
  sleep?: (delayMs: number) => Promise<void>;
  /**
   * Receives the retry event. A two-argument listener is called as
   * `(error, attempt)` for compatibility with the existing repository helper.
   */
  onRetry?: ((event: TxRetryEvent) => void) | ((error: unknown, attempt: number) => void);
  onFailure?: (event: TxRetryFailureEvent) => void;
}

export type TransactionRetryOptions = TxRetryOptions;

export interface TxRetryEvent {
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  code: RetryableTransactionCode;
  error: unknown;
}

export interface TxRetryFailureEvent {
  attempts: number;
  exhausted: boolean;
  error: unknown;
}

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const jitterDelay = (
  minDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number => {
  const span = Math.max(0, maxDelayMs - minDelayMs);
  return Math.min(maxDelayMs, minDelayMs + Math.floor(random() * (span + 1)));
};

/**
 * Runs `operation` and retries only deadlocks/lock-wait timeouts.
 *
 * The callback receives the 1-based attempt number, so a caller can include
 * it in an idempotency key if its storage design requires that.
 */
export const withTxRetry = async <T>(
  operation: (attempt: number) => Promise<T>,
  options: TxRetryOptions = {},
): Promise<T> => {
  const maxAttempts = options.idempotent === false
    ? 1
    : clampInteger(
        options.maxAttempts ?? options.attempts,
        DEFAULT_TX_RETRY_MAX_ATTEMPTS,
        1,
        DEFAULT_TX_RETRY_MAX_ATTEMPTS,
      );
  const minDelayMs = clampInteger(options.minDelayMs, DEFAULT_TX_RETRY_MIN_DELAY_MS, 0, 10_000);
  const maxDelayMs = Math.max(
    minDelayMs,
    clampInteger(options.maxDelayMs, DEFAULT_TX_RETRY_MAX_DELAY_MS, minDelayMs, 10_000),
  );
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    metrics.attempts += 1;
    try {
      const result = await operation(attempt);
      metrics.successes += 1;
      return result;
    } catch (error) {
      lastError = error;
      const code = readErrorCode(error);
      const retryable = code === 1213 || code === 1205;
      if (retryable && code === 1213) {
        metrics.deadlocks += 1;
      }
      if (retryable && code === 1205) {
        metrics.lockWaitTimeouts += 1;
      }
      if (!retryable || attempt >= maxAttempts) {
        metrics.failures += 1;
        if (retryable && attempt >= maxAttempts) {
          metrics.exhausted += 1;
        }
        const failureEvent: TxRetryFailureEvent = {
          attempts: attempt,
          exhausted: retryable && attempt >= maxAttempts,
          error,
        };
        options.onFailure?.(failureEvent);
        throw error;
      }
      const delayMs = jitterDelay(minDelayMs, maxDelayMs, random);
      metrics.retries += 1;
      const retryEvent: TxRetryEvent = {
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        code: code as RetryableTransactionCode,
        error,
      };
      if (options.onRetry) {
        if (options.onRetry.length >= 2) {
          (options.onRetry as (error: unknown, attempt: number) => void)(error, attempt);
        } else {
          (options.onRetry as (event: TxRetryEvent) => void)(retryEvent);
        }
      }
      await sleep(delayMs);
    }
  }

  // The loop either returns or throws; this keeps TypeScript satisfied.
  throw lastError;
};

export interface TxRetryTransactionOptions extends TxRetryOptions {
  transactionOptions?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: unknown;
  };
}

/**
 * Convenience wrapper for a Prisma `$transaction` callback. The same
 * idempotency contract as `withTxRetry` applies.
 */
export const withTransactionRetry = async <T>(
  client: { $transaction: (...args: any[]) => Promise<T> },
  callback: (tx: any, attempt: number) => Promise<T>,
  options: TxRetryTransactionOptions = {},
): Promise<T> => {
  const { transactionOptions, ...retryOptions } = options;
  return withTxRetry(
    (attempt) => client.$transaction(
      (tx: unknown) => callback(tx, attempt),
      transactionOptions as never,
    ),
    retryOptions,
  );
};

export default withTxRetry;
