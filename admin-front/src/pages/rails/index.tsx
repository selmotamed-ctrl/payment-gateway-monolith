import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VTextField } from "vuetify/components";
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

type RailField = {
    id: string;
    fieldKey: string;
    labelAr: string;
    labelEn: string;
    inputType: string;
    required: boolean;
    regex: string | null;
    minLength: number | null;
    maxLength: number | null;
    normalizer: string;
    sensitivity: string;
};

type Rail = {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string;
    collectionMode: string;
    currency: string;
    minAmount: string;
    maxAmount: string;
    capabilities: string[];
    fields: RailField[];
};

const RailsPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<Rail[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const selected = ref<Rail | null>(null);
    const form = ref<Partial<RailField>>({});
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.railsList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.rails ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const openRail = async (rail: Rail) => {
        selected.value = rail;
        form.value = {
            fieldKey: "",
            labelAr: "",
            labelEn: "",
            inputType: "text",
            required: false,
            regex: "",
            minLength: null,
            maxLength: null,
            normalizer: "NONE",
            sensitivity: "NORMAL",
        };
        dialogOpen.value = true;
        try {
            const response = await api.get(urlsMap.railFields(rail.id));
            const payload = response.data?.data ?? response.data ?? {};
            selected.value = { ...rail, fields: payload.fields ?? payload.railFields ?? [] };
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const saveField = async () => {
        if (!selected.value) {
            return;
        }
        actionLoading.value = true;
        try {
            await api.put(urlsMap.railFields(selected.value.id), {
                fields: [...(selected.value.fields ?? []), form.value],
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

    const headers: TableHeader<Rail>[] = [
        { key: "code", label: "Rail Code", value: (row) => row.code },
        { key: "nameEn", label: "Label (English)", value: (row) => row.nameEn },
        { key: "nameAr", label: "Label (Arabic)", value: (row) => row.nameAr },
        { key: "collectionMode", label: "Type", value: (row) => row.collectionMode },
        { key: "currency", label: "Currency", value: (row) => row.currency },
        { key: "limits", label: "Amount", value: (row) => `${row.minAmount ?? ""} - ${row.maxAmount ?? ""}` },
        { key: "capabilities", label: "Capabilities", value: (row) => (row.capabilities ?? []).join(", ") },
        { key: "fieldsCount", label: "Customer Catalog", value: (row) => String(row.fields?.length ?? 0) },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Rail }) => (
                <VBtn size="small" variant="tonal" onClick={() => void openRail(row)}>
                    {t("Customer Catalog")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader title={t("Rails")} />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Rails")}
                                data={rows.value}
                                headers={headers}
                                loading={loading.value}
                                showNumber={true}
                                xlsx={false}
                                noElevation={true}
                                searchValue={search.value}
                                setSearchValue={(value) => (search.value = value)}
                            />
                        </VCardText>
                    </VCard>
                )}
            </ThemedView>

            <VDialog v-model={dialogOpen.value} maxWidth="720px" scrollable>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedView style={{ flexDirection: "row", gap: "10px", alignItems: "center" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                {selected.value?.nameEn} ({selected.value?.code})
                            </ThemedText>
                            <StatusChip label={selected.value?.collectionMode ?? "-"} tone="info" />
                        </ThemedView>

                        <ThemedView style={{ flexDirection: "column", gap: "8px" }}>
                            {(selected.value?.fields ?? []).map((field) => (
                                <ThemedView
                                    key={field.id ?? field.fieldKey}
                                    style={{
                                        flexDirection: "row",
                                        gap: "10px",
                                        alignItems: "center",
                                        borderBottom: "1px solid rgba(100,116,139,0.18)",
                                        paddingBottom: "8px",
                                        fontSize: "13px",
                                    }}
                                >
                                    <span style={{ width: "150px" }}>{field.fieldKey}</span>
                                    <span style={{ flex: 1 }}>{field.labelEn}</span>
                                    <span style={{ flex: 1 }}>{field.labelAr}</span>
                                    <StatusChip label={field.sensitivity} tone="warning" />
                                    <StatusChip label={field.inputType} tone="neutral" />
                                </ThemedView>
                            ))}
                        </ThemedView>

                        <ThemedText type="defaultSemiBold">{t("Add")}</ThemedText>
                        <VTextField
                            label={t("Field Key")}
                            modelValue={form.value.fieldKey ?? ""}
                            onUpdate:modelValue={(v: string) => (form.value.fieldKey = v)}
                        />
                        <VTextField
                            label={t("Label (English)")}
                            modelValue={form.value.labelEn ?? ""}
                            onUpdate:modelValue={(v: string) => (form.value.labelEn = v)}
                        />
                        <VTextField
                            label={t("Label (Arabic)")}
                            modelValue={form.value.labelAr ?? ""}
                            onUpdate:modelValue={(v: string) => (form.value.labelAr = v)}
                        />
                        <VTextField
                            label={t("Input Type")}
                            modelValue={form.value.inputType ?? "text"}
                            onUpdate:modelValue={(v: string) => (form.value.inputType = v)}
                        />
                        <VTextField
                            label={t("Regex")}
                            modelValue={form.value.regex ?? ""}
                            onUpdate:modelValue={(v: string) => (form.value.regex = v)}
                        />
                        <VTextField
                            label={t("Normalizer")}
                            modelValue={form.value.normalizer ?? "NONE"}
                            onUpdate:modelValue={(v: string) => (form.value.normalizer = v)}
                        />
                        <VTextField
                            label={t("Sensitivity")}
                            modelValue={form.value.sensitivity ?? "NORMAL"}
                            onUpdate:modelValue={(v: string) => (form.value.sensitivity = v)}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void saveField()}>
                            {t("Save")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default RailsPage;
