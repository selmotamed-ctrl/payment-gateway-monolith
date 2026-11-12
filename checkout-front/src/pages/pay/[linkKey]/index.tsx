import { dc } from "kt-dc";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useLocale } from "vuetify";
import { useRoute } from "vue-router";
import { VAlert, VBtn, VIcon, VProgressCircular } from "vuetify/components";
import { ThemedText } from "@/components/ThemedText";
import { StateView } from "@/components/StateView";
import CheckoutLayout from "@/layouts/checkout";
import { RailCards } from "@/components/rail-cards";
import { RailFieldForm } from "@/components/rail-fields";
import { OtpFormRenderer } from "@/components/renderers/OtpFormRenderer";
import { RedirectRenderer, isAllowedRedirect } from "@/components/renderers/RedirectRenderer";
import { EmbeddedWidgetRenderer } from "@/components/renderers/EmbeddedWidgetRenderer";
import { QrOrCodeRenderer } from "@/components/renderers/QrOrCodeRenderer";
import { PushOrTransferRenderer } from "@/components/renderers/PushOrTransferRenderer";
import { PerRailInstructionsBanner } from "@/components/help/PerRailInstructionsBanner";
import { CheckoutHelpDrawer } from "@/components/help/CheckoutHelpDrawer";
import { SandboxCheckoutInspector } from "@/components/sandbox/SandboxCheckoutInspector";
import ThemeMenu from "@/components/ThemeMenu";
import type {
    AttemptSnapshot,
    AttemptStatus,
    ClientAction,
    InitiateResponse,
    PayLinkSummary,
    RailDescriptor,
    SandboxInspectorAccount,
} from "@/components/renderers/types";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiError } from "@/utils/errors/extractor";
import { errorKeyForCode } from "@/utils/security/errorMessages";
import {
    clearAttemptId,
    clearIdempotencyKey,
    generateIdempotencyKey,
    getOrCreateIdempotencyKey,
    loadAttemptId,
    saveAttemptId,
} from "@/utils/security/idempotency";
import { isTerminalStatus, startStatusPolling } from "@/utils/security/statusPolling";
import { buildRailFormSchema, normalizeFormValues } from "@/utils/zReady";
import { adaptedLocale } from "@/plugins/localization";

import {
    DescriptionList,
    EmptyState,
    MoneyDisplay,
    MonoRef,
    StatusBadge,
    SurfaceCard,
    type DescriptionItem,
} from "@/components/ui";
type Phase = "SUMMARY" | "FORM" | "ACTION" | "CONFIRMING" | "RECEIPT" | "ERROR";


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
    const helpOpen = ref(false);

    let stream: EventSource | null = null;
    let countdownTimer: number | null = null;
    let expiresAt: number | null = null;
    const remainingSeconds = ref<number | null>(null);

    let poller: { stop: () => void } | null = null;
    // One confirm key per distinct OTP intent; reused on retry of the same OTP.
    let confirmIntent: { otp: string; key: string } | null = null;

    // Never show raw server text: map the error code to a translated message.
    const safeError = (e: unknown): string => {
        const extracted = extractApiError(e);
        return t(errorKeyForCode(extracted?.code, extracted?.status));
    };

    const linkKey = computed(() => String(route.params.linkKey ?? ""));
    const currentLocale = computed<"ar" | "en">(() => (adaptedLocale.current.value === "ar" ? "ar" : "en"));
    const sandboxInspector = computed(() => summary.value?.sandboxInspector ?? null);
    const activeSandboxSecrets = computed(
        () => attempt.value?.sandboxInspector?.activeAttemptSecrets
            ?? summary.value?.sandboxInspector?.activeAttemptSecrets
            ?? null,
    );

    const refreshAttempt = async (): Promise<void> => {
        const attemptId = attempt.value?.attemptId;
        if (!attemptId) return;
        try {
            const response = await api.get(urlsMap.payLogs(linkKey.value, attemptId));
            applySnapshot((response.data?.data ?? response.data) as AttemptSnapshot);
        } catch {
            // The sandbox inspector refresh is best effort.
        }
    };

    const autoFillSandboxAccount = (account: SandboxInspectorAccount): void => {
        const rails = summary.value?.visibleRails ?? [];
        const rail = rails.find((entry) => entry.code === account.railCode) ?? selectedRail.value;
        if (!rail) return;
        if (selectedRail.value?.code !== rail.code) {
            clearIdempotencyKey("initiate", linkKey.value);
            clearAttemptId(linkKey.value);
            attempt.value = null;
            clientAction.value = null;
            selectedRail.value = rail;
            formValues.value = {};
            formErrors.value = {};
        }
        const fields = rail.fields ?? [];
        const target = fields.find((field) =>
            ["phone", "wallet_id"].includes(field.inputType)
            || /phone|mobile|card|pan|wallet|account|identifier/i.test(field.key),
        ) ?? fields[0];
        if (target) {
            formValues.value = { ...formValues.value, [target.key]: account.identifier };
        }
        phase.value = "FORM";
    };

    const resumeAttempt = async () => {
        const savedId = loadAttemptId(linkKey.value);
        if (!savedId) {
            return;
        }
        try {
            const response = await api.get(urlsMap.payLogs(linkKey.value, savedId));
            const snapshot = (response.data?.data ?? response.data) as AttemptSnapshot;
            if (!snapshot?.attemptId) {
                clearAttemptId(linkKey.value);
                return;
            }
            reference.value = snapshot.reference ?? null;
            phase.value = "ACTION";
            applySnapshot(snapshot);
            if (!isTerminalStatus(snapshot.status)) {
                openStream(snapshot.attemptId);
                const ca = snapshot.clientAction;
                if (ca && "expires_at" in ca) {
                    startCountdown(ca.expires_at);
                }
            }
        } catch {
            clearAttemptId(linkKey.value);
        }
    };

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
            await resumeAttempt();
        } catch (e) {
            loadError.value = safeError(e);
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

    const breakdownItems = computed<DescriptionItem[]>(() => {
        const data = summary.value;
        if (!data) {
            return [];
        }
        const items: DescriptionItem[] = [
            {
                label: t("Amount"),
                value: data.baseAmount,
                money: true,
                currency: currency.value,
            },
        ];
        if (data.feeBearerMode !== "MERCHANT_ABSORBS") {
            items.push({
                label:
                    data.feeBearerMode === "SPLIT"
                        ? `${t("Service Fee")} (${data.splitPercent ?? "0"}%)`
                        : t("Service Fee"),
                value: data.feeAmount,
                money: true,
                currency: currency.value,
            });
        }
        items.push({
            label: t("Amount Charged"),
            value: data.totalAmount,
            money: true,
            currency: currency.value,
        });
        return items;
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
        closeStream();
        if (typeof EventSource === "undefined") {
            startPolling(attemptId);
            return;
        }
        stream = new EventSource(urlsMap.payStatusStream(linkKey.value, attemptId));
        const handleFrame = (event: MessageEvent) => {
            try {
                const payload = JSON.parse(event.data);
                const snapshot = (payload.attempt ?? payload) as AttemptSnapshot;
                applySnapshot(snapshot);
            } catch {
                actionError.value = t("Something went wrong");
            }
        };
        // core emits the progress as a named `status` event, not the default
        // `message` event; handle both so the payer sees intermediate states.
        stream.addEventListener("status", handleFrame as EventListener);
        stream.onmessage = handleFrame;
        stream.onerror = () => {
            // Stream failed or closed: fall back to polling the logs endpoint (backoff, stops on terminal state).
            stream?.close();
            stream = null;
            if (!isTerminalStatus(attemptStatus.value)) {
                startPolling(attemptId);
            }
        };
    };

    const startPolling = (attemptId: string) => {
        poller?.stop();
        poller = startStatusPolling<AttemptSnapshot>({
            fetchSnapshot: async () => {
                const response = await api.get(urlsMap.payLogs(linkKey.value, attemptId));
                return (response.data?.data ?? response.data) as AttemptSnapshot;
            },
            onSnapshot: (snapshot) => applySnapshot(snapshot),
        });
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
        if (isTerminalStatus(snapshot.status)) {
            clearAttemptId(linkKey.value);
            clearIdempotencyKey("initiate", linkKey.value);
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
        // A captured payment under an AML hold is not settled until compliance
        // releases it; do not keep asking the payer to confirm.
        if (snapshot.substatus === "AML_HOLD" && !isTerminalStatus(snapshot.status)) {
            phase.value = "CONFIRMING";
        }
    };

    const closeStream = () => {
        stream?.close();
        stream = null;
        poller?.stop();
        poller = null;
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
                idempotencyKey: getOrCreateIdempotencyKey("initiate", linkKey.value),
            });
            const payload = (response.data?.data ?? response.data ?? {}) as InitiateResponse;
            saveAttemptId(linkKey.value, payload.attemptId);
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
            const status = extractApiError(e)?.status ?? 0;
            // A definitive client error means this intent is dead: the next click is a new intent.
            if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
                clearIdempotencyKey("initiate", linkKey.value);
            }
            actionError.value = safeError(e);
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
                idempotencyKey: (() => {
                    if (!confirmIntent || confirmIntent.otp !== otp) {
                        confirmIntent = { otp, key: generateIdempotencyKey() };
                    }
                    return confirmIntent.key;
                })(),
            });
            const payload = (response.data?.data ?? response.data ?? {}) as AttemptSnapshot;
            applySnapshot(payload);
            if (["VERIFYING", "UNKNOWN"].includes(payload.status)) {
                phase.value = "CONFIRMING";
            }
        } catch (e) {
            actionError.value = safeError(e);
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
            actionError.value = safeError(e);
        }
    };

    const cancelAttempt = async () => {
        if (!attempt.value) {
            return;
        }
        try {
            await api.post(urlsMap.payCancel(linkKey.value, attempt.value.attemptId), {});
            closeStream();
            // A cancelled attempt is terminal: the next click is a new intent.
            clearIdempotencyKey("initiate", linkKey.value);
            clearAttemptId(linkKey.value);
            attempt.value = null;
            clientAction.value = null;
            phase.value = "ERROR";
        } catch (e) {
            actionError.value = safeError(e);
        }
    };

    // The edge contract is `{ event, payload, idempotencyKey }` and the event
    // names are the canonical `ClientAction` events, so the widget events are
    // translated here instead of being sent verbatim.
    const CLIENT_EVENT_ALIASES: Record<string, string> = {
        ready: "widgetEvent",
        widget_ready: "widgetEvent",
        widget_ready_event: "widgetEvent",
        closed: "widgetEvent",
        widget_closed: "widgetEvent",
        complete: "completeCallback",
        completed: "completeCallback",
        complete_callback: "completeCallback",
        error: "errorCallback",
        error_callback: "errorCallback",
        cancel: "errorCallback",
        cancelled: "errorCallback",
        cancel_callback: "errorCallback",
        return: "returnHint",
        return_hint: "returnHint",
    };

    const sendClientEvent = async (event: string, data: Record<string, unknown>) => {
        if (!attempt.value) {
            return;
        }
        const normalized = event.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
        const canonical = CLIENT_EVENT_ALIASES[normalized] ?? event;
        try {
            await api.post(urlsMap.payClientEvent(linkKey.value, attempt.value.attemptId), {
                event: canonical,
                payload: data,
            });
        } catch (e) {
            actionError.value = safeError(e);
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
            return <EmptyState title={t("No Data Found")} icon="mdi-inbox-outline" />;
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
                return <EmptyState title={t("No Data Found")} icon="mdi-inbox-outline" />;
        }
    };

    const renderReference = () => {
        if (!reference.value) {
            return null;
        }
        return (
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "6px",
                    maxWidth: "100%",
                    minWidth: 0,
                }}
            >
                <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{t("Payment Reference")}</span>
                <div style={{ maxWidth: "100%", overflowX: "auto" }}>
                    <MonoRef value={reference.value} />
                </div>
            </div>
        );
    };

    return () => (
        <CheckoutLayout>
            <div
                style={{
                    width: "100%",
                    maxWidth: "560px",
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "16px",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "8px",
                        flexWrap: "wrap",
                        minWidth: 0,
                    }}
                >
                    <span
                        style={{
                            fontSize: "15px",
                            fontWeight: 600,
                            color: "var(--pg-ink-primary)",
                            minWidth: 0,
                            overflowWrap: "anywhere",
                        }}
                    >
                        {summary.value?.merchantTradeName ?? ""}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "2px", flexShrink: 0 }}>
                        <ThemeMenu />
                        <VBtn
                            icon
                            variant="text"
                            size="small"
                            aria-label={t("Help & Support")}
                            onClick={() => (helpOpen.value = true)}
                        >
                            <VIcon icon="mdi-help-circle-outline" size={18} />
                        </VBtn>
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
                </div>

                {loading.value ? (
                    <StateView loading={true} minHeight="320px" />
                ) : loadError.value ? (
                    <SurfaceCard>
                        <div style={{ display: "flex", flexDirection: "column", gap: "14px", alignItems: "center" }}>
                            <ThemedText
                                type="defaultSemiBold"
                                style={{ fontSize: "17px", color: "var(--pg-ink-primary)" }}
                            >
                                {t("This Payment Link Is No Longer Available")}
                            </ThemedText>
                            <ThemedText style={{ fontSize: "13px", color: "var(--pg-ink-muted)", textAlign: "center" }}>
                                {t("Cannot process this payment")}
                            </ThemedText>
                        </div>
                    </SurfaceCard>
                ) : (
                    <>
                        <SurfaceCard title={t("Payment Summary")}>
                            <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
                                <span
                                    style={{
                                        fontSize: "13px",
                                        color: "var(--pg-ink-secondary)",
                                        overflowWrap: "anywhere",
                                    }}
                                >
                                    {summary.value?.description ?? t("Payment Link")}
                                </span>
                                <div
                                    style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "flex-end",
                                        gap: "12px",
                                        flexWrap: "wrap",
                                    }}
                                >
                                    <span
                                        style={{
                                            fontSize: "13px",
                                            fontWeight: 500,
                                            color: "var(--pg-ink-secondary)",
                                        }}
                                    >
                                        {t("Amount Charged")}
                                    </span>
                                    <MoneyDisplay
                                        amount={summary.value?.totalAmount ?? "0"}
                                        currency={currency.value}
                                        size="xl"
                                    />
                                </div>
                                <div style={{ height: "1px", backgroundColor: "var(--pg-border-subtle)" }} />
                                <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--pg-ink-muted)" }}>
                                    {t("Amount Breakdown")}
                                </span>
                                <DescriptionList
                                    ariaLabel={t("Amount Breakdown")}
                                    items={breakdownItems.value}
                                />
                                {summary.value?.expiresAt && (
                                    <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                        {t("Expires At")}: {summary.value.expiresAt}
                                    </span>
                                )}
                            </div>
                        </SurfaceCard>

                        {phase.value === "FORM" && (
                            <SurfaceCard>
                                <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 }}>
                                    <RailCards
                                        rails={summary.value?.visibleRails ?? []}
                                        selectedCode={selectedRail.value?.code ?? null}
                                        onSelect={(rail) => {
                                            if (selectedRail.value?.code !== rail.code) {
                                                // A different rail is a different payment
                                                // intent; do not replay the old attempt.
                                                clearIdempotencyKey("initiate", linkKey.value);
                                                clearAttemptId(linkKey.value);
                                                attempt.value = null;
                                                clientAction.value = null;
                                            }
                                            selectedRail.value = rail;
                                            formValues.value = {};
                                            formErrors.value = {};
                                        }}
                                    />

                                    <PerRailInstructionsBanner
                                        rail={selectedRail.value}
                                        locale={currentLocale.value}
                                        onOpenHelp={() => (helpOpen.value = true)}
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
                                </div>
                            </SurfaceCard>
                        )}

                        {phase.value === "ACTION" && (
                            <SurfaceCard>
                                <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 }}>
                                    {remainingSeconds.value != null && (
                                        <ThemedText style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                            {t("Expires At")}: {Math.floor(remainingSeconds.value / 60)}:
                                            {String(remainingSeconds.value % 60).padStart(2, "0")}
                                        </ThemedText>
                                    )}
                                    {renderAction()}
                                </div>
                            </SurfaceCard>
                        )}

                        {phase.value === "CONFIRMING" && (
                            <SurfaceCard>
                                <div
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: "16px",
                                        alignItems: "center",
                                        minWidth: 0,
                                    }}
                                >
                                    <VProgressCircular indeterminate size={48} color="primary" width={4} />
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                        {t("Confirming your payment")}
                                    </ThemedText>
                                    <ThemedText style={{ fontSize: "13px", color: "var(--pg-ink-muted)", textAlign: "center" }}>
                                        {t("You will be redirected")}
                                    </ThemedText>
                                    <div
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            alignItems: "center",
                                            gap: "6px",
                                        }}
                                    >
                                        <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                            {t("Payment Status")}
                                        </span>
                                        <StatusBadge status={attemptStatus.value} />
                                    </div>
                                    {renderReference()}
                                    <VBtn variant="tonal" onClick={() => void cancelAttempt()}>
                                        {t("Cancel")}
                                    </VBtn>
                                </div>
                            </SurfaceCard>
                        )}

                        {phase.value === "RECEIPT" && (
                            <SurfaceCard>
                                <div
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: "14px",
                                        alignItems: "center",
                                        minWidth: 0,
                                    }}
                                >
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "19px" }}>
                                        {t("Payment Receipt")}
                                    </ThemedText>
                                    <StatusBadge status="SUCCEEDED" label={t("Payment Complete")} />
                                    <MoneyDisplay
                                        amount={summary.value?.totalAmount ?? "0"}
                                        currency={currency.value}
                                        size="xl"
                                    />
                                    {renderReference()}
                                    {summary.value?.redirectUrl && isAllowedRedirect(summary.value.redirectUrl, summary.value.allowlistedRedirectHosts) && (
                                        <VBtn
                                            color="primary"
                                            onClick={() => window.location.assign(summary.value!.redirectUrl!)}
                                        >
                                            {t("Return To Merchant")}
                                        </VBtn>
                                    )}
                                </div>
                            </SurfaceCard>
                        )}

                        {phase.value === "ERROR" && (
                            <SurfaceCard>
                                <div
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: "14px",
                                        alignItems: "center",
                                        minWidth: 0,
                                    }}
                                >
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "18px" }}>
                                        {t("Payment Failed")}
                                    </ThemedText>
                                    <ThemedText style={{ fontSize: "13px", color: "var(--pg-ink-muted)", textAlign: "center" }}>
                                        {t("Cannot process this payment")}
                                    </ThemedText>
                                    <div
                                        style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            alignItems: "center",
                                            gap: "6px",
                                        }}
                                    >
                                        <span style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                                            {t("Payment Status")}
                                        </span>
                                        <StatusBadge status={attemptStatus.value} />
                                    </div>
                                    <VBtn variant="tonal" onClick={() => (phase.value = "FORM")}>
                                        {t("Try Another Method")}
                                    </VBtn>
                                </div>
                            </SurfaceCard>
                        )}
                    </>
                )}

                {summary.value?.env === "SANDBOX" && sandboxInspector.value?.enabled ? (
                    <SandboxCheckoutInspector
                        linkKey={linkKey.value}
                        linkAmount={summary.value?.totalAmount ?? "0"}
                        selectedRailCode={selectedRail.value?.code ?? null}
                        attemptId={attempt.value?.attemptId ?? null}
                        phase={phase.value}
                        inspector={sandboxInspector.value}
                        activeSecrets={activeSandboxSecrets.value}
                        onAutoFillAccount={autoFillSandboxAccount}
                        onAutoConfirmOtp={(otp) => void confirmOtp(otp)}
                        onRefreshAttempt={() => void refreshAttempt()}
                    />
                ) : null}

                <div style={{ textAlign: "center", fontSize: "11px", color: "var(--pg-ink-faint)" }}>
                    {t("Powered By")} · {t("Payment Gateway")}
                </div>
            </div>

            <CheckoutHelpDrawer
                open={helpOpen.value}
                onClose={() => (helpOpen.value = false)}
                summary={summary.value}
                selectedRail={selectedRail.value}
                attemptStatus={attemptStatus.value}
                reference={reference.value}
                locale={currentLocale.value}
            />
        </CheckoutLayout>
    );
});

export default PayPage;
