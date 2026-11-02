import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VFileInput, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { MoneyText } from "@/components/MoneyText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { FormModal } from "@/components/ui/FormModal";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
type Dispute = {
    id: string;
    disputeRef: string;
    source: string;
    state: string;
    amount: string;
    currency: string;
    reasonCode: string;
    evidenceDueAt: string;
    evidenceSubmitted: boolean;
    openedAt: string;
};

const DisputesPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Dispute[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<Dispute | null>(null);
    const note = ref<string>("");
    const file = ref<File | null>(null);
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.disputesList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.disputes ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const submitEvidence = async () => {
        if (!selected.value) {
            return;
        }
        actionLoading.value = true;
        try {
            const body = new FormData();
            body.append("note", note.value);
            if (file.value) {
                body.append("file", file.value);
            }
            await api.post(urlsMap.disputeEvidence(selected.value.id), body, {
                headers: { "Content-Type": "multipart/form-data" },
            });
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Evidence") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const stateTone = (state: string) => {
        switch (state) {
            case "WON":
                return "success" as const;
            case "LOST":
            case "EXPIRED":
                return "error" as const;
            default:
                return "warning" as const;
        }
    };

    const headers: TableHeader<Dispute>[] = [
        { key: "disputeRef", label: "Reference", value: (row) => row.disputeRef },
        { key: "source", label: "Dispute Source", value: (row) => row.source },
        {
            key: "state",
            label: "Status",
            Value: ({ row }: { row: Dispute }) => <StatusChip label={row.state} tone={stateTone(row.state)} />,
        },
        {
            key: "amount",
            label: "Amount",
            Value: ({ row }: { row: Dispute }) => <MoneyText value={row.amount} currency={row.currency} bold />,
        },
        { key: "reasonCode", label: "Reason Code Label", value: (row) => row.reasonCode },
        { key: "evidenceDueAt", label: "Evidence Deadline", value: (row) => row.evidenceDueAt },
        {
            key: "evidenceSubmitted",
            label: "Evidence",
            Value: ({ row }: { row: Dispute }) => (
                <StatusChip label={row.evidenceSubmitted ? t("Submitted") : t("Pending")} tone={row.evidenceSubmitted ? "success" : "warning"} />
            ),
        },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Dispute }) => (
                <VBtn
                    size="small"
                    variant="tonal"
                    onClick={() => {
                        selected.value = row;
                        note.value = "";
                        file.value = null;
                        dialogOpen.value = true;
                    }}
                >
                    {t("Respond")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Disputes")}
                    subtitle={t("Chargeback cases, evidence, and resolution status.")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <SurfaceCard>
                        <SurfaceCardText>
                            <DataTable
                                title={t("Disputes")}
                                data={rows.value}
                                headers={headers}
                                loading={loading.value}
                                showNumber={true}
                                xlsx={false}
                                noElevation={true}
                                searchValue={search.value}
                                setSearchValue={(value) => (search.value = value)}
                            />
                        </SurfaceCardText>
                    </SurfaceCard>
                )}
            </ThemedView>

            <FormModal
                modelValue={dialogOpen.value}
                onUpdate:modelValue={(v: any) => (dialogOpen.value = v)}
                title={selected.value?.disputeRef ?? t("Dispute")}
                size="md"
            >
<VTextarea
                            label={t("Notes")}
                            modelValue={note.value}
                            onUpdate:modelValue={(v: string) => (note.value = v)}
                            rows={3}
                        />
                        <VFileInput
                            label={t("Evidence")}
                            modelValue={file.value}
                            onUpdate:modelValue={(v: File | File[] | null) => {
                                file.value = Array.isArray(v) ? (v[0] ?? null) : v;
                            }}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void submitEvidence()}>
                            {t("Submit")}
                        </VBtn>
            </FormModal>
        </ScreenContainer>
    );
});

export default DisputesPage;
