import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VDialog, VSelect, VTextField, VTextarea } from "vuetify/components";
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
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

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
    const summary = ref<RouteSummary | null>(null);
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const dialogOpen = ref(false);
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
        dialogOpen.value = true;
    };

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
            });
            if (form.status !== editingRoute.value.status) {
                await api.post(urlsMap.routeState(editingRoute.value.id), { status: form.status });
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

    const headers: TableHeader<GatewayRoute>[] = [
        { key: "railCode", label: "Rail Code", value: (row) => row.railCode },
        { key: "gatewayCode", label: "Gateway Code", value: (row) => row.gatewayCode },
        { key: "credentialPolicy", label: "Credential Policy", value: (row) => row.credentialPolicy },
        { key: "priority", label: "Priority", value: (row) => String(row.priority ?? "") },
        { key: "costModel", label: "Cost Model", value: (row) => (typeof row.costModel === "string" ? row.costModel : JSON.stringify(row.costModel ?? {})) },
        { key: "minAmount", label: "Amount", value: (row) => `${row.minAmount ?? ""} - ${row.maxAmount ?? ""}` },
        { key: "dailyCapAmount", label: "Amount Due", value: (row) => row.dailyCapAmount },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: GatewayRoute }) => <StatusChip label={row.status} tone={statusTone(row.status)} />,
        },
        {
            key: "healthState",
            label: "Invariant Status",
            Value: ({ row }: { row: GatewayRoute }) => (
                <StatusChip label={row.healthState} tone={healthTone(row.healthState)} />
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
                    end={() => (
                        <VBtn color="primary" variant="flat" prependIcon={"mdi-plus"} onClick={() => void openCreateRoute()}>
                            {t("Add Route")}
                        </VBtn>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("A route binds a rail to a gateway. Health and circuit-breaker state are operational facts, not editable fields.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Route health")}</ThemedText>
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
                                {[
                                    { label: t("Routes"), value: String(summary.value.total), tone: "info" as const },
                                    { label: t("Active"), value: String(summary.value.active), tone: "success" as const },
                                    { label: t("Paused"), value: String(summary.value.paused), tone: summary.value.paused > 0 ? "warning" as const : "success" as const },
                                    { label: t("Draining"), value: String(summary.value.draining), tone: summary.value.draining > 0 ? "info" as const : "success" as const },
                                    { label: t("Open breakers"), value: String(summary.value.openBreaker), tone: summary.value.openBreaker > 0 ? "error" as const : "success" as const },
                                    { label: t("Rail/gateway pairs"), value: String(summary.value.railGatewayPairs), tone: "neutral" as const },
                                ].map((item) => (
                                    <VCard key={item.label} variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px" }}>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.62 }}>{item.label}</ThemedText>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{item.value}</ThemedText>
                                        </VCardText>
                                    </VCard>
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
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

            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(v: any) => (dialogOpen.value = v)} maxWidth="680px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {t("Edit route")} {editingRoute.value?.railCode} → {editingRoute.value?.gatewayCode}
                        </ThemedText>
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
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (dialogOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn color="primary" loading={actionLoading.value} onClick={() => void saveRoute()}>
                                {t("Save")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} maxWidth="560px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {t("Add Route")}
                        </ThemedText>
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
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default RoutesPage;
