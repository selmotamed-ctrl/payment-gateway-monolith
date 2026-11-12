import { ref } from "vue";

export type PgEnvironment = "LIVE" | "SANDBOX";

const STORAGE_KEY = "pg_admin_env";

const readEnvironment = (): PgEnvironment => {
    try {
        return localStorage.getItem(STORAGE_KEY) === "SANDBOX" ? "SANDBOX" : "LIVE";
    } catch {
        return "LIVE";
    }
};

/** The plane the admin portal reads and writes. Live is the default. */
export const activeEnvironment = ref<PgEnvironment>(readEnvironment());

export const setActiveEnvironment = (environment: PgEnvironment): void => {
    if (activeEnvironment.value === environment) return;
    activeEnvironment.value = environment;
    try {
        localStorage.setItem(STORAGE_KEY, environment);
    } catch {
        // Private-mode storage may be unavailable; the in-memory value works.
    }
    window.location.reload();
};
