import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { useRouter } from "vue-router";
import {
    VAlert,
    VBtn,
    VCard,
    VCardText,
    VDialog,
    VProgressCircular,
    VSelect,
    VTab,
    VTabs,
    VTextarea,
} from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { statusTone } from "@/components/Table/statusTone";
import { JsonPatchDiff, type JsonPatchOperation } from "@/components/JsonPatchDiff";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import ApprovalHelpPanel from "./components/ApprovalHelpPanel";
import {
    APPROVAL_BLOCK_REASON_HELP,
    APPROVAL_DOMAIN_HELP,
    APPROVAL_STATE_HELP,
} from "./approvalHelp";
import type { ApprovalDetail, ApprovalRow, ApprovalSummary } from "./types";

type ApprovalView = "pending" | "history" | "all";

const PENDING_STATES = ["PENDING_REVIEW"];
const HISTORY_STATES = ["APPROVED", "EXECUTED", "REJECTED"];

const subjectTypeLabel = (value: string): string =>
    value
        .toLowerCase()
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");

const kindLabel = (value: string): string => value.replaceAll("_", " ");

const formatDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
};

const jsonText = (value: unknown): string => {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

const ApprovalsPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const router = useRouter();
    const rows = ref<ApprovalRow[]>([]);
    const total = ref(0);
    const summary = ref<ApprovalSummary | null>(null);
    const search = ref<string | null>(null);
    const activeView = ref<ApprovalView>("pending");
    const filters = ref<FilterValues>({ state: [...PENDING_STATES] });
    const pageSize = ref(20);
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;

    const detailsOpen = ref(false);
    const selected = ref<ApprovalDetail | null>(null);
    const detailLoading = ref(false);
    const decisionReason = ref("");
    const outcome = ref<"WON" | "LOST" | "">("");
    const riskAcceptanceNote = ref("");
    const actionLoading = ref(false);

    const filterDefinitions = computed(() => tableRegistry.Approvals?.filters ?? []);

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.approvalsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as ApprovalSummary;
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
        filters.value = activeView.value === "pending"
            ? { state: [...PENDING_STATES] }
            : activeView.value === "history"
              ? { state: [...HISTORY_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const setView = (view: ApprovalView) => {
        activeView.value = view;
        filters.value = view === "pending"
            ? { state: [...PENDING_STATES] }
            : view === "history"
              ? { state: [...HISTORY_STATES] }
              : {};
        refreshHook.value?.reset();
    };

    const refreshAll = () => {
        refreshHook.value?.refreshAsIs();
        void loadSummary();
    };

    const subjectRoute = (row: ApprovalRow): { name: string; params: Record<string, string> } | null => {
        switch (row.subjectType) {
            case "MERCHANT":
                return { name: "MerchantDetail", params: { id: row.subjectId } };
            case "JOIN_REQUEST":
                return { name: "JoinRequestDetail", params: { id: row.subjectId } };
            case "OPERATOR_CASE":
                return { name: "OperatorCaseDetail", params: { id: row.subjectId } };
            default:
                return null;
        }
    };

    const openSubject = (row: ApprovalRow) => {
        const target = subjectRoute(row);
        if (target) void router.push(target);
    };

    const openDetails = async (row: ApprovalRow) => {
        selected.value = {
            ...row,
            subjectContext: null,
            canCheck: false,
            canApprove: false,
            checkBlockedReason: null,
        };
        decisionReason.value = "";
        outcome.value = "";
        riskAcceptanceNote.value = "";
        detailsOpen.value = true;
        detailLoading.value = true;
        try {
            const response = await api.get(urlsMap.approvalDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = (payload.approval ?? payload) as ApprovalDetail;
        } catch (error) {
            detailsOpen.value = false;
            selected.value = null;
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            detailLoading.value = false;
        }
    };

    const requiresOutcome = computed(() =>
        selected.value?.subjectType === "ADJUSTMENT" && selected.value?.kind === "CHARGEBACK",
    );

    const canApprove = computed(() => selected.value?.canApprove === true);
    const canReject = computed(() => selected.value?.canCheck === true);
    const blockMessage = computed(() => {
        const reason = selected.value?.checkBlockedReason;
        if (!reason) return null;
        return APPROVAL_BLOCK_REASON_HELP[reason] ?? reason.replaceAll("_", " ");
    });

    const decide = async (approve: boolean) => {
        if (!selected.value) return;
        if (approve && !canApprove.value) return;
        if (!approve && !canReject.value) return;
        const reason = decisionReason.value.trim();
        if (!approve && reason.length < 3) {
            showSnackBar({ type: "warning", message: t("A rejection reason is required") });
            return;
        }
        if (approve && requiresOutcome.value && !outcome.value) {
            showSnackBar({ type: "warning", message: t("Choose the chargeback outcome before approving") });
            return;
        }
        actionLoading.value = true;
        try {
            const response = await api.post(
                approve ? urlsMap.approvalApprove(selected.value.id) : urlsMap.approvalReject(selected.value.id),
                {
                    ...(approve && requiresOutcome.value && outcome.value ? { outcome: outcome.value } : {}),
                    ...(reason ? { reason } : {}),
                    ...(approve && riskAcceptanceNote.value.trim() ? { riskAcceptanceNote: riskAcceptanceNote.value.trim() } : {}),
                },
            );
            const payload = response.data?.data ?? response.data ?? {};
            detailsOpen.value = false;
            showSnackBar({
                type: "success",
                message: approve
                    ? payload.status === "QUEUED"
                        ? t("Approved and queued for execution")
                        : t("Approved")
                    : t("Rejected"),
            });
            refreshAll();
        } catch (error) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(error) });
        } finally {
            actionLoading.value = false;
        }
    };

    const summaryItems = computed(() => {
        const data = summary.value;
        if (!data) return [];
        return [
            { label: t("Open requests"), value: String(data.totalPending), tone: data.totalPending > 0 ? "warning" as const : "success" as const },
            { label: t("Expiring in 24h"), value: String(data.expiringSoon), tone: data.expiringSoon > 0 ? "warning" as const : "success" as const },
            { label: t("Expired"), value: String(data.expired), tone: data.expired > 0 ? "error" as const : "success" as const },
            { label: t("Emergency due"), value: String(data.emergencyDue), tone: data.emergencyDue > 0 ? "error" as const : "success" as const },
            { label: t("Oldest pending"), value: `${data.oldestAgeHours}h`, tone: data.oldestAgeHours >= 72 ? "error" as const : data.oldestAgeHours >= 24 ? "warning" as const : "success" as const },
        ];
    });

    const contextRows = computed(() => {
        const context = selected.value?.subjectContext;
        if (!context) return [];
        const rows: Array<{ label: string; value: string }> = [];
        const push = (label: string, value: unknown) => {
            if (value === null || value === undefined || value === "") return;
            rows.push({ label, value: String(value) });
        };
        push(t("Type"), subjectTypeLabel(String(context.contextType ?? selected.value?.subjectType ?? "")));
        push(t("Reference"), context.id ?? selected.value?.subjectId);
        push(t("Merchant"), context.merchant?.tradeName ?? context.merchant?.legalName ?? context.tradeName ?? context.legalName ?? context.displayName);
        push(t("Status"), context.status);
        push(t("KYB"), context.kybStatus);
        push(t("Risk"), context.riskTier);
        push(t("Channel"), context.onboardingChannel);
        push(t("Submitted"), context.submittedAt ? formatDateTime(String(context.submittedAt)) : null);
        push(t("SLA due"), context.slaDueAt ? formatDateTime(String(context.slaDueAt)) : null);
        push(t("Adjustment type"), context.type);
        push(t("Amount"), context.amount);
        push(t("Adjustment state"), context.state);
        push(t("Operator priority"), context.priority);
        push(t("Operator kind"), context.kind);
        push(t("AML severity"), context.severity);
        push(t("Trigger"), context.triggerReason);
        push(t("Version"), context.versionNumber);
        push(t("Gateway"), context.gateway && typeof context.gateway === "object" ? `${(context.gateway as Record<string, unknown>).code ?? ""} ${(context.gateway as Record<string, unknown>).name ?? ""}`.trim() : null);
        push(t("Role"), context.role);
        push(t("Setting key"), context.key);
        push(t("Report type"), context.reportType);
        return rows;
    });

    const headers = computed<TableHeader<ApprovalRow>[]>(() => [
        {
            key: "subject",
            label: "Subject",
            sortKey: "subjectType",
            headerTooltip: "The entity that will change when this request is approved.",
            value: (row) => `${row.subjectType} ${row.subjectId}`,
            Value: ({ row }: { row: ApprovalRow }) => (
                <ThemedView style={{ gap: "3px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 700 }}>{subjectTypeLabel(row.subjectType)}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55, direction: "ltr" }}>{row.subjectId}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{kindLabel(row.kind)}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "domain",
            label: "Domain",
            headerTooltip: "The risk domain that owns this request. A checker may only act inside their authorised domains.",
            value: (row) => row.domain,
            Value: ({ row }: { row: ApprovalRow }) => <span title={APPROVAL_DOMAIN_HELP[row.domain]}><StatusChip label={row.domain} tone="neutral" size="x-small" /></span>,
        },
        {
            key: "state",
            label: "State",
            sortKey: "state",
            value: (row) => row.state,
            Value: ({ row }: { row: ApprovalRow }) => {
                const help = APPROVAL_STATE_HELP[row.state];
                return <span title={help?.meaning}><StatusChip label={help?.label ?? row.state} tone={help?.tone ?? statusTone(row.state)} size="small" /></span>;
            },
        },
        {
            key: "mode",
            label: "Mode",
            sortKey: "mode",
            value: (row) => row.mode,
            Value: ({ row }: { row: ApprovalRow }) => (
                <StatusChip
                    label={row.mode === "EMERGENCY_RATIFICATION" ? t("Emergency") : t("Standard")}
                    tone={row.mode === "EMERGENCY_RATIFICATION" ? "error" : "neutral"}
                    size="x-small"
                />
            ),
        },
        {
            key: "maker",
            label: "Maker",
            value: (row) => row.makerName,
            Value: ({ row }: { row: ApprovalRow }) => <ThemedText style={{ fontSize: "11px", direction: "ltr" }}>{row.makerName || row.makerUserId}</ThemedText>,
        },
        {
            key: "checker",
            label: "Checker",
            value: (row) => row.checkerName,
            Value: ({ row }: { row: ApprovalRow }) => <ThemedText style={{ fontSize: "11px", direction: "ltr", opacity: row.checkerName ? 1 : 0.55 }}>{row.checkerName || "—"}</ThemedText>,
        },
        {
            key: "age",
            label: "Age",
            headerTooltip: "How long this request has been waiting. Ageing above 24 hours is highlighted; above 72 hours is critical.",
            value: (row) => String(row.ageHours),
            Value: ({ row }: { row: ApprovalRow }) => (
                <StatusChip label={`${row.ageHours}h`} tone={row.ageHours >= 72 ? "error" : row.ageHours >= 24 ? "warning" : "neutral"} size="x-small" />
            ),
        },
        {
            key: "expires",
            label: "Expires",
            sortKey: "expiresAt",
            value: (row) => row.expiresAt ?? "",
            Value: ({ row }: { row: ApprovalRow }) => (
                row.expired
                    ? <StatusChip label={t("Expired")} tone="error" size="x-small" />
                    : <ThemedText style={{ fontSize: "11px", opacity: row.expiresInHours !== null && row.expiresInHours <= 24 ? 1 : 0.7 }}>
                        {row.expiresInHours === null ? t("No expiry") : `${row.expiresInHours}h`}
                    </ThemedText>
            ),
        },
        {
            key: "actions",
            label: "Review",
            sortable: false,
            Value: ({ row }: { row: ApprovalRow }) => (
                <VBtn size="small" variant="tonal" onClick={() => void openDetails(row)}>{t("Review")}</VBtn>
            ),
        },
    ]);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Approvals")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                        </ThemedView>
                    )}
                />

                <VAlert type="info" variant="tonal">
                    {t("Maker and checker must always be different people. Read the diff before deciding. All decisions are audited.")}
                </VAlert>

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Queue health")}</ThemedText>
                            <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
                                {summaryItems.value.map((item) => (
                                    <VCard key={item.label} variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px" }}>
                                            <ThemedText style={{ fontSize: "11px", opacity: 0.62 }}>{item.label}</ThemedText>
                                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                                <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>{item.value}</ThemedText>
                                                {item.tone !== "success" && (
                                                    <StatusChip
                                                        label={item.tone === "error" ? t("Critical") : t("Attention")}
                                                        tone={item.tone}
                                                        size="x-small"
                                                    />
                                                )}
                                            </ThemedView>
                                        </VCardText>
                                    </VCard>
                                ))}
                            </ThemedView>
                            <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                                {summary.value.byDomain.map((item) => (
                                    <StatusChip key={item.domain} label={`${item.domain}: ${item.count}`} tone="info" size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
                )}

                <VTabs modelValue={activeView.value} onUpdate:modelValue={(value: unknown) => setView(value as ApprovalView)} color="primary" density="comfortable" showArrows>
                    <VTab value="pending" prependIcon="mdi-clock-alert-outline">{t("Pending")}</VTab>
                    <VTab value="history" prependIcon="mdi-history">{t("History")}</VTab>
                    <VTab value="all" prependIcon="mdi-view-list-outline">{t("All")}</VTab>
                </VTabs>

                <ApiTable<ApprovalRow>
                    title={t("Approval requests")}
                    url={urlsMap.approvalsList}
                    localSearch={false}
                    xlsx={false}
                    showNumber={true}
                    numberOfItemsPerPage={pageSize.value}
                    numberOfItemsPerPageChoices={[
                        { label: "10", value: 10 },
                        { label: "20", value: 20 },
                        { label: "50", value: 50 },
                        { label: "100", value: 100 },
                    ]}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => (search.value = value)}
                    headers={headers.value}
                    rowColor={(row) => {
                        const colors = theme.current.value.colors as Record<string, string>;
                        if (row.expired || row.mode === "EMERGENCY_RATIFICATION") return colors.error;
                        if (row.ageHours >= 24) return colors.warning;
                        return undefined;
                    }}
                    apiDataExtractor={(data) => {
                        const payload = data as { approvals?: ApprovalRow[]; rows?: ApprovalRow[] };
                        return payload.approvals ?? payload.rows ?? [];
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

                <VCard><VCardText><ApprovalHelpPanel /></VCardText></VCard>
            </ThemedView>

            <VDialog modelValue={detailsOpen.value} onUpdate:modelValue={(value: boolean) => (detailsOpen.value = value)} maxWidth="1040px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {detailLoading.value || !selected.value ? (
                            <ThemedView style={{ alignItems: "center", justifyContent: "center", minHeight: "300px", gap: "12px" }}>
                                <VProgressCircular indeterminate size={52} color="primary" />
                                <ThemedText style={{ opacity: 0.65 }}>{t("Loading approval detail")}</ThemedText>
                            </ThemedView>
                        ) : (
                            <>
                                <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
                                    <ThemedView style={{ gap: "4px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>{subjectTypeLabel(selected.value.subjectType)}</ThemedText>
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65, direction: "ltr" }}>{selected.value.subjectId}</ThemedText>
                                    </ThemedView>
                                    <ThemedView style={{ flexDirection: "row", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                                        <StatusChip label={APPROVAL_STATE_HELP[selected.value.state]?.label ?? selected.value.state} tone={APPROVAL_STATE_HELP[selected.value.state]?.tone ?? statusTone(selected.value.state)} />
                                        <StatusChip label={selected.value.domain} tone="neutral" size="small" />
                                        <StatusChip label={kindLabel(selected.value.kind)} tone="info" size="small" />
                                        {selected.value.baseVersion !== null && <StatusChip label={`v${selected.value.baseVersion}`} tone="neutral" size="small" />}
                                        {selected.value.mode === "EMERGENCY_RATIFICATION" && <StatusChip label={t("Emergency")} tone="error" size="small" />}
                                    </ThemedView>
                                </ThemedView>

                                {selected.value.expired && (
                                    <VAlert type="error" variant="tonal">{t("This request has expired. It cannot be approved, but it can still be rejected with a reason.")}</VAlert>
                                )}
                                {blockMessage.value && (
                                    <VAlert type="warning" variant="tonal">{t(blockMessage.value)}</VAlert>
                                )}

                                <ThemedView style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px" }}>
                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "7px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Subject context")}</ThemedText>
                                            {contextRows.value.length === 0 && <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>{t("No subject context is available for this request type.")}</ThemedText>}
                                            {contextRows.value.map((row) => (
                                                <ThemedView key={row.label} style={{ flexDirection: "row", gap: "10px", justifyContent: "space-between", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{row.label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: /^[A-Za-z0-9-]+$/.test(row.value) ? "ltr" : undefined }}>{row.value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                            {subjectRoute(selected.value) && (
                                                <VBtn size="small" variant="text" prependIcon="mdi-open-in-new" onClick={() => openSubject(selected.value as ApprovalRow)}>{t("Open subject")}</VBtn>
                                            )}
                                        </VCardText>
                                    </VCard>

                                    <VCard variant="tonal">
                                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "7px", padding: "14px" }}>
                                            <ThemedText type="defaultSemiBold" style={{ fontSize: "13px" }}>{t("Approval metadata")}</ThemedText>
                                            {[
                                                [t("Maker"), selected.value.makerName || selected.value.makerUserId],
                                                [t("Checker"), selected.value.checkerName || "—"],
                                                [t("Created"), formatDateTime(selected.value.createdAt)],
                                                [t("Expires"), selected.value.expired ? t("Expired") : formatDateTime(selected.value.expiresAt)],
                                                [t("Base version"), selected.value.baseVersion === null ? "—" : `v${selected.value.baseVersion}`],
                                                [t("Maker reason"), selected.value.makerReason || "—"],
                                                [t("Rejection reason"), selected.value.rejectionReason || "—"],
                                            ].map(([label, value]) => (
                                                <ThemedView key={label} style={{ flexDirection: "row", gap: "10px", justifyContent: "space-between", borderBottom: "1px solid rgba(100,116,139,0.12)", paddingBottom: "4px" }}>
                                                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{label}</ThemedText>
                                                    <ThemedText style={{ fontSize: "11px", textAlign: "right", wordBreak: "break-word", direction: "ltr" }}>{value}</ThemedText>
                                                </ThemedView>
                                            ))}
                                        </VCardText>
                                    </VCard>
                                </ThemedView>

                                <ThemedView style={{ gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold">{t("Proposed change")}</ThemedText>
                                    {Array.isArray(selected.value.payloadDiff) ? (
                                        <JsonPatchDiff operations={selected.value.payloadDiff as JsonPatchOperation[]} />
                                    ) : (
                                        <pre style={{ margin: 0, padding: "10px 12px", borderRadius: "8px", background: "rgba(15,23,42,0.06)", fontSize: "11px", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", direction: "ltr", unicodeBidi: "isolate", maxHeight: "320px", overflow: "auto" }}>
                                            {jsonText(selected.value.payloadDiff)}
                                        </pre>
                                    )}
                                </ThemedView>

                                {selected.value.riskAcceptanceNote && (
                                    <VAlert type="warning" variant="tonal">
                                        <ThemedText style={{ fontSize: "12px" }}>{t("Risk acceptance note")}: {selected.value.riskAcceptanceNote}</ThemedText>
                                    </VAlert>
                                )}

                                <VCard variant="tonal">
                                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                                        <ThemedText type="defaultSemiBold">{t("Checker decision")}</ThemedText>
                                        {requiresOutcome.value && (
                                            <VSelect
                                                label={t("Dispute outcome")}
                                                items={["WON", "LOST"]}
                                                clearable
                                                modelValue={outcome.value}
                                                onUpdate:modelValue={(value: string | null) => (outcome.value = (value as "WON" | "LOST" | null) ?? "")}
                                            />
                                        )}
                                        <VTextarea
                                            modelValue={decisionReason.value}
                                            onUpdate:modelValue={(value: string) => (decisionReason.value = value)}
                                            label={t("Decision reason")}
                                            hint={t("Required for rejection. A clear reason lets the maker correct the request.")}
                                            persistentHint
                                            rows={2}
                                        />
                                        <VTextarea
                                            modelValue={riskAcceptanceNote.value}
                                            onUpdate:modelValue={(value: string) => (riskAcceptanceNote.value = value)}
                                            label={t("Risk acceptance note (optional)")}
                                            rows={2}
                                        />
                                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                                            <VBtn
                                                color="success"
                                                disabled={!canApprove.value}
                                                loading={actionLoading.value}
                                                onClick={() => void decide(true)}
                                            >
                                                {t("Approve")}
                                            </VBtn>
                                            <VBtn
                                                color="error"
                                                variant="tonal"
                                                disabled={!canReject.value}
                                                loading={actionLoading.value}
                                                onClick={() => void decide(false)}
                                            >
                                                {t("Reject")}
                                            </VBtn>
                                            <VBtn variant="text" onClick={() => (detailsOpen.value = false)}>{t("Close")}</VBtn>
                                        </ThemedView>
                                    </VCardText>
                                </VCard>
                            </>
                        )}
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default ApprovalsPage;
