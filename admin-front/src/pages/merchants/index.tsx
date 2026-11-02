import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { VBtn } from "vuetify/components";
import { useRouter } from "vue-router";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { ApiTable } from "@/components/Table/ApiTable";
import TableFilters from "@/components/Table/TableFilters";
import { buildFilterQuery, type FilterValues } from "@/components/Table/filters";
import { tableRegistry } from "@/components/Table/tableRegistry";
import { statusTone } from "@/components/Table/statusTone";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { hasOneOfAuthorities, user } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
import { areHelpPanelsVisible } from "@/constants/env";
import { xlsxUIPipeline } from "@/utils/xlsx";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import {
    COLUMN_HELP,
    formatDateTime,
    kybStatusHelp,
    merchantStatusHelp,
    riskHelp,
} from "./merchantHelp";
import type { MerchantSummary } from "./types";
import MerchantHelpPanel from "./components/MerchantHelpPanel";
import MerchantActionDialog, { type MerchantActionMode } from "./components/MerchantActionDialog";

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { DescriptionList } from "@/components/ui/DescriptionList";
import { MonoRef } from "@/components/ui/MonoRef";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
type MerchantsSummary = {
    total: number;
    active: number;
    pending: number;
    suspended: number;
    rejected: number;
    closed: number;
    kybPending: number;
    kybVerified: number;
    highRisk: number;
    reviewOverdue: number;
    reviewDueSoon: number;
    pendingApprovals: number;
    byStatus: Record<string, number>;
    byKyb: Record<string, number>;
    byRisk: Record<string, number>;
    byChannel: Record<string, number>;
};

const MerchantsPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const router = useRouter();
    const asBadgeTone = (tone: ReturnType<typeof statusTone>): BadgeTone =>
        tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const rows = ref<MerchantSummary[]>([]);
    const total = ref(0);
    const summary = ref<MerchantsSummary | null>(null);
    const pageSize = ref(20);
    let filterTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshHook = ref<{
        reset: () => void;
        refresh: (props: { queryParams?: Record<string, unknown>; nextSkip?: number }) => Promise<void>;
        refreshAsIs: () => void;
    } | null>(null);
    const actionOpen = ref(false);
    const actionMode = ref<MerchantActionMode>("SUSPEND");
    const actionMerchant = ref<MerchantSummary | null>(null);
    const inspectionOpen = ref(false);
    const inspectionMerchant = ref<MerchantSummary | null>(null);
    const exportLoading = ref(false);
    const summaryExportLoading = ref(false);

    const canWrite = computed(() =>
        hasOneOfAuthorities(["merchant:write", "merchants.edit_descriptive", "merchants.propose_sensitive", "merchants.suspend", "merchants.reinstate"]),
    );
    const canAml = computed(() =>
        user.value?.userInfo.role !== "SUPPORT"
        && hasOneOfAuthorities(["aml.read_confidential", "aml.review", "aml:read", "compliance:read"]),
    );

    const filterDefinitions = computed(() =>
        (tableRegistry.Merchants?.filters ?? []).filter((filter) => filter.key !== "hasOpenAmlCase" || canAml.value),
    );

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };

    const openDetail = (row: MerchantSummary) => {
        void router.push({ name: "MerchantDetail", params: { id: row.id } });
    };

    const openAction = (row: MerchantSummary, mode: MerchantActionMode) => {
        actionMerchant.value = row;
        actionMode.value = mode;
        actionOpen.value = true;
    };

    const openInspection = (row: MerchantSummary) => {
        inspectionMerchant.value = row;
        inspectionOpen.value = true;
    };

    const toneColor = (tone: ReturnType<typeof statusTone>): string => {
        const colors = theme.current.value.colors as Record<string, string>;
        return colors[tone] ?? colors["on-surface-variant"] ?? "var(--pg-ink-muted)";
    };

    const rowColor = (row: MerchantSummary): string | undefined => {
        if (row.status === "SUSPENDED" || row.status === "REJECTED") return toneColor("error");
        if (row.status === "PENDING" || row.pendingApprovalCount > 0) return toneColor("warning");
        return undefined;
    };

    const restricted = (value: unknown): string => (value === null || value === undefined || value === "" ? t("Restricted") : String(value));

    const headers: TableHeader<MerchantSummary>[] = [
        {
            key: "merchant",
            label: "Merchant",
            sortKey: "tradeName",
            headerTooltip: COLUMN_HELP.merchant,
            value: (row) => `${row.tradeName} ${row.legalName}`,
            Value: ({ row }: { row: MerchantSummary }) => (
                <ThemedView style={{ gap: "3px" }}>
                    <ThemedText style={{ fontSize: "13px", fontWeight: 700 }}>
                        {row.displayName || row.tradeName || "—"}
                    </ThemedText>
                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{row.legalName}</ThemedText>
                    <MonoRef value={row.id} truncate={16} />
                </ThemedView>
            ),
        },
        {
            key: "status",
            label: "Status",
            sortKey: "status",
            headerTooltip: COLUMN_HELP.status,
            value: (row) => row.status,
            Value: ({ row }: { row: MerchantSummary }) => {
                const help = merchantStatusHelp(row.status);
                return <span title={help.meaning}><StatusBadge status={row.status} label={help.label} toneOverride={asBadgeTone(help.tone)} /></span>;
            },
        },
        {
            key: "kyb",
            label: "KYB",
            sortKey: "kybStatus",
            headerTooltip: COLUMN_HELP.kyb,
            value: (row) => row.kybStatus ?? "",
            Value: ({ row }: { row: MerchantSummary }) => {
                if (!row.kybStatus) return <ThemedText style={{ opacity: 0.55 }}>{t("Restricted")}</ThemedText>;
                const help = kybStatusHelp(row.kybStatus);
                return <span title={help.meaning}><StatusBadge status={row.kybStatus} label={help.label} toneOverride={asBadgeTone(help.tone)} /></span>;
            },
        },
        {
            key: "risk",
            label: "Risk",
            sortKey: "riskTier",
            headerTooltip: COLUMN_HELP.risk,
            value: (row) => row.riskTier ?? "",
            Value: ({ row }: { row: MerchantSummary }) => {
                if (!row.riskTier) return <ThemedText style={{ opacity: 0.55 }}>{t("Restricted")}</ThemedText>;
                const help = riskHelp(row.riskTier);
                return <span title={help.meaning}><StatusBadge status={row.riskTier} label={help.label} toneOverride={asBadgeTone(help.tone)} /></span>;
            },
        },
        {
            key: "category",
            label: "Category",
            headerTooltip: COLUMN_HELP.category,
            value: (row) => row.businessCategory ?? "",
            Value: ({ row }: { row: MerchantSummary }) => (
                <ThemedText style={{ fontSize: "12px", opacity: row.businessCategory ? 1 : 0.55 }}>
                    {restricted(row.businessCategory)}
                </ThemedText>
            ),
        },
        {
            key: "country",
            label: "Country",
            headerTooltip: COLUMN_HELP.country,
            value: (row) => row.country,
        },
        {
            key: "channel",
            label: "Channel",
            headerTooltip: COLUMN_HELP.channel,
            value: (row) => row.onboardingChannel,
            Value: ({ row }: { row: MerchantSummary }) => (
                <StatusBadge
                    status={row.onboardingChannel}
                    label={row.onboardingChannel === "ADMIN_ASSISTED" ? t("Admin assisted") : t("Self service")}
                    toneOverride={row.onboardingChannel === "ADMIN_ASSISTED" ? "info" : "neutral"}
                />
            ),
        },
        {
            key: "contact",
            label: "Contact",
            headerTooltip: COLUMN_HELP.contact,
            value: (row) => `${row.contactEmail ?? ""} ${row.contactPhone ?? ""}`,
            Value: ({ row }: { row: MerchantSummary }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px" }}>{row.contactEmail || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.contactPhone || "—"}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "counts",
            label: "Wallets / apps",
            headerTooltip: COLUMN_HELP.counts,
            value: (row) => `${row.walletCount}/${row.applicationCount}`,
            Value: ({ row }: { row: MerchantSummary }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{row.walletCount} / {row.applicationCount}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.userCount} users · {row.tokenCount} tokens</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "request",
            label: "Latest request",
            headerTooltip: COLUMN_HELP.request,
            value: (row) => row.latestJoinRequest?.status ?? "",
            Value: ({ row }: { row: MerchantSummary }) =>
                row.latestJoinRequest ? (
                    <ThemedView style={{ gap: "3px" }}>
                        <StatusBadge status={row.latestJoinRequest.status} label={row.latestJoinRequest.status} toneOverride={asBadgeTone(statusTone(row.latestJoinRequest.status))} />
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(row.latestJoinRequest.createdAt)}</ThemedText>
                    </ThemedView>
                ) : (
                    <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>
                ),
        },
        {
            key: "nextReview",
            label: "Next KYB review",
            sortKey: "nextKybReviewAt",
            headerTooltip: COLUMN_HELP.review,
            value: (row) => row.nextKybReviewAt ?? "",
            Value: ({ row }: { row: MerchantSummary }) => (
                <ThemedText style={{ fontSize: "11px", opacity: row.nextKybReviewAt ? 1 : 0.55 }}>
                    {row.nextKybReviewAt ? formatDateTime(row.nextKybReviewAt) : t("Restricted")}
                </ThemedText>
            ),
        },
        {
            key: "lifecycle",
            label: "Activated / suspended",
            headerTooltip: COLUMN_HELP.lifecycleAt,
            value: (row) => row.activatedAt ?? row.suspendedAt ?? row.closedAt ?? "",
            Value: ({ row }: { row: MerchantSummary }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.7 }}>{t("Activated")}: {formatDateTime(row.activatedAt)}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.7 }}>{t("Suspended")}: {formatDateTime(row.suspendedAt)}</ThemedText>
                    {row.suspensionReasonCode && (
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>
                            {row.suspensionReasonCode}
                        </ThemedText>
                    )}
                </ThemedView>
            ),
        },
        {
            key: "pending",
            label: "Pending changes",
            headerTooltip: COLUMN_HELP.pending,
            value: (row) => String(row.pendingApprovalCount),
            Value: ({ row }: { row: MerchantSummary }) =>
                row.pendingApprovalCount > 0 ? (
                    <StatusBadge status="pending" label={`${row.pendingApprovalCount}`} toneOverride="warning" />
                ) : (
                    <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>
                ),
        },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            headerTooltip: COLUMN_HELP.actions,
            Value: ({ row }: { row: MerchantSummary }) => (
                <ThemedView style={{ flexDirection: "row", gap: "4px", flexWrap: "wrap" }}>
                    <VBtn size="x-small" variant="text" prependIcon="mdi-eye-outline" onClick={() => openInspection(row)}>
                        {t("Inspect")}
                    </VBtn>
                    <VBtn size="x-small" variant="text" prependIcon="mdi-open-in-new" onClick={() => openDetail(row)}>
                        {t("Open")}
                    </VBtn>
                    {canWrite.value && row.status === "ACTIVE" && (
                        <VBtn size="x-small" variant="text" color="error" onClick={() => openAction(row, "SUSPEND")}>
                            {t("Suspend")}
                        </VBtn>
                    )}
                    {canWrite.value && row.status === "SUSPENDED" && (
                        <VBtn size="x-small" variant="text" color="success" onClick={() => openAction(row, "REINSTATE")}>
                            {t("Reinstate")}
                        </VBtn>
                    )}
                    {canWrite.value && ["ACTIVE", "SUSPENDED"].includes(row.status) && (
                        <VBtn size="x-small" variant="text" color="error" onClick={() => openAction(row, "CLOSE")}>
                            {t("Close")}
                        </VBtn>
                    )}
                </ThemedView>
            ),
        },
    ];

    const loadSummary = async () => {
        try {
            const response = await api.get(urlsMap.merchantsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as MerchantsSummary;
        } catch {
            summary.value = null;
        }
    };

    void loadSummary();

    const exportExcel = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.merchantsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions.value, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.merchants ?? []) as MerchantSummary[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No merchants match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "tradeName", "legalName", "country", "status", "kybStatus", "riskTier", "onboardingChannel", "contactEmail", "contactPhone", "activatedAt", "nextKybReviewAt", "wallets", "applications", "users", "joinRequests", "kybDocuments", "pendingApprovals"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.tradeName,
                        row.legalName,
                        row.country,
                        row.status,
                        row.kybStatus ?? "",
                        row.riskTier ?? "",
                        row.onboardingChannel,
                        row.contactEmail ?? "",
                        row.contactPhone ?? "",
                        row.activatedAt ?? "",
                        row.nextKybReviewAt ?? "",
                        row.walletCount,
                        row.applicationCount,
                        row.userCount,
                        row.joinRequestCount,
                        row.kybDocumentCount,
                        row.pendingApprovalCount,
                    ]
                        .map(escape)
                        .join(","),
                ),
            ];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `merchants-${new Date().toISOString().slice(0, 10)}.xlsx`,
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

    const exportSummary = async () => {
        if (summaryExportLoading.value) return;
        summaryExportLoading.value = true;
        try {
            const response = await api.get(urlsMap.merchantsSummaryExport);
            const payload = response.data?.data ?? response.data ?? {};
            const snapshot = (payload.summary ?? payload) as MerchantsSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["active", snapshot.active],
                ["pending", snapshot.pending],
                ["suspended", snapshot.suspended],
                ["rejected", snapshot.rejected],
                ["closed", snapshot.closed],
                ["kyb_pending", snapshot.kybPending],
                ["kyb_verified", snapshot.kybVerified],
                ["high_risk", snapshot.highRisk],
                ["review_overdue", snapshot.reviewOverdue],
                ["review_due_soon", snapshot.reviewDueSoon],
                ["pending_approvals", snapshot.pendingApprovals],
            ];
            for (const [status, count] of Object.entries(snapshot.byStatus ?? {})) rows.push([`status.${status}.count`, count]);
            for (const [state, count] of Object.entries(snapshot.byKyb ?? {})) rows.push([`kyb.${state}.count`, count]);
            for (const [risk, count] of Object.entries(snapshot.byRisk ?? {})) rows.push([`risk.${risk}.count`, count]);
            for (const [channel, count] of Object.entries(snapshot.byChannel ?? {})) rows.push([`channel.${channel}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `merchant-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
            showSnackBar({ type: "success", message: t("Merchant summary exported") });
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
            {
                key: "active",
                label: t("Active"),
                value: String(data.active),
                subLabel: t("Live portfolio"),
                badge: t("LIVE"),
                badgeTone: "success" as const,
            },
            {
                key: "highRisk",
                label: t("High risk"),
                value: String(data.highRisk),
                subLabel: t("Enhanced monitoring"),
                badge: data.highRisk > 0 ? t("P1") : t("Clear"),
                badgeTone: data.highRisk > 0 ? "danger" as const : "success" as const,
            },
            {
                key: "kybPending",
                label: t("KYB pending"),
                value: String(data.kybPending),
                subLabel: t("Document review"),
                badge: data.kybPending > 0 ? t("P2") : t("Clear"),
                badgeTone: data.kybPending > 0 ? "warning" as const : "success" as const,
            },
            {
                key: "reviewOverdue",
                label: t("Review overdue"),
                value: String(data.reviewOverdue),
                subLabel: t("Past KYB review"),
                badge: data.reviewOverdue > 0 ? t("P1") : t("Clear"),
                badgeTone: data.reviewOverdue > 0 ? "danger" as const : "success" as const,
            },
            {
                key: "reviewDueSoon",
                label: t("Review due in 30d"),
                value: String(data.reviewDueSoon),
                subLabel: t("Next review window"),
                badge: data.reviewDueSoon > 0 ? t("Attention") : t("Clear"),
                badgeTone: data.reviewDueSoon > 0 ? "warning" as const : "success" as const,
            },
            {
                key: "pendingApprovals",
                label: t("Pending changes"),
                value: String(data.pendingApprovals),
                subLabel: t("Awaiting independent checker"),
                badge: data.pendingApprovals > 0 ? t("Four eyes") : t("Clear"),
                badgeTone: data.pendingApprovals > 0 ? "warning" as const : "success" as const,
            },
        ];
    });

    const suspendedCount = computed(() => rows.value.filter((row) => row.status === "SUSPENDED").length);
    const pendingCount = computed(() => rows.value.reduce((sum, row) => sum + row.pendingApprovalCount, 0));

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Merchants")}
                    subtitle={t("Search the merchant portfolio, inspect KYB and risk posture, and propose governed changes.")}
                    badge={summary.value ? `${summary.value.kybPending} ${t("KYB pending")}` : t("KYB review")}
                    badgeTone={summary.value && summary.value.kybPending > 0 ? "warning" : "info"}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            <StatusBadge status="info" label={`${total.value} ${t("merchants")}`} toneOverride="info" showDot={false} />
                            <StatusBadge status="suspended" label={`${suspendedCount.value} ${t("suspended")}`} toneOverride={suspendedCount.value ? "danger" : "neutral"} showDot={false} />
                            <StatusBadge status="pending" label={`${pendingCount.value} ${t("pending changes")}`} toneOverride={pendingCount.value ? "warning" : "neutral"} showDot={false} />
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                        </ThemedView>
                    )}
                />

                {summary.value && (
                    <SummaryExportCard
                        title={t("Merchant portfolio health")}
                        metrics={summaryItems.value}
                        exportLoading={summaryExportLoading.value}
                        exportLabel={t("Export summary")}
                        onExport={() => void exportSummary()}
                    >
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {Object.entries(summary.value.byStatus ?? {}).map(([state, count]) => (
                                <StatusBadge key={state} status={state} label={`${state}: ${count}`} toneOverride={asBadgeTone(statusTone(state))} showDot={false} />
                            ))}
                            {Object.entries(summary.value.byKyb ?? {}).map(([state, count]) => (
                                <StatusBadge key={`kyb-${state}`} status={state} label={`KYB ${state}: ${count}`} toneOverride={asBadgeTone(statusTone(state))} showDot={false} />
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
                )}

                {areHelpPanelsVisible() && (
                    <SurfaceCard>
                        <SurfaceCardText>
                            <MerchantHelpPanel />
                        </SurfaceCardText>
                    </SurfaceCard>
                )}
                <ApiTable<MerchantSummary>
                    title={t("Merchants")}
                    url={urlsMap.merchantsList}
                    showNumber={true}
                    xlsx={false}
                    localSearch={false}
                    numberOfItemsPerPage={pageSize.value}
                    setNumberOfItemsPerPage={(value) => (pageSize.value = value)}
                    searchValue={search.value}
                    setSearchValue={(value) => (search.value = value)}
                    headers={headers}
                    rowColor={rowColor}
                    apiDataExtractor={(data) => {
                        const payload = data as { merchants?: MerchantSummary[]; rows?: MerchantSummary[] };
                        return payload.merchants ?? payload.rows ?? [];
                    }}
                    apiTotalExtractor={(data) => {
                        const payload = data as { total?: number; merchants?: MerchantSummary[] };
                        return Number(payload.total ?? payload.merchants?.length ?? 0);
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
                                ...buildFilterQuery(filterDefinitions.value, filters.value),
                                ...(props.sortKey
                                    ? { sortKey: props.sortKey, sortDirection: props.sortDirection }
                                    : {}),
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
                modelValue={inspectionOpen.value}
                onUpdate:modelValue={(value: boolean) => (inspectionOpen.value = value)}
                title={inspectionMerchant.value?.displayName || inspectionMerchant.value?.tradeName || t("Merchant")}
                subtitle={inspectionMerchant.value?.legalName || ""}
            >
                {inspectionMerchant.value && (
                    <ThemedView style={{ gap: "16px" }}>
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                            <StatusBadge
                                status={inspectionMerchant.value.status}
                                label={merchantStatusHelp(inspectionMerchant.value.status).label}
                                toneOverride={asBadgeTone(merchantStatusHelp(inspectionMerchant.value.status).tone)}
                            />
                            {inspectionMerchant.value.kybStatus && (
                                <StatusBadge
                                    status={inspectionMerchant.value.kybStatus}
                                    label={kybStatusHelp(inspectionMerchant.value.kybStatus).label}
                                    toneOverride={asBadgeTone(kybStatusHelp(inspectionMerchant.value.kybStatus).tone)}
                                />
                            )}
                            {inspectionMerchant.value.riskTier && (
                                <StatusBadge
                                    status={inspectionMerchant.value.riskTier}
                                    label={riskHelp(inspectionMerchant.value.riskTier).label}
                                    toneOverride={asBadgeTone(riskHelp(inspectionMerchant.value.riskTier).tone)}
                                />
                            )}
                        </ThemedView>
                        <DescriptionList
                            columns={2}
                            items={[
                                { label: t("Merchant ID"), value: <MonoRef value={inspectionMerchant.value.id} /> },
                                { label: t("Legal name"), value: inspectionMerchant.value.legalName || "—" },
                                { label: t("Trade name"), value: inspectionMerchant.value.tradeName || "—" },
                                { label: t("Country"), value: inspectionMerchant.value.country || "—" },
                                { label: t("Onboarding channel"), value: inspectionMerchant.value.onboardingChannel },
                                { label: t("Contact email"), value: inspectionMerchant.value.contactEmail || "—" },
                                { label: t("Contact phone"), value: inspectionMerchant.value.contactPhone || "—" },
                                { label: t("Business category"), value: inspectionMerchant.value.businessCategory || t("Restricted") },
                                { label: t("Next KYB review"), value: formatDateTime(inspectionMerchant.value.nextKybReviewAt) },
                                { label: t("Pending changes"), value: String(inspectionMerchant.value.pendingApprovalCount) },
                            ]}
                        />
                        <ThemedView style={{ flexDirection: "row", gap: "8px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (inspectionOpen.value = false)}>{t("Close")}</VBtn>
                            <VBtn
                                color="primary"
                                prependIcon="mdi-open-in-new"
                                onClick={() => {
                                    const row = inspectionMerchant.value;
                                    inspectionOpen.value = false;
                                    if (row) openDetail(row);
                                }}
                            >
                                {t("Open")}
                            </VBtn>
                        </ThemedView>
                    </ThemedView>
                )}
            </SlideOverDrawer>

            <MerchantActionDialog
                open={actionOpen.value}
                mode={actionMode.value}
                merchant={actionMerchant.value}
                onUpdate={(value) => (actionOpen.value = value)}
                onDone={() => refreshHook.value?.refreshAsIs()}
            />
        </ScreenContainer>
    );
});

export default MerchantsPage;
