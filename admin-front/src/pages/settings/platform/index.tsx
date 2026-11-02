import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VChip,
    VDialog,
    VCheckbox,
    VDivider,
    VFileInput,
    VTextField,
    VTextarea,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type PlatformSetting = {
    id: string;
    key: string;
    scope: string;
    version: number;
    valueJson: Record<string, unknown>;
    effectiveFrom: string;
    createdAt: string;
    updatedAt: string;
};

type SettingsSummary = {
    keys: number;
    versions: number;
    scopes: Record<string, number>;
    futureEffective: number;
    updatedLast24h: number;
};

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
};

type DiffRow = { path: string; before: string; after: string; kind: "ADDED" | "REMOVED" | "CHANGED" };

const flattenJson = (value: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        out[prefix || "(root)"] = typeof value === "string" ? value : JSON.stringify(value);
        return out;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
            flattenJson(entry, path, out);
        } else {
            out[path] = typeof entry === "string" ? entry : JSON.stringify(entry);
        }
    }
    return out;
};

const jsonPreview = (value: unknown): string => {
    try {
        const text = JSON.stringify(value);
        return text.length > 180 ? `${text.slice(0, 177)}…` : text;
    } catch {
        return String(value);
    }
};

const SUMMARY_EXPORT_CHECKS = [
    { key: "SETTINGS_SCOPE_VERIFIED", label: "Settings scope verified" },
    { key: "VERSIONS_REVIEWED", label: "Version counts reviewed" },
    { key: "EFFECTIVE_DATES_REVIEWED", label: "Effective dates reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const SETTING_EDIT_CHECKS = [
    { key: "KEY_SCOPE_VERIFIED", label: "Key and scope verified" },
    { key: "VALUE_SCHEMA_REVIEWED", label: "Value schema reviewed" },
    { key: "EFFECTIVE_DATE_REVIEWED", label: "Effective date reviewed" },
    { key: "IMMUTABLE_VERSION_ACKNOWLEDGED", label: "Immutable-version impact acknowledged" },
] as const;

const RESTORE_CHECKS = [
    { key: "BACKUP_REVIEWED", label: "Backup contents reviewed" },
    { key: "INVALID_ENTRIES_CLEARED", label: "Invalid entries cleared" },
    { key: "VERSION_CONFLICTS_REVIEWED", label: "Version conflicts reviewed" },
    { key: "RESTORE_SCOPE_CONFIRMED", label: "Restore scope confirmed" },
] as const;

const PlatformSettingsPage = dc(() => {
    const { t } = useLocale();
    const settings = ref<PlatformSetting[]>([]);
    const summary = ref<SettingsSummary | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref("");

    const dialogOpen = ref(false);
    const editKey = ref("");
    const editValue = ref("{}");
    const editError = ref<string | null>(null);
    const editChecklist = ref<Record<string, boolean>>({});
    const saving = ref(false);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const history = ref<PlatformSetting[]>([]);
    const restoreOpen = ref(false);
    const restoreLoading = ref(false);
    const restoreError = ref<string | null>(null);
    const restoreFileName = ref("");
    const restorePreview = ref<{
        summary: { backupKeys: number; added: number; changed: number; unchanged: number; invalid: number; missingInBackup: number };
        entries: Array<{ index: number; key: string; scope: string; status: string; reason?: string; currentVersion?: number | null; nextVersion?: number; effectiveFrom?: string | null; backupValue?: Record<string, unknown> }>;
        missingInBackup: string[];
    } | null>(null);
    const restoreConfirm = ref(false);
    const restoreChecklist = ref<Record<string, boolean>>({});
    const restoreReason = ref("");
    const restoreApplying = ref(false);
    const restoreApplyError = ref<string | null>(null);
    const compareRow = ref<PlatformSetting | null>(null);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const [listResponse, summaryResponse] = await Promise.all([
                api.get(urlsMap.settings),
                api.get(urlsMap.settingsSummary),
            ]);
            const listPayload = listResponse.data?.data ?? listResponse.data ?? {};
            const summaryPayload = summaryResponse.data?.data ?? summaryResponse.data ?? {};
            settings.value = (listPayload.settings ?? []) as PlatformSetting[];
            summary.value = (summaryPayload.summary ?? summaryPayload) as SettingsSummary;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    void load();

    const grouped = computed(() => {
        const map = new Map<string, PlatformSetting[]>();
        for (const row of settings.value) {
            const list = map.get(row.key) ?? [];
            list.push(row);
            map.set(row.key, list);
        }
        for (const list of map.values()) list.sort((left, right) => right.version - left.version);
        return map;
    });

    const rows = computed(() => {
        const query = search.value.trim().toLowerCase();
        return [...grouped.value.entries()]
            .filter(([key]) => !query || key.toLowerCase().includes(query))
            .map(([key, versions]) => ({ key, latest: versions[0]!, versions }))
            .sort((left, right) => left.key.localeCompare(right.key));
    });

    const summaryExportChecklistComplete = computed(() => SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        if (!summaryExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all summary export checklist items before exporting") });
            return;
        }
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.settingsSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const snapshot = (payload.summary ?? payload) as SettingsSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["keys", snapshot.keys],
                ["versions", snapshot.versions],
                ["future_effective", snapshot.futureEffective],
                ["updated_last_24h", snapshot.updatedLast24h],
            ];
            for (const [scope, count] of Object.entries(snapshot.scopes ?? {})) rows.push([`scope.${scope}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `platform-settings-summary-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("Platform settings summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const summaryItems = computed(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { label: t("Setting keys"), value: String(data.keys), tone: "info" as const },
            { label: t("Versions"), value: String(data.versions), tone: "neutral" as const },
            { label: t("Updated last 24h"), value: String(data.updatedLast24h), tone: data.updatedLast24h > 0 ? "success" as const : "neutral" as const },
            { label: t("Future effective"), value: String(data.futureEffective), tone: data.futureEffective > 0 ? "warning" as const : "success" as const },
        ];
    });

    const exportBackup = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.settingsExport);
            const payload = response.data?.data ?? response.data ?? {};
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `platform-settings-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("Settings backup exported") });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            exportLoading.value = false;
        }
    };

    const openRestore = () => {
        restorePreview.value = null;
        restoreError.value = null;
        restoreFileName.value = "";
        restoreConfirm.value = false;
        restoreReason.value = "";
        restoreChecklist.value = {};
        restoreApplyError.value = null;
        restoreOpen.value = true;
    };

    const previewBackup = async (value: File | File[] | null) => {
        const file = Array.isArray(value) ? value[0] : value;
        if (!file) return;
        restoreFileName.value = file.name;
        restoreError.value = null;
        restorePreview.value = null;
        restoreLoading.value = true;
        try {
            const text = await file.text();
            let backup: unknown;
            try {
                backup = JSON.parse(text);
            } catch {
                restoreError.value = t("The selected backup is not valid JSON.");
                return;
            }
            const response = await api.post(urlsMap.settingsRestorePreview, { backup });
            restorePreview.value = response.data?.data ?? response.data ?? null;
        } catch (e) {
            restoreError.value = extractApiErrorMessage(e);
        } finally {
            restoreLoading.value = false;
        }
    };

    const restoreChecklistComplete = computed(() => RESTORE_CHECKS.every((check) => restoreChecklist.value[check.key] === true));

    const applyRestore = async () => {
        const preview = restorePreview.value;
        if (!preview || restoreApplying.value) return;
        const applicable = preview.entries.filter(
            (entry) => (entry.status === "ADDED" || entry.status === "CHANGED") && entry.backupValue,
        );
        if (applicable.length === 0) {
            restoreApplyError.value = t("There are no changes to apply.");
            return;
        }
        if (preview.summary.invalid > 0) {
            restoreApplyError.value = t("Fix or remove invalid backup entries before applying.");
            return;
        }
        if (restoreReason.value.trim().length < 3) {
            restoreApplyError.value = t("Enter a reason of at least 3 characters.");
            return;
        }
        if (!restoreChecklistComplete.value) {
            restoreApplyError.value = t("Complete all restore checklist items before applying.");
            return;
        }
        restoreApplying.value = true;
        restoreApplyError.value = null;
        try {
            await api.post(urlsMap.settingsRestoreApply, {
                confirm: true,
                reason: restoreReason.value.trim(),
                checklist: RESTORE_CHECKS.filter((check) => restoreChecklist.value[check.key]).map((check) => check.key),
                backup: {
                    settings: applicable.map((entry) => ({
                        key: entry.key,
                        scope: entry.scope,
                        valueJson: entry.backupValue,
                        expectedCurrentVersion: entry.currentVersion ?? 0,
                        ...(entry.effectiveFrom ? { effectiveFrom: entry.effectiveFrom } : {}),
                    })),
                },
            });
            showSnackBar({ type: "success", message: t("Settings restore applied") });
            restoreOpen.value = false;
            await load();
        } catch (e) {
            restoreApplyError.value = extractApiErrorMessage(e);
        } finally {
            restoreApplying.value = false;
        }
    };

    const openNew = () => {
        editKey.value = "";
        editValue.value = "{\n  \n}";
        editError.value = null;
        editChecklist.value = {};
        history.value = [];
        compareRow.value = null;
        dialogOpen.value = true;
    };

    const openEdit = (entry: { key: string; versions: PlatformSetting[] }) => {
        editKey.value = entry.key;
        editValue.value = JSON.stringify(entry.versions[0]?.valueJson ?? {}, null, 2);
        editError.value = null;
        editChecklist.value = {};
        history.value = entry.versions;
        compareRow.value = null;
        dialogOpen.value = true;
    };

    const diffRows = computed<DiffRow[]>(() => {
        const oldRow = compareRow.value;
        const current = history.value[0];
        if (!oldRow || !current) return [];
        const before = flattenJson(oldRow.valueJson ?? {});
        const after = flattenJson(current.valueJson ?? {});
        const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
        const rows: DiffRow[] = [];
        for (const path of paths) {
            const oldValue = before[path];
            const newValue = after[path];
            if (oldValue === newValue) continue;
            rows.push({
                path,
                before: oldValue ?? "—",
                after: newValue ?? "—",
                kind: oldValue === undefined ? "ADDED" : newValue === undefined ? "REMOVED" : "CHANGED",
            });
        }
        return rows;
    });

    const restoreVersion = (row: PlatformSetting) => {
        editValue.value = JSON.stringify(row.valueJson ?? {}, null, 2);
        editError.value = null;
    };

    const editChecklistComplete = computed(() => SETTING_EDIT_CHECKS.every((check) => editChecklist.value[check.key] === true));

    const save = async () => {
        if (saving.value) return;
        const key = editKey.value.trim();
        if (!/^[A-Za-z0-9._:-]{2,120}$/.test(key)) {
            editError.value = t("Use 2-120 letters, digits, dots, colons, underscores or hyphens.");
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(editValue.value || "{}");
        } catch {
            editError.value = t("The value must be valid JSON.");
            return;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            editError.value = t("The value must be a JSON object.");
            return;
        }
        if (!editChecklistComplete.value) {
            editError.value = t("Complete all setting checklist items before saving.");
            return;
        }
        saving.value = true;
        editError.value = null;
        try {
            await api.put(urlsMap.settings, {
                settings: { [key]: parsed },
                checklist: SETTING_EDIT_CHECKS.filter((check) => editChecklist.value[check.key]).map((check) => check.key),
            });
            showSnackBar({ type: "success", message: t("A new setting version was saved") });
            dialogOpen.value = false;
            await load();
        } catch (e) {
            editError.value = extractApiErrorMessage(e);
        } finally {
            saving.value = false;
        }
    };

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Platform Settings")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>
                                {t("Refresh")}
                            </VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportBackup()}>
                                {t("Export backup")}
                            </VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-backup-restore" onClick={openRestore}>
                                {t("Restore preview")}
                            </VBtn>
                            <VBtn color="primary" variant="flat" prependIcon="mdi-plus" onClick={openNew}>
                                {t("New setting")}
                            </VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Every save creates a new immutable version. The effective version is the highest version whose effective date has passed.")}
                </VAlert>

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        {summary.value && (
                            <VCard variant="flat" style={{ borderRadius: "16px" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Configuration health")}</ThemedText>
                                        <div style={{ flex: 1 }} />
                                        <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} disabled={!summaryExportChecklistComplete.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                                    </ThemedView>
                                    <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
                                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                            <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Summary export checklist")}</ThemedText>
                                            {SUMMARY_EXPORT_CHECKS.map((check) => (
                                                <VCheckbox
                                                    key={check.key}
                                                    modelValue={summaryExportChecklist.value[check.key] === true}
                                                    onUpdate:modelValue={(value: unknown) => (summaryExportChecklist.value = { ...summaryExportChecklist.value, [check.key]: Boolean(value) })}
                                                    label={t(check.label)}
                                                    density="compact"
                                                    hideDetails
                                                />
                                            ))}
                                            {!summaryExportChecklistComplete.value && (
                                                <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all summary export checklist items before exporting")}</ThemedText>
                                            )}
                                        </ThemedView>
                                        {summaryItems.value.map((item) => (
                                            <VCard key={item.label} variant="tonal">
                                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.62 }}>{item.label}</ThemedText>
                                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{item.value}</ThemedText>
                                                </VCardText>
                                            </VCard>
                                        ))}
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                        {Object.entries(summary.value.scopes ?? {}).map(([scope, count]) => (
                                            <VChip key={scope} size="x-small" variant="tonal">{scope}: {count}</VChip>
                                        ))}
                                    </ThemedView>
                                </VCardText>
                            </VCard>
                        )}

                        <VTextField
                            label={t("Search setting key")}
                            modelValue={search.value}
                            onUpdate:modelValue={(value: string) => (search.value = value)}
                            prependInnerIcon="mdi-magnify"
                            clearable
                            hideDetails
                        />

                        {rows.value.length === 0 && (
                            <VCard>
                                <VCardText>
                                    <StateView empty={true} emptyTitle={t("No settings found")} emptyDescription={t("Create the first platform setting.")} minHeight="180px" />
                                </VCardText>
                            </VCard>
                        )}

                        {rows.value.map((entry) => (
                            <VCard key={entry.key}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "14px", direction: "ltr" }}>{entry.key}</ThemedText>
                                        <VChip size="x-small" variant="tonal" color="primary">v{entry.latest.version}</VChip>
                                        <VChip size="x-small" variant="tonal">{entry.latest.scope}</VChip>
                                        {entry.versions.length > 1 && (
                                            <VChip size="x-small" variant="text">{entry.versions.length} {t("versions")}</VChip>
                                        )}
                                        <div style={{ flex: 1 }} />
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>
                                            {t("Effective")}: {formatDateTime(entry.latest.effectiveFrom)}
                                        </ThemedText>
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.7, direction: "ltr", fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
                                        {jsonPreview(entry.latest.valueJson)}
                                    </ThemedText>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                                        <VBtn size="small" variant="tonal" onClick={() => openEdit(entry)}>{t("History & edit")}</VBtn>
                                    </ThemedView>
                                </VCardText>
                            </VCard>
                        ))}
                    </>
                )}
            </ThemedView>

            <VDialog modelValue={restoreOpen.value} onUpdate:modelValue={(value: boolean) => (restoreOpen.value = value)} maxWidth="900px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Restore preview")}</ThemedText>
                        <VAlert type="info" variant="tonal">
                            {t("Choose a settings backup JSON. This preview does not write anything.")}
                        </VAlert>
                        <VFileInput
                            label={t("Settings backup JSON")}
                            {...{ accept: ".json,application/json" }}
                            modelValue={null}
                            prependIcon="mdi-file-upload-outline"
                            onUpdate:modelValue={(value: File | File[] | null) => void previewBackup(value)}
                        />
                        {restoreLoading.value && <StateView loading={true} minHeight="120px" />}
                        {restoreError.value && <VAlert type="error" variant="tonal" density="compact">{restoreError.value}</VAlert>}
                        {restorePreview.value && (
                            <>
                                <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{restoreFileName.value}</ThemedText>
                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "8px" }}>
                                    {[
                                        { label: t("Backup keys"), value: restorePreview.value.summary.backupKeys, tone: "info" as const },
                                        { label: t("Added"), value: restorePreview.value.summary.added, tone: "success" as const },
                                        { label: t("Changed"), value: restorePreview.value.summary.changed, tone: "warning" as const },
                                        { label: t("Unchanged"), value: restorePreview.value.summary.unchanged, tone: "neutral" as const },
                                        { label: t("Invalid"), value: restorePreview.value.summary.invalid, tone: "error" as const },
                                        { label: t("Missing in backup"), value: restorePreview.value.summary.missingInBackup, tone: "warning" as const },
                                    ].map((item) => (
                                        <VCard key={item.label} variant="tonal">
                                            <VCardText style={{ padding: "10px" }}>
                                                <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{item.label}</ThemedText>
                                                <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{item.value}</ThemedText>
                                            </VCardText>
                                        </VCard>
                                    ))}
                                </ThemedView>
                                <ThemedView style={{ gap: "6px" }}>
                                    {restorePreview.value.entries.map((entry) => (
                                        <ThemedView key={`${entry.index}-${entry.key}`} style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap", padding: "7px 9px", borderRadius: "8px", border: "1px solid rgba(100,116,139,0.2)" }}>
                                            <VChip size="x-small" variant="tonal" color={entry.status === "ADDED" ? "success" : entry.status === "CHANGED" ? "warning" : entry.status === "INVALID" ? "error" : "neutral"}>{entry.status}</VChip>
                                            <ThemedText style={{ fontSize: "12px", fontWeight: 700, direction: "ltr" }}>{entry.key}</ThemedText>
                                            <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{entry.scope}</ThemedText>
                                            {entry.currentVersion !== undefined && (
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                                    v{entry.currentVersion ?? 0} → v{entry.nextVersion ?? 1}
                                                </ThemedText>
                                            )}
                                            {entry.effectiveFrom && <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(entry.effectiveFrom)}</ThemedText>}
                                            {entry.reason && <ThemedText style={{ fontSize: "11px", color: "#dc2626" }}>{entry.reason}</ThemedText>}
                                        </ThemedView>
                                    ))}
                                </ThemedView>
                                {restorePreview.value.missingInBackup.length > 0 && (
                                    <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                        {t("Current keys missing from backup")}: {restorePreview.value.missingInBackup.join(", ")}
                                    </ThemedText>
                                )}
                                {restorePreview.value.summary.invalid > 0 && (
                                    <VAlert type="error" variant="tonal" density="compact">
                                        {t("Fix or remove invalid backup entries before applying.")}
                                    </VAlert>
                                )}
                                <VDivider />
                                <VTextarea
                                    label={t("Restore reason")}
                                    modelValue={restoreReason.value}
                                    onUpdate:modelValue={(value: string) => (restoreReason.value = value)}
                                    rows={2}
                                    hint={t("Required. Recorded in the audit log.")}
                                    persistentHint
                                />
                                <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Restore checklist")}</ThemedText>
                                    {RESTORE_CHECKS.map((check) => (
                                        <VCheckbox
                                            key={check.key}
                                            modelValue={restoreChecklist.value[check.key] === true}
                                            onUpdate:modelValue={(value: unknown) => (restoreChecklist.value = { ...restoreChecklist.value, [check.key]: Boolean(value) })}
                                            label={t(check.label)}
                                            density="compact"
                                            hideDetails
                                        />
                                    ))}
                                    {!restoreChecklistComplete.value && (
                                        <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all restore checklist items before applying.")}</ThemedText>
                                    )}
                                </ThemedView>
                                <VCheckbox
                                    modelValue={restoreConfirm.value}
                                    onUpdate:modelValue={(value: boolean | null) => (restoreConfirm.value = !!value)}
                                    label={t("I understand this creates new setting versions immediately.")}
                                    hideDetails
                                />
                                {restoreApplyError.value && <VAlert type="error" variant="tonal" density="compact">{restoreApplyError.value}</VAlert>}
                            </>
                        )}
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                            <VBtn variant="text" onClick={() => (restoreOpen.value = false)}>{t("Close")}</VBtn>
                            {restorePreview.value && (
                                <VBtn
                                    color="warning"
                                    loading={restoreApplying.value}
                                    disabled={!restoreConfirm.value || !restoreChecklistComplete.value || restoreReason.value.trim().length < 3 || restorePreview.value.summary.invalid > 0}
                                    onClick={() => void applyRestore()}
                                >
                                    {t("Apply restore")}
                                </VBtn>
                            )}
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(value: boolean) => (dialogOpen.value = value)} maxWidth="860px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px", flex: 1 }}>
                                {history.value.length > 0 ? t("Edit setting") : t("New setting")}
                            </ThemedText>
                            {history.value.length > 0 && <VChip size="small" variant="tonal" color="primary">v{history.value[0]?.version}</VChip>}
                        </ThemedView>

                        <VTextField
                            label={t("Setting key")}
                            modelValue={editKey.value}
                            onUpdate:modelValue={(value: string) => (editKey.value = value)}
                            readonly={history.value.length > 0}
                            hint={t("Example: checkout.support_config")}
                            persistentHint
                        />
                        <VTextarea
                            label={t("JSON value")}
                            modelValue={editValue.value}
                            onUpdate:modelValue={(value: string) => (editValue.value = value)}
                            rows={12}
                            autoGrow
                            style={{ fontFamily: "ui-monospace, monospace", direction: "ltr" }}
                        />
                        {editError.value && <VAlert type="error" variant="tonal" density="compact">{editError.value}</VAlert>}
                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Setting checklist")}</ThemedText>
                            {SETTING_EDIT_CHECKS.map((check) => (
                                <VCheckbox
                                    key={check.key}
                                    modelValue={editChecklist.value[check.key] === true}
                                    onUpdate:modelValue={(value: unknown) => (editChecklist.value = { ...editChecklist.value, [check.key]: Boolean(value) })}
                                    label={t(check.label)}
                                    density="compact"
                                    hideDetails
                                />
                            ))}
                            {!editChecklistComplete.value && (
                                <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all setting checklist items before saving.")}</ThemedText>
                            )}
                        </ThemedView>

                        {history.value.length > 0 && (
                            <>
                                <VDivider />
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>{t("Version history")}</ThemedText>
                                {history.value.map((row) => (
                                    <ThemedView
                                        key={row.id}
                                        style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(100,116,139,0.2)" }}
                                    >
                                        <VChip size="x-small" variant="tonal" color="primary">v{row.version}</VChip>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{formatDateTime(row.effectiveFrom)}</ThemedText>
                                        <ThemedText style={{ fontSize: "11px", opacity: 0.45 }}>{formatDateTime(row.updatedAt)}</ThemedText>
                                        <div style={{ flex: 1 }} />
                                        {row.version !== history.value[0]?.version && (
                                            <VBtn size="x-small" variant="text" onClick={() => (compareRow.value = row)}>{t("Compare with current")}</VBtn>
                                        )}
                                        <VBtn size="x-small" variant="text" onClick={() => restoreVersion(row)}>{t("Load into editor")}</VBtn>
                                    </ThemedView>
                                ))}
                            </>
                        )}

                        {compareRow.value && (
                            <VCard variant="tonal">
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "13px", flex: 1 }}>
                                            {t("Comparing")} v{compareRow.value.version} → v{history.value[0]?.version}
                                        </ThemedText>
                                        <VBtn size="x-small" variant="text" onClick={() => (compareRow.value = null)}>{t("Clear comparison")}</VBtn>
                                    </ThemedView>
                                    {diffRows.value.length === 0 && (
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{t("No differences in this version pair.")}</ThemedText>
                                    )}
                                    {diffRows.value.map((row) => (
                                        <ThemedView key={row.path} style={{ gap: "3px", padding: "6px 8px", borderRadius: "8px", background: "rgba(100,116,139,0.08)" }}>
                                            <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center" }}>
                                                <ThemedText style={{ fontSize: "11px", fontWeight: 700, direction: "ltr" }}>{row.path}</ThemedText>
                                                <VChip size="x-small" variant="tonal" color={row.kind === "ADDED" ? "success" : row.kind === "REMOVED" ? "error" : "warning"}>{row.kind}</VChip>
                                            </ThemedView>
                                            <ThemedText style={{ fontSize: "11px", direction: "ltr", opacity: 0.75 }}>{row.before} → {row.after}</ThemedText>
                                        </ThemedView>
                                    ))}
                                </VCardText>
                            </VCard>
                        )}

                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                            <VBtn variant="text" onClick={() => (dialogOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={saving.value} disabled={!editChecklistComplete.value} onClick={() => void save()}>{t("Save new version")}</VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default PlatformSettingsPage;
