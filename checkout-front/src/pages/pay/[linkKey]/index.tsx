import { dc } from "kt-dc";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VAlert, VBtn, VCard, VCardText, VDivider, VProgressCircular } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import CheckoutLayout from "@/layouts/checkout";
import { StatusChip } from "@/components/StatusChip";
import { MoneyText } from "@/components/MoneyText";
import { RailCards } from "@/components/rail-cards";
import { RailFieldForm } from "@/components/rail-fields";
import { OtpFormRenderer } from "@/components/renderers/OtpFormRenderer";
import { RedirectRenderer, isAllowedRedirect } from "@/components/renderers/RedirectRenderer";
import { EmbeddedWidgetRenderer } from "@/components/renderers/EmbeddedWidgetRenderer";
import { QrOrCodeRenderer } from "@/components/renderers/QrOrCodeRenderer";
import { PushOrTransferRenderer } from "@/components/renderers/PushOrTransferRenderer";
import type {
    AttemptSnapshot,
    AttemptStatus,
    ClientAction,
    InitiateResponse,
    PayLinkSummary,
    RailDescriptor,
} from "@/components/renderers/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { buildRailFormSchema, normalizeFormValues } from "@/utils/zReady";
import { adaptedLocale } from "@/plugins/localization";

type Phase = "SUMMARY" | "FORM" | "ACTION" | "CONFIRMING" | "RECEIPT" | "ERROR";

const newIdempotencyKey = () =>
    `chk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const PayPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();

    const summary = ref<PayLinkSummary | null>(null);
    const loading = ref(true);
    const loadError = ref<string | null>(null);

    const phase = ref<Phase>("SUMMARY");
    const selectedRail = ref<RailDescriptor | null>(null);
    const formValues = ref<Record<string, string>>({});
    const formErrors = ref<Record<string, string>>({});
    const actionError = ref<string | null>(null);
    const submitting = ref(false);

    const attempt = ref<AttemptSnapshot | null>(null);
    const clientAction = ref<ClientAction | null>(null);
    const attemptStatus = ref<AttemptStatus>("CREATED");
    const reference = ref<string | null>(null);

    let stream: EventSource | null = null;
    let countdownTimer: number | null = null;
    let expiresAt: number | null = null;
    const remainingSeconds = ref<number | null>(null);

    const linkKey = computed(() => String(route.params.linkKey ?? ""));

    const loadSummary = async () => {
        loading.value = true;
        loadError.value = null;
        try {
            const response = await api.get(urlsMap.payLink(linkKey.value));
            const payload = response.data?.data ?? response.data ?? {};
            summary.value = payload.summary ?? payload;
            const rails = summary.value?.visibleRails ?? [];
            if (rails.length) {
                selectedRail.value = rails[0]!;
            }
            phase.value = "FORM";
        } catch (e) {
            loadError.value = extractApiErrorMessage(e);
            phase.value = "ERROR";
        } finally {
            loading.value = false;
        }
    };

    void loadSummary();

    watch(linkKey, () => {
        void loadSummary();
    });

    const currency = computed(() => summary.value?.currency ?? "LYD");

    const feeRows = computed(() => {
        const data = summary.value;
        if (!data) {
            return [];
        }
        const rows: { label: string; value: string; emphasis?: boolean }[] = [
            { label: t("Amount"), value: data.baseAmount },
        ];
        if (data.feeBearerMode !== "MERCHANT_ABSORBS") {
            rows.push({
                label:
                    data.feeBearerMode === "SPLIT"
                        ? `${t("Service Fee")} (${data.splitPercent ?? "0"}%)`
                        : t("Service Fee"),
                value: data.feeAmount,
            });
        }
        rows.push({ label: t("Amount Charged"), value: data.totalAmount, emphasis: true });
        return rows;
    });

    const validate = (): boolean => {
        const rail = selectedRail.value;
        if (!rail) {
            return false;
        }
        const normalized = normalizeFormValues(rail.fields ?? [], formValues.value);
        const schema = buildRailFormSchema(rail.fields ?? []);
        const result = schema.safeParse(normalized);
        if (result.success) {
            formValues.value = normalized;
            formErrors.value = {};
            return true;
        }
        const errors: Record<string, string> = {};
        for (const issue of result.error.issues) {
            const key = String(issue.path[0] ?? "");
            if (key && !errors[key]) {
                errors[key] = issue.message;
            }
        }
        formErrors.value = errors;
        return false;
    };

    const openStream = (attemptId: string) => {
        stream?.close();
        if (typeof EventSource === "undefined") {
            return;
        }
        stream = new EventSource(urlsMap.payStatusStream(linkKey.value, attemptId));
        stream.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                const snapshot = (payload.attempt ?? payload) as AttemptSnapshot;
                applySnapshot(snapshot);
            } catch {
                actionError.value = t("Something went wrong");
            }
        };
        stream.onerror = () => {
            stream?.close();
            stream = null;
        };
    };

    const applySnapshot = (snapshot: AttemptSnapshot) => {
        attempt.value = snapshot;
        attemptStatus.value = snapshot.status;
        if (snapshot.clientAction) {
            clientAction.value = snapshot.clientAction;
        }
        if (snapshot.reference) {
            reference.value = snapshot.reference;
        }
        if (snapshot.status === "SUCCEEDED") {
            phase.value = "RECEIPT";
            closeStream();
            return;
        }
        if (["FAILED", "EXPIRED", "CANCELLED", "BLOCKED"].includes(snapshot.status)) {
            phase.value = "ERROR";
            closeStream();
            return;
        }
        if (["VERIFYING", "UNKNOWN", "AUTHORIZING"].includes(snapshot.status)) {
            phase.value = "CONFIRMING";
        }
    };

    const closeStream = () => {
        stream?.close();
        stream = null;
    };

    const startCountdown = (isoDate?: string | null) => {
        if (countdownTimer !== null) {
            window.clearInterval(countdownTimer);
            countdownTimer = null;
        }
        if (!isoDate) {
            remainingSeconds.value = null;
            return;
        }
        expiresAt = new Date(isoDate).getTime();
        const tick = () => {
            if (expiresAt === null) {
                return;
            }
            remainingSeconds.value = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
        };
        tick();
        countdownTimer = window.setInterval(tick, 1000);
    };

    const initiate = async () => {
        const rail = selectedRail.value;
        if (!rail || submitting.value) {
            return;
        }
        if (!validate()) {
            return;
        }
        submitting.value = true;
        actionError.value = null;
        try {
            const response = await api.post(urlsMap.payInitiate(linkKey.value), {
                railCode: rail.code,
                formData: formValues.value,
                idempotencyKey: newIdempotencyKey(),
            });
            const payload = (response.data?.data ?? response.data ?? {}) as InitiateResponse;
            reference.value = payload.reference ?? null;
            attemptStatus.value = payload.status ?? "CREATED";
            clientAction.value = payload.clientAction ?? null;
            attempt.value = {
                attemptId: payload.attemptId,
                reference: payload.reference,
                status: payload.status,
                clientAction: payload.clientAction,
            };
            phase.value = "ACTION";
            openStream(payload.attemptId);
            if (payload.clientAction && "expires_at" in payload.clientAction) {
                startCountdown(payload.clientAction.expires_at);
            }
        } catch (e) {
            actionError.value = extractApiErrorMessage(e);
        } finally {
            submitting.value = false;
        }
    };

    const confirmOtp = async (otp: string) => {
        if (!attempt.value) {
            return;
        }
        submitting.value = true;
        actionError.value = null;
        try {
            const response = await api.post(urlsMap.payConfirm(linkKey.value, attempt.value.attemptId), {
                otp,
                idempotencyKey: newIdempotencyKey(),
            });
            const payload = (response.data?.data ?? response.data ?? {}) as AttemptSnapshot;
            applySnapshot(payload);
            if (["VERIFYING", "UNKNOWN"].includes(payload.status)) {
                phase.value = "CONFIRMING";
            }
        } catch (e) {
            actionError.value = extractApiErrorMessage(e);
        } finally {
            submitting.value = false;
        }
    };

    const resendOtp = async () => {
        if (!attempt.value) {
            return;
        }
        try {
            await api.post(urlsMap.payResend(linkKey.value, attempt.value.attemptId), {});
            showNotice(t("Resend Code"));
        } catch (e) {
            actionError.value = extractApiErrorMessage(e);
        }
    };

    const cancelAttempt = async () => {
        if (!attempt.value) {
            return;
        }
        try {
            await api.post(urlsMap.payCancel(linkKey.value, attempt.value.attemptId), {});
            closeStream();
            phase.value = "ERROR";
        } catch (e) {
            actionError.value = extractApiErrorMessage(e);
        }
    };

    const sendClientEvent = async (event: string, data: Record<string, unknown>) => {
        if (!attempt.value) {
            return;
        }
        try {
            await api.post(urlsMap.payClientEvent(linkKey.value, attempt.value.attemptId), { event, data });
        } catch (e) {
            actionError.value = extractApiErrorMessage(e);
        }
    };

    const showNotice = (message: string) => {
        actionError.value = null;
        void message;
    };

    onBeforeUnmount(() => {
        closeStream();
        if (countdownTimer !== null) {
            window.clearInterval(countdownTimer);
            countdownTimer = null;
        }
    });

    const renderAction = () => {
        const action = clientAction.value;
        if (!action) {
            return <StateView empty={true} emptyTitle={t("No Data Found")} />;
        }
        switch (action.kind) {
            case "SHOW_OTP_FORM":
                return (
                    <OtpFormRenderer
                        action={action}
                        submitting={submitting.value}
                        error={actionError.value}
                        onSubmit={(otp: string) => void confirmOtp(otp)}
                        onResend={() => void resendOtp()}
                    />
                );
            case "HTTP_REDIRECT":
                return (
                    <RedirectRenderer
                        action={action}
                        allowlistedHosts={summary.value?.allowlistedRedirectHosts ?? []}
                        error={actionError.value}
                    />
                );
            case "RENDER_EMBEDDED":
                return (
                    <EmbeddedWidgetRenderer
                        action={action}
                        error={actionError.value}
                        onReady={() => void sendClientEvent("ready", {})}
                        onCallback={(payload) => void sendClientEvent(payload.event, payload.data)}
                        onError={(message) => (actionError.value = message)}
                    />
                );
            case "SHOW_QR_OR_CODE":
                return <QrOrCodeRenderer action={action} error={actionError.value} />;
            case "SHOW_PUSH_OR_TRANSFER":
                return (
                    <PushOrTransferRenderer
                        action={action}
                        error={actionError.value}
                        onCancel={() => void cancelAttempt()}
                    />
                );
            default:
                return <StateView empty={true} emptyTitle={t("No Data Found")} />;
        }
    };

    return () => (
        <CheckoutLayout>
            <div style={{ width: "100%", maxWidth: "560px", display: "flex", flexDirection: "column", gap: "16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "15px", fontWeight: "800" }}>{summary.value?.merchantTradeName ?? ""}</span>
                    <VBtn
                        variant="text"
                        size="small"
                        onClick={() => {
                            const next = adaptedLocale.current.value === "ar" ? "en" : "ar";
                            localStorage.setItem("locale-name", next);
                            location.reload();
                        }}
                    >
                        {adaptedLocale.current.value === "ar" ? "English" : "العربية"}
                    </VBtn>
                </div>

                {loading.value ? (
                    <StateView loading={true} minHeight="320px" />
                ) : loadError.value ? (
                    <VCard>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px", alignItems: "center" }}>
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                {t("This Payment Link Is No Longer Available")}
                            </ThemedText>
                            <ThemedText style={{ fontSize: "13px", opacity: 0.7, textAlign: "center" }}>
                                {t("Cannot process this payment")}
                            </ThemedText>
                        </VCardText>
                    </VCard>
                ) : (
                    <>
                        <VCard>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <ThemedText style={{ fontSize: "13px", opacity: 0.7 }}>
                                    {summary.value?.description ?? t("Payment Link")}
                                </ThemedText>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "22px" }}>
                                        {t("Amount Charged")}
                                    </ThemedText>
                                    <MoneyText value={summary.value?.totalAmount ?? "0"} currency={currency.value} bold />
                                </div>
                                <VDivider />
                                {feeRows.value.map((row) => (
                                    <div
                                        key={row.label}
                                        style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}
                                    >
                                        <ThemedText style={{ fontSize: "13px", opacity: row.emphasis ? 1 : 0.75 }}>
                                            {row.label}
                                        </ThemedText>
                                        <MoneyText
                                            value={row.value}
                                            currency={currency.value}
                                            bold={!!row.emphasis}
                                            color={row.emphasis ? "#0f6bff" : undefined}
                                        />
                                    </div>
                                ))}
                                {summary.value?.expiresAt && (
                                    <ThemedText style={{ fontSize: "12px", opacity: 0.6 }}>
                                        {t("Expires At")}: {summary.value.expiresAt}
                                    </ThemedText>
                                )}
                            </VCardText>
                        </VCard>

                        {phase.value === "FORM" && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                                    <RailCards
                                        rails={summary.value?.visibleRails ?? []}
                                        selectedCode={selectedRail.value?.code ?? null}
                                        onSelect={(rail) => {
                                            selectedRail.value = rail;
                                            formValues.value = {};
                                            formErrors.value = {};
                                        }}
                                    />

                                    {selectedRail.value && (
                                        <RailFieldForm
                                            fields={selectedRail.value.fields ?? []}
                                            values={formValues.value}
                                            errors={formErrors.value}
                                            onChange={(key, value) => {
                                                formValues.value = { ...formValues.value, [key]: value };
                                                if (formErrors.value[key]) {
                                                    const next = { ...formErrors.value };
                                                    delete next[key];
                                                    formErrors.value = next;
                                                }
                                            }}
                                        />
                                    )}

                                    {actionError.value && (
                                        <VAlert type="error" variant="tonal" density="compact">
                                            {actionError.value}
                                        </VAlert>
                                    )}

                                    <VBtn
                                        color="primary"
                                        size="large"
                                        block
                                        loading={submitting.value}
                                        disabled={!selectedRail.value}
                                        onClick={() => void initiate()}
                                    >
                                        {t("Pay Now")}
                                    </VBtn>
                                </VCardText>
                            </VCard>
                        )}

                        {phase.value === "ACTION" && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                                    {remainingSeconds.value != null && (
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                                            {t("Expires At")}: {Math.floor(remainingSeconds.value / 60)}:
                                            {String(remainingSeconds.value % 60).padStart(2, "0")}
                                        </ThemedText>
                                    )}
                                    {renderAction()}
                                </VCardText>
                            </VCard>
                        )}

                        {phase.value === "CONFIRMING" && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px", alignItems: "center" }}>
                                    <VProgressCircular indeterminate size={"48px"} color="primary" width={4} />
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                        {t("Confirming your payment")}
                                    </ThemedText>
                                    <ThemedText style={{ fontSize: "13px", opacity: 0.7, textAlign: "center" }}>
                                        {t("You will be redirected")}
                                    </ThemedText>
                                    <StatusChip label={attemptStatus.value} tone="warning" />
                                    {reference.value && (
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.6, direction: "ltr" }}>
                                            {reference.value}
                                        </ThemedText>
                                    )}
                                    <VBtn variant="tonal" onClick={() => void cancelAttempt()}>
                                        {t("Cancel")}
                                    </VBtn>
                                </VCardText>
                            </VCard>
                        )}

                        {phase.value === "RECEIPT" && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px", alignItems: "center" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>
                                        {t("Payment Receipt")}
                                    </ThemedText>
                                    <StatusChip label={t("Payment Complete")} tone="success" />
                                    <MoneyText value={summary.value?.totalAmount ?? "0"} currency={currency.value} bold />
                                    {reference.value && (
                                        <ThemedText style={{ fontSize: "12px", opacity: 0.65, direction: "ltr" }}>
                                            {reference.value}
                                        </ThemedText>
                                    )}
                                    {summary.value?.redirectUrl && isAllowedRedirect(summary.value.redirectUrl, summary.value.allowlistedRedirectHosts) && (
                                        <VBtn
                                            color="primary"
                                            onClick={() => window.location.assign(summary.value!.redirectUrl!)}
                                        >
                                            {t("Return To Merchant")}
                                        </VBtn>
                                    )}
                                </VCardText>
                            </VCard>
                        )}

                        {phase.value === "ERROR" && (
                            <VCard>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px", alignItems: "center" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                        {t("Payment Failed")}
                                    </ThemedText>
                                    <ThemedText style={{ fontSize: "13px", opacity: 0.75, textAlign: "center" }}>
                                        {t("Cannot process this payment")}
                                    </ThemedText>
                                    <StatusChip label={attemptStatus.value} tone="error" />
                                    <VBtn variant="tonal" onClick={() => (phase.value = "FORM")}>
                                        {t("Try Another Method")}
                                    </VBtn>
                                </VCardText>
                            </VCard>
                        )}
                    </>
                )}

                <div style={{ textAlign: "center", fontSize: "11px", opacity: 0.55 }}>
                    {t("Powered By")} · {t("Payment Gateway")}
                </div>
            </div>
        </CheckoutLayout>
    );
});

export default PayPage;
