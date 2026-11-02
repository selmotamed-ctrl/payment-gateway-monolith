import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VCard, VCardText, VCheckbox, VDialog, VProgressCircular, VSelect, VTextField, VTextarea } from "vuetify/components";
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

    const exportCsv = async () => {
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
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `aml-rules-${new Date().toISOString().slice(0, 10)}.csv`;
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
        createOpen.value = true;
    };

    const onRuleTypeChanged = (type: string) => {
        form.value.ruleType = type;
        form.value.paramsText = PARAM_HELP[type]?.match(/\{.*\}/)?.[0] ?? "{}";
    };

    const openDetails = async (row: AmlRule) => {
        selected.value = { ...row, approval: null };
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlRuleDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = (payload.rule ?? payload) as AmlRuleDetail;
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const ruleChecklistComplete = computed(() => RULE_CHECKS.every((check) => ruleChecklist.value[check.key] === true));

    const submit = async () => {
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
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `aml-rule-summary-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("AML rule summary exported") });
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
            { label: t("Total rules"), value: String(data.total), tone: "info" as const },
            { label: t("Active"), value: String(data.active), tone: "success" as const },
            { label: t("Inactive"), value: String(data.inactive), tone: data.inactive > 0 ? "warning" as const : "success" as const },
            { label: t("Pending approval"), value: String(data.pendingApprovals), tone: data.pendingApprovals > 0 ? "warning" as const : "success" as const },
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
                    <ThemedText style={{ fontSize: "11px", fontWeight: 600, direction: "ltr" }}>{row.code}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.name}</ThemedText>
                </ThemedView>
            ),
        },
        { key: "ruleType", label: "Type", sortKey: "ruleType", value: (row) => row.ruleType },
        {
            key: "action",
            label: "Action",
            value: (row) => row.action,
            Value: ({ row }: { row: AmlRule }) => <StatusChip label={row.action} tone={row.action === "BLOCK" || row.action === "HOLD" ? "error" : row.action === "FLAG" ? "warning" : "neutral"} size="x-small" />,
        },
        {
            key: "severity",
            label: "Severity",
            sortKey: "baseSeverity",
            value: (row) => row.baseSeverity,
            Value: ({ row }: { row: AmlRule }) => <StatusChip label={row.baseSeverity} tone={statusTone(row.baseSeverity)} size="small" />,
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
                    ? <StatusChip label={t("Pending approval")} tone="warning" size="small" />
                    : <StatusChip label={row.active ? t("Active") : t("Inactive")} tone={row.active ? "success" : "neutral"} size="small" />
            ),
        },
        {
            key: "approval",
            label: "Approval",
            value: (row) => row.approvalState ?? "",
            Value: ({ row }: { row: AmlRule }) => row.approvalState
                ? <StatusChip label={row.approvalState} tone={statusTone(row.approvalState)} size="x-small" />
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
            Value: ({ row }: { row: AmlRule }) => <VBtn size="small" variant="tonal" onClick={() => void openDetails(row)}>{t("Review")}</VBtn>,
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("AML Rules")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportCsv()}>{t("Export CSV")}</VBtn>
                            <VBtn color="primary" prependIcon="mdi-plus" onClick={openCreate}>{t("Draft rule")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Every AML rule change is a maker-checker request. The rule stays inactive until a different MLRO or authorised checker approves it.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Rule posture")}</ThemedText>
                                <div style={{ flex: 1 }} />
                                <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                            </ThemedView>
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px" }}>
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
                                {Object.entries(summary.value.byType ?? {}).map(([type, count]) => (
                                    <StatusChip key={type} label={`${type}: ${count}`} tone="neutral" size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
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

            <VDialog modelValue={detailsOpen.value} onUpdate:modelValue={(value: boolean) => (detailsOpen.value = value)} maxWidth="940px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {detailLoading.value || !selected.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "260px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading AML rule")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>{selected.value.code}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{selected.value.name} · v{selected.value.version}</ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                        <StatusChip label={selected.value.pendingApproval ? t("Pending approval") : selected.value.active ? t("Active") : t("Inactive")} tone={selected.value.pendingApproval ? "warning" : selected.value.active ? "success" : "neutral"} />
                                        <StatusChip label={selected.value.action} tone={selected.value.action === "BLOCK" || selected.value.action === "HOLD" ? "error" : "warning"} size="small" />
                                        <StatusChip label={selected.value.baseSeverity} tone={statusTone(selected.value.baseSeverity)} size="small" />
                                    </ThemedView>
                                </ThemedView>

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Rule context")}</ThemedText>
                                            {[
                                                [t("Type"), selected.value.ruleType],
                                                [t("Action"), selected.value.action],
                                                [t("Severity"), selected.value.baseSeverity],
                                                [t("Effective from"), formatDateTime(selected.value.effectiveFrom)],
                                                [t("Effective to"), formatDateTime(selected.value.effectiveTo)],
                                                [t("Created"), formatDateTime(selected.value.createdAt)],
                                                [t("Version"), String(selected.value.version)],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: "ltr" }}>{value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                        </VCardText>
                                    </VCard>
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Approval")}</ThemedText>
                                            {[
                                                [t("Approval state"), selected.value.approvalState || selected.value.approval?.state || "—"],
                                                [t("Approval request"), selected.value.approvalRequestId || "—"],
                                                [t("Checker"), selected.value.approval?.checkerUserId || "—"],
                                                [t("Rejection reason"), selected.value.approval?.rejectionReason || "—"],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: "ltr" }}>{value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                            {selected.value.approvalRequestId && (
                                                <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => void router.push({ name: "Approvals" })}>{t("Open approvals")}</VBtn>
                                            )}
                                        </VCardText>
                                    </VCard>
                                </ThemedView>

                                <VCard variant="tonal">
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold">{t("Scope")}</ThemedText>
                                        <pre style={{ margin: 0, padding: "8px 10px", borderRadius: "8px", background: "rgba(15,23,42,0.06)", fontSize: "10px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", maxHeight: "160px", overflow: "auto" }}>{JSON.stringify(selected.value.scope ?? {}, null, 2)}</pre>
                                        <ThemedText type="defaultSemiBold">{t("Params")}</ThemedText>
                                        <pre style={{ margin: 0, padding: "8px 10px", borderRadius: "8px", background: "rgba(15,23,42,0.06)", fontSize: "10px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", maxHeight: "220px", overflow: "auto" }}>{JSON.stringify(selected.value.params ?? {}, null, 2)}</pre>
                                    </VCardText>
                                </VCard>

                                <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                                    <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                </ThemedView>
                            </>
                        )}
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog modelValue={createOpen.value} onUpdate:modelValue={(value: boolean) => (createOpen.value = value)} maxWidth="760px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Draft AML rule")}</ThemedText>
                        <VAlert type="info" variant="tonal">{t("The rule is created inactive and an approval request is issued. A different authorised checker must approve it.")}</VAlert>
                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                            <VTextField label={t("Code")} modelValue={form.value.code} onUpdate:modelValue={(value: string) => (form.value.code = value)} />
                            <VTextField label={t("Name")} modelValue={form.value.name} onUpdate:modelValue={(value: string) => (form.value.name = value)} />
                        </ThemedView>
                        <VSelect items={RULE_TYPES.map((value) => ({ title: value, value }))} modelValue={form.value.ruleType} onUpdate:modelValue={(value: string) => onRuleTypeChanged(value)} label={t("Rule type")} />
                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" }}>
                            <VSelect items={RULE_ACTIONS.map((value) => ({ title: value, value }))} modelValue={form.value.action} onUpdate:modelValue={(value: string) => (form.value.action = value)} label={t("Action")} />
                            <VSelect items={SEVERITIES.map((value) => ({ title: value, value }))} modelValue={form.value.baseSeverity} onUpdate:modelValue={(value: string) => (form.value.baseSeverity = value)} label={t("Severity")} />
                        </ThemedView>
                        <VTextField type="date" label={t("Effective from (optional)")} modelValue={form.value.effectiveFrom} onUpdate:modelValue={(value: string) => (form.value.effectiveFrom = value)} />
                        <VTextarea label={t("Scope JSON")} modelValue={form.value.scopeText} onUpdate:modelValue={(value: string) => (form.value.scopeText = value)} rows={3} hint={t("Use {} for all merchants and rails.")} persistentHint />
                        <VTextarea label={t("Params JSON")} modelValue={form.value.paramsText} onUpdate:modelValue={(value: string) => (form.value.paramsText = value)} rows={4} hint={PARAM_HELP[form.value.ruleType] ?? ""} persistentHint />
                        <ThemedView style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{t("Rule checklist")}</ThemedText>
                            {RULE_CHECKS.map((check) => (
                                <VCheckbox
                                    key={check.key}
                                    modelValue={ruleChecklist.value[check.key] === true}
                                    onUpdate:modelValue={(value: unknown) => (ruleChecklist.value = { ...ruleChecklist.value, [check.key]: Boolean(value) })}
                                    label={t(check.label)}
                                    density="compact"
                                    hideDetails
                                />
                            ))}
                            {!ruleChecklistComplete.value && (
                                <ThemedText style={{ fontSize: "10px", opacity: 0.6 }}>{t("Complete all rule checklist items before drafting")}</ThemedText>
                            )}
                        </ThemedView>
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                            <VBtn variant="text" onClick={() => (createOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={actionLoading.value} disabled={!form.value.code.trim() || !form.value.name.trim() || !ruleChecklistComplete.value} onClick={() => void submit()}>{t("Create draft")}</VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default AmlRulesPage;
