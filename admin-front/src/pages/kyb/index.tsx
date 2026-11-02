import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale, useTheme } from "vuetify";
import { VBtn, VCard, VCardText, VDialog } from "vuetify/components";
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
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import {
    COLUMN_HELP,
    avStatusHelp,
    documentStatusHelp,
    documentTypeHelp,
    expiryHelp,
    formatBytes,
    formatDateTime,
} from "./kybReviewHelp";
import type { KybDocumentSummary } from "./types";
import KybHelpPanel from "./components/KybHelpPanel";
import KybDocumentPreview from "./components/KybDocumentPreview";
import KybReviewDialog from "./components/KybReviewDialog";
import KybActionDialog, { type KybActionMode } from "./components/KybActionDialog";

type KybDocumentsSummary = {
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
    expired: number;
    infected: number;
    scanning: number;
    duplicates: number;
    expiringSoon: number;
    byStatus: Record<string, number>;
    byAvStatus: Record<string, number>;
    byDocType: Record<string, number>;
};

const filterDefinitions = tableRegistry.KybReview?.filters ?? [];

const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

const requestSlaLabel = (row: KybDocumentSummary): { label: string; tone: "success" | "warning" | "error" | "neutral" } => {
    if (!row.joinRequest) return { label: "No request", tone: "neutral" };
    if (row.joinRequest.slaPausedAt) return { label: "Paused", tone: "neutral" };
    const diff = new Date(row.joinRequest.slaDueAt).getTime() - Date.now();
    if (Number.isNaN(diff)) return { label: "—", tone: "neutral" };
    if (diff < 0) return { label: "Overdue", tone: "error" };
    if (diff < 24 * 3600 * 1000) return { label: `${Math.max(1, Math.round(diff / 3600000))}h`, tone: "warning" };
    return { label: `${Math.round(diff / 86400000)}d`, tone: "success" };
};

const KybReviewPage = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    const router = useRouter();
    const search = ref<string | null>(null);
    const filters = ref<FilterValues>({});
    const rows = ref<KybDocumentSummary[]>([]);
    const total = ref(0);
    const summary = ref<KybDocumentsSummary | null>(null);
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
            const response = await api.get(urlsMap.kybDocumentsSummary);
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = (payload.summary ?? payload) as KybDocumentsSummary;
        } catch {
            summary.value = null;
        }
    };

    void loadSummary();

    const exportCsv = async () => {
        if (exportLoading.value) return;
        exportLoading.value = true;
        try {
            const response = await api.get(urlsMap.kybDocumentsExport, {
                params: {
                    ...(search.value ? { search: search.value } : {}),
                    ...buildFilterQuery(filterDefinitions, filters.value),
                },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const rowsData = (payload.documents ?? []) as KybDocumentSummary[];
            if (rowsData.length === 0) {
                showSnackBar({ type: "warning", message: t("No KYB documents match the current filters.") });
                return;
            }
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const columns = ["id", "merchantId", "merchantName", "merchantLegalName", "merchantStatus", "merchantKybStatus", "joinRequestId", "joinRequestStatus", "subjectType", "subjectId", "docType", "originalFileName", "mime", "sizeBytes", "sha256", "avStatus", "status", "expiresOn", "expiryState", "uploader", "reviewer", "reviewedAt", "rejectionReasonCode", "createdAt"];
            const lines = [
                columns.map(escape).join(","),
                ...rowsData.map((row) =>
                    [
                        row.id,
                        row.merchantId,
                        row.merchantName,
                        row.merchantLegalName,
                        row.merchantStatus ?? "",
                        row.merchantKybStatus ?? "",
                        row.joinRequestId ?? "",
                        row.joinRequest?.status ?? "",
                        row.subjectType,
                        row.subjectId,
                        row.docType,
                        row.originalFileName ?? "",
                        row.mime,
                        row.sizeBytes,
                        row.sha256,
                        row.avStatus,
                        row.status,
                        row.expiresOn ?? "",
                        row.expiryState,
                        row.uploader,
                        row.reviewer,
                        row.reviewedAt ?? "",
                        row.rejectionReasonCode ?? "",
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
            link.download = `kyb-documents-${new Date().toISOString().slice(0, 10)}.csv`;
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
            const response = await api.get(urlsMap.kybDocumentsSummaryExport);
            const payload = response.data?.data ?? response.data ?? {};
            const snapshot = (payload.summary ?? payload) as KybDocumentsSummary;
            const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
            const rows: Array<[string, unknown]> = [
                ["total", snapshot.total],
                ["pending", snapshot.pending],
                ["accepted", snapshot.accepted],
                ["rejected", snapshot.rejected],
                ["expired", snapshot.expired],
                ["expiring_soon", snapshot.expiringSoon],
                ["infected", snapshot.infected],
                ["scanning", snapshot.scanning],
                ["duplicates", snapshot.duplicates],
            ];
            for (const [status, count] of Object.entries(snapshot.byStatus ?? {})) rows.push([`status.${status}.count`, count]);
            for (const [status, count] of Object.entries(snapshot.byAvStatus ?? {})) rows.push([`av_status.${status}.count`, count]);
            for (const [type, count] of Object.entries(snapshot.byDocType ?? {})) rows.push([`doc_type.${type}.count`, count]);
            const lines = ["metric,value", ...rows.map(([key, value]) => `${escape(key)},${escape(value)}`)];
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `kyb-document-summary-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            showSnackBar({ type: "success", message: t("KYB document summary exported") });
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
            { label: t("Awaiting review"), value: String(data.pending), tone: "warning" as const },
            { label: t("Accepted"), value: String(data.accepted), tone: "success" as const },
            { label: t("Expiring in 30d"), value: String(data.expiringSoon), tone: data.expiringSoon > 0 ? "warning" as const : "success" as const },
            { label: t("Expired"), value: String(data.expired), tone: data.expired > 0 ? "error" as const : "success" as const },
            { label: t("Duplicates"), value: String(data.duplicates), tone: data.duplicates > 0 ? "warning" as const : "success" as const },
            { label: t("Infected"), value: String(data.infected), tone: data.infected > 0 ? "error" as const : "success" as const },
        ];
    });

    const previewOpen = ref(false);
    const previewDocument = ref<KybDocumentSummary | null>(null);
    const reviewOpen = ref(false);
    const reviewDocument = ref<KybDocumentSummary | null>(null);
    const reviewInitial = ref<"ACCEPTED" | "REJECTED">("ACCEPTED");
    const actionOpen = ref(false);
    const actionMode = ref<KybActionMode>("REPLACEMENT");
    const actionDocument = ref<KybDocumentSummary | null>(null);

    const onFiltersChanged = (key: string, value: unknown) => {
        filters.value = { ...filters.value, [key]: value };
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => refreshHook.value?.reset(), 300);
    };

    const onFiltersCleared = () => {
        filters.value = {};
        refreshHook.value?.reset();
    };

    const openDetail = (row: KybDocumentSummary) => {
        void router.push({ name: "KybReviewDetail", params: { id: row.id } });
    };

    const openPreview = (row: KybDocumentSummary) => {
        previewDocument.value = row;
        previewOpen.value = true;
    };

    const openReview = (row: KybDocumentSummary, decision: "ACCEPTED" | "REJECTED") => {
        reviewDocument.value = row;
        reviewInitial.value = decision;
        reviewOpen.value = true;
    };

    const openAction = (row: KybDocumentSummary) => {
        actionDocument.value = row;
        actionMode.value = row.canRequestReplacement ? "REPLACEMENT" : "REVALIDATION";
        actionOpen.value = true;
    };

    const refreshAfterAction = () => refreshHook.value?.refreshAsIs();

    const toneColor = (tone: ReturnType<typeof statusTone>): string => {
        const colors = theme.current.value.colors as Record<string, string>;
        return colors[tone] ?? colors["on-surface-variant"] ?? "#64748b";
    };

    const rowColor = (row: KybDocumentSummary): string | undefined => {
        if (row.avStatus === "INFECTED" || row.expiryState === "EXPIRED" || row.status === "REJECTED") {
            return toneColor("error");
        }
        if (row.avStatus === "PENDING" || row.expiryState === "DUE_SOON" || row.duplicateMerchantCount > 0) {
            return toneColor("warning");
        }
        return undefined;
    };

    const headers: TableHeader<KybDocumentSummary>[] = [
        {
            key: "merchant",
            label: "Merchant / subject",
            sortKey: "merchantName",
            headerTooltip: COLUMN_HELP.merchant,
            value: (row) => `${row.merchantName} ${row.subjectName ?? ""}`,
            Value: ({ row }: { row: KybDocumentSummary }) => (
                <ThemedView style={{ gap: "3px" }}>
                    <ThemedText style={{ fontSize: "13px", fontWeight: 700 }}>{row.merchantName || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>
                        {row.merchantLegalName || row.merchantId}
                    </ThemedText>
                    <ThemedView style={{ flexDirection: "row", gap: "4px", flexWrap: "wrap" }}>
                        <StatusChip label={row.merchantStatus || "—"} tone={statusTone(row.merchantStatus ?? "")} size="x-small" />
                        <StatusChip label={`KYB ${row.merchantKybStatus || "—"}`} tone={statusTone(row.merchantKybStatus ?? "")} size="x-small" />
                        {row.subjectType === "BENEFICIAL_OWNER" && (
                            <StatusChip label={row.subjectName || "Owner"} tone="info" size="x-small" />
                        )}
                    </ThemedView>
                </ThemedView>
            ),
        },
        {
            key: "docType",
            label: "Document type",
            sortKey: "docType",
            headerTooltip: COLUMN_HELP.documentType,
            value: (row) => documentTypeHelp(row.docType).label,
            Value: ({ row }: { row: KybDocumentSummary }) => {
                const help = documentTypeHelp(row.docType);
                return (
                    <span title={help.meaning}>
                        <StatusChip label={help.label} tone="info" size="small" />
                    </span>
                );
            },
        },
        {
            key: "file",
            label: "File",
            headerTooltip: COLUMN_HELP.file,
            value: (row) => row.originalFileName ?? "",
            Value: ({ row }: { row: KybDocumentSummary }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "12px", fontWeight: 600 }}>{row.originalFileName || "—"}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>
                        {formatBytes(row.sizeBytes)} · {row.mime}
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
            Value: ({ row }: { row: KybDocumentSummary }) => {
                const help = documentStatusHelp(row.status);
                return (
                    <span title={help.meaning}>
                        <StatusChip label={help.label} tone={help.tone} size="small" />
                    </span>
                );
            },
        },
        {
            key: "avStatus",
            label: "AV scan",
            sortKey: "avStatus",
            headerTooltip: COLUMN_HELP.avStatus,
            value: (row) => row.avStatus,
            Value: ({ row }: { row: KybDocumentSummary }) => {
                const help = avStatusHelp(row.avStatus);
                return (
                    <span title={help.meaning}>
                        <StatusChip label={help.label} tone={help.tone} size="small" />
                    </span>
                );
            },
        },
        {
            key: "expiry",
            label: "Expiry",
            sortKey: "expiresOn",
            headerTooltip: COLUMN_HELP.expiry,
            value: (row) => row.expiresOn ?? "",
            Value: ({ row }: { row: KybDocumentSummary }) => {
                const help = expiryHelp(row.expiryState);
                return (
                    <ThemedView style={{ gap: "3px" }}>
                        <span title={help.meaning}>
                            <StatusChip
                                label={row.daysUntilExpiry === null ? help.label : `${help.label} ${row.daysUntilExpiry < 0 ? `(${Math.abs(row.daysUntilExpiry)}d ago)` : `(${row.daysUntilExpiry}d)`}`}
                                tone={help.tone}
                                size="x-small"
                            />
                        </span>
                        <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{formatDateTime(row.expiresOn)}</ThemedText>
                    </ThemedView>
                );
            },
        },
        {
            key: "duplicate",
            label: "Duplicate",
            headerTooltip: COLUMN_HELP.duplicate,
            value: (row) => String(row.duplicateMerchantCount),
            Value: ({ row }: { row: KybDocumentSummary }) =>
                row.duplicateMerchantCount > 0 ? (
                    <StatusChip
                        label={`${row.duplicateMerchantCount} merchant${row.duplicateMerchantCount === 1 ? "" : "s"}`}
                        tone="warning"
                        size="x-small"
                    />
                ) : (
                    <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>
                ),
        },
        {
            key: "request",
            label: "Join request",
            headerTooltip: COLUMN_HELP.request,
            value: (row) => row.joinRequest?.status ?? "",
            Value: ({ row }: { row: KybDocumentSummary }) => {
                if (!row.joinRequest) return <ThemedText style={{ opacity: 0.55 }}>—</ThemedText>;
                const sla = requestSlaLabel(row);
                return (
                    <ThemedView style={{ gap: "3px" }}>
                        <StatusChip label={row.joinRequest.status} tone={statusTone(row.joinRequest.status)} size="x-small" />
                        <StatusChip label={`SLA ${sla.label}`} tone={sla.tone} size="x-small" />
                        <ThemedText style={{ fontSize: "10px", opacity: 0.5, direction: "ltr" }}>
                            {row.joinRequest.id}
                        </ThemedText>
                    </ThemedView>
                );
            },
        },
        {
            key: "uploaded",
            label: "Uploaded",
            sortKey: "createdAt",
            headerTooltip: COLUMN_HELP.uploaded,
            value: (row) => row.createdAt,
            Value: ({ row }: { row: KybDocumentSummary }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.createdAt)}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.uploader || "—"}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "reviewed",
            label: "Reviewed",
            headerTooltip: COLUMN_HELP.reviewed,
            value: (row) => row.reviewedAt ?? "",
            Value: ({ row }: { row: KybDocumentSummary }) => (
                <ThemedView style={{ gap: "2px" }}>
                    <ThemedText style={{ fontSize: "11px" }}>{formatDateTime(row.reviewedAt)}</ThemedText>
                    <ThemedText style={{ fontSize: "10px", opacity: 0.55 }}>{row.reviewer || "—"}</ThemedText>
                </ThemedView>
            ),
        },
        {
            key: "actions",
            label: "Actions",
            sortable: false,
            headerTooltip: COLUMN_HELP.actions,
            Value: ({ row }: { row: KybDocumentSummary }) => (
                <ThemedView style={{ flexDirection: "row", gap: "4px", flexWrap: "wrap" }}>
                    <VBtn size="x-small" variant="text" prependIcon="mdi-open-in-new" onClick={() => openDetail(row)}>
                        {t("Open")}
                    </VBtn>
                    <VBtn
                        size="x-small"
                        variant="text"
                        prependIcon="mdi-eye-outline"
                        disabled={row.avStatus !== "CLEAN" || !row.contentAvailable}
                        onClick={() => openPreview(row)}
                    >
                        {t("Preview")}
                    </VBtn>
                    {row.canReview && (
                        <>
                            <VBtn size="x-small" variant="text" color="success" onClick={() => openReview(row, "ACCEPTED")}>
                                {t("Accept")}
                            </VBtn>
                            <VBtn size="x-small" variant="text" color="error" onClick={() => openReview(row, "REJECTED")}>
                                {t("Reject")}
                            </VBtn>
                        </>
                    )}
                    {(row.canRequestReplacement || row.canRequestRevalidation) && (
                        <VBtn size="x-small" variant="text" color="warning" onClick={() => openAction(row)}>
                            {t(row.canRequestReplacement ? "Replace" : "Re-verify")}
                        </VBtn>
                    )}
                </ThemedView>
            ),
        },
    ];

    const actionableCount = computed(() => rows.value.filter((row) => row.canReview).length);
    const duplicateCount = computed(() => rows.value.filter((row) => row.duplicateMerchantCount > 0).length);

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("KYB Review")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            <StatusChip label={`${total.value} ${t("documents")}`} tone="info" size="small" />
                            <StatusChip label={`${actionableCount.value} ${t("actionable")}`} tone="success" size="small" />
                            <StatusChip label={`${duplicateCount.value} ${t("duplicates")}`} tone={duplicateCount.value ? "warning" : "neutral"} size="small" />
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportCsv()}>{t("Export CSV")}</VBtn>
                        </ThemedView>
                    )}
                />

                {summary.value && (
                    <VCard variant="flat" style={{ borderRadius: "16px" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <ThemedText type="defaultSemiBold" style={{ fontSize: "15px" }}>{t("Document review health")}</ThemedText>
                                <div style={{ flex: 1 }} />
                                <VBtn size="small" variant="tonal" prependIcon="mdi-download" loading={summaryExportLoading.value} onClick={() => void exportSummary()}>{t("Export summary")}</VBtn>
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
                                    <StatusChip key={state} label={`${state}: ${count}`} tone={statusTone(state)} size="x-small" />
                                ))}
                                {Object.entries(summary.value.byAvStatus ?? {}).map(([state, count]) => (
                                    <StatusChip key={`av-${state}`} label={`AV ${state}: ${count}`} tone={statusTone(state)} size="x-small" />
                                ))}
                            </ThemedView>
                        </VCardText>
                    </VCard>
                )}

                <VCard>
                    <VCardText>
                        <KybHelpPanel />
                    </VCardText>
                </VCard>
                <ApiTable<KybDocumentSummary>
                    title={t("KYB Review")}
                    url={urlsMap.kybDocumentsList}
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
                        const payload = data as { kybDocuments?: KybDocumentSummary[]; rows?: KybDocumentSummary[] };
                        return payload.kybDocuments ?? payload.rows ?? [];
                    }}
                    apiTotalExtractor={(data) => {
                        const payload = data as { total?: number; kybDocuments?: KybDocumentSummary[] };
                        return Number(payload.total ?? payload.kybDocuments?.length ?? 0);
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

            <VDialog modelValue={previewOpen.value} onUpdate:modelValue={(value: boolean) => (previewOpen.value = value)} maxWidth="1100px" scrollable>
                <VCard>
                    <VCardText>
                        <KybDocumentPreview document={previewDocument.value} />
                    </VCardText>
                </VCard>
            </VDialog>

            <KybReviewDialog
                open={reviewOpen.value}
                document={reviewDocument.value}
                initialDecision={reviewInitial.value}
                onUpdate={(value) => (reviewOpen.value = value)}
                onDone={refreshAfterAction}
            />
            <KybActionDialog
                open={actionOpen.value}
                mode={actionMode.value}
                document={actionDocument.value}
                onUpdate={(value) => (actionOpen.value = value)}
                onDone={refreshAfterAction}
            />
        </ScreenContainer>
    );
});

export default KybReviewPage;
