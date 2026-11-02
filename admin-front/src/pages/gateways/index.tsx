import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VCard, VCardText, VCheckbox, VDialog, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { statusTone } from "@/components/Table/statusTone";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

const ROLLBACK_CHECKS = [
    { key: "TARGET_VERSION_VERIFIED", label: "Target version verified" },
    { key: "GATES_VERIFIED", label: "Rollback target gates verified" },
    { key: "IMPACT_REVIEWED", label: "Merchant and route impact reviewed" },
    { key: "ROLLBACK_AUTHORITY_CONFIRMED", label: "Rollback authority confirmed" },
] as const;

const SUMMARY_EXPORT_CHECKS = [
    { key: "PORTFOLIO_SCOPE_VERIFIED", label: "Gateway portfolio scope verified" },
    { key: "STATUS_BREAKDOWN_REVIEWED", label: "Status and kind breakdown reviewed" },
    { key: "VERSION_RISK_REVIEWED", label: "Version and risk posture reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

type Gateway = {
    id: string;
    code: string;
    name: string;
    operator: string;
    country: string;
    kind: string;
    verificationState: string;
    riskClass: string;
    status: string;
    aliases: string[];
    activeVersion: { id: string; versionNumber: number; state: string } | null;
    versions: { id: string; versionNumber: number; state: string; createdAt: string }[];
    versionCount: number;
    pendingVersion: { id: string; versionNumber: number; state: string; createdAt: string } | null;
    routeCount: number;
    credentialSetCount: number;
    statementSourceCount: number;
    routeHealth: { healthy: number; degraded: number; openBreaker: number };
    createdAt: string;
    updatedAt: string;
};

type GatewaySummary = {
    total: number;
    byStatus: Record<string, number>;
    byKind: Record<string, number>;
    byVerification: Record<string, number>;
    byRisk: Record<string, number>;
    pendingVersions: number;
    routes: { healthy: number; degraded: number; openBreaker: number };
};

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(date);
};

const kindTone = (kind: string) => {
    if (kind === "INTERNAL") return "primary" as const;
    if (kind === "AGGREGATOR") return "info" as const;
    if (kind === "DIRECT") return "success" as const;
    return "warning" as const;
};

const GatewaysPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const rows = ref<Gateway[]>([]);
    const total = ref(0);
    const summary = ref<GatewaySummary | null>(null);
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const createOpen = ref(false);
    const rollbackOpen = ref(false);
    const rollbackGateway = ref<Gateway | null>(null);
    const rollbackTarget = ref("");
    const rollbackReason = ref("");
    const rollbackChecklist = ref<Record<string, boolean>>({});
    const rollbackLoading = ref(false);
    const rollbackError = ref<string | null>(null);
    const creating = ref(false);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const summaryExportChecklist = ref<Record<string, boolean>>({});
    const form = ref({ code: "", name: "", operator: "", kind: "DIRECT", country: "LY", riskClass: "NORMAL" });

    const filterDefinitions = computed(() => tableRegistry.Gateways?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.gatewaysSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as GatewaySummary;
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

    const exportCsv = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.gatewaysExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.gateways ?? []) as Gateway[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No gateways match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "code", "name", "operator", "country", "kind", "verificationState", "riskClass", "status", "activeVersion", "pendingVersion", "versions", "routes", "healthyRoutes", "degradedRoutes", "openBreakers", "credentialSets", "statementSources", "createdAt"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.code,
                        row.name,
                        row.operator,
                        row.country,
                        row.kind,
                        row.verificationState,
                        row.riskClass,
                        row.status,
                        row.activeVersion ? `v${row.activeVersion.versionNumber}` : "",
                        row.pendingVersion ? `v${row.pendingVersion.versionNumber}` : "",
                        row.versionCount,
                        row.routeCount,
                        row.routeHealth.healthy,
                        row.routeHealth.degraded,
                        row.routeHealth.openBreaker,
                        row.credentialSetCount,
                        row.statementSourceCount,
                        row.createdAt,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `gateways-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
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

    const openCreate = () => {
        form.value = { code: "", name: "", operator: "", kind: "DIRECT", country: "LY", riskClass: "NORMAL" };
        createOpen.value = true;
    };

    const createGateway = async () => {
        if (creating.value) return;
        creating.value = true;
        try {
            const response = await api.post(urlsMap.gatewaysList, {
                code: form.value.code.trim().toLowerCase(),
                name: form.value.name.trim(),
                operator: form.value.operator.trim() || form.value.name.trim(),
                kind: form.value.kind,
                country: form.value.country.trim().toUpperCase() || "LY",
                riskClass: form.value.riskClass,
            });
            const payload = response.data?.data ?? response.data ?? {};
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Gateway created") });
            refreshAll();
            if (payload.id) {
                await router.push({ name: "GatewayWizard", params: { id: payload.id } });
            }
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            creating.value = false;
        }
    };

    const rollbackTargets = (row: Gateway) => row.versions.filter((version) => version.id !== row.activeVersion?.id);

    const openRollback = (row: Gateway) => {
        rollbackGateway.value = row;
        rollbackTarget.value = rollbackTargets(row)[0]?.id ?? "";
        rollbackReason.value = "";
        rollbackChecklist.value = {};
        rollbackError.value = null;
        rollbackOpen.value = true;
    };

    const rollbackChecklistComplete = computed(() => ROLLBACK_CHECKS.every((check) => rollbackChecklist.value[check.key] === true));

    const applyRollback = async () => {
        if (!rollbackGateway.value || rollbackLoading.value) return;
        if (!rollbackTarget.value) {
            rollbackError.value = t("Select a rollback target");
            return;
        }
        if (rollbackReason.value.trim().length < 3) {
            rollbackError.value = t("A rollback reason is required");
            return;
        }
        if (!rollbackChecklistComplete.value) {
            rollbackError.value = t("Complete all rollback checklist items before continuing");
            return;
        }
        rollbackLoading.value = true;
        rollbackError.value = null;
        try {
            await api.post(urlsMap.gatewayRollback(rollbackGateway.value.id), {
                targetVersionId: rollbackTarget.value,
                reason: rollbackReason.value.trim(),
                checklist: ROLLBACK_CHECKS.filter((check) => rollbackChecklist.value[check.key]).map((check) => check.key),
            });
            rollbackOpen.value = false;
            showSnackBar({ type: "success", message: t("Gateway rolled back") });
            refreshAll();
        } catch (error) {
            rollbackError.value = extractApiErrorMessage(error);
        } finally {
            rollbackLoading.value = false;
        }
    };

    const summaryExportChecklistComplete = computed(() => SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        if (!summaryExportChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all summary export checklist items before exporting") });
            return;
        }
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.gatewaysSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as GatewaySummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["pending_versions", snapshot.pendingVersions],
                ["routes_healthy", snapshot.routes.healthy],
                ["routes_degraded", snapshot.routes.degraded],
                ["routes_open_breaker", snapshot.routes.openBreaker],
            ];
            for (const [status, count] of Object.entries(snapshot.byStatus ?? {})) rows.push([`status.${status}.count`, count]);
            for (const [kind, count] of Object.entries(snapshot.byKind ?? {})) rows.push([`kind.${kind}.count`, count]);
            for (const [state, count] of Object.entries(snapshot.byVerification ?? {})) rows.push([`verification.${state}.count`, count]);
            for (const [risk, count] of Object.entries(snapshot.byRisk ?? {})) rows.push([`risk.${risk}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `gateway-summary-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("Gateway summary exported") });
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
            { label: t("Gateways"), value: String(data.total), tone: "info" as const },
            { label: t("Live"), value: String(data.byStatus?.LIVE ?? 0), tone: "success" as const },
            { label: t("Draft"), value: String(data.byStatus?.DRAFT ?? 0), tone: "neutral" as const },
            { label: t("Suspended"), value: String(data.byStatus?.SUSPENDED ?? 0), tone: (data.byStatus?.SUSPENDED ?? 0) > 0 ? "error" as const : "success" as const },
            { label: t("Verified"), value: String(data.byVerification?.VERIFIED ?? 0), tone: "success" as const },
            { label: t("Pending versions"), value: String(data.pendingVersions), tone: data.pendingVersions > 0 ? "warning" as const : "success" as const },
            { label: t("Open breakers"), value: String(data.routes?.openBreaker ?? 0), tone: (data.routes?.openBreaker ?? 0) > 0 ? "error" as const : "success" as const },
        ];
    });

    const headers = computed<TableHeader<Gateway>[]>(() => [
        {
            key: "gateway",
            label: "Gateway",
            sortKey: "code",
            value: (row) => `${row.code} ${row.name}`,
            Value: ({ row }: { row: Gateway }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{row.name}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.code} · {row.operator}</ThemedText>
                    {row.aliases?.length > 0 && <ThemedText style={{ fontSize: "10px", opacity: 0.45 }}>{row.aliases.join(", ")}</ThemedText>}
                </ThemedView>
            ),
        },
        {
            key: "kind",
            label: "Kind",
            sortKey: "kind",
            value: (row) => row.kind,
            Value: ({ row }: { row: Gateway }) => <StatusChip label={row.kind} tone={kindTone(row.kind)} size="small" />,
        },
        { key: "country", label: "Country", value: (row) => row.country },
        {
            key: "verification",
            label: "Verification",
            sortKey: "verificationState",
            value: (row) => row.verificationState,
            Value: ({ row }: { row: Gateway }) => <StatusChip label={row.verificationState} tone={row.verificationState === "VERIFIED" ? "success" : "warning"} size="small" />,
        },
        {
            key: "risk",
            label: "Risk",
            sortKey: "riskClass",
            value: (row) => row.riskClass,
            Value: ({ row }: { row: Gateway }) => <StatusChip label={row.riskClass} tone={statusTone(row.riskClass)} size="small" />,
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: Gateway }) => <StatusChip label={row.status} tone={statusTone(row.status)} size="small" />,
        },
        {
            key: "versions",
            label: "Versions",
            value: (row) => String(row.versionCount),
            Value: ({ row }: { row: Gateway }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px" }}>{row.versionCount}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>
                        {row.activeVersion ? `live v${row.activeVersion.versionNumber}` : row.pendingVersion ? `pending v${row.pendingVersion.versionNumber}` : t("No live version")}
                    </ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "routes",
            label: "Routes",
            value: (row) => String(row.routeCount),
            Value: ({ row }: { row: Gateway }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px" }}>{row.routeCount}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>
                        {row.routeHealth.openBreaker > 0 ? `${row.routeHealth.openBreaker} ${t("open breaker")}` : `${row.routeHealth.healthy} ${t("healthy")}`}
                    </ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "createdAt",
            label: "Created",
            sortKey: "createdAt",
            value: (row) => row.createdAt,
            Value: ({ row }: { row: Gateway }) => <ThemedText style={{ fontSize: "10px" }}>{formatDateTime(row.createdAt)}</ThemedText>,
        },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }: { row: Gateway }) => (
                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                    <VBtn size="small" variant="tonal" color="primary" onClick={() => void router.push({ name: "GatewayWizard", params: { id: row.id } })}>
                        {t("Open wizard")}
                    </VBtn>
                    {row.activeVersion && rollbackTargets(row).length > 0 && (
                        <VBtn size="small" variant="text" color="warning" onClick={() => openRollback(row)}>
                            {t("Rollback")}
                        </VBtn>
                    )}
                </ThemedView>
            ),
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Gateways")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportCsv()}>{t("Export CSV")}</VBtn>
                            <VBtn color="primary" variant="tonal" prependIcon="mdi-robot-outline" onClick={() => void router.push({ name: "GatewayAiImport" })}>{t("Smart AI Integration")}</VBtn>
                            <VBtn color="primary" variant="flat" prependIcon="mdi-plus" onClick={openCreate}>{t("New Gateway")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("A gateway version cannot go LIVE until its 12 go-live gates pass and a different checker approves it.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Gateway health")}</ThemedText>
                                <div style={{ flex: 1 }} />
                                <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} disabled={!summaryExportChecklistComplete.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                            </ThemedView>
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
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px" }}>
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
                                {Object.entries(summary.value.byKind ?? {}).map(([kind, count]) => (
                                    <StatusChip key={kind} label={`${kind}: ${count}`} tone={kindTone(kind)} size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
                )}

                <ApiTable<Gateway>
                    title={t("Gateway catalog")}
                    url={urlsMap.gatewaysList}
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
                    rowColor={(row) => (row.routeHealth.openBreaker > 0 ? "#dc2626" : row.riskClass === "HIGH_RISK" ? "#d97706" : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { gateways?: Gateway[]; rows?: Gateway[] };
                        return payload.gateways ?? payload.rows ?? [];
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

            <VDialog modelValue={rollbackOpen.value} onUpdate:modelValue={(value: boolean) => (rollbackOpen.value = value)} maxWidth="620px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Rollback gateway")}</ThemedText>
                        <VAlert type="warning" variant="tonal">
                            {t("Rollback changes the live version immediately. Verify the target version and operational impact first.")}
                        </VAlert>
                        <VSelect
                            label={t("Target version")}
                            items={(rollbackGateway.value ? rollbackTargets(rollbackGateway.value) : []).map((version) => ({
                                title: `v${version.versionNumber} · ${version.state}`,
                                value: version.id,
                            }))}
                            modelValue={rollbackTarget.value}
                            onUpdate:modelValue={(value: string) => (rollbackTarget.value = value)}
                        />
                        <VTextField
                            label={t("Rollback reason")}
                            modelValue={rollbackReason.value}
                            onUpdate:modelValue={(value: string) => (rollbackReason.value = value)}
                        />
                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Rollback checklist")}</ThemedText>
                            {ROLLBACK_CHECKS.map((check) => (
                                <VCheckbox
                                    key={check.key}
                                    modelValue={rollbackChecklist.value[check.key] === true}
                                    onUpdate:modelValue={(value: unknown) => (rollbackChecklist.value = { ...rollbackChecklist.value, [check.key]: Boolean(value) })}
                                    label={t(check.label)}
                                    density="compact"
                                    hideDetails
                                />
                            ))}
                            {!rollbackChecklistComplete.value && (
                                <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all rollback checklist items before continuing")}</ThemedText>
                            )}
                        </ThemedView>
                        {rollbackError.value && <VAlert type="error" variant="tonal" density="compact">{rollbackError.value}</VAlert>}
                        <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end", gap: "10px" }}>
                            <VBtn variant="text" onClick={() => (rollbackOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="warning" loading={rollbackLoading.value} disabled={!rollbackChecklistComplete.value} onClick={() => void applyRollback()}>{t("Rollback")}</VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog modelValue={createOpen.value} onUpdate:modelValue={(value: boolean) => (createOpen.value = value)} maxWidth="560px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>{t("New Gateway")}</ThemedText>
                        <VTextField label={t("Gateway code")} hint="lowercase letters, digits, - and _" modelValue={form.value.code} onUpdate:modelValue={(value: string) => (form.value.code = value)} />
                        <VTextField label={t("Gateway name")} modelValue={form.value.name} onUpdate:modelValue={(value: string) => (form.value.name = value)} />
                        <VTextField label={t("Operator")} modelValue={form.value.operator} onUpdate:modelValue={(value: string) => (form.value.operator = value)} />
                        <VSelect label={t("Kind")} items={["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]} modelValue={form.value.kind} onUpdate:modelValue={(value: string) => (form.value.kind = value)} />
                        <VTextField label={t("Country")} modelValue={form.value.country} onUpdate:modelValue={(value: string) => (form.value.country = value)} />
                        <VSelect label={t("Risk class")} items={["NORMAL", "HIGH_RISK"]} modelValue={form.value.riskClass} onUpdate:modelValue={(value: string) => (form.value.riskClass = value)} />
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (createOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={creating.value} disabled={!form.value.code.trim() || !form.value.name.trim()} onClick={() => void createGateway()}>{t("Create")}</VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default GatewaysPage;
