import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { areChecklistsVisible } from "@/constants/env";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VProgressCircular, VSelect, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { statusTone } from "@/components/Table/statusTone";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { useOpenQuery } from "@/composables/useOpenQuery";
import { urlsMap } from "@/constants/urlsMap";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { useSafeguard } from "@/components/guide/useSafeguard";
import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { FormChecklist } from "@/components/ui/FormChecklist";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
import type { MetricItem } from "@/components/ui/MetricStrip";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { MonoRef } from "@/components/ui/MonoRef";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { SectionFields } from "@/components/SectionFields";
type AmlRule = {
    id: string;
    code: string;
    name: string;
    ruleType: string;
    scope: Record<string, unknown>;
    params: Record<string, unknown>;
    action: string;
    baseSeverity: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    version: number;
    active: boolean;
    approvalRequestId: string | null;
    approvalState: string | null;
    pendingApproval: boolean;
    createdAt: string;
    updatedAt: string;
};
type AmlRuleDetail = AmlRule & {
    approval: {
        id: string;
        state: string;
        makerUserId: string;
        checkerUserId: string | null;
        rejectionReason: string | null;
        createdAt: string;
    } | null;
};
type RuleSummary = {
    total: number;
    active: number;
    inactive: number;
    pendingApprovals: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
    byAction: Record<string, number>;
};
const RULE_TYPES = [
    "SINGLE_AMOUNT",
    "CUMULATIVE_WINDOW",
    "STRUCTURING",
    "RISK_TIER",
    "COUNTERPARTY_COUNTRY",
    "RAIL",
    "MERCHANT_DIRECT_AMOUNT",
];
const RULE_ACTIONS = ["HOLD", "FLAG", "BLOCK", "CASE_ONLY"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const PARAM_HELP: Record<string, string> = {
    SINGLE_AMOUNT: 'Example: {"min_amount": "10000.0000", "currency": "LYD"}',
    CUMULATIVE_WINDOW: 'Example: {"max_amount": "50000.0000", "max_count": 5, "window_seconds": 86400}',
    STRUCTURING: 'Example: {"threshold": "10000.0000", "band_percent": 10, "min_count": 2, "window_seconds": 86400}',
    RISK_TIER: 'Example: {"tier": "HIGH", "min_amount": "5000.0000"}',
    COUNTERPARTY_COUNTRY: 'Example: {"mode": "DENY", "countries": ["KP", "IR"]}',
    RAIL: 'Example: {"rail_codes": ["moamalat"], "min_amount": "20000.0000"}',
    MERCHANT_DIRECT_AMOUNT: 'Example: {"min_amount": "100000.0000", "currency": "LYD"}',
};
const badgeTone = (value: string): BadgeTone => {
    const tone = statusTone(value);
    return tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
};
const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};
const parseJsonObject = (text: string): Record<string, unknown> | null => {
    if (!text.trim()) return {};
    try {
        const parsed = JSON.parse(text) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
};
const RULE_CHECKS = [
    { key: "RULE_LOGIC_REVIEWED", label: "Rule logic reviewed" },
    { key: "THRESHOLDS_VERIFIED", label: "Thresholds verified" },
    { key: "REGULATORY_BASIS_DOCUMENTED", label: "Regulatory basis documented" },
    { key: "CHECKER_INDEPENDENCE_CONFIRMED", label: "Checker independence confirmed" },
] as const;
const AmlRulesPage = dc(() => {
    const { t } = useLocale();
    const showChecklists = areChecklistsVisible();
    const router = useRouter();
    const rows = ref<AmlRule[]>([]);
    const total = ref(0);
    const summary = ref<RuleSummary | null>(null);
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
    const form = ref({
        code: "",
        name: "",
        ruleType: "SINGLE_AMOUNT",
        action: "HOLD",
        baseSeverity: "MEDIUM",
        scopeText: "{}",
        paramsText: '{"min_amount":"10000.0000","currency":"LYD"}',
        effectiveFrom: "",
    });
    const actionLoading = ref(false);
    const createError = ref("");
    const ruleChecklist = ref<Record<string, boolean>>({});
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    const detailsOpen = ref(false);
    const selected = ref<AmlRuleDetail | null>(null);
    const detailLoading = ref(false);
    const filterDefinitions = computed(() => tableRegistry.AmlRules?.filters ?? []);
    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.amlRulesSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as RuleSummary;
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
            const response = await api.get(urlsMap.amlRulesExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.rules ?? []) as AmlRule[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No AML rules match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "code", "name", "ruleType", "action", "baseSeverity", "active", "version", "effectiveFrom", "effectiveTo", "approvalState", "createdAt"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.code,
                        row.name,
                        row.ruleType,
                        row.action,
                        row.baseSeverity,
                        row.active,
                        row.version,
                        row.effectiveFrom,
                        row.effectiveTo ?? "",
                        row.approvalState ?? "",
                        row.createdAt,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `aml-rules-${new Date().toISOString().slice(0, 10)}.xlsx`,
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
        form.value = {
            code: "",
            name: "",
            ruleType: "SINGLE_AMOUNT",
            action: "HOLD",
            baseSeverity: "MEDIUM",
            scopeText: "{}",
            paramsText: PARAM_HELP.SINGLE_AMOUNT?.match(/\{.*\}/)?.[0] ?? "{}",
            effectiveFrom: "",
        };
        ruleChecklist.value = {};
        createError.value = "";
        createOpen.value = true;
    };
    const onRuleTypeChanged = (type: string) => {
        form.value.ruleType = type;
        form.value.paramsText = PARAM_HELP[type]?.match(/\{.*\}/)?.[0] ?? "{}";
    };
    const presentRuleDetail = (detail: AmlRuleDetail) => {
        selected.value = detail;
        detailsOpen.value = true;
        detailLoading.value = false;
    };

    const fetchAmlRuleDetail = async (id: string): Promise<AmlRuleDetail | null> => {
        const response = await api.get(urlsMap.amlRuleDetail(id));
        const payload = response.data?.data ?? response.data ?? {};
        return (payload.rule ?? payload) as AmlRuleDetail;
    };

    const openDetails = async (row: AmlRule) => {
        selected.value = { ...row, approval: null };
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const detail = await fetchAmlRuleDetail(row.id);
            if (detail) presentRuleDetail(detail);
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const { clearOpenQueryParam } = useOpenQuery<AmlRuleDetail>({
        alwaysFetchDetail: true,
        fetchById: fetchAmlRuleDetail,
        onOpenRecord: presentRuleDetail,
        onNotFound: () => showSnackBar({ type: "error", message: t("AML rule not found.") }),
    });

    const closeDetails = () => {
        detailsOpen.value = false;
        void clearOpenQueryParam();
    };
    const ruleChecklistComplete = computed(() => !showChecklists || RULE_CHECKS.every((check) => ruleChecklist.value[check.key] === true));
    const ruleSafeguard = useSafeguard("sg-aml-rule-change");
    const submit = async () => {
        createError.value = "";
        const scope = parseJsonObject(form.value.scopeText);
        const params = parseJsonObject(form.value.paramsText);
        if (scope === null || params === null) {
            showSnackBar({ type: "warning", message: t("Scope and params must be valid JSON objects") });
            return;
        }
        if (!ruleChecklistComplete.value) {
            showSnackBar({ type: "warning", message: t("Complete all rule checklist items before drafting") });
            return;
        }
        if (!(await ruleSafeguard.confirm())) return;
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlRules, {
                code: form.value.code.trim(),
                name: form.value.name.trim(),
                ruleType: form.value.ruleType,
                action: form.value.action,
                baseSeverity: form.value.baseSeverity,
                scope,
                params,
                ...(form.value.effectiveFrom ? { effectiveFrom: form.value.effectiveFrom } : {}),
                checklist: RULE_CHECKS.filter((check) => ruleChecklist.value[check.key]).map((check) => check.key),
            });
            const payload = response.data?.data ?? response.data ?? {};
            createOpen.value = false;
            showSnackBar({
                type: "success",
                message: payload.approvalRequestId
                    ? `${t("AML rule drafted")} · ${t("Approval request")} ${String(payload.approvalRequestId).slice(0, 8)}`
                    : t("AML rule drafted"),
            });
            refreshAll();
        } catch (error) {
            createError.value = extractApiErrorMessage(error);
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            actionLoading.value = false;
        }
    };
    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlRulesSummaryExport);
            const snapshot = (response.data?.data ?? response.data ?? {}) as RuleSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["active", snapshot.active],
                ["inactive", snapshot.inactive],
                ["pending_approvals", snapshot.pendingApprovals],
            ];
            for (const [severity, count] of Object.entries(snapshot.bySeverity ?? {})) rows.push([`severity.${severity}.count`, count]);
            for (const [type, count] of Object.entries(snapshot.byType ?? {})) rows.push([`type.${type}.count`, count]);
            for (const [action, count] of Object.entries(snapshot.byAction ?? {})) rows.push([`action.${action}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `aml-rule-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("AML rule summary exported") });
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            summaryExportLoading.value = false;
        }
    };
    const summaryMetrics = computed<MetricItem[]>(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { key: "total", label: t("Total rules"), value: String(data.total) },
            { key: "active", label: t("Active"), value: String(data.active), badge: t("Active"), badgeTone: "success" },
            { key: "inactive", label: t("Inactive"), value: String(data.inactive), badge: data.inactive > 0 ? t("Inactive") : t("Clear"), badgeTone: data.inactive > 0 ? "warning" : "success" },
            { key: "pending", label: t("Pending approval"), value: String(data.pendingApprovals), badge: data.pendingApprovals > 0 ? t("Pending") : t("Clear"), badgeTone: data.pendingApprovals > 0 ? "warning" : "success" },
        ];
    });
    const headers = computed<TableHeader<AmlRule>[]>(() => [
        {
            key: "code",
            label: "Rule",
            sortKey: "code",
            value: (row) => row.code,
            Value: ({ row }: { row: AmlRule }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <MonoRef value={row.code} />
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.name}</ThemedText>
                </ThemedView>
            ),
        },
        { key: "ruleType", label: "Type", sortKey: "ruleType", value: (row) => row.ruleType },
        {
            key: "action",
            label: "Action",
            value: (row) => row.action,
            Value: ({ row }: { row: AmlRule }) => <StatusBadge status={row.action} toneOverride={row.action === "BLOCK" || row.action === "HOLD" ? "danger" : row.action === "FLAG" ? "warning" : "neutral"} />,
        },
        {
            key: "severity",
            label: "Severity",
            sortKey: "baseSeverity",
            value: (row) => row.baseSeverity,
            Value: ({ row }: { row: AmlRule }) => <StatusBadge status={row.baseSeverity} toneOverride={badgeTone(row.baseSeverity)} />,
        },
        {
            key: "params",
            label: "Params",
            value: (row) => JSON.stringify(row.params ?? {}),
            Value: ({ row }: { row: AmlRule }) => <ThemedText style={{ fontSize: "10px", direction: "ltr", maxWidth: "300px", wordBreak: "break-word" }}>{JSON.stringify(row.params ?? {})}</ThemedText>,
        },
        {
            key: "active",
            label: "Status",
            sortKey: "active",
            value: (row) => String(row.active),
            Value: ({ row }: { row: AmlRule }) => (
                row.pendingApproval
                    ? <StatusBadge status="PENDING_APPROVAL" label={t("Pending approval")} toneOverride="warning" />
                    : <StatusBadge status={row.active ? "ACTIVE" : "INACTIVE"} label={row.active ? t("Active") : t("Inactive")} toneOverride={row.active ? "success" : "neutral"} />
            ),
        },
        {
            key: "approval",
            label: "Approval",
            value: (row) => row.approvalState ?? "",
            Value: ({ row }: { row: AmlRule }) => row.approvalState
                ? <StatusBadge status={row.approvalState} toneOverride={badgeTone(row.approvalState)} />
                : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>,
        },
        {
            key: "effectiveFrom",
            label: "Effective",
            sortKey: "effectiveFrom",
            value: (row) => row.effectiveFrom,
            Value: ({ row }: { row: AmlRule }) => <ThemedText style={{ fontSize: "10px" }}>{formatDateTime(row.effectiveFrom)}</ThemedText>,
        },
        { key: "version", label: "v", value: (row) => String(row.version) },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: AmlRule }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Review"),
                        icon: "mdi-shield-search",
                        onClick: () => void openDetails(row),
                    }}
                />
            ),
        },
    ]);
    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("AML Rules")}
                    subtitle={t("Manage AML rule versions and thresholds through maker-checker approval.")}
                    badge="AML-CONFIDENTIAL"
                    badgeTone="danger"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                            <VBtn color="primary" prependIcon="mdi-plus" onClick={openCreate}>{t("Draft rule")}</VBtn>
                        </ThemedView>
                    )}
                />
                <VAlert type="info" variant="tonal">
                    {t("Every AML rule change is a maker-checker request. The rule stays inactive until a different MLRO or authorised checker approves it.")}
                </VAlert>
                {summary.value && (
                    <SummaryExportCard
                        title={t("Rule posture")}
                        metrics={summaryMetrics.value}
                        exportLoading={summaryExportLoading.value}
                        exportLabel={t("Export summary")}
                        onExport={() => void exportSummary()}
                    >
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {Object.entries(summary.value.byType ?? {}).map(([type, count]) => (
                                <StatusBadge key={type} status={type} label={`${type}: ${count}`} toneOverride="neutral" />
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
                )}
                <ApiTable<AmlRule>
                    title={t("AML rule register")}
                    url={urlsMap.amlRules}
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
                    rowColor={(row) => (row.pendingApproval ? "#d97706" : row.active ? undefined : "#64748b")}
                    apiDataExtractor={(data) => {
                        const payload = data as { rules?: AmlRule[]; rows?: AmlRule[] };
                        return payload.rules ?? payload.rows ?? [];
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
            <SlideOverDrawer
                modelValue={detailsOpen.value}
                onUpdate:modelValue={(value: boolean) => {
                    detailsOpen.value = value;
                    if (!value) void clearOpenQueryParam();
                }}
                title={selected.value?.code ?? t("AML rule")}
                subtitle={selected.value ? `${selected.value.name} · v${selected.value.version}` : ""}
                width={620}
                v-slots={{
                    footer: () => (
                        <VBtn variant="text" onClick={closeDetails}>{t("Close")}</VBtn>
                    ),
                }}
            >
                {detailLoading.value || !selected.value ? (
                    <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "260px", gap: "12px" }}>
                        <VProgressCircular indeterminate size={52} color="primary" />
                        <ThemedText style={{ opacity: 0.65 }}>{t("Loading AML rule")}</ThemedText>
                    </ThemedView>
                ) : (
                    <>
                        <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "16px" }}>
                            <StatusBadge status={selected.value.pendingApproval ? "PENDING_APPROVAL" : selected.value.active ? "ACTIVE" : "INACTIVE"} label={selected.value.pendingApproval ? t("Pending approval") : selected.value.active ? t("Active") : t("Inactive")} toneOverride={selected.value.pendingApproval ? "warning" : selected.value.active ? "success" : "neutral"} />
                            <StatusBadge status={selected.value.action} toneOverride={selected.value.action === "BLOCK" || selected.value.action === "HOLD" ? "danger" : "warning"} />
                            <StatusBadge status={selected.value.baseSeverity} toneOverride={badgeTone(selected.value.baseSeverity)} />
                        </ThemedView>
                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px", marginBottom: "16px" }}>
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Rule context")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Rule code"), value: <MonoRef value={selected.value.code} /> },
                                    { label: t("Type"), value: selected.value.ruleType },
                                    { label: t("Action"), value: selected.value.action },
                                    { label: t("Severity"), value: selected.value.baseSeverity },
                                    { label: t("Effective from"), value: formatDateTime(selected.value.effectiveFrom) },
                                    { label: t("Effective to"), value: formatDateTime(selected.value.effectiveTo) },
                                    { label: t("Created"), value: formatDateTime(selected.value.createdAt) },
                                    { label: t("Version"), value: String(selected.value.version) },
                                ]} />
                            </ThemedView>
                            <ThemedView style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Approval")}</ThemedText>
                                <DescriptionList items={[
                                    { label: t("Approval state"), value: selected.value.approvalState || selected.value.approval?.state || "—" },
                                    { label: t("Approval request"), value: <MonoRef value={selected.value.approvalRequestId ?? ""} /> },
                                    { label: t("Checker"), value: selected.value.approval?.checkerUserId || "—" },
                                    { label: t("Rejection reason"), value: selected.value.approval?.rejectionReason || "—" },
                                ]} />
                                {selected.value.approvalRequestId && (
                                    <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "Approvals" })}>{t("Open approvals")}</VBtn>
                                )}
                            </ThemedView>
                        </ThemedView>
                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <ThemedText type="defaultSemiBold">{t("Scope")}</ThemedText>
                            <pre style={{ margin: 0, padding: "8px 10px", borderRadius: "var(--pg-radius-sm)", background: "var(--pg-bg-surface-subtle)", border: "1px solid var(--pg-border-subtle)", fontSize: "10px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", maxHeight: "160px", overflow: "auto" }}>{JSON.stringify(selected.value.scope ?? {}, null, 2)}</pre>
                            <ThemedText type="defaultSemiBold">{t("Params")}</ThemedText>
                            <pre style={{ margin: 0, padding: "8px 10px", borderRadius: "var(--pg-radius-sm)", background: "var(--pg-bg-surface-subtle)", border: "1px solid var(--pg-border-subtle)", fontSize: "10px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", maxHeight: "220px", overflow: "auto" }}>{JSON.stringify(selected.value.params ?? {}, null, 2)}</pre>
                        </ThemedView>
                    </>
                )}
            </SlideOverDrawer>
            <FormModal
                modelValue={createOpen.value}
                onUpdate:modelValue={(value: boolean) => (createOpen.value = value)}
                title={t("Draft AML rule")}
                size="lg"
                loading={actionLoading.value}
                errorMessage={createError.value}
                submitLabel={t("Create draft")}
                onSubmit={() => void submit()}
            >
                <VAlert type="info" variant="tonal">{t("The rule is created inactive and an approval request is issued. A different authorised checker must approve it.")}</VAlert>
                <SectionFields title={t("Rule definition")}>
                    <FormField label={t("Code")} required sensitiveMakerChecker>
                        <VTextField modelValue={form.value.code} onUpdate:modelValue={(value: string) => (form.value.code = value)} hideDetails />
                    </FormField>
                    <FormField label={t("Name")} required sensitiveMakerChecker>
                        <VTextField modelValue={form.value.name} onUpdate:modelValue={(value: string) => (form.value.name = value)} hideDetails />
                    </FormField>
                    <FormField label={t("Rule type")} required sensitiveMakerChecker>
                        <VSelect items={RULE_TYPES.map((value) => ({ title: value, value }))} modelValue={form.value.ruleType} onUpdate:modelValue={(value: string) => onRuleTypeChanged(value)} hideDetails />
                    </FormField>
                    <FormField label={t("Action")} required sensitiveMakerChecker>
                        <VSelect items={RULE_ACTIONS.map((value) => ({ title: value, value }))} modelValue={form.value.action} onUpdate:modelValue={(value: string) => (form.value.action = value)} hideDetails />
                    </FormField>
                    <FormField label={t("Severity")} required sensitiveMakerChecker>
                        <VSelect items={SEVERITIES.map((value) => ({ title: value, value }))} modelValue={form.value.baseSeverity} onUpdate:modelValue={(value: string) => (form.value.baseSeverity = value)} hideDetails />
                    </FormField>
                </SectionFields>
                <SectionFields title={t("Scope and parameters")}>
                    <FormField label={t("Effective from (optional)")} sensitiveMakerChecker>
                        <VTextField type="date" modelValue={form.value.effectiveFrom} onUpdate:modelValue={(value: string) => (form.value.effectiveFrom = value)} hideDetails />
                    </FormField>
                    <FormField label={t("Scope JSON")} hint={t("Use {} for all merchants and rails.")} sensitiveMakerChecker>
                        <VTextarea modelValue={form.value.scopeText} onUpdate:modelValue={(value: string) => (form.value.scopeText = value)} rows={3} hideDetails />
                    </FormField>
                    <FormField label={t("Params JSON")} hint={PARAM_HELP[form.value.ruleType] ?? ""} sensitiveMakerChecker>
                        <VTextarea modelValue={form.value.paramsText} onUpdate:modelValue={(value: string) => (form.value.paramsText = value)} rows={4} hideDetails />
                    </FormField>
                </SectionFields>
                <FormChecklist
                    checks={[...RULE_CHECKS]}
                    modelValue={ruleChecklist.value}
                    onUpdate:modelValue={(value: Record<string, boolean>) => (ruleChecklist.value = value)}
                    show={showChecklists}
                    title={t("Rule checklist")}
                    complete={ruleChecklistComplete.value}
                    incompleteMessage={t("Complete all rule checklist items before drafting")}
                />
            </FormModal>
        </ScreenContainer>
    );
});
export default AmlRulesPage;
