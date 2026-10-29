import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VBtn, VCard, VCardText, VDialog, VSelect, VTextField } from "vuetify/components";
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

type Gateway = {
    id: string;
    code: string;
    name: string;
    operator: string;
    country: string;
    kind: string;
    verificationState: string;
    riskClass: string;
    status: string;
    aliases: string[];
    activeVersionId: string | null;
    versions: { id: string; version: number; status: string; createdAt: string }[];
};

const GatewaysPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const rows = ref<Gateway[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);
    const createOpen = ref(false);
    const creating = ref(false);
    const form = ref({ code: "", name: "", operator: "", kind: "DIRECT", country: "LY", riskClass: "NORMAL" });

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.gatewaysList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.gateways ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const openCreate = () => {
        form.value = { code: "", name: "", operator: "", kind: "DIRECT", country: "LY", riskClass: "NORMAL" };
        createOpen.value = true;
    };

    const createGateway = async () => {
        if (creating.value) {
            return;
        }
        creating.value = true;
        try {
            const response = await api.post(urlsMap.gatewaysList, {
                code: form.value.code.trim().toLowerCase(),
                name: form.value.name.trim(),
                operator: form.value.operator.trim() || form.value.name.trim(),
                kind: form.value.kind,
                country: form.value.country.trim().toUpperCase() || "LY",
                riskClass: form.value.riskClass,
            });
            const payload = response.data?.data ?? response.data ?? {};
            createOpen.value = false;
            showSnackBar({ type: "success", message: t("Saved") });
            await load();
            if (payload.id) {
                await router.push({ name: "GatewayWizard", params: { id: payload.id } });
            }
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            creating.value = false;
        }
    };

    const kindTone = (kind: string) => {
        switch (kind) {
            case "INTERNAL":
                return "primary" as const;
            case "AGGREGATOR":
                return "info" as const;
            case "DIRECT":
                return "success" as const;
            default:
                return "warning" as const;
        }
    };

    const headers: TableHeader<Gateway>[] = [
        { key: "code", label: "Gateway Code", value: (row) => row.code },
        { key: "name", label: "Gateway", value: (row) => row.name },
        { key: "operator", label: "Operator", value: (row) => row.operator },
        { key: "country", label: "Country", value: (row) => row.country },
        {
            key: "kind",
            label: "Kind",
            Value: ({ row }: { row: Gateway }) => <StatusChip label={row.kind} tone={kindTone(row.kind)} />,
        },
        {
            key: "verificationState",
            label: "Verification State",
            Value: ({ row }: { row: Gateway }) => (
                <StatusChip
                    label={row.verificationState}
                    tone={row.verificationState === "VERIFIED" ? "success" : "warning"}
                />
            ),
        },
        { key: "status", label: "Status", Value: ({ row }: { row: Gateway }) => <StatusChip label={row.status} tone={statusTone(row.status)} /> },
        {
            key: "riskClass",
            label: "Risk Class",
            Value: ({ row }: { row: Gateway }) => <StatusChip label={row.riskClass} tone={statusTone(row.riskClass)} />,
        },
        { key: "aliases", label: "Aliases", value: (row) => (row.aliases ?? []).join(", ") },
        { key: "versions", label: "Version", value: (row) => String(row.versions?.length ?? 0) },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Gateway }) => (
                <VBtn
                    size="small"
                    variant="tonal"
                    color="primary"
                    onClick={() => void router.push({ name: "GatewayWizard", params: { id: row.id } })}
                >
                    {t("Gateway Wizard")}
                </VBtn>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Gateways")}
                    end={() => (
                        <ThemedView style={{ flexDirection: "row", gap: "10px", flexWrap: "wrap" }}>
                            <VBtn
                                color="primary"
                                variant="flat"
                                prependIcon={"mdi-plus"}
                                onClick={() => openCreate()}
                            >
                                {t("New Gateway")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                variant="tonal"
                                prependIcon={"mdi-robot-outline"}
                                onClick={() => void router.push({ name: "GatewayAiImport" })}
                            >
                                {t("Smart AI Integration")}
                            </VBtn>
                        </ThemedView>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("Gateways")}
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

            <VDialog modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} maxWidth="560px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {t("New Gateway")}
                        </ThemedText>
                        <VTextField
                            label={t("Gateway Code")}
                            hint="lowercase letters, digits, - and _"
                            modelValue={form.value.code}
                            onUpdate:modelValue={(v: string) => (form.value.code = v)}
                        />
                        <VTextField
                            label={t("Gateway")}
                            modelValue={form.value.name}
                            onUpdate:modelValue={(v: string) => (form.value.name = v)}
                        />
                        <VTextField
                            label={t("Operator")}
                            modelValue={form.value.operator}
                            onUpdate:modelValue={(v: string) => (form.value.operator = v)}
                        />
                        <VSelect
                            label={t("Kind")}
                            items={["DIRECT", "AGGREGATOR", "NATIVE_ADAPTER", "INTERNAL"]}
                            modelValue={form.value.kind}
                            onUpdate:modelValue={(v: string) => (form.value.kind = v)}
                        />
                        <VTextField
                            label={t("Country")}
                            modelValue={form.value.country}
                            onUpdate:modelValue={(v: string) => (form.value.country = v)}
                        />
                        <VSelect
                            label={t("Risk Class")}
                            items={["NORMAL", "HIGH_RISK"]}
                            modelValue={form.value.riskClass}
                            onUpdate:modelValue={(v: string) => (form.value.riskClass = v)}
                        />
                        <ThemedView style={{ flexDirection: "row", gap: "10px", justifyContent: "flex-end" }}>
                            <VBtn variant="text" onClick={() => (createOpen.value = false)}>
                                {t("Cancel")}
                            </VBtn>
                            <VBtn
                                color="primary"
                                loading={creating.value}
                                disabled={!form.value.code.trim() || !form.value.name.trim()}
                                onClick={() => void createGateway()}
                            >
                                {t("Create")}
                            </VBtn>
                        </ThemedView>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default GatewaysPage;
