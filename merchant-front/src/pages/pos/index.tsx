import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
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

type Terminal = {
    id: string;
    name: string;
    location: string;
    status: string;
    lastSeenAt: string | null;
    screens: { id: string; code: string; name: string; role: string; pairedAt: string | null }[];
};

const PosTerminalsPage = dc(() => {
    const { t } = useLocale();
    const router = useRouter();
    const rows = ref<Terminal[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const terminalOpen = ref(false);
    const screenOpen = ref(false);
    const activeTerminal = ref<Terminal | null>(null);
    const terminalForm = ref({ name: "", location: "" });
    const screenForm = ref({ name: "", role: "CASHIER" });
    const actionLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.posTerminals, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.terminals ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const createTerminal = async () => {
        actionLoading.value = true;
        try {
            await api.post(urlsMap.posTerminals, terminalForm.value);
            terminalOpen.value = false;
            showSnackBar({ type: "success", message: t("Created") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const createScreen = async () => {
        if (!activeTerminal.value) {
            return;
        }
        actionLoading.value = true;
        try {
            await api.post(urlsMap.posScreens(activeTerminal.value.id), screenForm.value);
            screenOpen.value = false;
            showSnackBar({ type: "success", message: t("Created") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            actionLoading.value = false;
        }
    };

    const headers: TableHeader<Terminal>[] = [
        { key: "name", label: "Merchant Name", value: (row) => row.name },
        { key: "location", label: "Brand", value: (row) => row.location },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Terminal }) => (
                <StatusChip label={row.status} tone={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        { key: "lastSeenAt", label: "Last Used", value: (row) => row.lastSeenAt ?? "-" },
        {
            key: "screens",
            label: "Screens",
            Value: ({ row }: { row: Terminal }) => (
                <ThemedView style={{ flexDirection: "column", gap: "4px" }}>
                    {(row.screens ?? []).map((screen) => (
                        <ThemedView key={screen.id} style={{ flexDirection: "row", gap: "6px", alignItems: "center" }}>
                            <span style={{ fontSize: "12px" }}>{screen.name}</span>
                            <StatusChip label={screen.role} tone="info" />
                            <VBtn
                                size="x-small"
                                variant="text"
                                onClick={() => void router.push({ name: "PosScreen", params: { code: screen.code } })}
                            >
                                {t("Open")}
                            </VBtn>
                        </ThemedView>
                    ))}
                    {!(row.screens ?? []).length && (
                        <span style={{ fontSize: "12px", opacity: 0.6 }}>{t("No Data Found")}</span>
                    )}
                </ThemedView>
            ),
        },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: Terminal }) => (
                <ThemedView style={{ flexDirection: "row", gap: "6px" }}>
                    <VBtn
                        size="small"
                        variant="tonal"
                        onClick={() => {
                            activeTerminal.value = row;
                            screenForm.value = { name: "", role: "CASHIER" };
                            screenOpen.value = true;
                        }}
                    >
                        {t("Screens")}
                    </VBtn>
                    <VBtn
                        size="small"
                        variant="tonal"
                        disabled={!(row.screens ?? []).length}
                        onClick={() =>
                            void router.push({
                                name: "PosScreen",
                                params: { code: row.screens?.[0]?.code ?? "" },
                            })
                        }
                    >
                        {t("Fullscreen")}
                    </VBtn>
                </ThemedView>
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("POS Terminals")}
                    end={() => (
                        <VBtn
                            variant="tonal"
                            onClick={() => {
                                terminalForm.value = { name: "", location: "" };
                                terminalOpen.value = true;
                            }}
                        >
                            {t("Create")}
                        </VBtn>
                    )}
                />

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <VCard>
                        <VCardText>
                            <DataTable
                                title={t("POS Terminals")}
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

            <VDialog v-model={terminalOpen.value} maxWidth="480px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <VTextField
                            label={t("Terminal")}
                            modelValue={terminalForm.value.name}
                            onUpdate:modelValue={(v: string) => (terminalForm.value.name = v)}
                        />
                        <VTextField
                            label={t("Brand")}
                            modelValue={terminalForm.value.location}
                            onUpdate:modelValue={(v: string) => (terminalForm.value.location = v)}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void createTerminal()}>
                            {t("Create")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog v-model={screenOpen.value} maxWidth="480px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold">{activeTerminal.value?.name}</ThemedText>
                        <VTextField
                            label={t("Merchant Name")}
                            modelValue={screenForm.value.name}
                            onUpdate:modelValue={(v: string) => (screenForm.value.name = v)}
                        />
                        <VTextField
                            label={t("Type")}
                            modelValue={screenForm.value.role}
                            onUpdate:modelValue={(v: string) => (screenForm.value.role = v.toUpperCase())}
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void createScreen()}>
                            {t("Create")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default PosTerminalsPage;
