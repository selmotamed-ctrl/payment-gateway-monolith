import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VSelect, VTextField } from "vuetify/components";
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

type AmlRule = {
    id: string;
    code: string;
    name: string;
    ruleType: string;
    params: Record<string, unknown>;
    action: string;
    baseSeverity: string;
    effectiveFrom: string;
    version: number;
    active: boolean;
};

const RULE_TYPES = [
    { title: "Single Amount", value: "SINGLE_AMOUNT" },
    { title: "Cumulative Window", value: "CUMULATIVE_WINDOW" },
    { title: "Structuring", value: "STRUCTURING" },
    { title: "Risk Tier", value: "RISK_TIER" },
    { title: "Counterparty Country", value: "COUNTERPARTY_COUNTRY" },
    { title: "Rail", value: "RAIL" },
    { title: "Merchant Direct Amount", value: "MERCHANT_DIRECT_AMOUNT" },
];

const RULE_ACTIONS = [
    { title: "Hold", value: "HOLD" },
    { title: "Flag", value: "FLAG" },
    { title: "Block", value: "BLOCK" },
    { title: "Case Only", value: "CASE_ONLY" },
];

const AmlRulesPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<AmlRule[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const dialogOpen = ref(false);
    const form = ref({
        code: "",
        name: "",
        ruleType: "SINGLE_AMOUNT",
        action: "HOLD",
        baseSeverity: "MEDIUM",
        minAmount: "",
        maxAmount: "",
        windowSeconds: "",
        effectiveFrom: "",
    });
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.amlRules, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.rules ?? payload.rows ?? payload.items ?? [];
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
            const params: Record<string, unknown> = {};
            if (form.value.minAmount) {
                params["min_amount"] = form.value.minAmount;
            }
            if (form.value.maxAmount) {
                params["max_amount"] = form.value.maxAmount;
            }
            if (form.value.windowSeconds) {
                params["window_seconds"] = Number(form.value.windowSeconds);
            }
            await api.post(urlsMap.amlRules, {
                code: form.value.code,
                name: form.value.name,
                ruleType: form.value.ruleType,
                action: form.value.action,
                baseSeverity: form.value.baseSeverity,
                effectiveFrom: form.value.effectiveFrom || undefined,
                params,
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

    const headers: TableHeader<AmlRule>[] = [
        { key: "code", label: "Reference", value: (row) => row.code },
        { key: "name", label: "Merchant Name", value: (row) => row.name },
        { key: "ruleType", label: "Rule Type", value: (row) => row.ruleType },
        { key: "action", label: "Action", value: (row) => row.action },
        { key: "baseSeverity", label: "Severity", value: (row) => row.baseSeverity },
        { key: "params", label: "Params", value: (row) => JSON.stringify(row.params ?? {}) },
        { key: "effectiveFrom", label: "Effective From", value: (row) => row.effectiveFrom },
        { key: "version", label: "Version", value: (row) => String(row.version ?? "") },
        {
            key: "active",
            label: "Status",
            Value: ({ row }: { row: AmlRule }) => (
                <StatusChip label={row.active ? t("Active") : t("Inactive")} tone={row.active ? "success" : "neutral"} />
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("AML Rules")}
                    end={() => (
                        <VBtn
                            variant="tonal"
                            onClick={() => {
                                form.value = {
                                    code: "",
                                    name: "",
                                    ruleType: "SINGLE_AMOUNT",
                                    action: "HOLD",
                                    baseSeverity: "MEDIUM",
                                    minAmount: "",
                                    maxAmount: "",
                                    windowSeconds: "",
                                    effectiveFrom: "",
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
                        title={t("AML Rules")}
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

            <VDialog modelValue={dialogOpen.value} onUpdate:modelValue={(v: any) => (dialogOpen.value = v)} maxWidth="620px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <VTextField
                            label={t("Gateway Code")}
                            modelValue={form.value.code}
                            onUpdate:modelValue={(v: string) => (form.value.code = v)}
                        />
                        <VTextField
                            label={t("Merchant Name")}
                            modelValue={form.value.name}
                            onUpdate:modelValue={(v: string) => (form.value.name = v)}
                        />
                        <VSelect
                            items={RULE_TYPES}
                            modelValue={form.value.ruleType}
                            onUpdate:modelValue={(v: string) => (form.value.ruleType = v)}
                            label={t("Rule Type")}
                        />
                        <VSelect
                            items={RULE_ACTIONS}
                            modelValue={form.value.action}
                            onUpdate:modelValue={(v: string) => (form.value.action = v)}
                            label={t("Action")}
                        />
                        <VSelect
                            items={["LOW", "MEDIUM", "HIGH", "CRITICAL"]}
                            modelValue={form.value.baseSeverity}
                            onUpdate:modelValue={(v: string) => (form.value.baseSeverity = v)}
                            label={t("Severity")}
                        />
                        <VTextField
                            label="min_amount"
                            modelValue={form.value.minAmount}
                            onUpdate:modelValue={(v: string) => (form.value.minAmount = v)}
                        />
                        <VTextField
                            label="max_amount"
                            modelValue={form.value.maxAmount}
                            onUpdate:modelValue={(v: string) => (form.value.maxAmount = v)}
                        />
                        <VTextField
                            label="window_seconds"
                            modelValue={form.value.windowSeconds}
                            onUpdate:modelValue={(v: string) => (form.value.windowSeconds = v)}
                        />
                        <VTextField
                            label={t("Effective From")}
                            modelValue={form.value.effectiveFrom}
                            onUpdate:modelValue={(v: string) => (form.value.effectiveFrom = v)}
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

export default AmlRulesPage;
