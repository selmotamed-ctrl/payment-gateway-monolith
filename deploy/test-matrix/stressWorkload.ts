export interface WorkloadResult {
  total: number;
  succeeded: number;
  conflict: number;
  failed: number;
  latenciesMs: number[];
  p50: number;
  p95: number;
  p99: number;
  errors: string[];
}

export interface PaymentTarget {
  baseUrl: string;
  linkKey: string;
  railCode: string;
  /** Node id that serves this target (for per-node distribution). */
  nodeId?: string;
}

const percentile = (sorted: number[], ratio: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
};

export const summarize = (total: number, latencies: number[], statuses: number[], errors: string[]): WorkloadResult => {
  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    total,
    succeeded: statuses.filter((status) => status >= 200 && status < 300).length,
    conflict: statuses.filter((status) => status === 409).length,
    failed: statuses.filter((status) => status >= 400 && status !== 409).length + errors.length,
    latenciesMs: sorted,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    errors: errors.slice(0, 20),
  };
};

const initiate = async (target: PaymentTarget, idempotencyKey: string, timeoutMs: number): Promise<number> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${target.baseUrl.replace(/\/$/, "")}/api/v1/pay/${encodeURIComponent(target.linkKey)}/initiate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ railCode: target.railCode, formData: {}, idempotencyKey: idempotencyKey.slice(0, 120) }),
      signal: controller.signal,
    });
    await response.arrayBuffer();
    return response.status;
  } finally {
    clearTimeout(timer);
  }
};

/** Closed-loop: `total` requests with at most `concurrency` in flight. */
export const runPaymentBurst = async (input: {
  targets: PaymentTarget[];
  total: number;
  concurrency: number;
  idempotencyPrefix?: string;
  timeoutMs?: number;
}): Promise<WorkloadResult> => {
  const statuses: number[] = [];
  const latencies: number[] = [];
  const errors: string[] = [];
  let next = 0;
  const prefix = input.idempotencyPrefix ?? `lab-${Date.now()}`;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= input.total) return;
      const target = input.targets[index % input.targets.length]!;
      const started = performance.now();
      try {
        statuses.push(await initiate(target, `${prefix}-${index}`, input.timeoutMs ?? 30_000));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      } finally {
        latencies.push(performance.now() - started);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency, input.total)) }, () => worker()));
  return summarize(input.total, latencies, statuses, errors);
};

/** Many attempts on one slot-limited link: exactly `useCount` may win. */
export const runHotLinkContention = async (input: {
  targets: PaymentTarget[];
  attempts: number;
  concurrency: number;
  timeoutMs?: number;
}): Promise<WorkloadResult> =>
  runPaymentBurst({ targets: input.targets, total: input.attempts, concurrency: input.concurrency, idempotencyPrefix: `hot-${Date.now()}`, timeoutMs: input.timeoutMs });

export interface SustainedLoadResult extends WorkloadResult {
  offered: number;
  /** Requests not started because `concurrency` requests were in flight. */
  saturated: number;
  elapsedSec: number;
  steadySec: number;
  /** Successful requests per second in the steady-state window (after ramp). */
  achievedTps: number;
  errorRate: number;
  perNode: Record<string, { succeeded: number; failed: number }>;
  /** One bucket per second: [startedRequests, failedRequests]. */
  timeline: Array<[number, number]>;
}

/**
 * Open-loop generator: offers `targetTps` (linear ramp over `rampUpSec`) for
 * `rampUpSec + durationSec`, capped at `concurrency` in flight. Unlike the
 * archived burst-of-500 "500+ TPS" gate, it measures the achieved rate.
 * `targets()` is re-read for every request so scale/chaos gates can change
 * the live target set during the run.
 */
export const runSustainedLoad = async (input: {
  targets: () => PaymentTarget[];
  targetTps: number;
  rampUpSec: number;
  durationSec: number;
  concurrency: number;
  timeoutMs: number;
  idempotencyPrefix: string;
  now?: () => number;
}): Promise<SustainedLoadResult> => {
  const now = input.now ?? (() => performance.now());
  const statuses: number[] = [];
  const latencies: number[] = [];
  const errors: string[] = [];
  const perNode: SustainedLoadResult["perNode"] = {};
  const timeline: Array<[number, number]> = [];
  const steadyStatuses: number[] = [];
  let inFlight = 0;
  let offered = 0;
  let saturated = 0;
  let index = 0;
  const pending = new Set<Promise<void>>();
  const start = now();
  const totalMs = (input.rampUpSec + input.durationSec) * 1000;
  const rampMs = input.rampUpSec * 1000;
  // Offered requests by time t (ms): integral of the ramped rate.
  const offeredBy = (t: number): number => {
    const tps = input.targetTps / 1000;
    if (t <= rampMs) return rampMs === 0 ? tps * t : (tps * t * t) / (2 * rampMs);
    return (tps * rampMs) / 2 + tps * (t - rampMs);
  };

  const fire = (elapsed: number): void => {
    const targets = input.targets();
    const second = Math.floor(elapsed / 1000);
    while (timeline.length <= second) timeline.push([0, 0]);
    timeline[second]![0] += 1;
    if (targets.length === 0) {
      errors.push("no live targets");
      timeline[second]![1] += 1;
      return;
    }
    const target = targets[index % targets.length]!;
    const key = `${input.idempotencyPrefix}-${index++}`;
    const node = target.nodeId ?? target.baseUrl;
    perNode[node] ??= { succeeded: 0, failed: 0 };
    const inSteady = elapsed >= rampMs;
    inFlight += 1;
    const started = now();
    const promise = initiate(target, key, input.timeoutMs)
      .then((status) => {
        statuses.push(status);
        if (inSteady) steadyStatuses.push(status);
        if (status >= 200 && status < 300) perNode[node]!.succeeded += 1;
        else if (status !== 409) {
          perNode[node]!.failed += 1;
          timeline[second]![1] += 1;
        }
      })
      .catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
        if (inSteady) steadyStatuses.push(0);
        perNode[node]!.failed += 1;
        timeline[second]![1] += 1;
      })
      .finally(() => {
        latencies.push(now() - started);
        inFlight -= 1;
        pending.delete(promise);
      });
    pending.add(promise);
  };

  while (true) {
    const elapsed = now() - start;
    if (elapsed >= totalMs) break;
    const due = Math.floor(offeredBy(elapsed));
    while (offered < due) {
      offered += 1;
      if (inFlight >= input.concurrency) {
        saturated += 1;
        continue;
      }
      fire(elapsed);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await Promise.all([...pending]);
  const elapsedSec = (now() - start) / 1000;
  const summary = summarize(statuses.length + errors.length, latencies, statuses, errors);
  const steadySucceeded = steadyStatuses.filter((status) => status >= 200 && status < 300).length;
  const requests = statuses.length + errors.length;
  return {
    ...summary,
    offered,
    saturated,
    elapsedSec,
    steadySec: input.durationSec,
    achievedTps: input.durationSec > 0 ? steadySucceeded / input.durationSec : 0,
    errorRate: requests === 0 ? 1 : summary.failed / requests,
    perNode,
    timeline,
  };
};
