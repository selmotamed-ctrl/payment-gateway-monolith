import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VTextField } from "vuetify/components";
import QRCode from "qrcode";
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
import { copyToClipboard } from "@/utils/common";

import { FormModal } from "@/components/ui/FormModal";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import { MonoRef } from "@/components/ui/MonoRef";
type PaymentLink = {
    id: string;
    linkKey: string;
    description: string;
    amount: string;
    currency: string;
    useCount: number;
    confirmedCount: number;
    activeLockedCount: number;
    status: string;
    expiresAt: string | null;
    redirectUrl: string | null;
    railWhitelist: string[] | null;
    applicationId: string;
    createdAt: string;
};

type Attempt = {
    id: string;
    reference: string;
    railCode: string;
    status: string;
    amount: string;
    currency: string;
    otpAttempts: number;
    createdAt: string;
    updatedAt: string;
};

const LinksPage = dc(() => {
    const { t } = useLocale();
    const rows = ref<PaymentLink[]>([]);
    const loading = ref(true);
    const error = ref<string | null>(null);
    const search = ref<string | null>(null);

    const createOpen = ref(false);
    const form = ref({
        description: "",
        amount: "",
        currency: "LYD",
        useCount: 1,
        expiresAt: "",
        redirectUrl: "",
        railWhitelist: "",
    });
    const actionLoading = ref(false);
    const formError = ref("");

    const qrOpen = ref(false);
    const qrDataUrl = ref<string | null>(null);
    const qrLink = ref<PaymentLink | null>(null);

    const attemptsOpen = ref(false);
    const attempts = ref<Attempt[]>([]);
    const attemptsLoading = ref(false);

    const load = async () => {
        loading.value = true;
        error.value = null;
        try {
            const response = await api.get(urlsMap.linksList, {
                params: { search: search.value || undefined },
            });
            const payload = response.data?.data ?? response.data ?? {};
            rows.value = payload.links ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            error.value = extractApiErrorMessage(e);
            rows.value = [];
        } finally {
            loading.value = false;
        }
    };

    void load();

    const checkoutUrl = (link: PaymentLink) => `${location.origin}/pay/${link.linkKey}`;

    const createLink = async () => {
        actionLoading.value = true;
        formError.value = "";
        try {
            await api.post(urlsMap.linksList, {
                description: form.value.description,
                amount: form.value.amount,
                currency: form.value.currency.toUpperCase(),
                useCount: Number(form.value.useCount),
                expiresAt: form.value.expiresAt || undefined,
                redirectUrl: form.value.redirectUrl || undefined,
                railWhitelist: form.value.railWhitelist
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter((entry) => !!entry),
            });
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

    const showQr = async (link: PaymentLink) => {
        qrLink.value = link;
        qrDataUrl.value = null;
        qrOpen.value = true;
        try {
            qrDataUrl.value = await QRCode.toDataURL(checkoutUrl(link), {
                width: 320,
                margin: 2,
                errorCorrectionLevel: "M",
            });
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const openAttempts = async (link: PaymentLink) => {
        attemptsOpen.value = true;
        attemptsLoading.value = true;
        attempts.value = [];
        try {
            const response = await api.get(urlsMap.linkAttempts(link.id));
            const payload = response.data?.data ?? response.data ?? {};
            attempts.value = payload.attempts ?? payload.rows ?? payload.items ?? [];
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        } finally {
            attemptsLoading.value = false;
        }
    };

    const cancelLink = async (link: PaymentLink) => {
        try {
            await api.post(urlsMap.linkCancel(link.id), {});
            showSnackBar({ type: "success", message: t("Cancel") });
            await load();
        } catch (e) {
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
        }
    };

    const headers: TableHeader<PaymentLink>[] = [
        {
            key: "linkKey",
            label: "Link Key",
            Value: ({ row }: { row: PaymentLink }) => <MonoRef value={row.linkKey} truncate={18} />,
        },
        { key: "description", label: "Description", value: (row) => row.description },
        {
            key: "amount",
            label: "Amount",
            Value: ({ row }: { row: PaymentLink }) => (
                <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" />
            ),
        },
        { key: "useCount", label: "Use Count", value: (row) => `${row.confirmedCount}/${row.useCount}` },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: PaymentLink }) => (
                <StatusBadge status={row.status} toneOverride={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        { key: "expiresAt", label: "Expiry", value: (row) => row.expiresAt ?? "-" },
        {
            key: "railWhitelist",
            label: "Rail Whitelist",
            value: (row) => (row.railWhitelist?.length ? row.railWhitelist.join(", ") : t("All")),
        },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
        {
            key: "actions",
            label: "Actions Column",
            Value: ({ row }: { row: PaymentLink }) => (
                <ThemedView style={{ flexDirection: "row", gap: "6px", flexWrap: "wrap" }}>
                    <VBtn
                        size="small"
                        variant="tonal"
                        onClick={() => {
                            copyToClipboard(checkoutUrl(row));
                            showSnackBar({ type: "success", message: t("Copied") });
                        }}
                    >
                        {t("Copy")}
                    </VBtn>
                    <VBtn size="small" variant="tonal" onClick={() => void showQr(row)}>
                        {t("Generate QR")}
                    </VBtn>
                    <VBtn size="small" variant="tonal" onClick={() => void openAttempts(row)}>
                        {t("Attempts Inspector")}
                    </VBtn>
                    <VBtn
                        size="small"
                        variant="tonal"
                        color="error"
                        disabled={row.status !== "ACTIVE"}
                        onClick={() => void cancelLink(row)}
                    >
                        {t("Cancel")}
                    </VBtn>
                </ThemedView>
            ),
        },
    ];

    const attemptHeaders: TableHeader<Attempt>[] = [
        {
            key: "reference",
            label: "Reference",
            Value: ({ row }: { row: Attempt }) => <MonoRef value={row.reference} truncate={18} />,
        },
        { key: "railCode", label: "Rail Code", value: (row) => row.railCode },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: Attempt }) => <StatusBadge status={row.status} />,
        },
        {
            key: "amount",
            label: "Amount",
            Value: ({ row }: { row: Attempt }) => (
                <MoneyDisplay amount={row.amount} currency={row.currency} size="sm" />
            ),
        },
        { key: "otpAttempts", label: "Attempts", value: (row) => String(row.otpAttempts ?? 0) },
        { key: "createdAt", label: "Created At", value: (row) => row.createdAt },
        { key: "updatedAt", label: "Updated At", value: (row) => row.updatedAt },
    ];

    return () => (
        <ScreenContainer>
            <ThemedView style={{ gap: "18px" }}>
                <PageHeader
                    title={t("Payment Links")}
                    subtitle={t("Create, track, and expire customer payment links.")}
                    end={() => (
                        <VBtn
                            variant="tonal"
                            onClick={() => {
                                form.value = {
                                    description: "",
                                    amount: "",
                                    currency: "LYD",
                                    useCount: 1,
                                    expiresAt: "",
                                    redirectUrl: "",
                                    railWhitelist: "",
                                };
                                formError.value = "";
                                createOpen.value = true;
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
                        title={t("Payment Links")}
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
                title={t("Payment Link")}
                size="md"
                loading={actionLoading.value}
                errorMessage={formError.value}
                submitLabel={t("Create")}
                onSubmit={() => void createLink()}
            >
                <FormField label={t("Description")} required>
                    <VTextField
                        modelValue={form.value.description}
                        onUpdate:modelValue={(v: string) => (form.value.description = v)}
                        hideDetails
                    />
                </FormField>
                <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                    <FormField label={t("Amount")} required style={{ minWidth: "170px" }}>
                        <VTextField
                            modelValue={form.value.amount}
                            onUpdate:modelValue={(v: string) => (form.value.amount = v)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Currency")} required style={{ minWidth: "130px" }}>
                        <VTextField
                            modelValue={form.value.currency}
                            onUpdate:modelValue={(v: string) => (form.value.currency = v.toUpperCase())}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Use Count")} style={{ minWidth: "140px" }}>
                        <VTextField
                            type="number"
                            modelValue={form.value.useCount}
                            onUpdate:modelValue={(v: any) => (form.value.useCount = Number(v))}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Expiry")} style={{ minWidth: "200px" }}>
                        <VTextField
                            modelValue={form.value.expiresAt}
                            onUpdate:modelValue={(v: string) => (form.value.expiresAt = v)}
                            hideDetails
                        />
                    </FormField>
                </ThemedView>
                <FormField label={t("Redirect URL")}>
                    <VTextField
                        modelValue={form.value.redirectUrl}
                        onUpdate:modelValue={(v: string) => (form.value.redirectUrl = v)}
                        hideDetails
                    />
                </FormField>
                <FormField label={t("Rail Whitelist")} hint={t("Comma separated, empty means all rails.")}>
                    <VTextField
                        modelValue={form.value.railWhitelist}
                        onUpdate:modelValue={(v: string) => (form.value.railWhitelist = v)}
                        hideDetails
                    />
                </FormField>
            </FormModal>

            <FormModal
                modelValue={qrOpen.value}
                onUpdate:modelValue={(v: any) => (qrOpen.value = v)}
                title={t("QR Code")}
                size="sm"
            >
                {qrDataUrl.value ? (
                    <img src={qrDataUrl.value} alt="qr" width={"280px"} height={"280px"} />
                ) : (
                    <StateView loading={true} minHeight="200px" />
                )}
                {qrLink.value && <MonoRef value={checkoutUrl(qrLink.value)} />}
            </FormModal>

            <FormModal
                modelValue={attemptsOpen.value}
                onUpdate:modelValue={(v: any) => (attemptsOpen.value = v)}
                title={t("Attempts Inspector")}
                size="lg"
            >
                {attemptsLoading.value ? (
                    <StateView loading={true} />
                ) : (
                    <DataTable
                        title={t("Attempts")}
                        data={attempts.value}
                        headers={attemptHeaders}
                        loading={false}
                        showNumber={true}
                        xlsx={false}
                        noElevation={true}
                    />
                )}
            </FormModal>
        </ScreenContainer>
    );
});

export default LinksPage;
