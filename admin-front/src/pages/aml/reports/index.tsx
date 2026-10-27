import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect, VTextField, VTextarea } from "vuetify/components";
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

type RegulatoryReport = {
    id: string;
    reportRef: string;
    reportType: string;
    authority: string;
    state: string;
    subjectName: string;
    amount: string;
    currency: string;
    sourceRuleCode: string;
    createdAt: string;
    submittedAt: string | null;
    payloadHash: string | null;
};

const AmlReportsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<RegulatoryReport[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const form = ref({
        reportingRuleId: "",
        reportType: "LARGE_TRANSACTION",
        authority: "",
        subjectName: "",
        amount: "",
        currency: "LYD",
        sourceRuleCode: "",
        notes: "",
    });
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.amlReports, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.reports ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const submit = async () => {
        actionLoading.value = true;
        try {
            const today = new Date();
            const periodStart = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
            await api.post(urlsMap.amlReports, {
                reportingRuleId: form.value.reportingRuleId,
                reportType: form.value.reportType,
                periodStart: periodStart.toISOString().slice(0, 10),
                periodEnd: today.toISOString().slice(0, 10),
                notes: form.value.notes,
            });
            dialogOpen.value = false;
            showSnackBar({ type: "success", message: t("Save") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const stateTone = (state: string) => {
        switch (state) {
            case "SUBMITTED":
            case "ACKNOWLEDGED":
                return "success" as const;
            case "REJECTED_BY_AUTHORITY":
                return "error" as const;
            case "PENDING_CHECKER":
                return "warning" as const;
            default:
                return "neutral" as const;
        }
    };

    const headers: TableHeader<RegulatoryReport>[] = [
        { key: "reportRef", label: "Reference", value: (row) => row.reportRef },
        { key: "reportType", label: "Report Type", value: (row) => row.reportType },
        { key: "authority", label: "Authority", value: (row) => row.authority },
        { key: "subjectName", label: "Merchant Name", value: (row) => row.subjectName },
        { key: "amount", label: "Amount", value: (row) => `${row.amount ?? ""} ${row.currency ?? ""}` },
        { key: "sourceRuleCode", label: "Source Reference", value: (row) => row.sourceRuleCode },
        {
            key: "state",
            label: "Status",
            Value: ({ row }: { row: RegulatoryReport }) => <StatusChip label={row.state} tone={stateTone(row.state)} />,
        },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
        { key: "submittedAt", label: "Submitted At", value: (row) => row.submittedAt ?? "-" },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("AML Reports")}
                    end={() => (
                        <VBtn
                            variant="tonal"
                            onClick={() => {
                                form.value = {
                                    reportingRuleId: "",
                                    reportType: "LARGE_TRANSACTION",
                                    authority: "",
                                    subjectName: "",
                                    amount: "",
                                    currency: "LYD",
                                    sourceRuleCode: "",
                                    notes: "",
                                };
                                dialogOpen.value = true;
                            }}
                        >
                            {t("Create")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("AML Reports")}
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

            <VDialog v-model={dialogOpen.value} maxWidth="600px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <VSelect
                            items={["LARGE_TRANSACTION", "SUSPICIOUS_ACTIVITY", "PERIODIC_RETURN"]}
                            modelValue={form.value.reportType}
                            onUpdate:modelValue={(v: string) => (form.value.reportType = v)}
                            label={t("Report Type")}
                        />
                        <VTextField
                            label={t("Authority")}
                            modelValue={form.value.authority}
                            onUpdate:modelValue={(v: string) => (form.value.authority = v)}
                        />
                        <VTextField
                            label={t("Merchant Name")}
                            modelValue={form.value.subjectName}
                            onUpdate:modelValue={(v: string) => (form.value.subjectName = v)}
                        />
                        <VTextField
                            label={t("Amount")}
                            modelValue={form.value.amount}
                            onUpdate:modelValue={(v: string) => (form.value.amount = v)}
                        />
                        <VTextField
                            label={t("Currency")}
                            modelValue={form.value.currency}
                            onUpdate:modelValue={(v: string) => (form.value.currency = v.toUpperCase())}
                        />
                        <VTextField
                            label={t("Source Reference")}
                            modelValue={form.value.sourceRuleCode}
                            onUpdate:modelValue={(v: string) => (form.value.sourceRuleCode = v)}
                        />
                        <VTextarea
                            label={t("Notes")}
                            modelValue={form.value.notes}
                            onUpdate:modelValue={(v: string) => (form.value.notes = v)}
                            rows={3}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void submit()}>
                            {t("Save")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default AmlReportsPage;
