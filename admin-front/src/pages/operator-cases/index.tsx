import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VCheckbox, VDialog, VSelect, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { statusTone } from "@/components/Table/statusTone";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { formatPlainNumber } from "@/utils/money";

type OperatorCase = {
    id: string;
    caseRef: string;
    caseType: string;
    priority: string;
    state: string;
    attemptId: string | null;
    merchantName: string;
    railCode: string;
    amount: string;
    currency: string;
    openedAt: string;
    slaDueAt: string;
    summary: string;
    resolution: string | null;
};

const CASE_TYPES = ["UNKNOWN", "CONFLICT", "MISMATCH", "LATE_SUCCESS", "HELD", "UNMATCHED_STATEMENT"];

const OperatorCasesPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<OperatorCase[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);
    const typeFilter = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<OperatorCase | null>(null);
    const resolutionChoice = ref<string>("RETRY_INQUIRE");
    const resolutionReason = ref<string>("");
    const actionLoading = ref(false);

    const bulkIds = ref<string[]>([]);
    const bulkLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.operatorCases, {
                params: { search: search.value || undefined, caseType: typeFilter.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.cases ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const resolve = async () => {
        if (!selected.value || resolutionReason.value.trim().length < 3) {
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(urlsMap.operatorCaseResolve(selected.value.id), {
                resolution: resolutionChoice.value,
                reason: resolutionReason.value.trim(),
            });
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Resolve") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const runBulkInquiry = async () => {
        if (!bulkIds.value.length) {
            return;
        }
        bulkLoading.value = true;
        let ok = 0;
        let failed = 0;
        try {
            for (const attemptId of bulkIds.value) {
                try {
                    await api.post(urlsMap.attemptInquire(attemptId), {});
                    ok += 1;
                } catch {
                    failed += 1;
                }
            }
            showSnackBar({
                type: failed ? "warning" : "success",
                message: `${t("Inquire")}: ${ok} ${t("Approved")} / ${failed} ${t("Failed")}`,
            });
            bulkIds.value = [];
            await load();
        } finally {
            bulkLoading.value = false;
        }
    };

    const toneFor = (type: string) => {
        switch (type) {
            case "CONFLICT":
            case "LATE_SUCCESS":
                return "error" as const;
            case "UNKNOWN":
            case "MISMATCH":
                return "warning" as const;
            default:
                return "info" as const;
        }
    };

    const headers: TableHeader<OperatorCase>[] = [
        { key: "caseRef", label: "Reference", value: (row) => row.caseRef },
        {
            key: "caseType",
            label: "Case Type",
            Value: ({ row }: { row: OperatorCase }) => <StatusChip label={row.caseType} tone={toneFor(row.caseType)} />,
        },
        { key: "priority", label: "Priority", value: (row) => row.priority },
        { key: "state", label: "Status", Value: ({ row }: { row: OperatorCase }) => <StatusChip label={row.state} tone={statusTone(row.state)} /> },
        { key: "merchantName", label: "Merchant Name", value: (row) => row.merchantName },
        { key: "railCode", label: "Rail Code", value: (row) => row.railCode },
        { key: "amount", label: "Amount", value: (row) => `${row.amount ?? ""} ${row.currency ?? ""}` },
        { key: "openedAt", label: "Opened At", value: (row) => row.openedAt },
        { key: "slaDueAt", label: "Due At", value: (row) => row.slaDueAt },
        {
            key: "attempt",
            label: "Attempts",
            Value: ({ row }: { row: OperatorCase }) =>
                row.attemptId ? (
                    <VCheckbox
                        modelValue={bulkIds.value.includes(row.attemptId)}
                        onUpdate:modelValue={(value: boolean | null) => {
                            if (!row.attemptId) {
                                return;
                            }
                            bulkIds.value = value
                                ? [...bulkIds.value, row.attemptId]
                                : bulkIds.value.filter((id) => id !== row.attemptId);
                        }}
                        density="compact"
                        hideDetails
                    />
                ) : (
                    <span>-</span>
                ),
        },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: OperatorCase }) => (
                <ThemedView style={{ flexDirection: "row", gap: "6px" }}>
                    <VBtn
                        size="small"
                        variant="tonal"
                        disabled={!row.attemptId}
                        onClick={async () => {
                            try {
                                await api.post(urlsMap.attemptInquire(row.attemptId!), {});
                                showSnackBar({ type: "success", message: t("Inquire") });
                                await load();
                            } catch (e) {
                                showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
                            }
                        }}
                    >
                        {t("Inquire")}
                    </VBtn>
                    <VBtn
                        size="small"
                        variant="tonal"
                        color="primary"
                        onClick={() => {
                            selected.value = row;
                            resolutionChoice.value = "RETRY_INQUIRE";
                            resolutionReason.value = "";
                            dialogOpen.value = true;
                        }}
                    >
                        {t("Resolve")}
                    </VBtn>
                </ThemedView>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Operator Cases")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center" }}>
                            <VSelect
                                items={CASE_TYPES.map((value) => ({ title: value, value }))}
                                modelValue={typeFilter.value}
                                onUpdate:modelValue={(v: string | null) => (typeFilter.value = v)}
                                label={t("Case Type")}
                                clearable
                                hideDetails
                                density="compact"
                                style={{ minWidth: "200px" }}
                            />
                            <VBtn
                                variant="tonal"
                                loading={bulkLoading.value}
                                disabled={!bulkIds.value.length}
                                onClick={() => void runBulkInquiry()}
                            >
                                {t("Bulk Inquiry")} ({formatPlainNumber(bulkIds.value.length)})
                            </VBtn>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("Operator Cases")}
                        data={rows.value}
                        headers={headers}
                        loading={loading.value}
                        showNumber={true}
                        xlsx={false}
                        searchValue={search.value}
                        setSearchValue={(value) => (search.value = value)}
                    />
                )}
            </ThemedView>

            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(v: any) => (dialogOpen.value = v)} maxWidth="560px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold">{selected.value?.caseRef}</ThemedText>
                        <ThemedText style={{ fontSize: "13px", opacity: 0.75 }}>{selected.value?.summary}</ThemedText>
                        <VSelect
                            items={[
                                { title: t("Retry inquiry"), value: "RETRY_INQUIRE" },
                                { title: t("Mark succeeded"), value: "MARK_SUCCEEDED" },
                                { title: t("Mark failed"), value: "MARK_FAILED" },
                                { title: t("Escalate"), value: "ESCALATE" },
                                { title: t("Release reservation"), value: "RELEASE_RESERVATION" },
                            ]}
                            modelValue={resolutionChoice.value}
                            onUpdate:modelValue={(v: string) => (resolutionChoice.value = v)}
                            label={t("Resolution")}
                        />
                        <VTextarea
                            modelValue={resolutionReason.value}
                            onUpdate:modelValue={(v: string) => (resolutionReason.value = v)}
                            label={t("Reason")}
                            rows={3}
                        />
                        <VBtn
                            color="primary"
                            disabled={resolutionReason.value.trim().length < 3}
                            loading={actionLoading.value}
                            onClick={() => void resolve()}
                        >
                            {t("Resolve")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default OperatorCasesPage;
