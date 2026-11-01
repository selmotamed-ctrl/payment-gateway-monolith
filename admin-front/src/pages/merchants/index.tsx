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
import { hasOneOfAuthorities, user } from "@/state/user";
import { urlsMap } from "@/constants/urlsMap";
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

const MerchantsPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const router = useRouter();
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const rows = ref<MerchantSummary[]>([]);
    const total = ref(0);
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

    const toneColor = (tone: ReturnType<typeof statusTone>): string => {
        const colors = theme.current.value.colors as Record<string, string>;
        return colors[tone] ?? colors["on-surface-variant"] ?? "#64748b";
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
                    <ThemedText style={{ fontSize: "10px", opacity: 0.5, direction: "ltr" }}>{row.id}</ThemedText>
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
                return <span title={help.meaning}><StatusChip label={help.label} tone={help.tone} size="small" /></span>;
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
                return <span title={help.meaning}><StatusChip label={help.label} tone={help.tone} size="small" /></span>;
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
                return <span title={help.meaning}><StatusChip label={help.label} tone={help.tone} size="small" /></span>;
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
                <StatusChip
                    label={row.onboardingChannel === "ADMIN_ASSISTED" ? t("Admin assisted") : t("Self service")}
                    tone={row.onboardingChannel === "ADMIN_ASSISTED" ? "info" : "neutral"}
                    size="x-small"
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
                        <StatusChip label={row.latestJoinRequest.status} tone={statusTone(row.latestJoinRequest.status)} size="x-small" />
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
                    <StatusChip label={`${row.pendingApprovalCount}`} tone="warning" size="x-small" />
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

    const suspendedCount = computed(() => rows.value.filter((row) => row.status === "SUSPENDED").length);
    const pendingCount = computed(() => rows.value.reduce((sum, row) => sum + row.pendingApprovalCount, 0));

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Merchants")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            <StatusChip label={`${total.value} ${t("merchants")}`} tone="info" size="small" />
                            <StatusChip label={`${suspendedCount.value} ${t("suspended")}`} tone={suspendedCount.value ? "error" : "neutral"} size="small" />
                            <StatusChip label={`${pendingCount.value} ${t("pending changes")}`} tone={pendingCount.value ? "warning" : "neutral"} size="small" />
                        </ThemedView>
                    )}
                />
                <VCard>
                    <VCardText>
                        <MerchantHelpPanel />
                    </VCardText>
                </VCard>
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
