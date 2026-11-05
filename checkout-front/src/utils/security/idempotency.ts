/**
 * One idempotency key per user intent. The key is persisted in sessionStorage so that
 * retries and page reloads of the same attempt reuse it; it is cleared when the intent
 * is finished (success / terminal failure) or explicitly renewed.
 */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const defaultStorage = (): StorageLike | null => {
    try {
        return typeof sessionStorage !== "undefined" ? sessionStorage : null;
    } catch {
        return null;
    }
};

export const generateIdempotencyKey = (): string => `chk-${crypto.randomUUID()}`;

export const intentStorageKey = (intent: string, scope: string) => `PG:CHECKOUT:IDEM:${scope}:${intent}`;

export const getOrCreateIdempotencyKey = (
    intent: string,
    scope: string,
    storage: StorageLike | null = defaultStorage(),
): string => {
    const storageKey = intentStorageKey(intent, scope);
    try {
        const existing = storage?.getItem(storageKey);
        if (existing) {
            return existing;
        }
    } catch {
        /* storage unavailable: fall through to a fresh key */
    }
    const key = generateIdempotencyKey();
    try {
        storage?.setItem(storageKey, key);
    } catch {
        /* ignore */
    }
    return key;
};

export const clearIdempotencyKey = (intent: string, scope: string, storage: StorageLike | null = defaultStorage()) => {
    try {
        storage?.removeItem(intentStorageKey(intent, scope));
    } catch {
        /* ignore */
    }
};

const attemptKey = (scope: string) => `PG:CHECKOUT:ATTEMPT:${scope}`;

export const saveAttemptId = (scope: string, attemptId: string, storage: StorageLike | null = defaultStorage()) => {
    try {
        storage?.setItem(attemptKey(scope), attemptId);
    } catch {
        /* ignore */
    }
};

export const loadAttemptId = (scope: string, storage: StorageLike | null = defaultStorage()): string | null => {
    try {
        return storage?.getItem(attemptKey(scope)) ?? null;
    } catch {
        return null;
    }
};

export const clearAttemptId = (scope: string, storage: StorageLike | null = defaultStorage()) => {
    try {
        storage?.removeItem(attemptKey(scope));
    } catch {
        /* ignore */
    }
};
