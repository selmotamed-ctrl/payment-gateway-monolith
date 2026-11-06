import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VSelect, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { statusTone } from "@/components/Table/statusTone";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
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
import { FormField } from "@/components/ui/FormField";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import { MetaPill } from "@/components/ui/MetaPill";
import { SectionFields } from "@/components/SectionFields";
import GatewayHealthDrawer from "./components/GatewayHealthDrawer";
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
    const theme = useTheme();
    const showChecklists = areChecklistsVisible();
    const toneColor = (tone: "error" | "warning"): string =>
        (theme.current.value.colors as Record<string, string>)[tone] ?? "";
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
    const healthGateway = ref<{ id: string; name: string } | null>(null);
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

    const exportExcel = async () => {
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
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `gateways-${new Date().toISOString().slice(0, 10)}.xlsx`,
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

    const rollbackChecklistComplete = computed(() => !showChecklists || ROLLBACK_CHECKS.every((check) => rollbackChecklist.value[check.key] === true));

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

    const summaryExportChecklistComplete = computed(() => !showChecklists || SUMMARY_EXPORT_CHECKS.every((check) => summaryExportChecklist.value[check.key] === true));

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
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `gateway-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Gateway summary exported") });
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
            { key: "total", label: t("Gateways"), value: String(data.total) },
            { key: "live", label: t("Live"), value: String(data.byStatus?.LIVE ?? 0), badge: t("Live"), badgeTone: "success" },
            { key: "verified", label: t("Verified"), value: String(data.byVerification?.VERIFIED ?? 0), badge: t("Verified"), badgeTone: "success" },
            { key: "pending", label: t("Pending versions"), value: String(data.pendingVersions), badge: (data.pendingVersions ?? 0) > 0 ? t("Review") : t("Clear"), badgeTone: (data.pendingVersions ?? 0) > 0 ? "warning" : "success" },
            { key: "breakers", label: t("Open breakers"), value: String(data.routes?.openBreaker ?? 0), badge: (data.routes?.openBreaker ?? 0) > 0 ? t("Critical") : t("Clear"), badgeTone: (data.routes?.openBreaker ?? 0) > 0 ? "danger" : "success" },
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
                    <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{row.name}</ThemedText>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                        <MonoRef value={row.code} />
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.operator}</ThemedText>
                    </div>
                    {row.aliases?.length > 0 && <ThemedText style={{ fontSize: "10px", opacity: 0.45 }}>{row.aliases.join(", ")}</ThemedText>}
                </ThemedView>
            ),
        },
        {
            key: "kind",
            label: "Kind",
            sortKey: "kind",
            value: (row) => row.kind,
            Value: ({ row }: { row: Gateway }) => <StatusBadge status={row.kind} toneOverride={kindTone(row.kind) === "primary" ? "info" : (kindTone(row.kind) as any)} />,
        },
        { key: "country", label: "Country", value: (row) => row.country },
        {
            key: "verification",
            label: "Verification",
            sortKey: "verificationState",
            value: (row) => row.verificationState,
            Value: ({ row }: { row: Gateway }) => <StatusBadge status={row.verificationState} toneOverride={row.verificationState === "VERIFIED" ? "success" : "warning"} />,
        },
        {
            key: "risk",
            label: "Risk",
            sortKey: "riskClass",
            value: (row) => row.riskClass,
            Value: ({ row }: { row: Gateway }) => <StatusBadge status={row.riskClass} toneOverride={statusTone(row.riskClass) === "error" ? "danger" : statusTone(row.riskClass) as any} />,
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            value: (row) => row.status,
            Value: ({ row }: { row: Gateway }) => <StatusBadge status={row.status} toneOverride={statusTone(row.status) === "error" ? "danger" : statusTone(row.status) as any} />,
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
                <TableRowActions
                    primaryAction={{
                        label: t("Wizard"),
                        icon: "mdi-tune-variant",
                        onClick: () => void router.push({ name: "GatewayWizard", params: { id: row.id } }),
                    }}
                    items={[
                        {
                            key: "health",
                            label: t("Health & telemetry"),
                            icon: "mdi-heart-pulse",
                            onClick: () => void (healthGateway.value = { id: row.id, name: `${row.name} (${row.code})` }),
                        },
                        {
                            key: "rollback",
                            label: t("Rollback"),
                            icon: "mdi-history",
                            danger: true,
                            dividerBefore: true,
                            hidden: !(row.activeVersion && rollbackTargets(row).length > 0),
                            onClick: () => openRollback(row),
                        },
                    ]}
                />
            ),
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Gateways")}
                    subtitle={t("Gateway portfolio, version state, and live route health.")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                            <VBtn color="primary" variant="tonal" prependIcon="mdi-robot-outline" onClick={() => void router.push({ name: "GatewayAiImport" })}>{t("Smart AI Integration")}</VBtn>
                            <VBtn color="primary" variant="flat" prependIcon="mdi-plus" onClick={openCreate}>{t("New Gateway")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("A gateway version cannot go LIVE until its 12 go-live gates pass and a different checker approves it.")}
                </VAlert>

                {summary.value && (
                    <SummaryExportCard
                        title={t("Gateway health")}
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
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {Object.entries(summary.value.byKind ?? {}).map(([kind, count]) => (
                                <StatusBadge key={kind} status={kind} label={`${kind}: ${count}`} toneOverride={kindTone(kind) === "primary" ? "info" : (kindTone(kind) as any)} showDot={false} />
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
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
                    rowColor={(row) => (row.routeHealth.openBreaker > 0 ? toneColor("error") : row.riskClass === "HIGH_RISK" ? toneColor("warning") : undefined)}
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

            <GatewayHealthDrawer
                gatewayId={healthGateway.value?.id ?? null}
                gatewayName={healthGateway.value?.name ?? ""}
                onClose={() => (healthGateway.value = null)}
            />

            <FormModal
                modelValue={rollbackOpen.value}
                onUpdate:modelValue={(value: boolean) => (rollbackOpen.value = value)}
                title={t("Rollback gateway")}
                size="md"
                onSubmit={() => void applyRollback()}
                submitLabel={t("Rollback")}
                loading={rollbackLoading.value}
                errorMessage={rollbackError.value ?? ""}
                v-slots={{
                    footer: () => (
                        <>
                            <VBtn variant="outlined" disabled={rollbackLoading.value} onClick={() => (rollbackOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="warning"
                                variant="flat"
                                {...{ type: "submit" }}
                                loading={rollbackLoading.value}
                                disabled={!rollbackChecklistComplete.value}
                            >
                                {t("Rollback")}
                            </VBtn>
                        </>
                    ),
                }}
            >
                <VAlert type="warning" variant="tonal">
                    {t("Rollback changes the live version immediately. Verify the target version and operational impact first.")}
                </VAlert>
                <SectionFields title={t("Rollback details")}>
                    <FormField label={t("Target version")} required sensitiveMakerChecker>
                        <VSelect
                            items={(rollbackGateway.value ? rollbackTargets(rollbackGateway.value) : []).map((version) => ({
                                title: `v${version.versionNumber} · ${version.state}`,
                                value: version.id,
                            }))}
                            modelValue={rollbackTarget.value}
                            onUpdate:modelValue={(value: string) => (rollbackTarget.value = value)}
                        />
                    </FormField>
                    <FormField label={t("Rollback reason")} required sensitiveMakerChecker>
                        <VTextField
                            modelValue={rollbackReason.value}
                            onUpdate:modelValue={(value: string) => (rollbackReason.value = value)}
                        />
                    </FormField>
                </SectionFields>
                <FormChecklist
                    checks={[...ROLLBACK_CHECKS]}
                    modelValue={rollbackChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (rollbackChecklist.value = value)}
                    show={showChecklists}
                    title={t("Rollback checklist")}
                    complete={rollbackChecklistComplete.value}
                    incompleteMessage={t("Complete all rollback checklist items before continuing")}
                />
            </FormModal>

            <FormModal
                modelValue={createOpen.value}
                onUpdate:modelValue={(value: boolean) => (createOpen.value = value)}
                title={t("New Gateway")}
                size="md"
                onSubmit={() => void createGateway()}
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
                                disabled={!form.value.code.trim() || !form.value.name.trim()}
                            >
                                {t("Create")}
                            </VBtn>
                        </>
                    ),
                }}
            >
                <SectionFields title={t("Gateway profile")}>
                    <FormField label={t("Gateway code")} hint="lowercase letters, digits, - and _" required sensitiveMakerChecker>
                        <VTextField modelValue={form.value.code} onUpdate:modelValue={(value: string) => (form.value.code = value)} />
                    </FormField>
                    <FormField label={t("Gateway name")} required>
                        <VTextField modelValue={form.value.name} onUpdate:modelValue={(value: string) => (form.value.name = value)} />
                    </FormField>
                    <FormField label={t("Operator")}>
                        <VTextField modelValue={form.value.operator} onUpdate:modelValue={(value: string) => (form.value.operator = value)} />
                    </FormField>
                    <FormField label={t("Kind")}>
                        <VSelect items={["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]} modelValue={form.value.kind} onUpdate:modelValue={(value: string) => (form.value.kind = value)} />
                    </FormField>
                    <FormField label={t("Country")}>
                        <VTextField modelValue={form.value.country} onUpdate:modelValue={(value: string) => (form.value.country = value)} />
                    </FormField>
                    <FormField label={t("Risk class")} sensitiveMakerChecker>
                        <VSelect items={["NORMAL", "HIGH_RISK"]} modelValue={form.value.riskClass} onUpdate:modelValue={(value: string) => (form.value.riskClass = value)} />
                    </FormField>
                </SectionFields>
            </FormModal>
        </ScreenContainer>
    );
});

export default GatewaysPage;
