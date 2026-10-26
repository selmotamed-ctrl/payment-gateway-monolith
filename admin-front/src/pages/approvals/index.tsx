import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VTextField, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { JsonPatchDiff, type JsonPatchOperation } from "@/components/JsonPatchDiff";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Approval = {
    id: string;
    subjectType: string;
    subjectId: string;
    domain: string;
    state: string;
    makerUserId: string;
    makerName: string;
    checkerUserId: string | null;
    checkerName: string | null;
    reason: string;
    createdAt: string;
    expiresAt: string | null;
    payloadDiff: JsonPatchOperation[];
    baseVersion: number | null;
    entityType: string;
};

const ApprovalsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Approval[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);
    const stateFilter = ref<string | null>(null);

    const detailsOpen = ref(false);
    const selected = ref<Approval | null>(null);
    const decisionReason = ref<string>("");
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.approvalsList, {
                params: { search: search.value || undefined, state: stateFilter.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.approvals ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const openDetails = async (row: Approval) => {
        selected.value = row;
        decisionReason.value = "";
        detailsOpen.value = true;
        try {
            const response = await api.get(urlsMap.approvalDetail(row.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = {
                ...row,
                ...payload,
                payloadDiff: payload.payloadDiff ?? payload.payload_diff_json ?? row.payloadDiff ?? [],
            } as Approval;
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const decide = async (approve: boolean) => {
        if (!selected.value) {
            return;
        }
        if (!approve && !decisionReason.value) {
            showSnackBar({ type: "warning", message: t("Decision Reason") });
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(approve ? urlsMap.approvalApprove(selected.value.id) : urlsMap.approvalReject(selected.value.id), {
                reason: decisionReason.value,
            });
            detailsOpen.value = false;
            showSnackBar({ type: "success", message: approve ? t("Approved") : t("Rejected") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const canDecide = computed(() => selected.value?.state === "PENDING_REVIEW" || selected.value?.state === "PENDING_CHECKER");

    const headers: TableHeader<Approval>[] = [
        { key: "subjectType", label: "Subject Type", value: (row) => row.subjectType },
        { key: "subjectId", label: "Reference", value: (row) => row.subjectId },
        { key: "domain", label: "Domain", value: (row) => row.domain },
        { key: "state", label: "Status", value: (row) => row.state },
        { key: "makerName", label: "Maker", value: (row) => row.makerName },
        { key: "checkerName", label: "Checker", value: (row) => row.checkerName ?? "-" },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
        {
            key: "view",
            label: "Actions Column",
            Value: ({ row }: { row: Approval }) => (
                <VBtn size="small" variant="tonal" onClick={() => void openDetails(row)}>
                    {t("Details")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Approvals")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("Approvals")}
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

            <VDialog v-model={detailsOpen.value} maxWidth="860px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                {selected.value?.subjectType}
                            </ThemedText>
                            <StatusChip label={selected.value?.state ?? "-"} tone="info" />
                            {selected.value?.baseVersion != null && (
                                <StatusChip label={`v${selected.value.baseVersion}`} tone="neutral" />
                            )}
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "row", gap: "24px", flexWrap: "wrap" }}>
                            <ThemedView style={{ gap: "4px" }}>
                                <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{t("Maker")}</ThemedText>
                                <ThemedText style={{ fontSize: "13px" }}>{selected.value?.makerName}</ThemedText>
                            </ThemedView>
                            <ThemedView style={{ gap: "4px" }}>
                                <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{t("Checker")}</ThemedText>
                                <ThemedText style={{ fontSize: "13px" }}>{selected.value?.checkerName ?? "-"}</ThemedText>
                            </ThemedView>
                            <ThemedView style={{ gap: "4px" }}>
                                <ThemedText style={{ fontSize: "11px", opacity: 0.6 }}>{t("Reason")}</ThemedText>
                                <ThemedText style={{ fontSize: "13px" }}>{selected.value?.reason ?? "-"}</ThemedText>
                            </ThemedView>
                        </ThemedView>

                        <ThemedView style={{ gap: "8px" }}>
                            <ThemedText type="defaultSemiBold">{t("Details")}</ThemedText>
                            <JsonPatchDiff operations={selected.value?.payloadDiff ?? []} />
                        </ThemedView>

                        <VTextarea
                            modelValue={decisionReason.value}
                            onUpdate:modelValue={(v: string) => (decisionReason.value = v)}
                            label={t("Decision Reason")}
                            rows={2}
                        />

                        <ThemedView style={{ flexDirection: "row", gap: "12px" }}>
                            <VBtn
                                color="success"
                                disabled={!canDecide.value}
                                loading={actionLoading.value}
                                onClick={() => void decide(true)}
                            >
                                {t("Approve")}
                            </VBtn>
                            <VBtn
                                color="error"
                                variant="tonal"
                                disabled={!canDecide.value}
                                loading={actionLoading.value}
                                onClick={() => void decide(false)}
                            >
                                {t("Reject")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default ApprovalsPage;
