import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { useRouter } from "vue-router";
import { VBtn, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
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
    const formError = ref("");

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
        formError.value = "";
        try {
            await api.post(urlsMap.posTerminals, terminalForm.value);
            terminalOpen.value = false;
            showSnackBar({ type: "success", message: t("Created") });
            await load();
        } catch (e) {
            const message = extractApiErrorMessage(e);
            formError.value = message;
            showSnackBar({ type: "error", message });
        } finally {
            actionLoading.value = false;
        }
    };

    const createScreen = async () => {
        if (!activeTerminal.value) {
            return;
        }
        actionLoading.value = true;
        formError.value = "";
        try {
            await api.post(urlsMap.posScreens(activeTerminal.value.id), {
                label: screenForm.value.name,
                mode: screenForm.value.role,
            });
            screenOpen.value = false;
            showSnackBar({ type: "success", message: t("Created") });
            await load();
        } catch (e) {
            const message = extractApiErrorMessage(e);
            formError.value = message;
            showSnackBar({ type: "error", message });
        } finally {
            actionLoading.value = false;
        }
    };

    const headers: TableHeader<Terminal>[] = [
        { key: "name", label: "Terminal Name", value: (row) => row.name },
        { key: "location", label: "Location", value: (row) => row.location },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Terminal }) => (
                <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} />
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
                            <StatusBadge status={screen.role} label={screen.role} toneOverride="info" />
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
                        <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{t("No screens paired")}</span>
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
                            formError.value = "";
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
                    subtitle={t("Point-of-sale terminals and payment screens.")}
                    end={() => (
                        <VBtn
                            variant="tonal"
                            onClick={() => {
                                terminalForm.value = { name: "", location: "" };
                                formError.value = "";
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
                )}
            </ThemedView>

            <FormModal
                modelValue={terminalOpen.value}
                onUpdate:modelValue={(v: any) => (terminalOpen.value = v)}
                title={t("Create Terminal")}
                size="sm"
                loading={actionLoading.value}
                errorMessage={formError.value}
                submitLabel={t("Create")}
                onSubmit={() => void createTerminal()}
            >
                <FormField label={t("Terminal Name")} required>
                    <VTextField
                        modelValue={terminalForm.value.name}
                        onUpdate:modelValue={(v: string) => (terminalForm.value.name = v)}
                        hideDetails
                    />
                </FormField>
                <FormField label={t("Location")}>
                    <VTextField
                        modelValue={terminalForm.value.location}
                        onUpdate:modelValue={(v: string) => (terminalForm.value.location = v)}
                        hideDetails
                    />
                </FormField>
            </FormModal>

            <FormModal
                modelValue={screenOpen.value}
                onUpdate:modelValue={(v: any) => (screenOpen.value = v)}
                title={activeTerminal.value?.name ?? t("POS terminal")}
                size="sm"
                loading={actionLoading.value}
                errorMessage={formError.value}
                submitLabel={t("Create")}
                onSubmit={() => void createScreen()}
            >
                <FormField label={t("Screen Name")} required>
                    <VTextField
                        modelValue={screenForm.value.name}
                        onUpdate:modelValue={(v: string) => (screenForm.value.name = v)}
                        hideDetails
                    />
                </FormField>
                <FormField label={t("Type")}>
                    <VTextField
                        modelValue={screenForm.value.role}
                        onUpdate:modelValue={(v: string) => (screenForm.value.role = v.toUpperCase())}
                        hideDetails
                    />
                </FormField>
            </FormModal>
        </ScreenContainer>
    );
});

export default PosTerminalsPage;
