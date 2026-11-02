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
import { urlsMap } from "@/constants/urlsMap";
import { areHelpPanelsVisible } from "@/constants/env";
import { xlsxUIPipeline } from "@/utils/xlsx";
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

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { MonoRef } from "@/components/ui/MonoRef";
import { SlideOverDrawer } from "@/components/ui/SlideOverDrawer";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";
import { SummaryExportCard } from "@/components/ui/SummaryExportCard";
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
    const asBadgeTone = (tone: ReturnType<typeof statusTone>): BadgeTone =>
        tone === "error" ? "danger" : tone === "primary" ? "info" : tone;
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

    const exportExcel = async () => {
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
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `kyb-documents-${new Date().toISOString().slice(0, 10)}.xlsx`,
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
            await xlsxUIPipeline.downloadXlsxFromCsvLines({
                title: `kyb-document-summary-${new Date().toISOString().slice(0, 10)}.xlsx`,
                lines,
            });
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
            {
                key: "pending",
                label: t("Awaiting review"),
                value: String(data.pending),
                subLabel: t("Document review"),
                badge: data.pending > 0 ? t("P2") : t("Clear"),
                badgeTone: data.pending > 0 ? "warning" as const : "success" as const,
            },
            {
                key: "accepted",
                label: t("Accepted"),
                value: String(data.accepted),
                subLabel: t("Verified evidence"),
                badge: t("Clean"),
                badgeTone: "success" as const,
            },
            {
                key: "expiring",
                label: t("Expiring in 30d"),
                value: String(data.expiringSoon),
                subLabel: t("Expiry posture"),
                badge: data.expiringSoon > 0 ? t("Attention") : t("Clear"),
                badgeTone: data.expiringSoon > 0 ? "warning" as const : "success" as const,
            },
            {
                key: "expired",
                label: t("Expired"),
                value: String(data.expired),
                subLabel: t("Past expiry"),
                badge: data.expired > 0 ? t("P1") : t("Clear"),
                badgeTone: data.expired > 0 ? "danger" as const : "success" as const,
            },
            {
                key: "duplicates",
                label: t("Duplicates"),
                value: String(data.duplicates),
                subLabel: t("Reused file hashes"),
                badge: data.duplicates > 0 ? t("Review") : t("Clear"),
                badgeTone: data.duplicates > 0 ? "warning" as const : "success" as const,
            },
            {
                key: "infected",
                label: t("Infected"),
                value: String(data.infected),
                subLabel: t("Malware blocked"),
                badge: data.infected > 0 ? t("Critical") : t("Clear"),
                badgeTone: data.infected > 0 ? "danger" as const : "success" as const,
            },
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
        return colors[tone] ?? colors["on-surface-variant"] ?? "var(--pg-ink-muted)";
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
                        <StatusBadge status={row.merchantStatus || "—"} label={row.merchantStatus || "—"} toneOverride={asBadgeTone(statusTone(row.merchantStatus ?? ""))} />
                        <StatusBadge status={row.merchantKybStatus || "—"} label={`KYB ${row.merchantKybStatus || "—"}`} toneOverride={asBadgeTone(statusTone(row.merchantKybStatus ?? ""))} />
                        {row.subjectType === "BENEFICIAL_OWNER" && (
                            <StatusBadge status={row.subjectName || "Owner"} label={row.subjectName || "Owner"} toneOverride="info" />
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
                        <StatusBadge status={row.docType} label={help.label} toneOverride="info" />
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
                        <StatusBadge status={row.status} label={help.label} toneOverride={asBadgeTone(help.tone)} />
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
                        <StatusBadge status={row.avStatus} label={help.label} toneOverride={asBadgeTone(help.tone)} />
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
                            <StatusBadge
                                status={row.expiryState}
                                label={row.daysUntilExpiry === null ? help.label : `${help.label} ${row.daysUntilExpiry < 0 ? `(${Math.abs(row.daysUntilExpiry)}d ago)` : `(${row.daysUntilExpiry}d)`}`}
                                toneOverride={asBadgeTone(help.tone)}
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
                    <StatusBadge
                        status="duplicate"
                        label={`${row.duplicateMerchantCount} merchant${row.duplicateMerchantCount === 1 ? "" : "s"}`}
                        toneOverride="warning"
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
                        <StatusBadge status={row.joinRequest.status} label={row.joinRequest.status} toneOverride={asBadgeTone(statusTone(row.joinRequest.status))} />
                        <StatusBadge status={sla.label} label={`SLA ${sla.label}`} toneOverride={asBadgeTone(sla.tone)} />
                        <MonoRef value={row.joinRequest.id} truncate={18} />
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
                    subtitle={t("Review KYB evidence, document integrity and expiry posture before accepting or rejecting a merchant.")}
                    badge={t("KYB review")}
                    badgeTone="info"
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            <StatusBadge status="info" label={`${total.value} ${t("documents")}`} toneOverride="info" showDot={false} />
                            <StatusBadge status="success" label={`${actionableCount.value} ${t("actionable")}`} toneOverride="success" showDot={false} />
                            <StatusBadge status="duplicates" label={`${duplicateCount.value} ${t("duplicates")}`} toneOverride={duplicateCount.value ? "warning" : "neutral"} showDot={false} />
                            <VBtn variant="tonal" prependIcon="mdi-refresh" onClick={refreshAll}>{t("Refresh")}</VBtn>
                            <VBtn variant="tonal" prependIcon="mdi-download" loading={exportLoading.value} onClick={() => void exportExcel()}>{t("Export Excel")}</VBtn>
                        </ThemedView>
                    )}
                />

                {summary.value && (
                    <SummaryExportCard
                        title={t("Document review health")}
                        metrics={summaryItems.value}
                        exportLoading={summaryExportLoading.value}
                        exportLabel={t("Export summary")}
                        onExport={() => void exportSummary()}
                    >
                        <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                            {Object.entries(summary.value.byStatus ?? {}).map(([state, count]) => (
                                <StatusBadge key={state} status={state} label={`${state}: ${count}`} toneOverride={asBadgeTone(statusTone(state))} showDot={false} />
                            ))}
                            {Object.entries(summary.value.byAvStatus ?? {}).map(([state, count]) => (
                                <StatusBadge key={`av-${state}`} status={state} label={`AV ${state}: ${count}`} toneOverride={asBadgeTone(statusTone(state))} showDot={false} />
                            ))}
                        </ThemedView>
                    </SummaryExportCard>
                )}

                {areHelpPanelsVisible() && (
                    <SurfaceCard>
                        <SurfaceCardText>
                            <KybHelpPanel />
                        </SurfaceCardText>
                    </SurfaceCard>
                )}
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

            <SlideOverDrawer
                modelValue={previewOpen.value}
                onUpdate:modelValue={(value: boolean) => (previewOpen.value = value)}
                title={t("Document inspection")}
                subtitle={previewDocument.value?.originalFileName || previewDocument.value?.merchantName || ""}
                width={720}
            >
                <KybDocumentPreview document={previewDocument.value} />
            </SlideOverDrawer>

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
