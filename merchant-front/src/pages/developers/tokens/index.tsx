import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VTextField } from "vuetify/components";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { StateView } from "@/components/StateView";
import { DataTable } from "@/components/Table/DataTable";
import { TableRowActions } from "@/components/Table/TableRowActions";
import type { TableHeader } from "@/components/Table/types";
import { SectionFields } from "@/components/SectionFields";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MonoRef } from "@/components/ui/MonoRef";
type AccessToken = {
    id: string;
    name: string;
    tokenPrefix: string;
    scopes: string[];
    ipWhitelistEnabled: boolean;
    ipAllowlist: string[];
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
};

const DeveloperTokensPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<AccessToken[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const createOpen = ref(false);
    const form = ref({ name: "", scopes: "", ipWhitelistEnabled: false, ipAllowlist: "" });
    const createdSecret = ref<string | null>(null);
    const actionLoading = ref(false);
    const formError = ref("");

    const ipOpen = ref(false);
    const activeToken = ref<AccessToken | null>(null);
    const ipList = ref("");

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.tokensList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            const tokens = payload.tokens ?? payload.rows ?? payload.items ?? [];
            rows.value = tokens.map((token: any) => ({
                ...token,
                tokenPrefix: token.tokenPrefix ?? token.lastFour ?? "",
                ipAllowlist: token.ipAllowlist ?? token.allowedCidrs ?? [],
                ipWhitelistEnabled: token.ipWhitelistEnabled ?? (token.allowedCidrs ?? []).length > 0,
            }));
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const createToken = async () => {
        actionLoading.value = true;
        formError.value = "";
        try {
            const cidrs = form.value.ipAllowlist
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => !!entry);
            const response = await api.post(urlsMap.tokensList, {
                name: form.value.name,
                scopes: form.value.scopes
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter((entry) => !!entry),
                ...(form.value.ipWhitelistEnabled && cidrs.length ? { allowedCidrs: cidrs } : {}),
            });
            const payload = response.data?.data ?? response.data ?? {};
            createdSecret.value = payload.token ?? payload.secret ?? null;
            createOpen.value = false;
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

    const revoke = async (token: AccessToken) => {
        try {
            await api.delete(urlsMap.tokenDetail(token.id));
            showSnackBar({ type: "success", message: t("Revoke") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const saveIps = async () => {
        if (!activeToken.value) {
            return;
        }
        actionLoading.value = true;
        formError.value = "";
        try {
            await api.put(urlsMap.tokenIps(activeToken.value.id), {
                allowedCidrs: ipList.value
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter((entry) => !!entry),
            });
            ipOpen.value = false;
            showSnackBar({ type: "success", message: t("Saved") });
            await load();
        } catch (e) {
            const message = extractApiErrorMessage(e);
            formError.value = message;
            showSnackBar({ type: "error", message });
        } finally {
            actionLoading.value = false;
        }
    };

    const headers: TableHeader<AccessToken>[] = [
        { key: "name", label: "Token Name", value: (row) => row.name },
        {
            key: "tokenPrefix",
            label: "Token Prefix",
            Value: ({ row }: { row: AccessToken }) => <MonoRef value={row.tokenPrefix} truncate={14} />,
        },
        { key: "scopes", label: "Scopes", value: (row) => (row.scopes ?? []).join(", ") },
        {
            key: "ipWhitelistEnabled",
            label: "IP Whitelist",
            Value: ({ row }: { row: AccessToken }) => (
                <StatusBadge
                    status={row.ipWhitelistEnabled ? "ON" : "OFF"}
                    label={row.ipWhitelistEnabled ? t("On") : t("Off")}
                    toneOverride={row.ipWhitelistEnabled ? "success" : "neutral"}
                />
            ),
        },
        {
            key: "ipAllowlist",
            label: "CIDR",
            Value: ({ row }: { row: AccessToken }) =>
                (row.ipAllowlist ?? []).length ? (
                    <ThemedView style={{ flexDirection: "row", gap: "4px", flexWrap: "wrap" }}>
                        {(row.ipAllowlist ?? []).map((cidr) => (
                            <MonoRef key={cidr} value={cidr} />
                        ))}
                    </ThemedView>
                ) : (
                    <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
                ),
        },
        { key: "lastUsedAt", label: "Last Used", value: (row) => row.lastUsedAt ?? t("Never") },
        { key: "expiresAt", label: "Expires", value: (row) => row.expiresAt ?? t("Never") },
        {
            key: "revokedAt",
            label: "Status",
            Value: ({ row }: { row: AccessToken }) => (
                <StatusBadge
                    status={row.revokedAt ? "INACTIVE" : "ACTIVE"}
                    label={row.revokedAt ? t("Inactive") : t("Active")}
                    toneOverride={row.revokedAt ? "neutral" : "success"}
                />
            ),
        },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: AccessToken }) => (
                <TableRowActions
                    primaryAction={{
                        label: t("IP Whitelist"),
                        icon: "mdi-shield-edit-outline",
                        onClick: () => {
                            activeToken.value = row;
                            ipList.value = (row.ipAllowlist ?? []).join(", ");
                            formError.value = "";
                            ipOpen.value = true;
                        },
                    }}
                    items={[
                        {
                            key: "revoke",
                            label: t("Revoke"),
                            icon: "mdi-key-remove",
                            danger: true,
                            disabled: !!row.revokedAt,
                            dividerBefore: true,
                            onClick: () => void revoke(row),
                        },
                    ]}
                />
            ),
        },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Developer Tokens")}
                    subtitle={t("API credentials and IP allow-lists for integrations.")}
                    end={() => (
                        <VBtn
                            variant="tonal"
                            onClick={() => {
                                form.value = { name: "", scopes: "", ipWhitelistEnabled: false, ipAllowlist: "" };
                                formError.value = "";
                                createOpen.value = true;
                            }}
                        >
                            {t("Create Token")}
                        </VBtn>
                    )}
                />

                {createdSecret.value && (
                    <SurfaceCard title={t("Secret")}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <MonoRef
                                value={createdSecret.value}
                                onCopied={() => showSnackBar({ type: "success", message: t("Copied") })}
                            />
                            <p style={{ fontSize: "12px", color: "var(--pg-ink-muted)", margin: 0 }}>
                                {t("This secret is shown once. Store it securely.")}
                            </p>
                        </div>
                    </SurfaceCard>
                )}

                {error.value ? (
                    <StateView error={error.value} onRetry={() => void load()} />
                ) : (
                    <DataTable
                        title={t("Developer Tokens")}
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
                modelValue={createOpen.value}
                onUpdate:modelValue={(v: any) => (createOpen.value = v)}
                title={t("Create Token")}
                size="md"
                loading={actionLoading.value}
                errorMessage={formError.value}
                submitLabel={t("Create Token")}
                onSubmit={() => void createToken()}
            >
                <SectionFields title={t("Details")}>
                    <FormField label={t("Token Name")} required>
                        <VTextField
                            modelValue={form.value.name}
                            onUpdate:modelValue={(v: string) => (form.value.name = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Scopes")} hint={t("Comma separated, e.g. links.create,payments.read.")}>
                        <VTextField
                            modelValue={form.value.scopes}
                            onUpdate:modelValue={(v: string) => (form.value.scopes = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("IP Whitelist")} hint={t("Comma separated CIDR ranges.")}>
                        <VTextField
                            modelValue={form.value.ipAllowlist}
                            onUpdate:modelValue={(v: string) => (form.value.ipAllowlist = v)}
                            hideDetails
                        />
                    </FormField>
                </SectionFields>
            </FormModal>

            <FormModal
                modelValue={ipOpen.value}
                onUpdate:modelValue={(v: any) => (ipOpen.value = v)}
                title={activeToken.value?.name ?? t("API token")}
                size="sm"
                loading={actionLoading.value}
                errorMessage={formError.value}
                submitLabel={t("Save")}
                onSubmit={() => void saveIps()}
            >
                <FormField label={t("CIDR")} hint={t("Comma separated CIDR ranges.")}>
                    <VTextField
                        modelValue={ipList.value}
                        onUpdate:modelValue={(v: string) => (ipList.value = v)}
                        hideDetails
                    />
                </FormField>
            </FormModal>
        </ScreenContainer>
    );
});

export default DeveloperTokensPage;
