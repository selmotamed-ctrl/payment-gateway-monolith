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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
        const response = await fetch(`${target.baseUrl.replace(/\/$/, "")}/api/v1/pay/${encodeURIComponent(target.linkKey)}/initiate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            railCode: target.railCode,
            formData: {},
            idempotencyKey: `${prefix}-${index}`.slice(0, 120),
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        statuses.push(response.status);
        if (!response.ok) {
          await response.arrayBuffer();
        } else {
          await response.arrayBuffer();
        }
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

export const runHotLinkContention = async (input: {
  targets: PaymentTarget[];
  attempts: number;
  concurrency: number;
}): Promise<WorkloadResult> => {
  const statuses: number[] = [];
  const latencies: number[] = [];
  const errors: string[] = [];
  let next = 0;
  const prefix = `hot-${Date.now()}`;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= input.attempts) return;
      const target = input.targets[index % input.targets.length]!;
      const started = performance.now();
      try {
        const response = await fetch(`${target.baseUrl.replace(/\/$/, "")}/api/v1/pay/${encodeURIComponent(target.linkKey)}/initiate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            railCode: target.railCode,
            formData: {},
            idempotencyKey: `${prefix}-${index}`.slice(0, 120),
          }),
        });
        statuses.push(response.status);
        await response.arrayBuffer();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      } finally {
        latencies.push(performance.now() - started);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency, input.attempts)) }, () => worker()));
  return summarize(input.attempts, latencies, statuses, errors);
};
