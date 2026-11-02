import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { ApiTable } from "@/components/Table/ApiTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
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
import { formatDateTime } from "../operatorCaseHelp";
import type {
    GatewayInquirySchedule,
    GatewayInquiryScheduleSummary,
} from "../types";

import { FormModal } from "@/components/ui/FormModal";
import { MetricStrip } from "@/components/ui/MetricStrip";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { FormField } from "@/components/ui/FormField";
import { EmptyState } from "@/components/ui/EmptyState";
const filterDefinitions = tableRegistry.GatewayInquiries?.filters ?? [];

const statusLabel = (status: string): string =>
    status
        .replaceAll("_", " ")
        .toLowerCase()
        .replace(/^\w/, (letter) => letter.toUpperCase());

const summaryCards = (summary: GatewayInquiryScheduleSummary | null, t: (key: string) => string) => {
    if (!summary) return [];
    return [
        {
            key: "SCHEDULED",
            label: t("Scheduled"),
            value: String(summary.scheduled),
            subLabel: t("Queued inquiries"),
            badge: t("Queued"),
            badgeTone: "info" as const,
        },
        {
            key: "RUNNING",
            label: t("Running"),
            value: String(summary.running),
            subLabel: t("In flight"),
            badge: t("Live"),
            badgeTone: "info" as const,
        },
        {
            key: "RETRYING",
            label: t("Retrying"),
            value: String(summary.retrying),
            subLabel: t("Retry window"),
            badge: t("P2"),
            badgeTone: "warning" as const,
        },
        {
            key: "COMPLETED",
            label: t("Completed"),
            value: String(summary.completed),
            subLabel: t("Settled inquiries"),
            badge: t("Complete"),
            badgeTone: "success" as const,
        },
        {
            key: "FAILED",
            label: t("Failed"),
            value: String(summary.failed),
            subLabel: t("Needs operator review"),
            badge: summary.failed > 0 ? t("P1") : t("Clear"),
            badgeTone: summary.failed > 0 ? "danger" as const : "success" as const,
        },
        {
            key: "CANCELLED",
            label: t("Cancelled"),
            value: String(summary.cancelled),
            subLabel: t("Stopped schedules"),
            badge: t("Closed"),
            badgeTone: "neutral" as const,
        },
        {
            key: "EXPIRED",
            label: t("Expired"),
            value: String(summary.expired),
            subLabel: t("Past window"),
            badge: summary.expired > 0 ? t("P1") : t("Clear"),
            badgeTone: summary.expired > 0 ? "danger" as const : "success" as const,
        },
        {
            key: "OVERDUE",
            label: t("Overdue"),
            value: String(summary.overdue),
            subLabel: t("Past SLA"),
            badge: summary.overdue > 0 ? t("P1") : t("Clear"),
            badgeTone: summary.overdue > 0 ? "danger" as const : "success" as const,
        },
    ];
};

type ActionMode = "cancel" | "run-now" | "retry";

type ScheduleDetail = {
    schedule: GatewayInquirySchedule;
    auditTrail: Array<{
        id: string;
        createdAt: string;
        action: string;
        role: string;
        actor?: { email?: string | null } | null;
        afterJson?: unknown;
    }>;
};

const GatewayInquirySchedulesPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const router = useRouter();
    const asBadgeTone = (tone: ReturnType<typeof statusTone>): BadgeTone =>
        tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const total = ref(0);
    const summary = ref<GatewayInquiryScheduleSummary | null>(null);
    const summaryLoading = ref(false);
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const actionMode = ref<ActionMode | null>(null);
    const actionRow = ref<GatewayInquirySchedule | null>(null);
    const actionReason = ref("");
    const actionLoading = ref(false);

    const detailOpen = ref(false);
    const detailLoading = ref(false);
    const detail = ref<ScheduleDetail | null>(null);

    const canAct = computed(() => hasOneOfAuthorities(["attempt:inquire", "case:write", "operator:write"]));
    const cards = computed(() => summaryCards(summary.value, t));
    const sourceLabel = (source: string): string => {
        if (source === "OPERATOR_CASE") return t("Operator case");
        if (source === "AUTOMATIC") return t("Automatic");
        return statusLabel(source);
    };

    const loadSummary = async () => {
        summaryLoading.value = true;
        try {
            const response = await api.get(urlsMap.gatewayInquiriesSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as GatewayInquiryScheduleSummary;
        } catch {
            summary.value = null;
        } finally {
            summaryLoading.value = false;
        }
    };

    void loadSummary();

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const onSearch = () => {
        refreshHook.value?.reset();
    };

    const onFiltersChanged = () => {
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };

    const openCase = (row: GatewayInquirySchedule) => {
        if (row.operatorCaseId) {
            void router.push({ name: "OperatorCaseDetail", params: { id: row.operatorCaseId } });
        }
    };

    const openAction = (mode: ActionMode, row: GatewayInquirySchedule) => {
        actionMode.value = mode;
        actionRow.value = row;
        actionReason.value = "";
    };

    const closeAction = () => {
        actionMode.value = null;
        actionRow.value = null;
        actionReason.value = "";
    };

    const actionTitle = computed(() => {
        if (actionMode.value === "cancel") return t("Cancel gateway inquiry");
        if (actionMode.value === "run-now") return t("Run gateway inquiry now");
        if (actionMode.value === "retry") return t("Retry gateway inquiry");
        return "";
    });

    const actionDescription = computed(() => {
        if (actionMode.value === "cancel") return t("The schedule will stop before its next run. The payment attempt itself is not changed.");
        if (actionMode.value === "run-now") return t("The next gateway inquiry will run immediately.");
        if (actionMode.value === "retry") return t("A failed, expired or cancelled inquiry will be scheduled to run again.");
        return "";
    });

    const submitAction = async () => {
        const row = actionRow.value;
        const mode = actionMode.value;
        if (!row || !mode || actionLoading.value) return;
        if (mode === "cancel" && actionReason.value.trim().length < 3) {
            showSnackBar({ type: "warning", message: t("A cancellation reason of at least 3 characters is required") });
            return;
        }
        actionLoading.value = true;
        try {
            const body = { reason: actionReason.value.trim() || undefined };
            if (mode === "cancel") {
                await api.post(urlsMap.gatewayInquiryCancel(row.id), { reason: actionReason.value.trim() });
            } else if (mode === "run-now") {
                await api.post(urlsMap.gatewayInquiryRunNow(row.id), body);
            } else {
                await api.post(urlsMap.gatewayInquiryRetry(row.id), body);
            }
            showSnackBar({
                type: "success",
                message:
                    mode === "cancel"
                        ? t("Gateway inquiry cancelled")
                        : mode === "run-now"
                          ? t("Gateway inquiry will run now")
                          : t("Gateway inquiry retried"),
            });
            closeAction();
            refreshAll();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            actionLoading.value = false;
        }
    };

    const openDetail = async (row: GatewayInquirySchedule) => {
        detailOpen.value = true;
        detailLoading.value = true;
        detail.value = null;
        try {
            const response = await api.get(urlsMap.gatewayInquiryDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            detail.value = {
                schedule: (payload.schedule ?? row) as GatewayInquirySchedule,
                auditTrail: (payload.auditTrail ?? []) as ScheduleDetail["auditTrail"],
            };
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const headers: TableHeader<GatewayInquirySchedule>[] = [
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            headerTooltip: "The current state of the persisted gateway inquiry schedule.",
            value: (row) => row.status,
            Value: ({ row }) => (
                <ThemedView style={{ gap: "3px" }}>
                    <StatusBadge status={row.status} label={statusLabel(row.status)} toneOverride={asBadgeTone(statusTone(row.status))} />
                    {row.isOverdue && <StatusBadge status="Overdue" label={t("Overdue")} toneOverride="warning" />}
                </ThemedView>
            ),
        },
        {
            key: "case",
            label: "Case",
            value: (row) => row.caseRef ?? row.operatorCaseId ?? "",
            Value: ({ row }) => (
                <VBtn
                    size="small"
                    variant="text"
                    disabled={!row.operatorCaseId}
                    onClick={() => openCase(row)}
                >
                    {row.caseRef || row.operatorCaseId || "—"}
                </VBtn>
            ),
        },
        {
            key: "attempt",
            label: "Attempt",
            value: (row) => row.attemptReference ?? "",
            Value: ({ row }) => (
                <ThemedView style={{ gap: "3px" }}>
                    <MonoRef value={row.attemptReference ?? ""} truncate={18} />
                    <StatusBadge status={row.attemptStatus || "Unknown"} label={row.attemptStatus || t("Unknown")} toneOverride={asBadgeTone(statusTone(row.attemptStatus))} />
                </ThemedView>
            ),
        },
        {
            key: "merchant",
            label: "Merchant",
            value: (row) => row.merchantName,
            Value: ({ row }) => <ThemedText style={{ fontSize: "12px" }}>{row.merchantName || "—"}</ThemedText>,
        },
        {
            key: "gateway",
            label: "Gateway",
            value: (row) => row.gatewayName ?? row.gatewayCode ?? "",
            Value: ({ row }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{row.gatewayName || row.gatewayCode || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.railCode || ""}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "source",
            label: "Source",
            sortKey: "source",
            value: (row) => row.source,
            Value: ({ row }) => <StatusBadge status={row.source} label={sourceLabel(row.source)} toneOverride={row.source === "OPERATOR_CASE" ? "info" : "neutral"} />,
        },
        {
            key: "scheduledAt",
            label: "Scheduled",
            sortKey: "scheduledAt",
            value: (row) => row.scheduledAt,
            Value: ({ row }) => <ThemedText style={{ fontSize: "12px" }}>{formatDateTime(row.scheduledAt)}</ThemedText>,
        },
        {
            key: "nextRunAt",
            label: "Next run",
            sortKey: "nextRunAt",
            value: (row) => row.nextRunAt,
            Value: ({ row }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: row.isOverdue ? 700 : 400 }}>{formatDateTime(row.nextRunAt)}</ThemedText>
                    {row.attempts > 0 && <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.attempts} {t("attempts")}</ThemedText>}
                </ThemedView>
            ),
        },
        {
            key: "lastRunAt",
            label: "Last run",
            sortKey: "lastRunAt",
            value: (row) => row.lastRunAt ?? "",
            Value: ({ row }) => <ThemedText style={{ fontSize: "12px" }}>{formatDateTime(row.lastRunAt)}</ThemedText>,
        },
        {
            key: "lastResult",
            label: "Result",
            value: (row) => row.lastResult ?? row.lastError ?? "",
            Value: ({ row }) => (
                <ThemedView style={{ gap: "2px", maxWidth: "220px" }}>
                    {row.lastResult && <StatusBadge status={row.lastResult} label={row.lastResult} toneOverride={asBadgeTone(statusTone(row.lastResult))} />}
                    {row.lastError && <ThemedText style={{ fontSize: "10px", opacity: 0.65 }}>{row.lastError}</ThemedText>}
                    {!row.lastResult && !row.lastError && <ThemedText style={{ fontSize: "11px", opacity: 0.5 }}>—</ThemedText>}
                </ThemedView>
            ),
        },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            Value: ({ row }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("Run now"),
                        icon: "mdi-radar",
                        disabled: !canAct.value || !row.canRunNow || actionLoading.value,
                        onClick: () => openAction("run-now", row),
                    }}
                    items={[
                        { key: "view", label: t("View"), icon: "mdi-eye-outline", onClick: () => void openDetail(row) },
                        {
                            key: "cancel",
                            label: t("Cancel"),
                            icon: "mdi-cancel",
                            danger: true,
                            disabled: !canAct.value || !row.canCancel || actionLoading.value,
                            onClick: () => openAction("cancel", row),
                        },
                        {
                            key: "retry",
                            label: t("Retry"),
                            icon: "mdi-refresh",
                            disabled: !canAct.value || !row.canRetry || actionLoading.value,
                            onClick: () => openAction("retry", row),
                        },
                    ]}
                />
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Gateway Inquiry Schedule")}
                    subtitle={t("Monitor and operate gateway status inquiry schedules created by operator cases.")}
                    badge={summary.value ? `${summary.value.overdue} ${t("Overdue")}` : t("Gateway inquiries")}
                    badgeTone={summary.value && summary.value.overdue > 0 ? "danger" : "info"}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                            <VBtn variant="text" prependIcon="mdi-arrow-left" onClick={() => void router.push({ name: "OperatorCases" })}>
                                {t("Operator Cases")}
                            </VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" loading={summaryLoading.value} onClick={refreshAll}>
                                {t("Refresh")}
                            </VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Schedules are created when an operator requests a gateway status inquiry. The platform poll worker performs the inquiry and updates the schedule status.")}
                </VAlert>

                {cards.value.length > 0 && <MetricStrip items={cards.value} loading={summaryLoading.value} />}

                <ApiTable<GatewayInquirySchedule>
                    title={t("Gateway Inquiry Schedule")}
                    url={urlsMap.gatewayInquiries}
                    showNumber={true}
                    xlsx={true}
                    localSearch={false}
                    numberOfItemsPerPage={pageSize.value}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => {
                        search.value = value;
                        onSearch();
                    }}
                    headers={headers}
                    rowColor={(row) => (row.isOverdue ? theme.current.value.colors.warning : undefined)}
                    apiDataExtractor={(data) => {
                        const payload = data as { schedules?: GatewayInquirySchedule[]; rows?: GatewayInquirySchedule[] };
                        return payload.schedules ?? payload.rows ?? [];
                    }}
                    apiTotalExtractor={(data) => Number((data as { total?: number }).total ?? 0)}
                    onData={(_rows, nextTotal) => {
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
                                ...(props.sortKey ? { sortKey: props.sortKey, sortDirection: props.sortDirection } : {}),
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

            <FormModal
                modelValue={actionMode.value !== null}
                onUpdate:modelValue={(value: boolean) => !value && closeAction()}
                title={actionTitle.value}
                size="sm"
                onSubmit={() => void submitAction()}
                submitLabel={actionMode.value === "cancel" ? t("Cancel inquiry") : actionMode.value === "retry" ? t("Retry inquiry") : t("Run now")}
                cancelLabel={t("Close")}
                loading={actionLoading.value}
                danger={actionMode.value === "cancel"}
            >
                <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{actionDescription.value}</ThemedText>
                {actionRow.value && (
                    <ThemedView style={{ gap: "3px", padding: "10px", borderRadius: "var(--pg-radius-lg)", background: "var(--pg-bg-surface-subtle)" }}>
                        <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{actionRow.value.caseRef || actionRow.value.operatorCaseId}</ThemedText>
                        <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{actionRow.value.attemptReference} · {actionRow.value.gatewayName || actionRow.value.gatewayCode}</ThemedText>
                    </ThemedView>
                )}
                <FormField
                    label={actionMode.value === "cancel" ? t("Cancellation reason") : t("Reason (optional)")}
                    hint={actionMode.value === "cancel" ? t("At least 3 characters.") : ""}
                    required={actionMode.value === "cancel"}
                >
                    <VTextarea
                        modelValue={actionReason.value}
                        onUpdate:modelValue={(value: string) => (actionReason.value = value)}
                        rows={3}
                    />
                </FormField>
            </FormModal>

            <SlideOverDrawer
                modelValue={detailOpen.value}
                onUpdate:modelValue={(value: boolean) => (detailOpen.value = value)}
                title={t("Gateway inquiry detail")}
                subtitle={detail.value?.schedule.caseRef || detail.value?.schedule.attemptReference || ""}
                width={620}
            >
{detailLoading.value ? (
                            <ThemedText style={{ opacity: 0.65 }}>{t("Loading")}</ThemedText>
                        ) : detail.value ? (
                            <>
                                <DescriptionList
                                    columns={2}
                                    items={[
                                        { label: t("Schedule ID"), value: <MonoRef value={detail.value.schedule.id} /> },
                                        { label: t("Status"), value: statusLabel(detail.value.schedule.status) },
                                        { label: t("Source"), value: sourceLabel(detail.value.schedule.source) },
                                        { label: t("Case"), value: <MonoRef value={detail.value.schedule.caseRef || detail.value.schedule.operatorCaseId || ""} /> },
                                        { label: t("Attempt"), value: <MonoRef value={detail.value.schedule.attemptReference || detail.value.schedule.attemptId} /> },
                                        { label: t("Merchant"), value: detail.value.schedule.merchantName || "—" },
                                        { label: t("Merchant ID"), value: <MonoRef value={detail.value.schedule.merchantId ?? ""} /> },
                                        { label: t("Gateway"), value: detail.value.schedule.gatewayName || detail.value.schedule.gatewayCode || "—" },
                                        { label: t("Gateway ID"), value: <MonoRef value={detail.value.schedule.gatewayId ?? ""} /> },
                                        { label: t("Scheduled"), value: formatDateTime(detail.value.schedule.scheduledAt) },
                                        { label: t("Next run"), value: formatDateTime(detail.value.schedule.nextRunAt) },
                                        { label: t("Last run"), value: formatDateTime(detail.value.schedule.lastRunAt) },
                                        { label: t("Attempts"), value: String(detail.value.schedule.attempts) },
                                        { label: t("Last result"), value: detail.value.schedule.lastResult || "—" },
                                        { label: t("Last error"), value: detail.value.schedule.lastError || "—" },
                                        { label: t("Scheduled by"), value: detail.value.schedule.scheduledByEmail || "—" },
                                        { label: t("Cancelled by"), value: detail.value.schedule.cancelledByEmail || "—" },
                                        { label: t("Cancel reason"), value: detail.value.schedule.cancelReason || "—" },
                                    ]}
                                />
                                <ThemedText type="defaultSemiBold">{t("Schedule audit trail")}</ThemedText>
                                {detail.value.auditTrail.length === 0 ? (
                                    <EmptyState title={t("No audit entries yet.")} icon="mdi-history" />
                                ) : (
                                    detail.value.auditTrail.map((entry) => (
                                        <ThemedView key={entry.id} style={{ gap: "3px", borderBottom: "1px solid var(--pg-border-subtle)", paddingBottom: "7px" }}>
                                            <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", gap: "10px" }}>
                                                <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{entry.action.replaceAll("_", " ")}</ThemedText>
                                                <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(entry.createdAt)}</ThemedText>
                                            </ThemedView>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>
                                                {entry.actor?.email || entry.role}
                                            </ThemedText>
                                        </ThemedView>
                                    ))
                                )}
                            </>
                        ) : null}
            </SlideOverDrawer>
        </ScreenContainer>
    );
});

export default GatewayInquirySchedulesPage;
