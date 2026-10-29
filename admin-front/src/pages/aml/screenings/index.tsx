import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

type Screening = {
    id: string;
    subjectType: string;
    subjectName: string;
    provider: string;
    lists: string[];
    listVersions: string;
    result: string;
    score: number;
    screenedAt: string;
    matchId: string | null;
    disposition: string | null;
};

const DISPOSITIONS = [
    { title: "False Positive", value: "FALSE_POSITIVE" },
    { title: "Confirmed Match", value: "CONFIRMED_MATCH" },
    { title: "Escalated", value: "ESCALATED" },
];

const AmlScreeningsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Screening[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<Screening | null>(null);
    const disposition = ref<string>("FALSE_POSITIVE");
    const note = ref<string>("");
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.amlScreenings, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.screenings ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const submitDisposition = async () => {
        if (!selected.value?.matchId) {
            showSnackBar({ type: "error", message: t("No match attached to this screening") });
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(urlsMap.amlMatchDisposition(selected.value.matchId), {
                disposition: disposition.value,
                notes: note.value,
            });
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Disposition") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const resultTone = (result: string) => {
        if (result === "CONFIRMED_MATCH") {
            return "error" as const;
        }
        if (result === "POTENTIAL_MATCH") {
            return "warning" as const;
        }
        if (result === "CLEAR") {
            return "success" as const;
        }
        return "neutral" as const;
    };

    const headers: TableHeader<Screening>[] = [
        { key: "subjectType", label: "Screening Subject", value: (row) => row.subjectType },
        { key: "subjectName", label: "Merchant Name", value: (row) => row.subjectName },
        { key: "provider", label: "Provider", value: (row) => row.provider },
        { key: "lists", label: "List Version", value: (row) => (row.lists ?? []).join(", ") },
        {
            key: "result",
            label: "Status",
            Value: ({ row }: { row: Screening }) => <StatusChip label={row.result} tone={resultTone(row.result)} />,
        },
        { key: "score", label: "Score", value: (row) => String(row.score ?? "") },
        { key: "screenedAt", label: "Created At", value: (row) => row.screenedAt },
        { key: "disposition", label: "Disposition", value: (row) => row.disposition ?? "-" },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Screening }) => (
                <VBtn
                    size="small"
                    variant="tonal"
                    disabled={!row.matchId}
                    onClick={() => {
                        selected.value = row;
                        disposition.value = "FALSE_POSITIVE";
                        note.value = "";
                        dialogOpen.value = true;
                    }}
                >
                    {t("Disposition")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("AML Screenings")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("AML Screenings")}
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

            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(v: any) => (dialogOpen.value = v)} maxWidth="520px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <VSelect
                            items={DISPOSITIONS}
                            modelValue={disposition.value}
                            onUpdate:modelValue={(v: string) => (disposition.value = v)}
                            label={t("Disposition")}
                        />
                        <VTextarea
                            modelValue={note.value}
                            onUpdate:modelValue={(v: string) => (note.value = v)}
                            label={t("Notes")}
                            rows={3}
                        />
                        <VBtn
                            color="primary"
                            disabled={note.value.trim().length < 3}
                            loading={actionLoading.value}
                            onClick={() => void submitDisposition()}
                        >
                            {t("Save")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default AmlScreeningsPage;
