import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect, VTextarea } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { formatPlainNumber } from "@/utils/money";

type AmlCase = {
    id: string;
    caseRef: string;
    subjectType: string;
    subjectName: string;
    severity: string;
    status: string;
    amount: string;
    currency: string;
    ruleCode: string;
    openedAt: string;
    slaDueAt: string;
    severityInputs: Record<string, unknown>;
    assignedTo: string | null;
};

const RESOLUTIONS = [
    { title: "Release", value: "RELEASE" },
    { title: "Void And Return", value: "REJECT" },
    { title: "Freeze", value: "AML_HOLD" },
    { title: "Escalate STR", value: "REPORT" },
];

const AmlCasesPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<AmlCase[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<AmlCase | null>(null);
    const resolution = ref<string>("RELEASE");
    const rationale = ref<string>("");
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.amlCases, {
                params: { search: search.value || undefined },
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

    const propose = async () => {
        if (!selected.value) {
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(urlsMap.amlCasePropose(selected.value.id), {
                severity: selected.value.severity,
                action: resolution.value,
                reason: rationale.value,
            });
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Propose") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const severityTone = (severity: string) => {
        switch (severity) {
            case "CRITICAL":
                return "error" as const;
            case "HIGH":
                return "warning" as const;
            case "MEDIUM":
                return "info" as const;
            default:
                return "neutral" as const;
        }
    };

    const headers: TableHeader<AmlCase>[] = [
        { key: "caseRef", label: "Reference", value: (row) => row.caseRef },
        { key: "subjectType", label: "Screening Subject", value: (row) => row.subjectType },
        { key: "subjectName", label: "Merchant Name", value: (row) => row.subjectName },
        {
            key: "severity",
            label: "Case Severity",
            Value: ({ row }: { row: AmlCase }) => <StatusChip label={row.severity} tone={severityTone(row.severity)} />,
        },
        { key: "status", label: "Case Status", value: (row) => row.status },
        { key: "amount", label: "Amount", value: (row) => `${row.amount ?? ""} ${row.currency ?? ""}` },
        { key: "ruleCode", label: "Rule Type", value: (row) => row.ruleCode },
        { key: "openedAt", label: "Opened At", value: (row) => row.openedAt },
        { key: "slaDueAt", label: "Due At", value: (row) => row.slaDueAt },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: AmlCase }) => (
                <VBtn
                    size="small"
                    variant="tonal"
                    onClick={() => {
                        selected.value = row;
                        resolution.value = "RELEASE";
                        rationale.value = "";
                        dialogOpen.value = true;
                    }}
                >
                    {t("Propose")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("AML Cases")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("AML Cases")}
                        data={rows.value}
                        headers={headers}
                        loading={loading.value}
                        showNumber={true}
                        xlsx={false}
                        searchValue={search.value}
                        setSearchValue={(value) => (search.value = value)}
                    />
                )}

                <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                    {t("AML-CONFIDENTIAL")} · {formatPlainNumber(rows.value.length)} {t("Open Cases")}
                </ThemedText>
            </ThemedView>

            <VDialog v-model={dialogOpen.value} maxWidth="560px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {selected.value?.caseRef}
                        </ThemedText>
                        <VSelect
                            items={RESOLUTIONS}
                            modelValue={resolution.value}
                            onUpdate:modelValue={(v: string) => (resolution.value = v)}
                            label={t("Resolution")}
                        />
                        <VTextarea
                            modelValue={rationale.value}
                            onUpdate:modelValue={(v: string) => (rationale.value = v)}
                            label={t("Notes & Rationale")}
                            rows={3}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void propose()}>
                            {t("Propose")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default AmlCasesPage;
