import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VCard, VCardText, VDialog, VTextField, VTextarea } from "vuetify/components";
import QRCode from "qrcode";
import ScreenContainer from "@/components/ScreenContainer";
import { PageHeader } from "@/components/PageHeader";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import { StatusChip } from "@/components/StatusChip";
import { DataTable } from "@/components/Table/DataTable";
import type { TableHeader } from "@/components/Table/types";
import { MoneyText } from "@/components/MoneyText";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { copyToClipboard } from "@/utils/common";

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
            showSnackBar({ type: "error", message: extractApiErrorMessage(e) });
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
        { key: "linkKey", label: "Link Key", value: (row) => row.linkKey },
        { key: "description", label: "Merchant Name", value: (row) => row.description },
        {
            key: "amount",
            label: "Amount",
            Value: ({ row }: { row: PaymentLink }) => <MoneyText value={row.amount} currency={row.currency} bold />,
        },
        { key: "useCount", label: "Use Count", value: (row) => `${row.confirmedCount}/${row.useCount}` },
        {
            key: "status",
            label: "Status",
            Value: ({ row }: { row: PaymentLink }) => (
                <StatusChip label={row.status} tone={row.status === "ACTIVE" ? "success" : "warning"} />
            ),
        },
        { key: "expiresAt", label: "Expiry", value: (row) => row.expiresAt ?? "-" },
        { key: "railWhitelist", label: "Rail Whitelist", value: (row) => (row.railWhitelist?.length ? row.railWhitelist.join(", ") : t("All")) },
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
        { key: "reference", label: "Reference", value: (row) => row.reference },
        { key: "railCode", label: "Rail Code", value: (row) => row.railCode },
        { key: "status", label: "Status", value: (row) => row.status },
        {
            key: "amount",
            label: "Amount",
            Value: ({ row }: { row: Attempt }) => <MoneyText value={row.amount} currency={row.currency} />,
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
                    <VCard>
                        <VCardText>
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
                        </VCardText>
                    </VCard>
                )}
            </ThemedView>

            <VDialog modelValue={createOpen.value} onUpdate:modelValue={(v: any) => (createOpen.value = v)} maxWidth="620px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                            {t("Payment Link")}
                        </ThemedText>
                        <VTextField
                            label={t("Merchant Name")}
                            modelValue={form.value.description}
                            onUpdate:modelValue={(v: string) => (form.value.description = v)}
                        />
                        <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                            <VTextField
                                label={t("Amount")}
                                modelValue={form.value.amount}
                                onUpdate:modelValue={(v: string) => (form.value.amount = v)}
                                style={{ minWidth: "170px" }}
                            />
                            <VTextField
                                label={t("Currency")}
                                modelValue={form.value.currency}
                                onUpdate:modelValue={(v: string) => (form.value.currency = v.toUpperCase())}
                                style={{ minWidth: "130px" }}
                            />
                            <VTextField
                                label={t("Use Count")}
                                type="number"
                                modelValue={form.value.useCount}
                                onUpdate:modelValue={(v: any) => (form.value.useCount = Number(v))}
                                style={{ minWidth: "140px" }}
                            />
                            <VTextField
                                label={t("Expiry")}
                                modelValue={form.value.expiresAt}
                                onUpdate:modelValue={(v: string) => (form.value.expiresAt = v)}
                                style={{ minWidth: "200px" }}
                            />
                        </ThemedView>
                        <VTextField
                            label={t("Redirect URL")}
                            modelValue={form.value.redirectUrl}
                            onUpdate:modelValue={(v: string) => (form.value.redirectUrl = v)}
                        />
                        <VTextField
                            label={t("Rail Whitelist")}
                            modelValue={form.value.railWhitelist}
                            onUpdate:modelValue={(v: string) => (form.value.railWhitelist = v)}
                            hint="Comma separated, empty means all rails"
                            persistentHint
                        />
                        <VBtn color="primary" loading={actionLoading.value} onClick={() => void createLink()}>
                            {t("Create")}
                        </VBtn>
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog modelValue={qrOpen.value} onUpdate:modelValue={(v: any) => (qrOpen.value = v)} maxWidth="460px">
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
                        <ThemedText type="defaultSemiBold">{t("QR Code")}</ThemedText>
                        {qrDataUrl.value ? (
                            <img src={qrDataUrl.value} alt="qr" width={"280px"} height={"280px"} />
                        ) : (
                            <StateView loading={true} minHeight="200px" />
                        )}
                        <ThemedText style={{ fontSize: "12px", opacity: 0.7, direction: "ltr" }}>
                            {qrLink.value ? checkoutUrl(qrLink.value) : ""}
                        </ThemedText>
                    </VCardText>
                </VCard>
            </VDialog>

            <VDialog modelValue={attemptsOpen.value} onUpdate:modelValue={(v: any) => (attemptsOpen.value = v)} maxWidth="900px" scrollable>
                <VCard>
                    <VCardText>
                        <ThemedText type="defaultSemiBold" style={{ fontSize: "17px", marginBottom: "10px" }}>
                            {t("Attempts Inspector")}
                        </ThemedText>
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
                    </VCardText>
                </VCard>
            </VDialog>
        </ScreenContainer>
    );
});

export default LinksPage;
