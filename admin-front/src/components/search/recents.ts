const STORAGE_KEY = "pg_admin_recent_search_queries_v1";
const MAX_RECENTS = 8;

function getStorage(): Storage | null {
    if (typeof window === "undefined") {
        return null;
    }
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

export function getRecentSearchQueries(): string[] {
    const storage = getStorage();
    if (!storage) {
        return [];
    }

    try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length >= 2 && item.length <= 120)
            .slice(0, MAX_RECENTS);
    } catch {
        return [];
    }
}

export function saveRecentSearchQuery(query: string): string[] {
    const clean = query.trim().slice(0, 120);
    if (clean.length < 2) {
        return getRecentSearchQueries();
    }

    const storage = getStorage();
    if (!storage) {
        return [];
    }

    try {
        const existing = getRecentSearchQueries().filter(
            (recent) => recent.toLowerCase() !== clean.toLowerCase(),
        );
        const next = [clean, ...existing].slice(0, MAX_RECENTS);
        storage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
    } catch {
        return [];
    }
}

export function removeRecentSearchQuery(query: string): string[] {
    const clean = query.trim().toLowerCase();
    const storage = getStorage();
    if (!storage) {
        return [];
    }

    try {
        const next = getRecentSearchQueries().filter(
            (recent) => recent.toLowerCase() !== clean,
        );
        storage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
    } catch {
        return [];
    }
}

export function clearRecentSearchQueries(): void {
    const storage = getStorage();
    if (!storage) {
        return;
    }

    try {
        storage.removeItem(STORAGE_KEY);
    } catch {
        return;
    }
}
