import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type GatewayRoute = {
    id: string;
    railCode: string;
    gatewayCode: string;
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

const RoutesPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<GatewayRoute[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

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

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.routesList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.routes ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

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
            await load();
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
            await load();
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

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Routes")}
                                data={rows.value}
                                headers={headers}
                                loading={loading.value}
                                showNumber={true}
                                xlsx={false}
                                noElevation={true}
                                searchValue={search.value}
                                setSearchValue={(value) => (search.value = value)}
                            />
                        </VCardText>
                    </VCard>
                )}
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
