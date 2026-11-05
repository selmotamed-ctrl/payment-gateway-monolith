/** Polling fallback for the payment status stream, with capped exponential backoff. */
export const TERMINAL_STATUSES = ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED"] as const;

export const isTerminalStatus = (status: unknown): boolean =>
    typeof status === "string" && (TERMINAL_STATUSES as readonly string[]).includes(status);

export const nextPollDelay = (attempt: number, baseMs = 1500, maxMs = 15000): number =>
    Math.min(maxMs, Math.round(baseMs * Math.pow(1.6, Math.max(0, attempt))));

export type PollerOptions<T extends { status?: unknown }> = {
    fetchSnapshot: () => Promise<T>;
    onSnapshot: (snapshot: T) => void;
    schedule?: (fn: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
    baseMs?: number;
    maxMs?: number;
    maxAttempts?: number;
};

/** Polls immediately, then with backoff; stops on a terminal status, on `stop()`, or after `maxAttempts`. */
export const startStatusPolling = <T extends { status?: unknown }>(opts: PollerOptions<T>) => {
    const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const cancel = opts.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const maxAttempts = opts.maxAttempts ?? 200;
    let stopped = false;
    let handle: unknown = null;
    let attempt = 0;

    const tick = async () => {
        if (stopped) {
            return;
        }
        try {
            const snapshot = await opts.fetchSnapshot();
            if (stopped) {
                return;
            }
            opts.onSnapshot(snapshot);
            if (isTerminalStatus(snapshot?.status)) {
                stopped = true;
                return;
            }
        } catch {
            /* transient failure: back off and retry */
        }
        if (stopped) {
            return;
        }
        attempt += 1;
        if (attempt > maxAttempts) {
            stopped = true;
            return;
        }
        handle = schedule(() => void tick(), nextPollDelay(attempt, opts.baseMs, opts.maxMs));
    };

    void tick();
    return {
        stop: () => {
            stopped = true;
            if (handle !== null) {
                cancel(handle);
            }
        },
    };
};
