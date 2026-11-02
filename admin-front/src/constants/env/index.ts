export const isDev = () => {
    return !!import.meta.env.DEV;
};

export const isSendNotFoundTranslations = () => {
    return isDev() && import.meta.env.VITE_SEND_NOT_FOUND_TRANSLATIONS === "YES";
};

const isEnabled = (value: string | undefined, fallback: boolean): boolean => {
    if (value === undefined || value.trim() === "") return fallback;
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
};

export const areChecklistsVisible = () => {
    const runtimeConfig = typeof window === "undefined" ? undefined : window.__PG_RUNTIME_CONFIG__;
    if (typeof runtimeConfig?.showChecklists === "boolean") return runtimeConfig.showChecklists;
    if (typeof runtimeConfig?.showSnapshotExportChecklist === "boolean") return runtimeConfig.showSnapshotExportChecklist;
    return isEnabled(
        import.meta.env.VITE_SHOW_CHECKLISTS ?? import.meta.env.VITE_SHOW_SNAPSHOT_EXPORT_CHECKLIST,
        true,
    );
};
