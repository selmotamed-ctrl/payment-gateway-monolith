import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VCard, VCardText, VSelect, VSwitch, VTextField, VTextarea } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import type { WizardClientAction, WizardConfirmationChannel, WizardPollPolicy } from "./types";
import type { WizardStepProps } from "./StepIdentity";

const listToString = (list: string[]) => (list ?? []).join(", ");
const stringToList = (value: string) =>
    value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => !!entry);

const emptyAction = (): WizardClientAction => ({
    kind: "SHOW_OTP_FORM",
    name: "",
    scriptUrls: [],
    scriptSriHashes: [],
    allowedOrigins: [],
    iframeSandbox: "allow-scripts allow-forms",
    otpLength: 6,
    maxOtpAttempts: 3,
    resendCooldownSeconds: 30,
    redirectMethod: "GET",
    redirectUrl: "",
    qrPayload: "",
    payCode: "",
    instructionsAr: "",
    instructionsEn: "",
    deepLinkUrl: "",
    walletHint: "",
    destinationAccount: "",
});

const emptyChannel = (): WizardConfirmationChannel => ({
    kind: "WEBHOOK",
    name: "",
    eventMap: [],
    secretRef: "",
    ipAllowlist: [],
    mustInquire: false,
    timestampToleranceSeconds: 300,
});

const emptyPoll = (): WizardPollPolicy => ({
    name: "",
    intervalSeconds: 30,
    backoffSchedule: [30, 60, 120, 300],
    maxAttempts: 6,
    timeoutSeconds: 600,
});

export const StepClientAction = dc(
    (props: WizardStepProps) => {
        const { t } = useLocale();
        const guardError = ref<string | null>(null);

        const updateAction = (index: number, patch: Partial<WizardClientAction>) => {
            const clientActions = props.model.clientActions.map((action, actionIndex) =>
                actionIndex === index ? { ...action, ...patch } : action,
            );
            props.onChange({ ...props.model, clientActions });
        };

        const updateChannel = (index: number, patch: Partial<WizardConfirmationChannel>) => {
            const confirmationChannels = props.model.confirmationChannels.map((channel, channelIndex) =>
                channelIndex === index ? { ...channel, ...patch } : channel,
            );
            props.onChange({ ...props.model, confirmationChannels });
        };

        const updatePoll = (index: number, patch: Partial<WizardPollPolicy>) => {
            const pollPolicies = props.model.pollPolicies.map((policy, policyIndex) =>
                policyIndex === index ? { ...policy, ...patch } : policy,
            );
            props.onChange({ ...props.model, pollPolicies });
        };

        const addAction = () => {
            props.onChange({ ...props.model, clientActions: [...props.model.clientActions, emptyAction()] });
        };

        const addChannel = () => {
            props.onChange({
                ...props.model,
                confirmationChannels: [...props.model.confirmationChannels, emptyChannel()],
            });
        };

        const addPoll = () => {
            props.onChange({ ...props.model, pollPolicies: [...props.model.pollPolicies, emptyPoll()] });
        };

        const validateMustInquire = () => {
            const errors: string[] = [];
            props.model.confirmationChannels.forEach((channel, index) => {
                if (channel.kind === "BROWSER_CALLBACK" || channel.kind === "RETURN_URL") {
                    if (!channel.mustInquire) {
                        errors.push(
                            `channel ${index + 1} (${channel.kind}) is an untrusted hint and must set must_inquire = true`,
                        );
                    }
                }
                if (channel.kind === "INQUIRY_POLL" && !props.model.pollPolicies.length) {
                    errors.push(`channel ${index + 1} (INQUIRY_POLL) requires at least one poll policy`);
                }
            });
            guardError.value = errors.length ? errors.join(" · ") : null;
        };

        return () => (
            <ThemedView style={{ gap: "16px" }}>
                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedView
                            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                        >
                            <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                                {t("Client Action & Channels")}
                            </ThemedText>
                            <VBtn variant="tonal" size="small" onClick={addAction}>
                                {t("Add")}
                            </VBtn>
                        </ThemedView>

                        {props.model.clientActions.map((action, index) => (
                            <ThemedView
                                key={index}
                                style={{
                                    flexDirection: "column",
                                    gap: "10px",
                                    border: "1px solid rgba(100,116,139,0.2)",
                                    borderRadius: "12px",
                                    padding: "12px",
                                }}
                            >
                                <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                                    <VSelect
                                        items={[
                                            "SHOW_OTP_FORM",
                                            "HTTP_REDIRECT",
                                            "RENDER_EMBEDDED",
                                            "SHOW_QR_OR_CODE",
                                            "SHOW_PUSH_OR_TRANSFER",
                                        ]}
                                        modelValue={action.kind}
                                        onUpdate:modelValue={(v: any) => updateAction(index, { kind: v })}
                                        label={t("Client Action")}
                                        style={{ minWidth: "240px" }}
                                    />
                                    <VTextField
                                        label={t("Merchant Name")}
                                        modelValue={action.name}
                                        onUpdate:modelValue={(v: string) => updateAction(index, { name: v })}
                                        style={{ minWidth: "200px" }}
                                    />
                                </ThemedView>

                                {action.kind === "SHOW_OTP_FORM" && (
                                    <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                                        <VTextField
                                            label="otp_length"
                                            type="number"
                                            modelValue={action.otpLength}
                                            onUpdate:modelValue={(v: any) => updateAction(index, { otpLength: Number(v) })}
                                            style={{ minWidth: "140px" }}
                                        />
                                        <VTextField
                                            label="max_attempts"
                                            type="number"
                                            modelValue={action.maxOtpAttempts}
                                            onUpdate:modelValue={(v: any) =>
                                                updateAction(index, { maxOtpAttempts: Number(v) })
                                            }
                                            style={{ minWidth: "150px" }}
                                        />
                                        <VTextField
                                            label="resend_cooldown_seconds"
                                            type="number"
                                            modelValue={action.resendCooldownSeconds}
                                            onUpdate:modelValue={(v: any) =>
                                                updateAction(index, { resendCooldownSeconds: Number(v) })
                                            }
                                            style={{ minWidth: "220px" }}
                                        />
                                    </ThemedView>
                                )}

                                {action.kind === "HTTP_REDIRECT" && (
                                    <ThemedView style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap" }}>
                                        <VSelect
                                            items={["GET", "POST_FORM"]}
                                            modelValue={action.redirectMethod}
                                            onUpdate:modelValue={(v: any) => updateAction(index, { redirectMethod: v })}
                                            label="method"
                                            style={{ minWidth: "160px" }}
                                        />
                                        <VTextField
                                            label={t("Redirect URL")}
                                            modelValue={action.redirectUrl}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { redirectUrl: v })}
                                            style={{ minWidth: "320px" }}
                                        />
                                    </ThemedView>
                                )}

                                {action.kind === "RENDER_EMBEDDED" && (
                                    <ThemedView style={{ flexDirection: "column", gap: "10px" }}>
                                        <VTextField
                                            label="script_urls"
                                            modelValue={listToString(action.scriptUrls)}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { scriptUrls: stringToList(v) })}
                                        />
                                        <VTextField
                                            label="script_sri_hashes"
                                            modelValue={listToString(action.scriptSriHashes)}
                                            onUpdate:modelValue={(v: string) =>
                                                updateAction(index, { scriptSriHashes: stringToList(v) })
                                            }
                                        />
                                        <VTextField
                                            label="allowed_origins"
                                            modelValue={listToString(action.allowedOrigins)}
                                            onUpdate:modelValue={(v: string) =>
                                                updateAction(index, { allowedOrigins: stringToList(v) })
                                            }
                                        />
                                        <VTextField
                                            label="iframe_sandbox"
                                            modelValue={action.iframeSandbox}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { iframeSandbox: v })}
                                        />
                                    </ThemedView>
                                )}

                                {action.kind === "SHOW_QR_OR_CODE" && (
                                    <ThemedView style={{ flexDirection: "column", gap: "10px" }}>
                                        <VTextField
                                            label="qr_payload"
                                            modelValue={action.qrPayload}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { qrPayload: v })}
                                        />
                                        <VTextField
                                            label="pay_code"
                                            modelValue={action.payCode}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { payCode: v })}
                                        />
                                        <VTextField
                                            label="deep_link_url"
                                            modelValue={action.deepLinkUrl}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { deepLinkUrl: v })}
                                        />
                                        <VTextarea
                                            label="instructions_ar"
                                            modelValue={action.instructionsAr}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { instructionsAr: v })}
                                            rows={2}
                                        />
                                        <VTextarea
                                            label="instructions_en"
                                            modelValue={action.instructionsEn}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { instructionsEn: v })}
                                            rows={2}
                                        />
                                    </ThemedView>
                                )}

                                {action.kind === "SHOW_PUSH_OR_TRANSFER" && (
                                    <ThemedView style={{ flexDirection: "column", gap: "10px" }}>
                                        <VTextField
                                            label="wallet_hint"
                                            modelValue={action.walletHint}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { walletHint: v })}
                                        />
                                        <VTextField
                                            label="destination_account"
                                            modelValue={action.destinationAccount}
                                            onUpdate:modelValue={(v: string) =>
                                                updateAction(index, { destinationAccount: v })
                                            }
                                        />
                                        <VTextarea
                                            label="instructions_ar"
                                            modelValue={action.instructionsAr}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { instructionsAr: v })}
                                            rows={2}
                                        />
                                        <VTextarea
                                            label="instructions_en"
                                            modelValue={action.instructionsEn}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { instructionsEn: v })}
                                            rows={2}
                                        />
                                    </ThemedView>
                                )}
                            </ThemedView>
                        ))}
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedView
                            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                        >
                            <ThemedText type="defaultSemiBold">{t("Confirmation Channel")}</ThemedText>
                            <ThemedView style={{ flexDirection: "row", gap: "8px" }}>
                                <VBtn variant="tonal" size="small" onClick={validateMustInquire}>
                                    {t("Must Inquire")}
                                </VBtn>
                                <VBtn variant="tonal" size="small" onClick={addChannel}>
                                    {t("Add")}
                                </VBtn>
                            </ThemedView>
                        </ThemedView>

                        {guardError.value && (
                            <VAlert type="warning" variant="tonal" density="compact">
                                {guardError.value}
                            </VAlert>
                        )}

                        {props.model.confirmationChannels.map((channel, index) => (
                            <ThemedView
                                key={index}
                                style={{
                                    flexDirection: "row",
                                    gap: "12px",
                                    flexWrap: "wrap",
                                    alignItems: "center",
                                    borderBottom: "1px solid rgba(100,116,139,0.18)",
                                    paddingBottom: "10px",
                                }}
                            >
                                <VSelect
                                    items={[
                                        "SYNC_RESPONSE",
                                        "WEBHOOK",
                                        "INQUIRY_POLL",
                                        "RETURN_URL",
                                        "BROWSER_CALLBACK",
                                        "STATEMENT",
                                        "OPERATOR",
                                    ]}
                                    modelValue={channel.kind}
                                    onUpdate:modelValue={(v: any) => updateChannel(index, { kind: v })}
                                    label={t("Confirmation Channel")}
                                    style={{ minWidth: "220px" }}
                                />
                                <VTextField
                                    label={t("Merchant Name")}
                                    modelValue={channel.name}
                                    onUpdate:modelValue={(v: string) => updateChannel(index, { name: v })}
                                    style={{ minWidth: "180px" }}
                                />
                                <VTextField
                                    label="secret_ref"
                                    modelValue={channel.secretRef}
                                    onUpdate:modelValue={(v: string) => updateChannel(index, { secretRef: v })}
                                    style={{ minWidth: "180px" }}
                                />
                                <VTextField
                                    label={t("IP Whitelist")}
                                    modelValue={listToString(channel.ipAllowlist)}
                                    onUpdate:modelValue={(v: string) =>
                                        updateChannel(index, { ipAllowlist: stringToList(v) })
                                    }
                                    style={{ minWidth: "220px" }}
                                />
                                <VTextField
                                    label="timestamp_tolerance_sec"
                                    type="number"
                                    modelValue={channel.timestampToleranceSeconds}
                                    onUpdate:modelValue={(v: any) =>
                                        updateChannel(index, { timestampToleranceSeconds: Number(v) })
                                    }
                                    style={{ minWidth: "210px" }}
                                />
                                <VSwitch
                                    label={t("Must Inquire")}
                                    modelValue={channel.mustInquire}
                                    onUpdate:modelValue={(v: boolean | null) => updateChannel(index, { mustInquire: !!v })}
                                    density="compact"
                                    hideDetails
                                />
                                {channel.mustInquire && <StatusChip label={t("Must Inquire")} tone="warning" />}
                            </ThemedView>
                        ))}
                    </VCardText>
                </VCard>

                <VCard>
                    <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <ThemedView
                            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                        >
                            <ThemedText type="defaultSemiBold">{t("Poll Policy")}</ThemedText>
                            <VBtn variant="tonal" size="small" onClick={addPoll}>
                                {t("Add")}
                            </VBtn>
                        </ThemedView>

                        {props.model.pollPolicies.map((policy, index) => (
                            <ThemedView
                                key={index}
                                style={{ flexDirection: "row", gap: "12px", flexWrap: "wrap", alignItems: "center" }}
                            >
                                <VTextField
                                    label={t("Merchant Name")}
                                    modelValue={policy.name}
                                    onUpdate:modelValue={(v: string) => updatePoll(index, { name: v })}
                                    style={{ minWidth: "180px" }}
                                />
                                <VTextField
                                    label="interval_seconds"
                                    type="number"
                                    modelValue={policy.intervalSeconds}
                                    onUpdate:modelValue={(v: any) => updatePoll(index, { intervalSeconds: Number(v) })}
                                    style={{ minWidth: "180px" }}
                                />
                                <VTextField
                                    label="backoff_schedule"
                                    modelValue={(policy.backoffSchedule ?? []).join(",")}
                                    onUpdate:modelValue={(v: string) =>
                                        updatePoll(index, {
                                            backoffSchedule: v
                                                .split(",")
                                                .map((entry) => Number(entry.trim()))
                                                .filter((entry) => !Number.isNaN(entry)),
                                        })
                                    }
                                    style={{ minWidth: "220px" }}
                                />
                                <VTextField
                                    label="max_attempts"
                                    type="number"
                                    modelValue={policy.maxAttempts}
                                    onUpdate:modelValue={(v: any) => updatePoll(index, { maxAttempts: Number(v) })}
                                    style={{ minWidth: "150px" }}
                                />
                                <VTextField
                                    label="timeout_seconds"
                                    type="number"
                                    modelValue={policy.timeoutSeconds}
                                    onUpdate:modelValue={(v: any) => updatePoll(index, { timeoutSeconds: Number(v) })}
                                    style={{ minWidth: "170px" }}
                                />
                            </ThemedView>
                        ))}
                    </VCardText>
                </VCard>
            </ThemedView>
        );
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepClientAction;
