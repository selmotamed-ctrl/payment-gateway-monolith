import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { VAlert, VBtn, VCheckbox, VSelect, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
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

import { FormModal } from "@/components/ui/FormModal";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
const SUMMARY_EXPORT_CHECKS = [
    { key: "ROUTE_SCOPE_VERIFIED", label: "Route portfolio scope verified" },
    { key: "STATUS_HEALTH_REVIEWED", label: "Status and health reviewed" },
    { key: "PAIR_SCOPE_REVIEWED", label: "Rail/gateway pair scope reviewed" },
    { key: "EXPORT_APPROVAL_CONFIRMED", label: "Export approval confirmed" },
] as const;

const ROUTE_EDIT_CHECKS = [
    { key: "PRIORITY_WEIGHT_REVIEWED", label: "Priority and weight reviewed" },
    { key: "LIMITS_CAP_VERIFIED", label: "Amount limits and daily cap verified" },
    { key: "SCOPE_COST_REVIEWED", label: "Scope and cost model reviewed" },
    { key: "ROUTING_IMPACT_REVIEWED", label: "Routing impact reviewed" },
] as const;

type GatewayRoute = {
    id: string;
    railCode: string;
    railName?: string;
    gatewayCode: string;
    gatewayName?: string;
    credentialPolicy: string;
    priority: number;
    weight: number;
    costModel: unknown;
    minAmount: string;
    maxAmount: string;
    dailyCapAmount: string;
    status: string;
    healthState: string;
    scope: unknown;
};

type RouteSummary = {
    total: number;
    byStatus: Record<string, number>;
    byHealth: Record<string, number>;
    railGatewayPairs: number;
    active: number;
    paused: number;
    draining: number;
    openBreaker: number;
};

const RoutesPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const summary = ref<RouteSummary | null>(null);
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

    const dialogOpen = ref(false);
    const routeEditChecklist = ref<Record<string, boolean>>({});
    const editingRoute = ref<GatewayRoute | null>(null);
    const actionLoading = ref(false);
    const routeEditForm = ref({
        priority: 0,
        weight: 100,
        minAmount: "",
        maxAmount: "",
        dailyCapAmount: "",
        costModel: "{}",
        scope: "{}",
        status: "ACTIVE",
    });
    const createOpen = ref(false);
    const creating = ref(false);
    const routeForm = ref({ railId: "", gatewayId: "", priority: 100, limitAmount: "" });
    const railOptions = ref<{ title: string; value: string }[]>([]);
    const gatewayOptions = ref<{ title: string; value: string }[]>([]);

    const filterDefinitions = computed(() => tableRegistry.GatewayRoutes?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.routesSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as RouteSummary;
        } catch {
            summary.value = null;
        }
    };

    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.routesExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.routes ?? []) as GatewayRoute[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No routes match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "railCode", "railName", "gatewayCode", "gatewayName", "credentialPolicy", "priority", "weight", "minAmount", "maxAmount", "dailyCapAmount", "status", "healthState"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.railCode,
                        row.railName ?? "",
                        row.gatewayCode,
                        row.gatewayName ?? "",
                        row.credentialPolicy,
                        row.priority,
                        row.weight,
                        row.minAmount,
                        row.maxAmount,
                        row.dailyCapAmount,
                        row.status,
                        row.healthState,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `routes-${new Date().toISOString().slice(0, 10)}.xlsx`,
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
        refreshHook.value?.reset();
        void loadSummary();
    };

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };

    void loadSummary();

    const openCreateRoute = async () => {
        createOpen.value = true;
        try {
            const [railsResponse, gatewaysResponse] = await Promise.all([
                api.get(urlsMap.railsList),
                api.get(urlsMap.gatewaysList),
            ]);
            const railsPayload = railsResponse.data?.data ?? railsResponse.data ?? {};
            const gatewaysPayload = gatewaysResponse.data?.data ?? gatewaysResponse.data ?? {};
            const rails = railsPayload.rails ?? railsPayload.rows ?? railsPayload.items ?? [];
            const gateways = gatewaysPayload.gateways ?? gatewaysPayload.rows ?? gatewaysPayload.items ?? [];
            railOptions.value = rails.map((rail: { id: string; code: string; nameEn?: string }) => ({
                title: `${rail.nameEn ?? rail.code} (${rail.code})`,
                value: rail.id,
            }));
            gatewayOptions.value = gateways.map((gateway: { id: string; code: string; name: string }) => ({
                title: `${gateway.name} (${gateway.code})`,
                value: gateway.id,
            }));
            routeForm.value = {
                railId: railOptions.value[0]?.value ?? "",
                gatewayId: gatewayOptions.value[0]?.value ?? "",
                priority: 100,
                limitAmount: "",
            };
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const createRoute = async () => {
        if (creating.value || !routeForm.value.railId || !routeForm.value.gatewayId) {
            return;
        }
        creating.value = true;
        try {
            await api.post(urlsMap.routesList, {
                railId: routeForm.value.railId,
                gatewayId: routeForm.value.gatewayId,
                credentialPolicy: "PLATFORM",
                environment: "live",
                priority: Number(routeForm.value.priority) || 0,
                ...(routeForm.value.limitAmount.trim() ? { limitAmount: routeForm.value.limitAmount.trim() } : {}),
            });
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Saved") });
            refreshAll();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            creating.value = false;
        }
    };

    const openEditRoute = (route: GatewayRoute) => {
        editingRoute.value = route;
        routeEditForm.value = {
            priority: Number(route.priority ?? 0),
            weight: Number(route.weight ?? 100),
            minAmount: route.minAmount ?? "",
            maxAmount: route.maxAmount ?? "",
            dailyCapAmount: route.dailyCapAmount ?? "",
            costModel: JSON.stringify(route.costModel ?? {}, null, 2),
            scope: JSON.stringify(route.scope ?? {}, null, 2),
            status: route.status,
        };
        routeEditChecklist.value = {};
        dialogOpen.value = true;
    };

    const routeEditChecklistComplete = computed(() => !showChecklists || ROUTE_EDIT_CHECKS.every((check) => routeEditChecklist.value[check.key] === true));

    const saveRoute = async () => {
        if (!editingRoute.value || actionLoading.value) {
            return;
        }
        let costModel: unknown;
        let scope: unknown;
        try {
            costModel = JSON.parse(routeEditForm.value.costModel || "{}");
            scope = JSON.parse(routeEditForm.value.scope || "{}");
        } catch {
            showSnackBar({ type: "error", message: t("Cost model and scope must be valid JSON") });
            return;
        }
        if (!routeEditChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all route checklist items before saving") });
            return;
        }
        actionLoading.value = true;
        try {
            const form = routeEditForm.value;
            await api.patch(urlsMap.routeDetail(editingRoute.value.id), {
                priority: Number(form.priority) || 0,
                weight: Number(form.weight) || 1,
                ...(form.minAmount.trim() ? { minAmount: form.minAmount.trim() } : {}),
                ...(form.maxAmount.trim() ? { maxAmount: form.maxAmount.trim() } : {}),
                ...(form.dailyCapAmount.trim() ? { dailyCapAmount: form.dailyCapAmount.trim() } : {}),
                ...(costModel && typeof costModel === "object" && Object.keys(costModel as object).length ? { costModel } : {}),
                ...(scope && typeof scope === "object" && Object.keys(scope as object).length ? { scope } : {}),
                checklist: ROUTE_EDIT_CHECKS.filter((check) => routeEditChecklist.value[check.key]).map((check) => check.key),
            });
            if (form.status !== editingRoute.value.status) {
                await api.post(urlsMap.routeState(editingRoute.value.id), {
                    status: form.status,
                    checklist: ROUTE_EDIT_CHECKS.filter((check) => routeEditChecklist.value[check.key]).map((check) => check.key),
                });
            }
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Update") });
            refreshAll();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const statusTone = (status: string) => {
        switch (status) {
            case "ACTIVE":
                return "success" as const;
            case "PAUSED":
                return "warning" as const;
            case "DRAINING":
                return "info" as const;
            default:
                return "neutral" as const;
        }
    };

    const healthTone = (health: string) => {
        switch (health) {
            case "HEALTHY":
                return "success" as const;
            case "DEGRADED":
                return "warning" as const;
            default:
                return "error" as const;
        }
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
            const response = await api.get(urlsMap.routesSummaryExport, {
                params: { checklist: SUMMARY_EXPORT_CHECKS.filter((check) => summaryExportChecklist.value[check.key]).map((check) => check.key).join(",") },
            });
            const snapshot = (response.data?.data ?? response.data ?? {}) as RouteSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["active", snapshot.active],
                ["paused", snapshot.paused],
                ["draining", snapshot.draining],
                ["open_breaker", snapshot.openBreaker],
                ["rail_gateway_pairs", snapshot.railGatewayPairs],
            ];
            for (const [status, count] of Object.entries(snapshot.byStatus ?? {})) rows.push([`status.${status}.count`, count]);
            for (const [state, count] of Object.entries(snapshot.byHealth ?? {})) rows.push([`health.${state}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `route-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Route summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };

    const metricItems = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { key: "routes", label: t("Routes"), value: String(data.total) },
            { key: "active", label: t("Active"), value: String(data.active), badge: t("Active"), badgeTone: "success" },
            { key: "paused", label: t("Paused"), value: String(data.paused), badge: (data.paused ?? 0) > 0 ? t("Watch") : t("Clear"), badgeTone: (data.paused ?? 0) > 0 ? "warning" : "success" },
            { key: "draining", label: t("Draining"), value: String(data.draining) },
            { key: "breakers", label: t("Open breakers"), value: String(data.openBreaker), badge: (data.openBreaker ?? 0) > 0 ? t("Critical") : t("Clear"), badgeTone: (data.openBreaker ?? 0) > 0 ? "danger" : "success" },
        ];
    });

    const headers: TableHeader<GatewayRoute>[] = [
        { key: "railCode", label: "Rail Code", value: (row) => row.railCode, Value: ({ row }) => <MonoRef value={row.railCode} /> },
        { key: "gatewayCode", label: "Gateway Code", value: (row) => row.gatewayCode, Value: ({ row }) => <MonoRef value={row.gatewayCode} /> },
        { key: "credentialPolicy", label: "Credential Policy", value: (row) => row.credentialPolicy },
        { key: "priority", label: "Priority", value: (row) => String(row.priority ?? "") },
        { key: "costModel", label: "Cost Model", value: (row) => (typeof row.costModel === "string" ? row.costModel : JSON.stringify(row.costModel ?? {})) },
        {
            key: "minAmount",
            label: "Amount",
            value: (row) => `${row.minAmount ?? ""} - ${row.maxAmount ?? ""}`,
            Value: ({ row }: { row: GatewayRoute }) => (
                <div style={{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" }}>
                    <MoneyDisplay amount={row.minAmount ?? "0"} currency={"LYD"} size="sm" />
                    <span style={{ color: "var(--pg-ink-faint)" }}>–</span>
                    <MoneyDisplay amount={row.maxAmount ?? "0"} currency={"LYD"} size="sm" />
                </div>
            ),
        },
        { key: "dailyCapAmount", label: "Amount Due", value: (row) => row.dailyCapAmount, Value: ({ row }) => <MoneyDisplay amount={row.dailyCapAmount ?? "0"} currency={"LYD"} size="sm" /> },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: GatewayRoute }) => <StatusBadge status={row.status} toneOverride={statusTone(row.status) as any} />,
        },
        {
            key: "healthState",
            label: "Invariant Status",
            Value: ({ row }: { row: GatewayRoute }) => (
                <StatusBadge status={row.healthState} toneOverride={healthTone(row.healthState) === "error" ? "danger" : (healthTone(row.healthState) as any)} />
            ),
        },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: GatewayRoute }) => (
                <VBtn
                    size="small"
                    variant="tonal"
                    onClick={() => openEditRoute(row)}
                >
                    {t("Update")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Routes")}
                    subtitle={t("Routing priority, limits, and circuit-breaker health.")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                            <VBtn color="primary" variant="flat" prependIcon={"mdi-plus"} onClick={() => void openCreateRoute()}>
                                {t("Add Route")}
                            </VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("A route binds a rail to a gateway. Health and circuit-breaker state are operational facts, not editable fields.")}
                </VAlert>

                {summary.value && (
                    <SurfaceCard variant="flat" style={{ borderRadius: "16px" }}>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Route health")}</ThemedText>
                                <div style={{ flex: 1 }} />
                                <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} disabled={!summaryExportChecklistComplete.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                            </ThemedView>
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
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
                            </ThemedView>
                            <MetricStrip items={metricItems.value} />
                        </SurfaceCardText>
                    </SurfaceCard>
                )}

                <ApiTable<GatewayRoute>
                    title={t("Route catalog")}
                    url={urlsMap.routesList}
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
                    headers={headers}
                    rowColor={(row) => (row.healthState === "OPEN_BREAKER" ? "#dc2626" : row.healthState === "DEGRADED" ? "#d97706" : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { routes?: GatewayRoute[]; rows?: GatewayRoute[] };
                        return payload.routes ?? payload.rows ?? [];
                    }}
                    apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
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
                            onChange={onFiltersChanged}
                            onClear={onFiltersCleared}
                        />
                    )}
                />
            </ThemedView>

            <FormModal
                modelValue={dialogOpen.value}
                onUpdate:modelValue={(v: any) => (dialogOpen.value = v)}
                title={[t("Edit route"), editingRoute.value?.railCode, "→", editingRoute.value?.gatewayCode].filter(Boolean).join(" · ")}
                size="md"
            >
<ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <StatusChip label={editingRoute.value?.credentialPolicy ?? "-"} tone="info" />
                            <StatusChip label={editingRoute.value?.healthState ?? "-"} tone="neutral" />
                        </ThemedView>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px" }}>
                            <VTextField
                                label={t("Priority")}
                                type="number"
                                modelValue={String(routeEditForm.value.priority)}
                                onUpdate:modelValue={(v: string) => (routeEditForm.value.priority = Number(v) || 0)}
                            />
                            <VTextField
                                label={t("Weight")}
                                type="number"
                                modelValue={String(routeEditForm.value.weight)}
                                onUpdate:modelValue={(v: string) => (routeEditForm.value.weight = Number(v) || 1)}
                            />
                            <VTextField
                                label={t("Minimum amount")}
                                modelValue={routeEditForm.value.minAmount}
                                onUpdate:modelValue={(v: string) => (routeEditForm.value.minAmount = v)}
                            />
                            <VTextField
                                label={t("Maximum amount")}
                                modelValue={routeEditForm.value.maxAmount}
                                onUpdate:modelValue={(v: string) => (routeEditForm.value.maxAmount = v)}
                            />
                            <VTextField
                                label={t("Daily cap")}
                                modelValue={routeEditForm.value.dailyCapAmount}
                                onUpdate:modelValue={(v: string) => (routeEditForm.value.dailyCapAmount = v)}
                            />
                            <VSelect
                                label={t("Status")}
                                items={["ACTIVE", "PAUSED", "DRAINING"]}
                                modelValue={routeEditForm.value.status}
                                onUpdate:modelValue={(v: string) => (routeEditForm.value.status = v)}
                            />
                            <div style={{ gridColumn: "span 2" }}>
                                <VTextarea
                                    label={t("Cost model (JSON)")}
                                    rows={4}
                                    modelValue={routeEditForm.value.costModel}
                                    onUpdate:modelValue={(v: string) => (routeEditForm.value.costModel = v)}
                                />
                            </div>
                            <div style={{ gridColumn: "span 2" }}>
                                <VTextarea
                                    label={t("Scope (JSON)")}
                                    rows={3}
                                    modelValue={routeEditForm.value.scope}
                                    onUpdate:modelValue={(v: string) => (routeEditForm.value.scope = v)}
                                />
                            </div>
                        </div>
                        {showChecklists && (
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Route edit checklist")}</ThemedText>
                                {ROUTE_EDIT_CHECKS.map((check) => (
                                    <VCheckbox
                                        key={check.key}
                                        modelValue={routeEditChecklist.value[check.key] === true}
                                        onUpdate:modelValue={(value: unknown) => (routeEditChecklist.value = { ...routeEditChecklist.value, [check.key]: Boolean(value) })}
                                        label={t(check.label)}
                                        density="compact"
                                        hideDetails
                                    />
                                ))}
                                {!routeEditChecklistComplete.value && (
                                    <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all route checklist items before saving")}</ThemedText>
                                )}
                            </ThemedView>
                        )}
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (dialogOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn color="primary" loading={actionLoading.value} disabled={!routeEditChecklistComplete.value} onClick={() => void saveRoute()}>
                                {t("Save")}
                            </VBtn>
                        </ThemedView>
            </FormModal>

            <FormModal
                modelValue={createOpen.value}
                onUpdate:modelValue={(v: any) => (createOpen.value = v)}
                title={t("Add Route")}
                size="md"
            >
<VSelect
                            label={t("Rails")}
                            items={railOptions.value}
                            modelValue={routeForm.value.railId}
                            onUpdate:modelValue={(v: string) => (routeForm.value.railId = v)}
                        />
                        <VSelect
                            label={t("Gateways")}
                            items={gatewayOptions.value}
                            modelValue={routeForm.value.gatewayId}
                            onUpdate:modelValue={(v: string) => (routeForm.value.gatewayId = v)}
                        />
                        <VTextField
                            label={t("Priority")}
                            type="number"
                            modelValue={String(routeForm.value.priority)}
                            onUpdate:modelValue={(v: string) => (routeForm.value.priority = Number(v) || 0)}
                        />
                        <VTextField
                            label={t("Max Amount")}
                            hint="optional, e.g. 5000.0000"
                            modelValue={routeForm.value.limitAmount}
                            onUpdate:modelValue={(v: string) => (routeForm.value.limitAmount = v)}
                        />
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (createOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                loading={creating.value}
                                disabled={!routeForm.value.railId || !routeForm.value.gatewayId}
                                onClick={() => void createRoute()}
                            >
                                {t("Create")}
                            </VBtn>
                        </ThemedView>
            </FormModal>
        </ScreenContainer>
    );
});

export default RoutesPage;
