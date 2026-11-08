import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { VAlert, VBtn, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { useOpenQuery } from "@/composables/useOpenQuery";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { useSafeguard } from "@/components/guide/useSafeguard";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import { MetaPill } from "@/components/ui/MetaPill";
import { SectionFields } from "@/components/SectionFields";
import { CostModelBuilder } from "@/components/builders/CostModelBuilder";
import { MismatchPolicyBuilder, RouteScopeBuilder } from "@/components/builders/RouteScopeBuilder";
import { MaintenanceWindowsBuilder } from "@/components/builders/MaintenanceWindowsBuilder";
import { KeyValueSummary } from "@/components/builders/KeyValueSummary";
import {
    formatCostModel,
    isScopeEmpty,
    parseCostModel,
    parseMaintenanceWindows,
    parseMismatchPolicy,
    parseRouteScope,
    serializeCostModel,
    serializeMaintenanceWindows,
    serializeMismatchPolicy,
    serializeRouteScope,
    validateCostModel,
    validateMaintenanceWindows,
    validateMismatchPolicy,
    validateRouteScope,
    type CostModelState,
    type MaintenanceWindowRow,
    type MismatchPolicyState,
    type RouteScopeState,
} from "@/components/builders/model";
import { toCapView, type RouteCapRow, type RouteCapView } from "@/pages/finance/liquidity/routeCaps";
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
    mismatchPolicy?: unknown;
    maintenanceWindows?: unknown;
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
    const theme = useTheme();
    const showChecklists = areChecklistsVisible();
    const toneColor = (tone: "error" | "warning"): string =>
        (theme.current.value.colors as Record<string, string>)[tone] ?? "";
    const summary = ref<RouteSummary | null>(null);
    const routes = ref<GatewayRoute[]>([]);
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
        status: "ACTIVE",
    });
    const costState = ref<CostModelState>(parseCostModel({}));
    const scopeState = ref<RouteScopeState>(parseRouteScope({}));
    const mismatchState = ref<MismatchPolicyState>(parseMismatchPolicy({}));
    const windowRows = ref<MaintenanceWindowRow[]>([]);
    const routeCaps = ref<Record<string, RouteCapView>>({});
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
        void loadRouteCaps();
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

    /** Live daily-cap utilisation per route (needs `finance:read`; the badges are simply absent without it). */
    const loadRouteCaps = async () => {
        try {
            const response = await api.get(urlsMap.financeRouteCaps);
            const payload = response.data?.data ?? response.data ?? {};
            const rows = (payload.routes ?? []) as RouteCapRow[];
            routeCaps.value = Object.fromEntries(rows.map((row) => [row.routeId, toCapView(row)]));
        } catch {
            routeCaps.value = {};
        }
    };

    void loadSummary();
    void loadRouteCaps();

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
        if (!(await routeSafeguard.confirm())) return;
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
            status: route.status,
        };
        costState.value = parseCostModel(route.costModel);
        scopeState.value = parseRouteScope(route.scope);
        mismatchState.value = parseMismatchPolicy(route.mismatchPolicy);
        windowRows.value = parseMaintenanceWindows(route.maintenanceWindows);
        routeEditChecklist.value = {};
        dialogOpen.value = true;
    };

    const fetchRouteById = async (id: string): Promise<GatewayRoute | null> => {
        const response = await api.get(urlsMap.routeDetail(id));
        const payload = response.data?.data ?? response.data ?? {};
        const detail = payload.route ?? payload;
        if (!detail?.id) return null;
        return {
            ...detail,
            railCode: detail.railCode ?? detail.rail?.code ?? "",
            railName: detail.railName ?? detail.rail?.nameEn ?? "",
            gatewayCode: detail.gatewayCode ?? detail.gateway?.code ?? "",
            gatewayName: detail.gatewayName ?? detail.gateway?.name ?? "",
        } as GatewayRoute;
    };

    const { clearOpenQueryParam } = useOpenQuery<GatewayRoute>({
        loadedRows: routes,
        fetchById: fetchRouteById,
        onOpenRecord: openEditRoute,
    });

    const closeRouteEditDialog = () => {
        dialogOpen.value = false;
        void clearOpenQueryParam();
    };

    const routeEditChecklistComplete = computed(() => !showChecklists || ROUTE_EDIT_CHECKS.every((check) => routeEditChecklist.value[check.key] === true));
    const routeSafeguard = useSafeguard("sg-edit-route");

    const saveRoute = async () => {
        if (!editingRoute.value || actionLoading.value) {
            return;
        }
        if (validateCostModel(costState.value.form).length > 0) {
            showSnackBar({ type: "error", message: t("Fix the cost model errors before saving") });
            return;
        }
        if (validateRouteScope(scopeState.value.form).length > 0) {
            showSnackBar({ type: "error", message: t("Fix the scope errors before saving") });
            return;
        }
        if (validateMismatchPolicy(mismatchState.value) !== null) {
            showSnackBar({ type: "error", message: t("The mismatch tolerance must be a non-negative amount with up to 4 decimals") });
            return;
        }
        if (validateMaintenanceWindows(windowRows.value).length > 0) {
            showSnackBar({ type: "error", message: t("Fix the maintenance window errors before saving") });
            return;
        }
        const costModel = serializeCostModel(costState.value);
        const scope = serializeRouteScope(scopeState.value);
        // The API merges `scope` / `costModel` only when they are not empty, so an emptied scope cannot be saved as "no scope".
        const hadScope = Object.keys(parseRouteScope(editingRoute.value.scope).extras).length > 0 || !isScopeEmpty(parseRouteScope(editingRoute.value.scope).form);
        if (hadScope && Object.keys(scope).length === 0) {
            showSnackBar({ type: "warning", message: t("The route scope cannot be cleared through the API. Keep at least one restriction.") });
            return;
        }
        if (!routeEditChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all route checklist items before saving") });
            return;
        }
        if (!(await routeSafeguard.confirm())) return;
        actionLoading.value = true;
        try {
            const form = routeEditForm.value;
            await api.patch(urlsMap.routeDetail(editingRoute.value.id), {
                priority: Number(form.priority) || 0,
                weight: Number(form.weight) || 1,
                ...(form.minAmount.trim() ? { minAmount: form.minAmount.trim() } : {}),
                ...(form.maxAmount.trim() ? { maxAmount: form.maxAmount.trim() } : {}),
                ...(form.dailyCapAmount.trim() ? { dailyCapAmount: form.dailyCapAmount.trim() } : {}),
                ...(Object.keys(costModel).length ? { costModel } : {}),
                ...(Object.keys(scope).length ? { scope } : {}),
                // Both are sent even when empty: an empty list / policy is how an operator clears them.
                mismatchPolicy: serializeMismatchPolicy(mismatchState.value),
                maintenanceWindows: serializeMaintenanceWindows(windowRows.value),
                checklist: ROUTE_EDIT_CHECKS.filter((check) => routeEditChecklist.value[check.key]).map((check) => check.key),
            });
            if (form.status !== editingRoute.value.status) {
                await api.post(urlsMap.routeState(editingRoute.value.id), {
                    status: form.status,
                    checklist: ROUTE_EDIT_CHECKS.filter((check) => routeEditChecklist.value[check.key]).map((check) => check.key),
                });
            }
            closeRouteEditDialog();
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
        {
            key: "costModel",
            label: "Cost Model",
            value: (row) => formatCostModel(row.costModel),
            Value: ({ row }: { row: GatewayRoute }) => {
                const text = formatCostModel(row.costModel, { labels: { min: t("min"), max: t("max"), tiers: t("tiers"), tiered: t("Tiered") } });
                return text ? (
                    <MetaPill size="x-small" variant="tonal" color="primary"><span dir="ltr">{text}</span></MetaPill>
                ) : (
                    <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
                );
            },
        },
        {
            key: "minAmount",
            label: "Amount",
            value: (row) => `${row.minAmount ?? ""} - ${row.maxAmount ?? ""}`,
            Value: ({ row }: { row: GatewayRoute }) => (
                <div style={{ display: "flex", gap: "4px", alignItems: "center", flexWrap: "nowrap" }}>
                    <MoneyDisplay amount={row.minAmount ?? "0"} currency={"LYD"} size="sm" />
                    <span style={{ color: "var(--pg-ink-faint)" }}>–</span>
                    <MoneyDisplay amount={row.maxAmount ?? "0"} currency={"LYD"} size="sm" />
                </div>
            ),
        },
        {
            key: "dailyCapAmount",
            label: "Amount Due",
            value: (row) => row.dailyCapAmount,
            Value: ({ row }: { row: GatewayRoute }) => {
                const cap = routeCaps.value[row.id];
                return (
                    <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                        <MoneyDisplay amount={row.dailyCapAmount ?? "0"} currency={"LYD"} size="sm" />
                        {cap?.capped && (
                            <StatusBadge
                                status={cap.exhausted ? "DAILY_CAP_EXCEEDED" : "CAP_USED"}
                                label={cap.exhausted ? t("Daily cap reached") : `${cap.utilisationLabel} ${t("of daily cap")}`}
                                toneOverride={cap.tone}
                                showDot={false}
                            />
                        )}
                    </div>
                );
            },
        },
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
                <TableRowActions
                    primaryAction={{
                        label: t("Edit"),
                        icon: "mdi-pencil-outline",
                        onClick: () => openEditRoute(row),
                    }}
                />
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
                    <SummaryExportCard
                        title={t("Route health")}
                        metrics={metricItems.value}
                        exportLoading={summaryExportLoading.value}
                        exportDisabled={!summaryExportChecklistComplete.value}
                        onExport={() => void exportSummary()}
                    >
                        <FormChecklist
                            checks={[...SUMMARY_EXPORT_CHECKS]}
                            modelValue={summaryExportChecklist.value}
                            onUpdate:modelValue={(value: Record<string, boolean>) => (summaryExportChecklist.value = value)}
                            show={showChecklists}
                            title={t("Summary export checklist")}
                            complete={summaryExportChecklistComplete.value}
                            incompleteMessage={t("Complete all summary export checklist items before exporting")}
                        />
                    </SummaryExportCard>
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
                    rowColor={(row) => (row.healthState === "OPEN_BREAKER" ? toneColor("error") : row.healthState === "DEGRADED" ? toneColor("warning") : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { routes?: GatewayRoute[]; rows?: GatewayRoute[] };
                        return payload.routes ?? payload.rows ?? [];
                    }}
                    apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                    onData={(rows) => (routes.value = rows)}
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
                onUpdate:modelValue={(v: any) => {
                    dialogOpen.value = v;
                    if (!v) void clearOpenQueryParam();
                }}
                title={[t("Edit route"), editingRoute.value?.railCode, "→", editingRoute.value?.gatewayCode].filter(Boolean).join(" · ")}
                size="md"
                onSubmit={() => void saveRoute()}
                submitLabel={t("Save")}
                loading={actionLoading.value}
                v-slots={{
                    footer: () => (
                        <>
                            <VBtn variant="outlined" disabled={actionLoading.value} onClick={closeRouteEditDialog}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                variant="flat"
                                {...{ type: "submit" }}
                                loading={actionLoading.value}
                                disabled={!routeEditChecklistComplete.value}
                            >
                                {t("Save")}
                            </VBtn>
                        </>
                    ),
                }}
            >
                <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                    <MetaPill size="small" variant="tonal" color="primary">{editingRoute.value?.credentialPolicy ?? "-"}</MetaPill>
                    <StatusBadge status={editingRoute.value?.healthState ?? "-"} toneOverride={healthTone(editingRoute.value?.healthState ?? "") === "error" ? "danger" : (healthTone(editingRoute.value?.healthState ?? "") as any)} />
                </ThemedView>
                <SectionFields title={t("Routing controls")}>
                    <FormField label={t("Priority")} sensitiveMakerChecker>
                        <VTextField
                            type="number"
                            modelValue={String(routeEditForm.value.priority)}
                            onUpdate:modelValue={(v: string) => (routeEditForm.value.priority = Number(v) || 0)}
                        />
                    </FormField>
                    <FormField label={t("Weight")} sensitiveMakerChecker>
                        <VTextField
                            type="number"
                            modelValue={String(routeEditForm.value.weight)}
                            onUpdate:modelValue={(v: string) => (routeEditForm.value.weight = Number(v) || 1)}
                        />
                    </FormField>
                    <FormField label={t("Minimum amount")} sensitiveMakerChecker>
                        <VTextField
                            modelValue={routeEditForm.value.minAmount}
                            onUpdate:modelValue={(v: string) => (routeEditForm.value.minAmount = v)}
                        />
                    </FormField>
                    <FormField label={t("Maximum amount")} sensitiveMakerChecker>
                        <VTextField
                            modelValue={routeEditForm.value.maxAmount}
                            onUpdate:modelValue={(v: string) => (routeEditForm.value.maxAmount = v)}
                        />
                    </FormField>
                    <FormField label={t("Daily cap")} sensitiveMakerChecker>
                        <VTextField
                            modelValue={routeEditForm.value.dailyCapAmount}
                            onUpdate:modelValue={(v: string) => (routeEditForm.value.dailyCapAmount = v)}
                        />
                    </FormField>
                    <FormField label={t("Status")} sensitiveMakerChecker>
                        <VSelect
                            items={["ACTIVE", "PAUSED", "DRAINING"]}
                            modelValue={routeEditForm.value.status}
                            onUpdate:modelValue={(v: string) => (routeEditForm.value.status = v)}
                        />
                    </FormField>
                </SectionFields>
                <SectionFields title={t("Cost model")} subtitle={t("How the platform estimates the cost of routing a payment through this route.")}>
                    <div style={{ gridColumn: "1 / -1" }}>
                        <CostModelBuilder modelValue={costState.value} onUpdate:modelValue={(value: CostModelState) => (costState.value = value)} />
                    </div>
                </SectionFields>
                <SectionFields title={t("Scope and constraints")} subtitle={t("Restrict which traffic may use this route.")}>
                    <div style={{ gridColumn: "1 / -1" }}>
                        <RouteScopeBuilder modelValue={scopeState.value} onUpdate:modelValue={(value: RouteScopeState) => (scopeState.value = value)} />
                    </div>
                </SectionFields>
                <SectionFields title={t("Mismatch policy and maintenance")} subtitle={t("The tolerance applies to settlement reconciliation; a route is hidden from checkout during a maintenance window (UTC).")}>
                    <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: "12px" }}>
                        <MismatchPolicyBuilder modelValue={mismatchState.value} onUpdate:modelValue={(value: MismatchPolicyState) => (mismatchState.value = value)} />
                        {Object.keys(mismatchState.value.extras).length > 0 && (
                            <KeyValueSummary value={mismatchState.value.extras} />
                        )}
                        <MaintenanceWindowsBuilder modelValue={windowRows.value} onUpdate:modelValue={(value: MaintenanceWindowRow[]) => (windowRows.value = value)} />
                    </div>
                </SectionFields>
                <FormChecklist
                    checks={[...ROUTE_EDIT_CHECKS]}
                    modelValue={routeEditChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (routeEditChecklist.value = value)}
                    show={showChecklists}
                    title={t("Route edit checklist")}
                    complete={routeEditChecklistComplete.value}
                    incompleteMessage={t("Complete all route checklist items before saving")}
                />
            </FormModal>

            <FormModal
                modelValue={createOpen.value}
                onUpdate:modelValue={(v: any) => (createOpen.value = v)}
                title={t("Add Route")}
                size="md"
                onSubmit={() => void createRoute()}
                submitLabel={t("Create")}
                loading={creating.value}
                v-slots={{
                    footer: () => (
                        <>
                            <VBtn variant="outlined" disabled={creating.value} onClick={() => (createOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                variant="flat"
                                {...{ type: "submit" }}
                                loading={creating.value}
                                disabled={!routeForm.value.railId || !routeForm.value.gatewayId}
                            >
                                {t("Create")}
                            </VBtn>
                        </>
                    ),
                }}
            >
                <SectionFields title={t("Route pairing")}>
                    <FormField label={t("Rails")} required>
                        <VSelect
                            items={railOptions.value}
                            modelValue={routeForm.value.railId}
                            onUpdate:modelValue={(v: string) => (routeForm.value.railId = v)}
                        />
                    </FormField>
                    <FormField label={t("Gateways")} required>
                        <VSelect
                            items={gatewayOptions.value}
                            modelValue={routeForm.value.gatewayId}
                            onUpdate:modelValue={(v: string) => (routeForm.value.gatewayId = v)}
                        />
                    </FormField>
                    <FormField label={t("Priority")} sensitiveMakerChecker>
                        <VTextField
                            type="number"
                            modelValue={String(routeForm.value.priority)}
                            onUpdate:modelValue={(v: string) => (routeForm.value.priority = Number(v) || 0)}
                        />
                    </FormField>
                    <FormField label={t("Max Amount")} hint="optional, e.g. 5000.0000" sensitiveMakerChecker>
                        <VTextField
                            modelValue={routeForm.value.limitAmount}
                            onUpdate:modelValue={(v: string) => (routeForm.value.limitAmount = v)}
                        />
                    </FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default RoutesPage;
