import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { VAlert, VBtn, VCard, VCardText, VCheckbox, VChip, VDialog, VDivider } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type AuditLog = {
    id: string;
    createdAt: string;
    actorId: string;
    actorEmail: string;
    role: string;
    action: string;
    entityType: string;
    entityId: string;
    beforeJson: Record<string, unknown> | null;
    afterJson: Record<string, unknown> | null;
    approvalRequestId: string | null;
};

const SUMMARY_EXPORT_CHECKS = [
    { key: "ACTIVITY_SCOPE_VERIFIED", label: "Activity scope verified" },
    { key: "ACTION_BREAKDOWN_REVIEWED", label: "Action breakdown reviewed" },
    { key: "ENTITY_BREAKDOWN_REVIEWED", label: "Entity breakdown reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

type AuditSummary = {
    total: number;
    last24h: number;
    actors: number;
    byAction: Record<string, number>;
    byEntityType: Record<string, number>;
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

const jsonPreview = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    try {
        const text = JSON.stringify(value);
        return text.length > 140 ? `${text.slice(0, 137)}…` : text;
    } catch {
        return String(value);
    }
};

const AuditLogsPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const rows = ref<AuditLog[]>([]);
    const total = ref(0);
    const summary = ref<AuditSummary | null>(null);
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const pageSize = ref(20);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const detailOpen = ref(false);
    const selected = ref<AuditLog | null>(null);

    const filterDefinitions = computed(() => tableRegistry.AuditLogs?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.auditLogsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as AuditSummary;
        } catch {
            summary.value = null;
        }
    };

    void loadSummary();

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };

    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.auditLogsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.auditLogs ?? []) as AuditLog[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No audit events match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "createdAt", "actorEmail", "role", "action", "entityType", "entityId", "approvalRequestId", "beforeJson", "afterJson"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.createdAt,
                        row.actorEmail || row.actorId,
                        row.role,
                        row.action,
                        row.entityType,
                        row.entityId,
                        row.approvalRequestId ?? "",
                        JSON.stringify(row.beforeJson ?? {}),
                        JSON.stringify(row.afterJson ?? {}),
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `audit-logs-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({
                type: payload.truncated ? "warning" : "success",
                message: payload.truncated
                    ? `${t("Exported")} ${rowsData.length} / ${payload.total}`
                    : `${t("Exported")} ${rowsData.length}`,
            });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            exportLoading.value = false;
        }
    };

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const summaryExportChecklistComplete = computed(() => !showChecklists || SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        if (!summaryExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all summary export checklist items before exporting") });
            return;
        }
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.auditLogsSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const snapshot = (payload.summary ?? payload) as AuditSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["last_24h", snapshot.last24h],
                ["actors", snapshot.actors],
            ];
            for (const [action, count] of Object.entries(snapshot.byAction ?? {})) rows.push([`action.${action}.count`, count]);
            for (const [entity, count] of Object.entries(snapshot.byEntityType ?? {})) rows.push([`entity.${entity}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `audit-log-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Audit log summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const summaryItems = computed(() => {
        const data = summary.value;
        if (!data) return [];
        const topAction = Object.entries(data.byAction ?? {}).sort((left, right) => right[1] - left[1])[0];
        return [
            { label: t("Audit events"), value: String(data.total), tone: "info" as const },
            { label: t("Last 24h"), value: String(data.last24h), tone: "primary" as const },
            { label: t("Actors"), value: String(data.actors), tone: "neutral" as const },
            { label: t("Top action"), value: topAction ? `${topAction[0]} (${topAction[1]})` : "—", tone: "warning" as const },
        ];
    });

    const openDetails = (row: AuditLog) => {
        selected.value = row;
        detailOpen.value = true;
    };

    const headers = computed<TableHeader<AuditLog>[]>(() => [
        {
            key: "createdAt",
            label: "Time",
            sortKey: "createdAt",
            value: (row) => row.createdAt,
            Value: ({ row }: { row: AuditLog }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.5 }}>{row.actorEmail || row.actorId}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "role",
            label: "Role",
            sortKey: "role",
            value: (row) => row.role,
            Value: ({ row }: { row: AuditLog }) => <StatusChip label={row.role} tone="neutral" size="x-small" />,
        },
        {
            key: "action",
            label: "Action",
            sortKey: "action",
            value: (row) => row.action,
            Value: ({ row }: { row: AuditLog }) => (
                <ThemedText style={{ fontSize: "12px", fontWeight: 700, direction: "ltr" }}>{row.action}</ThemedText>
            ),
        },
        {
            key: "entity",
            label: "Entity",
            sortKey: "entityType",
            value: (row) => `${row.entityType} ${row.entityId}`,
            Value: ({ row }: { row: AuditLog }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px" }}>{row.entityType}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.entityId}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "change",
            label: "Change",
            value: (row) => jsonPreview(row.afterJson),
            Value: ({ row }: { row: AuditLog }) => (
                <ThemedText style={{ fontSize: "10px", opacity: 0.7, direction: "ltr", maxWidth: "300px", wordBreak: "break-word" }}>
                    {jsonPreview(row.afterJson)}
                </ThemedText>
            ),
        },
        {
            key: "approval",
            label: "Approval",
            value: (row) => row.approvalRequestId ?? "",
            Value: ({ row }: { row: AuditLog }) =>
                row.approvalRequestId ? (
                    <VChip size="x-small" variant="tonal" color="warning" style={{ direction: "ltr" }}>{row.approvalRequestId.slice(0, 8)}</VChip>
                ) : (
                    <ThemedText style={{ opacity: 0.5 }}>—</ThemedText>
                ),
        },
        {
            key: "actions",
            label: "Inspect",
            sortable: false,
            Value: ({ row }: { row: AuditLog }) => (
                <VBtn size="small" variant="tonal" onClick={() => openDetails(row)}>{t("Inspect")}</VBtn>
            ),
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Audit Log")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Every privileged action is recorded here. Before and after payloads are read-only and cannot be edited or deleted from the portal.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Audit health")}</ThemedText>
                                <div style={{ flex: 1 }} />
                                <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} disabled={!summaryExportChecklistComplete.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                            </ThemedView>
                            {showChecklists && (
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
                            )}
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
                                {summaryItems.value.map((item) => (
                                    <VCard key={item.label} variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px" }}>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.62 }}>{item.label}</ThemedText>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px", direction: /^[A-Za-z0-9_ ()-]+$/.test(item.value) ? "ltr" : undefined }}>{item.value}</ThemedText>
                                        </VCardText>
                                    </VCard>
                                ))}
                            </ThemedView>
                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                {Object.entries(summary.value.byEntityType ?? {}).slice(0, 10).map(([entity, count]) => (
                                    <StatusChip key={entity} label={`${entity}: ${count}`} tone="neutral" size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
                )}

                <ApiTable<AuditLog>
                    title={t("Audit events")}
                    url={urlsMap.auditLogs}
                    localSearch={false}
                    xlsx={false}
                    showNumber={true}
                    numberOfItemsPerPage={pageSize.value}
                    numberOfItemsPerPageChoices={[
                        { label: "10", value: 10 },
                        { label: "20", value: 20 },
                        { label: "50", value: 50 },
                    ]}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => (search.value = value)}
                    headers={headers.value}
                    apiDataExtractor={(data) => {
                        const payload = data as { auditLogs?: AuditLog[]; rows?: AuditLog[] };
                        return payload.auditLogs ?? payload.rows ?? [];
                    }}
                    apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                    onData={(nextRows, nextTotal) => {
                        rows.value = nextRows;
                        total.value = nextTotal;
                    }}
                    setRefreshHook={(hook) => {
                        refreshHook.value = hook as typeof refreshHook.value;
                    }}
                    clearRefreshHook={() => {
                        refreshHook.value = null;
                    }}
                    onRefresh={(table, refresh) => {
                        void refresh({
                            queryParams: {
                                page: table.page,
                                pageSize: pageSize.value,
                                ...(search.value ? { search: search.value } : {}),
                                ...buildFilterQuery(filterDefinitions.value, filters.value),
                                ...(table.sortKey ? { sortKey: table.sortKey, sortDirection: table.sortDirection } : {}),
                            },
                        });
                    }}
                    TopSlot={() => (
                        <TableFilters
                            filters={filterDefinitions.value}
                            values={filters.value}
                            total={total.value}
                            onChange={onFiltersChanged}
                            onClear={onFiltersCleared}
                        />
                    )}
                />
            </ThemedView>

            <VDialog modelValue={detailOpen.value} onUpdate:modelValue={(value: boolean) => (detailOpen.value = value)} maxWidth="900px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        {selected.value ? (
                            <>
                                <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "18px", direction: "ltr" }}>{selected.value.action}</ThemedText>
                                    <StatusChip label={selected.value.role} tone="neutral" size="small" />
                                    <div style={{ flex: 1 }} />
                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{formatDateTime(selected.value.createdAt)}</ThemedText>
                                </ThemedView>
                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
                                    {[
                                        [t("Actor"), selected.value.actorEmail || selected.value.actorId],
                                        [t("Entity type"), selected.value.entityType],
                                        [t("Entity ID"), selected.value.entityId],
                                        [t("Approval request"), selected.value.approvalRequestId ?? "—"],
                                    ].map(([label, value]) => (
                                        <ThemedView key={label} style={{ gap: "2px" }}>
                                            <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{label}</ThemedText>
                                            <ThemedText style={{ fontSize: "12px", direction: "ltr", wordBreak: "break-word" }}>{value}</ThemedText>
                                        </ThemedView>
                                    ))}
                                </ThemedView>
                                <VDivider />
                                <ThemedText type="defaultSemiBold">{t("Before")}</ThemedText>
                                <pre style={{ margin: 0, padding: "10px 12px", borderRadius: "8px", background: "rgba(15,23,42,0.06)", fontSize: "11px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", maxHeight: "220px", overflow: "auto" }}>
                                    {JSON.stringify(selected.value.beforeJson ?? {}, null, 2)}
                                </pre>
                                <ThemedText type="defaultSemiBold">{t("After")}</ThemedText>
                                <pre style={{ margin: 0, padding: "10px 12px", borderRadius: "8px", background: "rgba(15,23,42,0.06)", fontSize: "11px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", maxHeight: "300px", overflow: "auto" }}>
                                    {JSON.stringify(selected.value.afterJson ?? {}, null, 2)}
                                </pre>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                                    <VBtn variant="text" onClick={() => (detailOpen.value = false)}>{t("Close")}</VBtn>
                                </ThemedView>
                            </>
                        ) : null}
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default AuditLogsPage;
