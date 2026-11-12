import { ref } from "vue";

export type PgEnvironment = "LIVE" | "SANDBOX";

const STORAGE_KEY = "pg_merchant_env";

const readEnvironment = (): PgEnvironment => {
    try {
        return localStorage.getItem(STORAGE_KEY) === "SANDBOX" ? "SANDBOX" : "LIVE";
    } catch {
        return "LIVE";
    }
};

/** The plane the merchant portal reads and writes. Live is the default. */
export const activeEnvironment = ref<PgEnvironment>(readEnvironment());

export const isSandboxEnvironment = () => activeEnvironment.value === "SANDBOX";

export const setActiveEnvironment = (environment: PgEnvironment): void => {
    if (activeEnvironment.value === environment) return;
    activeEnvironment.value = environment;
    try {
        localStorage.setItem(STORAGE_KEY, environment);
    } catch {
        // A private-mode browser may refuse storage; the in-memory value still works.
    }
    // Every list, wallet, link and report is plane-specific; a reload is the
    // simplest correct invalidation of the whole portal cache.
    window.location.reload();
};
