import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { areChecklistsVisible } from "@/constants/env";
import { VAlert, VBtn, VCheckbox, VFileInput, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { NotificationTemplatesTab } from "./components/NotificationTemplatesTab";
import { CommunicationTab } from "./components/CommunicationTab";
import { SettingsSectionNav } from "./components/SettingsSectionNav";
import { SettingsHealthStrip } from "./components/SettingsHealthStrip";
import { SettingRow } from "./components/SettingRow";
import { SettingDetailDrawer } from "./components/SettingDetailDrawer";
import { NewSettingDrawer } from "./components/NewSettingDrawer";
import {
    SETTING_SECTIONS,
    SETTING_SECTION_BY_ID,
    createUnregisteredEntry,
    filterSettingEntries,
    mergeSettingEntries,
    resolveSettingDefinition,
    resolveSettingNamespace,
    settingSectionCounts,
    type PlatformSettingRow,
    type SettingEntry,
    type SettingSectionId,
    type SettingStatusFilter,
    type SettingsViewId,
} from "@/components/builders/model";

const BACKUP_EXPORT_CHECKS = [
    { key: "SETTINGS_SCOPE_VERIFIED", label: "Settings scope verified" },
    { key: "SENSITIVE_VALUES_REVIEWED", label: "Sensitive values reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const SUMMARY_EXPORT_CHECKS = [
    { key: "SETTINGS_SCOPE_VERIFIED", label: "Settings scope verified" },
    { key: "VERSIONS_REVIEWED", label: "Version counts reviewed" },
    { key: "EFFECTIVE_DATES_REVIEWED", label: "Effective dates reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const RESTORE_CHECKS = [
    { key: "BACKUP_REVIEWED", label: "Backup contents reviewed" },
    { key: "INVALID_ENTRIES_CLEARED", label: "Invalid entries cleared" },
    { key: "VERSION_CONFLICTS_REVIEWED", label: "Version conflicts reviewed" },
    { key: "RESTORE_SCOPE_CONFIRMED", label: "Restore scope confirmed" },
] as const;

const STATUS_FILTERS: Array<{ id: SettingStatusFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "live", label: "Live policies" },
    { id: "decision", label: "Decision records" },
    { id: "default", label: "Using defaults" },
    { id: "attention", label: "Needs attention" },
];

const isSectionId = (value: unknown): value is SettingSectionId =>
    typeof value === "string" && SETTING_SECTIONS.some((item) => item.id === value);
const isStatusFilter = (value: unknown): value is SettingStatusFilter =>
    typeof value === "string" && STATUS_FILTERS.some((item) => item.id === value);

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

const restoreTone = (status: string): "success" | "warning" | "danger" | "neutral" => {
    if (status === "ADDED") return "success";
    if (status === "CHANGED" || status === "MISSING_IN_BACKUP") return "warning";
    if (status === "INVALID" || status === "REMOVED") return "danger";
    return "neutral";
};

const PlatformSettingsPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const showChecklists = areChecklistsVisible();
    const canWrite = computed(() => hasOneOfAuthorities(["settings:write", "settings.write"]));

    const settings = ref<PlatformSettingRow[]>([]);
    const summary = ref<SettingsSummary | null>(null);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref(typeof route.query.q === "string" ? route.query.q : "");
    const section = ref<SettingsViewId>(isSectionId(route.query.section) ? (route.query.section as SettingsViewId) : "all");
    const statusFilter = ref<SettingStatusFilter>(isStatusFilter(route.query.status) ? (route.query.status as SettingStatusFilter) : "all");
    const tab = ref<"settings" | "templates" | "communication">("settings");
    const detailOpen = ref(false);
    const selectedEntry = ref<SettingEntry | null>(null);
    const detailOpenedAt = ref(0);
    const newOpen = ref(false);
    const newOpenedAt = ref(0);

    const exportLoading = ref(false);
    const backupExportOpen = ref(false);
    const backupExportChecklist = ref<Record<string, boolean>>({});
    const summaryExportLoading = ref(false);
    const summaryExportOpen = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});

    const restoreOpen = ref(false);
    const restoreLoading = ref(false);
    const restoreError = ref<string | null>(null);
    const restoreFileName = ref("");
    const restorePreview = ref<{
        summary: { backupKeys: number; added: number; changed: number; unchanged: number; invalid: number; missingInBackup: number };
        entries: Array<{ index: number; key: string; scope: string; status: string; reason?: string; currentVersion?: number | null; nextVersion?: number; effectiveFrom?: string | null; backupValue?: Record<string, unknown>; currentValue?: Record<string, unknown> | null }>;
        missingInBackup: string[];
    } | null>(null);
    const restoreConfirm = ref(false);
    const restoreChecklist = ref<Record<string, boolean>>({});
    const restoreReason = ref("");
    const restoreApplying = ref(false);
    const restoreApplyError = ref<string | null>(null);

    const backupExportChecklistComplete = computed(() => !showChecklists || BACKUP_EXPORT_CHECKS.every((check) => backupExportChecklist.value[check.key] === true));
    const summaryExportChecklistComplete = computed(() => !showChecklists || SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));
    const restoreChecklistComplete = computed(() => !showChecklists || RESTORE_CHECKS.every((check) => restoreChecklist.value[check.key] === true));

    const entries = computed(() => mergeSettingEntries(settings.value));
    const sectionCounts = computed(() => settingSectionCounts(entries.value));
    const filtered = computed(() =>
        filterSettingEntries(entries.value, {
            query: search.value,
            section: section.value,
            status: statusFilter.value,
            translate: t,
        }),
    );
    const statusCounts = computed(() => ({
        all: entries.value.length,
        live: entries.value.filter((entry) => entry.displayStatus === "RUNTIME" || entry.displayStatus === "DYNAMIC").length,
        decision: entries.value.filter((entry) => entry.displayStatus === "DECISION").length,
        default: entries.value.filter((entry) => entry.displayStatus === "UNCONFIGURED").length,
        attention: entries.value.filter((entry) => entry.displayStatus === "UNREGISTERED" || entry.displayStatus === "DEPRECATED" || entry.displayStatus === "FALLBACK").length,
    }));

    const groups = computed(() => {
        const map = new Map<SettingSectionId, SettingEntry[]>();
        for (const entry of filtered.value) {
            const list = map.get(entry.definition.section) ?? [];
            list.push(entry);
            map.set(entry.definition.section, list);
        }
        return SETTING_SECTIONS.filter((item) => map.has(item.id)).map((item) => ({
            section: item,
            entries: map.get(item.id)!,
        }));
    });

    const activeSection = computed(() => (section.value === "all" ? null : SETTING_SECTION_BY_ID[section.value]));
    const unconfiguredEntries = computed(() => entries.value.filter((entry) => entry.displayStatus === "UNCONFIGURED"));
    const hasFilters = computed(() => search.value.trim().length > 0 || section.value !== "all" || statusFilter.value !== "all");

    const updateQuery = (patch: Record<string, string | undefined>) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries({ ...route.query, ...patch })) {
            if (typeof value === "string" && value.length > 0) next[key] = value;
        }
        void router.replace({ query: next });
    };

    const load = async (openKey?: string | null) => {
        loading.value = true;
        error.value = null;
        try {
            const [listResponse, summaryResponse] = await Promise.all([
                api.get(urlsMap.settings),
                api.get(urlsMap.settingsSummary),
            ]);
            const listPayload = listResponse.data?.data ?? listResponse.data ?? {};
            const summaryPayload = summaryResponse.data?.data ?? summaryResponse.data ?? {};
            settings.value = (listPayload.settings ?? []) as PlatformSettingRow[];
            summary.value = (summaryPayload.summary ?? summaryPayload) as SettingsSummary;
            const wanted = openKey ?? (typeof route.query.open === "string" ? route.query.open : null);
            if (wanted) {
                const found = mergeSettingEntries(settings.value).find((entry) => entry.key === wanted);
                if (found) {
                    selectedEntry.value = found;
                    window.setTimeout(() => {
                        detailOpen.value = true;
                        detailOpenedAt.value = Date.now();
                    }, 0);
                }
            }
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };
    void load();

    const selectSection = (value: SettingsViewId) => {
        section.value = value;
        updateQuery({ section: value === "all" ? undefined : value });
    };

    const setStatusFilter = (value: SettingStatusFilter) => {
        statusFilter.value = value;
        updateQuery({ status: value === "all" ? undefined : value });
    };

    const openEntry = (entry: SettingEntry) => {
        selectedEntry.value = entry;
        window.setTimeout(() => {
            detailOpen.value = true;
            detailOpenedAt.value = Date.now();
            updateQuery({ open: entry.key });
        }, 0);
    };

    const openKey = (key: string) => {
        const found = entries.value.find((entry) => entry.key === key);
        openEntry(found ?? createUnregisteredEntry(key));
    };

    const closeDetail = (value: boolean) => {
        // Vuetify can emit an initial false while the temporary drawer is mounting.
        if (!value && Date.now() - detailOpenedAt.value < 250) return;
        detailOpen.value = value;
        if (!value) updateQuery({ open: undefined });
    };

    const openNew = () => {
        window.setTimeout(() => {
            newOpen.value = true;
            newOpenedAt.value = Date.now();
        }, 0);
    };

    const selectNew = (entry: SettingEntry) => {
        newOpen.value = false;
        selectedEntry.value = entry;
        window.setTimeout(() => {
            detailOpen.value = true;
            detailOpenedAt.value = Date.now();
            updateQuery({ open: entry.key });
        }, 0);
    };

    const createCustom = (key: string) => {
        newOpen.value = false;
        const found = entries.value.find((entry) => entry.key === key);
        selectedEntry.value = found ?? createUnregisteredEntry(key);
        window.setTimeout(() => {
            detailOpen.value = true;
            detailOpenedAt.value = Date.now();
            updateQuery({ open: key });
        }, 0);
    };

    const saved = async () => {
        const key = selectedEntry.value?.key ?? null;
        await load(key);
    };

    const reviewDefaults = () => {
        search.value = "";
        section.value = "all";
        setStatusFilter("default");
    };

    const reviewAttention = () => {
        search.value = "";
        section.value = "all";
        setStatusFilter("attention");
    };

    const clearFilters = () => {
        search.value = "";
        section.value = "all";
        statusFilter.value = "all";
        updateQuery({ q: undefined, section: undefined, status: undefined });
    };

    const metricItems = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { key: "keys", label: t("Setting keys"), value: String(data.keys) },
            { key: "versions", label: t("Versions"), value: String(data.versions) },
            { key: "updated", label: t("Updated last 24h"), value: String(data.updatedLast24h), badge: data.updatedLast24h > 0 ? t("Active") : t("Clear"), badgeTone: data.updatedLast24h > 0 ? "success" : "neutral" },
            { key: "future", label: t("Future effective"), value: String(data.futureEffective), badge: data.futureEffective > 0 ? t("Watch") : t("Clear"), badgeTone: data.futureEffective > 0 ? "warning" : "success" },
        ];
    });

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
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `platform-settings-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Platform settings summary exported") });
            summaryExportOpen.value = false;
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const exportBackup = async () => {
        if (exportLoading.value) return;
        if (!backupExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all backup export checklist items before exporting") });
            return;
        }
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.settingsExport, {
                params: { checklist: BACKUP_EXPORT_CHECKS.filter((check) => backupExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
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
            backupExportOpen.value = false;
            backupExportChecklist.value = {};
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

    const restoreMetricItems = computed<MetricItem[]>(() => {
        const preview = restorePreview.value;
        if (!preview) return [];
        return [
            { key: "backupKeys", label: t("Backup keys"), value: String(preview.summary.backupKeys) },
            { key: "added", label: t("Added"), value: String(preview.summary.added) },
            { key: "changed", label: t("Changed"), value: String(preview.summary.changed) },
            { key: "unchanged", label: t("Unchanged"), value: String(preview.summary.unchanged) },
            { key: "invalid", label: t("Invalid"), value: String(preview.summary.invalid), badge: preview.summary.invalid > 0 ? t("Critical") : t("Clear"), badgeTone: preview.summary.invalid > 0 ? "danger" : "success" },
            { key: "missing", label: t("Missing in backup"), value: String(preview.summary.missingInBackup), badge: preview.summary.missingInBackup > 0 ? t("Watch") : t("Clear"), badgeTone: preview.summary.missingInBackup > 0 ? "warning" : "success" },
        ];
    });

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Platform Settings")}
                    subtitle={t("Searchable, versioned configuration with a reader, effect and hint for every setting.")}
                    end={() => tab.value !== "settings" ? null : (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={loading.value} onClick={() => void load()}>
                                {t("Refresh")}
                            </VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" onClick={() => (backupExportOpen.value = true)}>
                                {t("Export backup")}
                            </VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-chart-box-outline" onClick={() => (summaryExportOpen.value = true)}>
                                {t("Export summary")}
                            </VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-backup-restore" onClick={openRestore}>
                                {t("Restore preview")}
                            </VBtn>
                            {canWrite.value && (
                                <VBtn color="primary" variant="flat" prependIcon="mdi-plus" onClick={openNew}>
                                    {t("New setting")}
                                </VBtn>
                            )}
                        </ThemedView>
                    )}
                />

                <SegmentedTabs
                    modelValue={tab.value}
                    onUpdate:modelValue={(value: string) => (tab.value = value === "templates" ? "templates" : value === "communication" ? "communication" : "settings")}
                    tabs={[
                        { value: "settings", label: t("Platform settings") },
                        { value: "communication", label: t("Communication") },
                        { value: "templates", label: t("Notification templates") },
                    ]}
                    ariaLabel={t("Platform settings sections")}
                />

                {tab.value === "templates" ? (
                    <NotificationTemplatesTab />
                ) : tab.value === "communication" ? (
                    <CommunicationTab onEdit={openKey} />
                ) : error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : loading.value ? (
                    <StateView loading={true} />
                ) : (
                    <>
                        <VAlert type="info" variant="tonal">
                            {t("Every save creates a new immutable version. The effective version is the highest version whose effective date has passed; a future version is shown as scheduled.")}
                        </VAlert>
                        <SettingsHealthStrip entries={entries.value} onReviewDefaults={reviewDefaults} onReviewAttention={reviewAttention} />

                        <SurfaceCard bodyPadding="14px 16px">
                            <div class="pg-settings-toolbar">
                                <VTextField
                                    modelValue={search.value}
                                    onUpdate:modelValue={(value: string) => (search.value = value)}
                                    prependInnerIcon="mdi-magnify"
                                    label={t("Search settings")}
                                    placeholder={t("Search by name, key, description, reader, effect or hint…")}
                                    density="compact"
                                    hideDetails
                                    clearable
                                    aria-label={t("Search settings")}
                                />
                                <div class="pg-settings-toolbar__filters" role="group" aria-label={t("Filter by status")}>
                                    {STATUS_FILTERS.map((filter) => (
                                        <VBtn
                                            key={filter.id}
                                            size="small"
                                            variant={statusFilter.value === filter.id ? "tonal" : "text"}
                                            color={statusFilter.value === filter.id ? "primary" : undefined}
                                            onClick={() => setStatusFilter(filter.id)}
                                        >
                                            {t(filter.label)} <span class="pg-settings-toolbar__count">{statusCounts.value[filter.id]}</span>
                                        </VBtn>
                                    ))}
                                </div>
                            </div>
                        </SurfaceCard>

                        <div class="pg-settings-layout">
                            <SettingsSectionNav modelValue={section.value} counts={sectionCounts.value} onUpdate:modelValue={selectSection} ariaLabel={t("Settings sections")} />
                            <section id="pg-settings-results" role="tabpanel" aria-live="polite" class="pg-settings-results">
                                <div class="pg-settings-results__header">
                                    <div>
                                        <h2 class="pg-settings-results__title">
                                            {activeSection.value ? t(activeSection.value.title) : t("All settings")}
                                        </h2>
                                        <p class="pg-settings-results__subtitle">
                                            {activeSection.value ? t(activeSection.value.description) : t("Every known setting, grouped by the part of the platform it affects.")}
                                        </p>
                                    </div>
                                    <div class="pg-settings-results__meta">
                                        <span>{t("{count} settings", { count: filtered.value.length })}</span>
                                        {hasFilters.value && <VBtn size="x-small" variant="text" onClick={clearFilters}>{t("Clear filters")}</VBtn>}
                                    </div>
                                </div>

                                {groups.value.length === 0 ? (
                                    <SurfaceCard bodyPadding="18px">
                                        <StateView
                                            empty={true}
                                            emptyTitle={t("No settings match")}
                                            emptyDescription={t("Try a different search, section or status filter.")}
                                            minHeight="160px"
                                        />
                                    </SurfaceCard>
                                ) : (
                                    groups.value.map((group) => (
                                        <div key={group.section.id} class="pg-settings-group">
                                            <div class="pg-settings-group__header">
                                                <div>
                                                    <h3 class="pg-settings-group__title">{t(group.section.title)}</h3>
                                                    <p class="pg-settings-group__subtitle">{t(group.section.description)}</p>
                                                </div>
                                                <span class="pg-settings-group__count">{t("{count} settings", { count: group.entries.length })}</span>
                                            </div>
                                            <SurfaceCard noPadding>
                                                {group.entries.map((entry) => (
                                                    <SettingRow key={entry.key} entry={entry} onOpen={openEntry} />
                                                ))}
                                            </SurfaceCard>
                                        </div>
                                    ))
                                )}
                            </section>
                        </div>
                    </>
                )}
            </ThemedView>

            <SettingDetailDrawer
                modelValue={detailOpen.value}
                onUpdate:modelValue={closeDetail}
                entry={selectedEntry.value}
                canWrite={canWrite.value}
                showChecklists={showChecklists}
                onSaved={() => void saved()}
                onOpenKey={openKey}
            />

            <NewSettingDrawer
                modelValue={newOpen.value}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value && Date.now() - newOpenedAt.value < 250) return;
                    newOpen.value = value;
                }}
                entries={unconfiguredEntries.value}
                onSelect={selectNew}
                onCreateCustom={createCustom}
            />

            <FormModal
                modelValue={backupExportOpen.value}
                onUpdate:modelValue={(value: boolean) => (backupExportOpen.value = value)}
                title={t("Export settings backup")}
                size="md"
                loading={exportLoading.value}
                submitLabel={t("Export")}
                onSubmit={() => void exportBackup()}
            >
                <VAlert type="warning" variant="tonal">{t("The backup contains versioned platform settings and may contain sensitive operational values. Handle it as confidential.")}</VAlert>
                <FormChecklist
                    checks={[...BACKUP_EXPORT_CHECKS]}
                    modelValue={backupExportChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (backupExportChecklist.value = value)}
                    show={showChecklists}
                    title={t("Backup export checklist")}
                    complete={backupExportChecklistComplete.value}
                    incompleteMessage={t("Complete all backup export checklist items before exporting")}
                />
            </FormModal>

            <FormModal
                modelValue={summaryExportOpen.value}
                onUpdate:modelValue={(value: boolean) => (summaryExportOpen.value = value)}
                title={t("Export settings summary")}
                size="md"
                loading={summaryExportLoading.value}
                submitLabel={t("Export summary")}
                onSubmit={() => void exportSummary()}
            >
                <VAlert type="info" variant="tonal">{t("The summary contains counts and effective-date health, not the values themselves.")}</VAlert>
                <MetricStrip items={metricItems.value} />
                <FormChecklist
                    checks={[...SUMMARY_EXPORT_CHECKS]}
                    modelValue={summaryExportChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (summaryExportChecklist.value = value)}
                    show={showChecklists}
                    title={t("Summary export checklist")}
                    complete={summaryExportChecklistComplete.value}
                    incompleteMessage={t("Complete all summary export checklist items before exporting")}
                />
            </FormModal>

            <FormModal
                modelValue={restoreOpen.value}
                onUpdate:modelValue={(value: boolean) => (restoreOpen.value = value)}
                title={t("Restore preview")}
                size="lg"
                onSubmit={() => void applyRestore()}
                submitLabel={t("Apply restore")}
                loading={restoreApplying.value}
                errorMessage={restoreApplyError.value ?? restoreError.value ?? ""}
                v-slots={{
                    footer: () => (
                        <>
                            <VBtn variant="outlined" disabled={restoreApplying.value} onClick={() => (restoreOpen.value = false)}>{t("Close")}</VBtn>
                            {restorePreview.value && (
                                <VBtn
                                    color="warning"
                                    variant="flat"
                                    {...{ type: "submit" }}
                                    loading={restoreApplying.value}
                                    disabled={!restoreConfirm.value || !restoreChecklistComplete.value || restoreReason.value.trim().length < 3 || restorePreview.value.summary.invalid > 0}
                                >
                                    {t("Apply restore")}
                                </VBtn>
                            )}
                        </>
                    ),
                }}
            >
                <VAlert type="info" variant="tonal">
                    {t("Choose a settings backup JSON. This preview does not write anything.")}
                </VAlert>
                <FormField label={t("Settings backup JSON")}>
                    <VFileInput
                        {...{ accept: ".json,application/json" }}
                        modelValue={null}
                        prependIcon="mdi-file-upload-outline"
                        onUpdate:modelValue={(value: File | File[] | null) => void previewBackup(value)}
                    />
                </FormField>
                {restoreLoading.value && <StateView loading={true} minHeight="120px" />}
                {restorePreview.value && (
                    <>
                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{restoreFileName.value}</ThemedText>
                        <MetricStrip items={restoreMetricItems.value} />
                        <ThemedView style={{ gap: "6px" }}>
                            {restorePreview.value.entries.map((entry) => {
                                const definition = resolveSettingDefinition(entry.key);
                                const namespace = resolveSettingNamespace(definition.namespaceId);
                                return (
                                    <ThemedView key={`${entry.index}-${entry.key}`} style={{ display: "flex", flexDirection: "column", gap: "3px", padding: "8px 10px", borderRadius: "var(--pg-radius-sm)", border: "1px solid var(--pg-border-subtle)" }}>
                                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                                            <StatusBadge status={entry.status} toneOverride={restoreTone(entry.status)} showDot={false} />
                                            <ThemedText style={{ fontSize: "12.5px", fontWeight: 600 }}>{t(namespace?.title ?? definition.summary)}</ThemedText>
                                            <ThemedText style={{ fontSize: "10.5px", opacity: 0.6, direction: "ltr" }}>{entry.key}</ThemedText>
                                            <div style={{ flex: 1 }} />
                                            {entry.currentVersion !== undefined && (
                                                <ThemedText style={{ fontSize: "11px", opacity: 0.7 }}>v{entry.currentVersion ?? 0} → v{entry.nextVersion ?? 1}</ThemedText>
                                            )}
                                            {entry.effectiveFrom && <ThemedText style={{ fontSize: "10.5px", opacity: 0.55 }}>{formatDateTime(entry.effectiveFrom)}</ThemedText>}
                                        </ThemedView>
                                        <ThemedText style={{ fontSize: "11.5px", opacity: 0.72 }}>{t(definition.summary)}</ThemedText>
                                        {entry.reason && <ThemedText style={{ fontSize: "11px", color: "var(--pg-status-danger-text)" }}>{entry.reason}</ThemedText>}
                                    </ThemedView>
                                );
                            })}
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
                        <VTextarea
                            modelValue={restoreReason.value}
                            onUpdate:modelValue={(value: string) => (restoreReason.value = value)}
                            label={t("Restore reason")}
                            hint={t("Required. Recorded in the audit log.")}
                            rows={2}
                        />
                        <FormChecklist
                            checks={[...RESTORE_CHECKS]}
                            modelValue={restoreChecklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (restoreChecklist.value = value)}
                            show={showChecklists}
                            title={t("Restore checklist")}
                            complete={restoreChecklistComplete.value}
                            incompleteMessage={t("Complete all restore checklist items before applying.")}
                        />
                        <VCheckbox
                            modelValue={restoreConfirm.value}
                            onUpdate:modelValue={(value: boolean | null) => (restoreConfirm.value = !!value)}
                            label={t("I understand this creates new setting versions immediately.")}
                            hideDetails
                        />
                    </>
                )}
            </FormModal>
        </ScreenContainer>
    );
});

export default PlatformSettingsPage;
