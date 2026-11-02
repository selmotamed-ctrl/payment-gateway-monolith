import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { VBtn, VCard, VCardText } from "vuetify/components";
import { useRouter } from "vue-router";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import { statusTone } from "@/components/Table/statusTone";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { hasOneOfAuthorities } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import {
    COLUMN_HELP,
    channelLabel,
    formatDateTime,
    joinStatusHelp,
    slaInfo,
} from "./joinRequestHelp";
import type { JoinRequestSummary } from "./types";

type JoinRequestsSummary = {
    total: number;
    open: number;
    submitted: number;
    inReview: number;
    infoRequested: number;
    pendingChecker: number;
    approved: number;
    rejected: number;
    overdue: number;
    dueSoon: number;
    unassigned: number;
    fourEyes: number;
    byStatus: Record<string, number>;
    byRisk: Record<string, number>;
};

const filterDefinitions = tableRegistry.JoinRequests?.filters ?? [];

const textValue = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

const JoinRequestsPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const router = useRouter();

    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const rows = ref<JoinRequestSummary[]>([]);
    const total = ref(0);
    const summary = ref<JoinRequestsSummary | null>(null);
    const pageSize = ref(20);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.joinRequestsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as JoinRequestsSummary;
        } catch {
            summary.value = null;
        }
    };

    void loadSummary();

    const exportCsv = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.joinRequestsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.joinRequests ?? []) as JoinRequestSummary[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No join requests match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "merchantId", "merchantName", "legalName", "status", "riskTier", "onboardingChannel", "submittedAt", "slaDueAt", "slaPausedAt", "reviewer", "fourEyesRequired", "decision", "decisionReasonCode"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.merchantId,
                        row.merchantName,
                        row.merchant?.legalName ?? "",
                        row.status,
                        row.riskTier,
                        row.onboardingChannel,
                        row.submittedAt ?? "",
                        row.slaDueAt,
                        row.slaPausedAt ?? "",
                        row.reviewer,
                        row.fourEyesRequired,
                        row.decision ?? "",
                        row.decisionReasonCode ?? "",
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `join-requests-${new Date().toISOString().slice(0, 10)}.csv`;
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

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.joinRequestsSummaryExport);
            const payload = response.data?.data ?? response.data ?? {};
            const snapshot = (payload.summary ?? payload) as JoinRequestsSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["open", snapshot.open],
                ["submitted", snapshot.submitted],
                ["in_review", snapshot.inReview],
                ["info_requested", snapshot.infoRequested],
                ["pending_checker", snapshot.pendingChecker],
                ["approved", snapshot.approved],
                ["rejected", snapshot.rejected],
                ["overdue", snapshot.overdue],
                ["due_soon", snapshot.dueSoon],
                ["unassigned", snapshot.unassigned],
                ["four_eyes", snapshot.fourEyes],
            ];
            for (const [status, count] of Object.entries(snapshot.byStatus ?? {})) rows.push([`status.${status}.count`, count]);
            for (const [risk, count] of Object.entries(snapshot.byRisk ?? {})) rows.push([`risk.${risk}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `join-request-summary-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("Join request summary exported") });
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
            { label: t("Open queue"), value: String(data.open), tone: "info" as const },
            { label: t("Overdue"), value: String(data.overdue), tone: data.overdue > 0 ? "error" as const : "success" as const },
            { label: t("Due within 24h"), value: String(data.dueSoon), tone: data.dueSoon > 0 ? "warning" as const : "success" as const },
            { label: t("Unassigned"), value: String(data.unassigned), tone: data.unassigned > 0 ? "warning" as const : "success" as const },
            { label: t("Pending checker"), value: String(data.pendingChecker), tone: data.pendingChecker > 0 ? "warning" as const : "success" as const },
            { label: t("Four-eyes"), value: String(data.fourEyes), tone: data.fourEyes > 0 ? "error" as const : "success" as const },
        ];
    });

    const canWrite = computed(() => hasOneOfAuthorities(["joinrequests.review", "kyb.review"]));

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };

    const openRequest = (row: JoinRequestSummary) => {
        void router.push({ name: "JoinRequestDetail", params: { id: row.id } });
    };

    const toneColor = (tone: ReturnType<typeof statusTone>): string => {
        const colors = theme.current.value.colors as Record<string, string>;
        return colors[tone] ?? colors["on-surface-variant"] ?? "#64748b";
    };

    const rowColor = (row: JoinRequestSummary): string | undefined => {
        const sla = slaInfo(row);
        if (sla.tone === "error" || row.status === "REJECTED") return toneColor("error");
        if (sla.tone === "warning" || row.status === "PENDING_CHECKER" || row.status === "INFO_REQUESTED") {
            return toneColor("warning");
        }
        return undefined;
    };

    const headers: TableHeader<JoinRequestSummary>[] = [
        {
            key: "merchantName",
            label: "Merchant",
            sortKey: "merchantName",
            headerTooltip: COLUMN_HELP.merchant,
            value: (row) => row.merchantName || row.merchant?.tradeName || row.merchant?.legalName || "",
            Value: ({ row }: { row: JoinRequestSummary }) => (
                <ThemedView style={{ gap: "3px" }}>
                    <ThemedText style={{ fontSize: "13px", fontWeight: 700 }}>
                        {row.merchant?.tradeName || row.merchantName || "—"}
                    </ThemedText>
                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                        {row.merchant?.legalName || row.merchantId}
                    </ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            headerTooltip: COLUMN_HELP.status,
            value: (row) => row.status,
            Value: ({ row }: { row: JoinRequestSummary }) => {
                const help = joinStatusHelp(row.status);
                return (
                    <span title={help.meaning}>
                        <StatusChip label={help.label} tone={help.tone} size="small" />
                    </span>
                );
            },
        },
        {
            key: "channel",
            label: "Channel",
            headerTooltip: COLUMN_HELP.channel,
            value: (row) => channelLabel(row.onboardingChannel),
            Value: ({ row }: { row: JoinRequestSummary }) => (
                <StatusChip
                    label={channelLabel(row.onboardingChannel)}
                    tone={row.onboardingChannel === "ADMIN_ASSISTED" ? "info" : "neutral"}
                    size="x-small"
                />
            ),
        },
        {
            key: "riskTier",
            label: "Risk tier",
            sortKey: "riskTier",
            headerTooltip: COLUMN_HELP.riskTier,
            value: (row) => row.proposedRiskTier || row.riskTier,
            Value: ({ row }: { row: JoinRequestSummary }) => (
                <StatusChip
                    label={row.proposedRiskTier || row.riskTier || "—"}
                    tone={statusTone(row.proposedRiskTier || row.riskTier)}
                    size="small"
                />
            ),
        },
        {
            key: "category",
            label: "Business category",
            headerTooltip: COLUMN_HELP.category,
            value: (row) => row.merchant?.businessCategory ?? textValue(row.profileJson?.businessCategory),
        },
        {
            key: "volume",
            label: "Expected volume",
            headerTooltip: COLUMN_HELP.volume,
            value: (row) =>
                [row.profileJson?.expectedMonthlyVolume, row.profileJson?.currency].filter(Boolean).join(" "),
            Value: ({ row }: { row: JoinRequestSummary }) => {
                const amount = textValue(row.profileJson?.expectedMonthlyVolume);
                const currency = textValue(row.profileJson?.currency);
                return (
                    <ThemedView style={{ gap: "2px" }}>
                        <ThemedText style={{ fontSize: "13px", fontWeight: 600 }}>
                            {amount ? `${amount} ${currency}`.trim() : "—"}
                        </ThemedText>
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>
                            {row.merchant?.country || ""}
                        </ThemedText>
                    </ThemedView>
                );
            },
        },
        {
            key: "submittedAt",
            label: "Submitted",
            sortKey: "submittedAt",
            headerTooltip: COLUMN_HELP.submitted,
            value: (row) => row.submittedAt ?? row.createdAt,
            Value: ({ row }: { row: JoinRequestSummary }) => (
                <ThemedText style={{ fontSize: "12px" }}>{formatDateTime(row.submittedAt ?? row.createdAt)}</ThemedText>
            ),
        },
        {
            key: "sla",
            label: "SLA",
            sortKey: "slaDueAt",
            headerTooltip: COLUMN_HELP.sla,
            value: (row) => row.slaDueAt,
            Value: ({ row }: { row: JoinRequestSummary }) => {
                const sla = slaInfo(row);
                return (
                    <ThemedView style={{ gap: "3px" }}>
                        <StatusChip label={sla.label} tone={sla.tone} size="x-small" />
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>
                            {formatDateTime(row.slaDueAt)}
                        </ThemedText>
                    </ThemedView>
                );
            },
        },
        {
            key: "reviewer",
            label: "Assignee",
            headerTooltip: COLUMN_HELP.reviewer,
            value: (row) => row.reviewer ?? "",
            Value: ({ row }: { row: JoinRequestSummary }) => (
                <ThemedText style={{ fontSize: "12px", opacity: row.reviewer ? 1 : 0.55 }}>
                    {row.reviewer || t("Unassigned")}
                </ThemedText>
            ),
        },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }: { row: JoinRequestSummary }) => (
                <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => openRequest(row)}>
                    {t("Open")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Join Requests")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                            <StatusChip label={`${total.value} ${t("requests")}`} tone="info" size="small" />
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportCsv()}>{t("Export CSV")}</VBtn>
                            {canWrite.value && (
                                <VBtn
                                    color="primary"
                                    prependIcon="mdi-account-plus-outline"
                                    onClick={() => void router.push({ name: "JoinRequestNew" })}
                                >
                                    {t("New admin-assisted request")}
                                </VBtn>
                            )}
                        </ThemedView>
                    )}
                />

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px", flex: 1 }}>{t("Onboarding SLA health")}</ThemedText>
                                <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
                                <ThemedText style={{ fontSize: "11px", opacity: 0.55 }}>{t("Paused SLAs are excluded from overdue counts.")}</ThemedText>
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
                                {Object.entries(summary.value.byStatus ?? {}).map(([state, count]) => (
                                    <StatusChip key={state} label={`${state.replaceAll("_", " ")}: ${count}`} tone={statusTone(state)} size="x-small" />
                                ))}
                                {Object.entries(summary.value.byRisk ?? {}).map(([risk, count]) => (
                                    <StatusChip key={risk} label={`${risk}: ${count}`} tone={statusTone(risk)} size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
                )}

                <ApiTable<JoinRequestSummary>
                    title={t("Join Requests")}
                    url={urlsMap.joinRequestsList}
                    showNumber={true}
                    xlsx={true}
                    localSearch={false}
                    numberOfItemsPerPage={pageSize.value}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => (search.value = value)}
                    headers={headers}
                    rowColor={rowColor}
                    apiDataExtractor={(data) => {
                        const payload = data as { joinRequests?: JoinRequestSummary[]; rows?: JoinRequestSummary[] };
                        return payload.joinRequests ?? payload.rows ?? [];
                    }}
                    apiTotalExtractor={(data) => {
                        const payload = data as { total?: number; joinRequests?: JoinRequestSummary[] };
                        return Number(payload.total ?? payload.joinRequests?.length ?? 0);
                    }}
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
                    onRefresh={(props, refresh) => {
                        void refresh({
                            queryParams: {
                                page: props.page,
                                pageSize: pageSize.value,
                                ...(search.value ? { search: search.value } : {}),
                                ...buildFilterQuery(filterDefinitions, filters.value),
                                ...(props.sortKey
                                    ? { sortKey: props.sortKey, sortDirection: props.sortDirection }
                                    : {}),
                            },
                        });
                    }}
                    TopSlot={() => (
                        <TableFilters
                            filters={filterDefinitions}
                            values={filters.value}
                            total={total.value}
                            onChange={onFiltersChanged}
                            onClear={onFiltersCleared}
                        />
                    )}
                />
            </ThemedView>
        </ScreenContainer>
    );
});

export default JoinRequestsPage;
