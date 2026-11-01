import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VCard, VCardText, VDialog, VProgressCircular, VSelect, VTab, VTabs, VTextField, VTextarea } from "vuetify/components";
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

type RegulatoryReport = {
    id: string;
    reportRef: string;
    reportType: string;
    authority: string;
    status: string;
    state: string;
    subjectType: string;
    subjectId: string;
    amlCaseId: string | null;
    amlCaseStatus: string | null;
    amlCaseSeverity: string | null;
    subjectName: string;
    periodStart: string | null;
    periodEnd: string | null;
    submissionRef: string | null;
    payloadSha256: string;
    confidential: boolean;
    approvalRequestId: string | null;
    approvalState: string | null;
    submittedAt: string | null;
    createdAt: string;
    updatedAt: string;
    ageHours: number;
};

type RegulatoryReportDetail = RegulatoryReport & {
    approval: {
        id: string;
        state: string;
        makerUserId: string;
        checkerUserId: string | null;
        rejectionReason: string | null;
        createdAt: string;
    } | null;
    amlCase: {
        id: string;
        status: string;
        severity: string;
        subjectType: string;
        subjectId: string;
        triggerReason: string;
    } | null;
};

type ReportSummary = {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    submittedThisMonth: number;
    pendingChecker: number;
    drafts: number;
    acknowledged: number;
    rejected: number;
};

type ReportView = "open" | "submitted" | "all";

type ReportingRule = {
    id: string;
    reportType: string;
    status: string;
    sourceReference: string | null;
    authority?: string;
};

const OPEN_STATES = ["DRAFT", "PENDING_CHECKER", "APPROVED"];
const SUBMITTED_STATES = ["SUBMITTED", "ACKNOWLEDGED", "REJECTED_BY_AUTHORITY"];
const REPORT_TYPES = ["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"];

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};

const AmlReportsPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const rows = ref<RegulatoryReport[]>([]);
    const total = ref(0);
    const summary = ref<ReportSummary | null>(null);
    const search = ref<string | null>(null);
    const activeView = ref<ReportView>("open");
    const filters = ref<FilterValues>({ status: [...OPEN_STATES] });
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const createOpen = ref(false);
    const form = ref({
        reportingRuleId: "",
        reportType: "LARGE_TRANSACTION",
        authority: "CBL",
        periodStart: "",
        periodEnd: "",
        caseId: "",
        notes: "",
    });
    const rules = ref<ReportingRule[]>([]);
    const actionLoading = ref(false);

    const detailsOpen = ref(false);
    const selected = ref<RegulatoryReportDetail | null>(null);
    const detailLoading = ref(false);

    const filterDefinitions = computed(() => tableRegistry.AmlReports?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.amlReportsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as ReportSummary;
        } catch {
            summary.value = null;
        }
    };

    const loadRules = async () => {
        try {
            const response = await api.get(urlsMap.amlReportingRules);
            const payload = response.data?.data ?? response.data ?? {};
            rules.value = payload.rules ?? [];
        } catch {
            rules.value = [];
        }
    };

    void loadSummary();
    void loadRules();

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = activeView.value === "open"
            ? { status: [...OPEN_STATES] }
            : activeView.value === "submitted"
              ? { status: [...SUBMITTED_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const setView = (view: ReportView) => {
        activeView.value = view;
        filters.value = view === "open"
            ? { status: [...OPEN_STATES] }
            : view === "submitted"
              ? { status: [...SUBMITTED_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const openCreate = () => {
        form.value = {
            reportingRuleId: "",
            reportType: "LARGE_TRANSACTION",
            authority: "CBL",
            periodStart: "",
            periodEnd: "",
            caseId: "",
            notes: "",
        };
        createOpen.value = true;
        void loadRules();
    };

    const onRuleChanged = (value: string) => {
        form.value.reportingRuleId = value ?? "";
        const rule = rules.value.find((entry) => entry.id === form.value.reportingRuleId);
        if (rule) {
            form.value.reportType = rule.reportType;
            if (rule.authority) form.value.authority = rule.authority;
        }
    };

    const submit = async () => {
        if (!form.value.reportingRuleId || !form.value.periodStart || !form.value.periodEnd) {
            showSnackBar({ type: "warning", message: t("Reporting rule and period are required") });
            return;
        }
        actionLoading.value = true;
        try {
            const response = await api.post(urlsMap.amlReports, {
                reportingRuleId: form.value.reportingRuleId,
                reportType: form.value.reportType,
                authority: form.value.authority,
                periodStart: form.value.periodStart,
                periodEnd: form.value.periodEnd,
                ...(form.value.caseId.trim() ? { caseId: form.value.caseId.trim() } : {}),
                ...(form.value.notes.trim() ? { notes: form.value.notes.trim() } : {}),
            });
            const payload = response.data?.data ?? response.data ?? {};
            createOpen.value = false;
            showSnackBar({
                type: "success",
                message: payload.approvalRequestId
                    ? `${t("Report drafted")} · ${t("Approval request")} ${String(payload.approvalRequestId).slice(0, 8)}`
                    : t("Report drafted"),
            });
            refreshAll();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            actionLoading.value = false;
        }
    };

    const openDetails = async (row: RegulatoryReport) => {
        selected.value = { ...row, approval: null, amlCase: null };
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const response = await api.get(urlsMap.amlReportDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = (payload.report ?? payload) as RegulatoryReportDetail;
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const summaryItems = computed(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { label: t("Reports"), value: String(data.total), tone: "info" as const },
            { label: t("Pending checker"), value: String(data.pendingChecker), tone: data.pendingChecker > 0 ? "warning" as const : "success" as const },
            { label: t("Drafts"), value: String(data.drafts), tone: "neutral" as const },
            { label: t("Submitted this month"), value: String(data.submittedThisMonth), tone: "success" as const },
            { label: t("Acknowledged"), value: String(data.acknowledged), tone: "success" as const },
            { label: t("Rejected by authority"), value: String(data.rejected), tone: data.rejected > 0 ? "error" as const : "success" as const },
        ];
    });

    const headers = computed<TableHeader<RegulatoryReport>[]>(() => [
        {
            key: "reportRef",
            label: "Report",
            value: (row) => row.reportRef,
            Value: ({ row }: { row: RegulatoryReport }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px", fontWeight: 600, direction: "ltr" }}>{row.reportRef}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.reportType}</ThemedText>
                </ThemedView>
            ),
        },
        { key: "authority", label: "Authority", value: (row) => row.authority },
        {
            key: "subject",
            label: "Subject",
            value: (row) => row.subjectName,
            Value: ({ row }: { row: RegulatoryReport }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px" }}>{row.subjectName || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.subjectType} · {row.subjectId}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "status",
            label: "Status",
            value: (row) => row.status,
            Value: ({ row }: { row: RegulatoryReport }) => <StatusChip label={row.status} tone={statusTone(row.status)} size="small" />,
        },
        {
            key: "period",
            label: "Period",
            value: (row) => `${row.periodStart ?? ""} ${row.periodEnd ?? ""}`,
            Value: ({ row }: { row: RegulatoryReport }) => <ThemedText style={{ fontSize: "10px" }}>{formatDateTime(row.periodStart)} → {formatDateTime(row.periodEnd)}</ThemedText>,
        },
        {
            key: "submission",
            label: "Submission",
            value: (row) => row.submissionRef ?? "",
            Value: ({ row }: { row: RegulatoryReport }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "10px", direction: "ltr" }}>{row.submissionRef || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(row.submittedAt)}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "approval",
            label: "Approval",
            value: (row) => row.approvalState ?? "",
            Value: ({ row }: { row: RegulatoryReport }) => row.approvalState
                ? <StatusChip label={row.approvalState} tone={statusTone(row.approvalState)} size="x-small" />
                : <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>,
        },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: RegulatoryReport }) => <VBtn size="small" variant="tonal" onClick={() => void openDetails(row)}>{t("Review")}</VBtn>,
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("AML Reports")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn color="primary" prependIcon="mdi-plus" onClick={openCreate}>{t("Draft report")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="error" variant="tonal">
                    {t("AML-CONFIDENTIAL · Regulatory reports are restricted to Compliance, MLRO and authorised reporting roles. Never disclose an STR or its existence to the subject.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Reporting health")}</ThemedText>
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
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
                                {Object.entries(summary.value.byStatus ?? {}).map(([status, count]) => (
                                    <StatusChip key={status} label={`${status}: ${count}`} tone={statusTone(status)} size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
                )}

                <VTabs modelValue={activeView.value} onUpdate:modelValue={(value: unknown) => setView(value as ReportView)} color="primary" density="comfortable" showArrows>
                    <VTab value="open" prependIcon="mdi-file-edit-outline">{t("Open")}</VTab>
                    <VTab value="submitted" prependIcon="mdi-send-check-outline">{t("Submitted")}</VTab>
                    <VTab value="all" prependIcon="mdi-view-list-outline">{t("All")}</VTab>
                </VTabs>

                <ApiTable<RegulatoryReport>
                    title={t("Regulatory report queue")}
                    url={urlsMap.amlReports}
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
                    rowColor={(row) => (row.status === "REJECTED_BY_AUTHORITY" ? "#dc2626" : row.status === "PENDING_CHECKER" ? "#d97706" : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { reports?: RegulatoryReport[]; rows?: RegulatoryReport[] };
                        return payload.reports ?? payload.rows ?? [];
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

            <VDialog modelValue={detailsOpen.value} onUpdate:modelValue={(value: boolean) => (detailsOpen.value = value)} maxWidth="960px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {detailLoading.value || !selected.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "280px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading regulatory report")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>{selected.value.reportRef}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>{selected.value.reportType} · {selected.value.authority}</ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                        <StatusChip label={selected.value.status} tone={statusTone(selected.value.status)} />
                                        {selected.value.confidential && <StatusChip label="AML-CONFIDENTIAL" tone="error" size="small" />}
                                    </ThemedView>
                                </ThemedView>

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Report context")}</ThemedText>
                                            {[
                                                [t("Subject type"), selected.value.subjectType],
                                                [t("Subject"), selected.value.subjectName],
                                                [t("Subject ID"), selected.value.subjectId],
                                                [t("AML case"), selected.value.amlCaseId || "—"],
                                                [t("Case status"), selected.value.amlCase?.status || selected.value.amlCaseStatus || "—"],
                                                [t("Case severity"), selected.value.amlCase?.severity || selected.value.amlCaseSeverity || "—"],
                                                [t("Period start"), formatDateTime(selected.value.periodStart)],
                                                [t("Period end"), formatDateTime(selected.value.periodEnd)],
                                                [t("Submission ref"), selected.value.submissionRef || "—"],
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
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Approval and integrity")}</ThemedText>
                                            {[
                                                [t("Approval state"), selected.value.approvalState || selected.value.approval?.state || "—"],
                                                [t("Approval request"), selected.value.approvalRequestId || "—"],
                                                [t("Checker"), selected.value.approval?.checkerUserId || "—"],
                                                [t("Rejection reason"), selected.value.approval?.rejectionReason || "—"],
                                                [t("Payload SHA-256"), selected.value.payloadSha256],
                                                [t("Created"), formatDateTime(selected.value.createdAt)],
                                                [t("Submitted"), formatDateTime(selected.value.submittedAt)],
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

                                <VAlert type="info" variant="tonal">
                                    {t("The report payload is frozen and encrypted. Its SHA-256 digest proves the submitted content was not changed.")}
                                </VAlert>

                                <ThemedView style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                                    <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                </ThemedView>
                            </>
                        )}
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog modelValue={createOpen.value} onUpdate:modelValue={(value: boolean) => (createOpen.value = value)} maxWidth="700px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{t("Draft regulatory report")}</ThemedText>
                        <VAlert type="info" variant="tonal">{t("The report is drafted as PENDING_CHECKER. A different MLRO must approve it before it is frozen and submitted.")}</VAlert>
                        <VSelect
                            items={rules.value.map((rule) => ({ title: `${rule.reportType} · ${rule.status} · ${rule.sourceReference ?? rule.id}`, value: rule.id }))}
                            modelValue={form.value.reportingRuleId}
                            onUpdate:modelValue={(value: string) => onRuleChanged(value)}
                            label={t("Reporting rule")}
                        />
                        <VSelect
                            items={REPORT_TYPES.map((value) => ({ title: value, value }))}
                            modelValue={form.value.reportType}
                            onUpdate:modelValue={(value: string) => (form.value.reportType = value)}
                            label={t("Report type")}
                        />
                        <VTextField label={t("Authority")} modelValue={form.value.authority} onUpdate:modelValue={(value: string) => (form.value.authority = value)} />
                        <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                            <VTextField type="date" label={t("Period start")} modelValue={form.value.periodStart} onUpdate:modelValue={(value: string) => (form.value.periodStart = value)} />
                            <VTextField type="date" label={t("Period end")} modelValue={form.value.periodEnd} onUpdate:modelValue={(value: string) => (form.value.periodEnd = value)} />
                        </ThemedView>
                        <VTextField label={t("AML case ID (optional)")} modelValue={form.value.caseId} onUpdate:modelValue={(value: string) => (form.value.caseId = value)} />
                        <VTextarea label={t("Notes")} modelValue={form.value.notes} onUpdate:modelValue={(value: string) => (form.value.notes = value)} rows={3} />
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                            <VBtn variant="text" onClick={() => (createOpen.value = false)}>{t("Cancel")}</VBtn>
                            <VBtn color="primary" loading={actionLoading.value} disabled={!form.value.reportingRuleId || !form.value.periodStart || !form.value.periodEnd} onClick={() => void submit()}>{t("Create draft")}</VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default AmlReportsPage;
