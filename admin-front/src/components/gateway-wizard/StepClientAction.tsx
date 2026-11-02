import { dc } from "kt-dc";
import { ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VSelect, VSwitch, VTextField, VTextarea } from "vuetify/components";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { WizardSection } from "./WizardSection";
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

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "14px",
} as const;

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
            <SurfaceCard
                title={t("Client Action & Channels")}
                v-slots={{
                    headerActions: () => (
                        <VBtn variant="tonal" size="small" onClick={addAction}>
                            {t("Add")}
                        </VBtn>
                    ),
                }}
            >
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                    <WizardSection title={t("Client Action")}>
                        {props.model.clientActions.map((action, index) => (
                            <WizardSection
                                key={index}
                                title={action.name || `${t("Client Action")} ${index + 1}`}
                                divider={index > 0}
                                v-slots={{
                                    actions: () => (
                                        <StatusBadge status={action.kind} toneOverride="info" showDot={false} />
                                    ),
                                }}
                            >
                                <div style={gridStyle}>
                                    <FormField label={t("Client Action")}>
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
                                        />
                                    </FormField>
                                    <FormField label={t("Merchant Name")}>
                                        <VTextField
                                            modelValue={action.name}
                                            onUpdate:modelValue={(v: string) => updateAction(index, { name: v })}
                                        />
                                    </FormField>
                                </div>

                                {action.kind === "SHOW_OTP_FORM" && (
                                    <div style={gridStyle}>
                                        <FormField label="otp_length">
                                            <VTextField
                                                type="number"
                                                modelValue={action.otpLength}
                                                onUpdate:modelValue={(v: any) => updateAction(index, { otpLength: Number(v) })}
                                            />
                                        </FormField>
                                        <FormField label="max_attempts">
                                            <VTextField
                                                type="number"
                                                modelValue={action.maxOtpAttempts}
                                                onUpdate:modelValue={(v: any) =>
                                                    updateAction(index, { maxOtpAttempts: Number(v) })
                                                }
                                            />
                                        </FormField>
                                        <FormField label="resend_cooldown_seconds">
                                            <VTextField
                                                type="number"
                                                modelValue={action.resendCooldownSeconds}
                                                onUpdate:modelValue={(v: any) =>
                                                    updateAction(index, { resendCooldownSeconds: Number(v) })
                                                }
                                            />
                                        </FormField>
                                    </div>
                                )}

                                {action.kind === "HTTP_REDIRECT" && (
                                    <div style={gridStyle}>
                                        <FormField label="method">
                                            <VSelect
                                                items={["GET", "POST_FORM"]}
                                                modelValue={action.redirectMethod}
                                                onUpdate:modelValue={(v: any) => updateAction(index, { redirectMethod: v })}
                                            />
                                        </FormField>
                                        <FormField label={t("Redirect URL")}>
                                            <VTextField
                                                modelValue={action.redirectUrl}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { redirectUrl: v })}
                                            />
                                        </FormField>
                                    </div>
                                )}

                                {action.kind === "RENDER_EMBEDDED" && (
                                    <div style={gridStyle}>
                                        <FormField label="script_urls">
                                            <VTextField
                                                modelValue={listToString(action.scriptUrls)}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { scriptUrls: stringToList(v) })}
                                            />
                                        </FormField>
                                        <FormField label="script_sri_hashes">
                                            <VTextField
                                                modelValue={listToString(action.scriptSriHashes)}
                                                onUpdate:modelValue={(v: string) =>
                                                    updateAction(index, { scriptSriHashes: stringToList(v) })
                                                }
                                            />
                                        </FormField>
                                        <FormField label="allowed_origins">
                                            <VTextField
                                                modelValue={listToString(action.allowedOrigins)}
                                                onUpdate:modelValue={(v: string) =>
                                                    updateAction(index, { allowedOrigins: stringToList(v) })
                                                }
                                            />
                                        </FormField>
                                        <FormField label="iframe_sandbox">
                                            <VTextField
                                                modelValue={action.iframeSandbox}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { iframeSandbox: v })}
                                            />
                                        </FormField>
                                    </div>
                                )}

                                {action.kind === "SHOW_QR_OR_CODE" && (
                                    <div style={gridStyle}>
                                        <FormField label="qr_payload">
                                            <VTextField
                                                modelValue={action.qrPayload}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { qrPayload: v })}
                                            />
                                        </FormField>
                                        <FormField label="pay_code">
                                            <VTextField
                                                modelValue={action.payCode}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { payCode: v })}
                                            />
                                        </FormField>
                                        <FormField label="deep_link_url">
                                            <VTextField
                                                modelValue={action.deepLinkUrl}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { deepLinkUrl: v })}
                                            />
                                        </FormField>
                                        <FormField label="instructions_ar">
                                            <VTextarea
                                                modelValue={action.instructionsAr}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { instructionsAr: v })}
                                                rows={2}
                                            />
                                        </FormField>
                                        <FormField label="instructions_en">
                                            <VTextarea
                                                modelValue={action.instructionsEn}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { instructionsEn: v })}
                                                rows={2}
                                            />
                                        </FormField>
                                    </div>
                                )}

                                {action.kind === "SHOW_PUSH_OR_TRANSFER" && (
                                    <div style={gridStyle}>
                                        <FormField label="wallet_hint">
                                            <VTextField
                                                modelValue={action.walletHint}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { walletHint: v })}
                                            />
                                        </FormField>
                                        <FormField label="destination_account">
                                            <VTextField
                                                modelValue={action.destinationAccount}
                                                onUpdate:modelValue={(v: string) =>
                                                    updateAction(index, { destinationAccount: v })
                                                }
                                            />
                                        </FormField>
                                        <FormField label="instructions_ar">
                                            <VTextarea
                                                modelValue={action.instructionsAr}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { instructionsAr: v })}
                                                rows={2}
                                            />
                                        </FormField>
                                        <FormField label="instructions_en">
                                            <VTextarea
                                                modelValue={action.instructionsEn}
                                                onUpdate:modelValue={(v: string) => updateAction(index, { instructionsEn: v })}
                                                rows={2}
                                            />
                                        </FormField>
                                    </div>
                                )}
                            </WizardSection>
                        ))}
                    </WizardSection>

                    <WizardSection
                        title={t("Confirmation Channel")}
                        divider
                        v-slots={{
                            actions: () => (
                                <>
                                    <VBtn variant="tonal" size="small" onClick={validateMustInquire}>
                                        {t("Must Inquire")}
                                    </VBtn>
                                    <VBtn variant="tonal" size="small" onClick={addChannel}>
                                        {t("Add")}
                                    </VBtn>
                                </>
                            ),
                        }}
                    >
                        {guardError.value && (
                            <VAlert type="warning" variant="tonal" density="compact">
                                {guardError.value}
                            </VAlert>
                        )}

                        {props.model.confirmationChannels.map((channel, index) => (
                            <WizardSection
                                key={index}
                                title={channel.name || `${t("Confirmation Channel")} ${index + 1}`}
                                divider={index > 0}
                                v-slots={{
                                    actions: () => (
                                        <>
                                            <StatusBadge status={channel.kind} toneOverride="info" showDot={false} />
                                            {channel.mustInquire && (
                                                <StatusBadge
                                                    status="MUST_INQUIRE"
                                                    label={t("Must Inquire")}
                                                    toneOverride="warning"
                                                />
                                            )}
                                        </>
                                    ),
                                }}
                            >
                                <div style={gridStyle}>
                                    <FormField label={t("Confirmation Channel")}>
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
                                        />
                                    </FormField>
                                    <FormField label={t("Merchant Name")}>
                                        <VTextField
                                            modelValue={channel.name}
                                            onUpdate:modelValue={(v: string) => updateChannel(index, { name: v })}
                                        />
                                    </FormField>
                                    <FormField label="secret_ref" sensitiveMakerChecker>
                                        <VTextField
                                            modelValue={channel.secretRef}
                                            onUpdate:modelValue={(v: string) => updateChannel(index, { secretRef: v })}
                                        />
                                    </FormField>
                                    <FormField label={t("IP Whitelist")}>
                                        <VTextField
                                            modelValue={listToString(channel.ipAllowlist)}
                                            onUpdate:modelValue={(v: string) =>
                                                updateChannel(index, { ipAllowlist: stringToList(v) })
                                            }
                                        />
                                    </FormField>
                                    <FormField label="timestamp_tolerance_sec">
                                        <VTextField
                                            type="number"
                                            modelValue={channel.timestampToleranceSeconds}
                                            onUpdate:modelValue={(v: any) =>
                                                updateChannel(index, { timestampToleranceSeconds: Number(v) })
                                            }
                                        />
                                    </FormField>
                                    <FormField label={t("Must Inquire")}>
                                        <VSwitch
                                            modelValue={channel.mustInquire}
                                            onUpdate:modelValue={(v: boolean | null) => updateChannel(index, { mustInquire: !!v })}
                                            density="compact"
                                            hideDetails
                                        />
                                    </FormField>
                                </div>
                            </WizardSection>
                        ))}
                    </WizardSection>

                    <WizardSection
                        title={t("Poll Policy")}
                        divider
                        v-slots={{
                            actions: () => (
                                <VBtn variant="tonal" size="small" onClick={addPoll}>
                                    {t("Add")}
                                </VBtn>
                            ),
                        }}
                    >
                        {props.model.pollPolicies.map((policy, index) => (
                            <WizardSection
                                key={index}
                                title={policy.name || `${t("Poll Policy")} ${index + 1}`}
                                divider={index > 0}
                            >
                                <div style={gridStyle}>
                                    <FormField label={t("Merchant Name")}>
                                        <VTextField
                                            modelValue={policy.name}
                                            onUpdate:modelValue={(v: string) => updatePoll(index, { name: v })}
                                        />
                                    </FormField>
                                    <FormField label="interval_seconds">
                                        <VTextField
                                            type="number"
                                            modelValue={policy.intervalSeconds}
                                            onUpdate:modelValue={(v: any) => updatePoll(index, { intervalSeconds: Number(v) })}
                                        />
                                    </FormField>
                                    <FormField label="backoff_schedule">
                                        <VTextField
                                            modelValue={(policy.backoffSchedule ?? []).join(",")}
                                            onUpdate:modelValue={(v: string) =>
                                                updatePoll(index, {
                                                    backoffSchedule: v
                                                        .split(",")
                                                        .map((entry) => Number(entry.trim()))
                                                        .filter((entry) => !Number.isNaN(entry)),
                                                })
                                            }
                                        />
                                    </FormField>
                                    <FormField label="max_attempts">
                                        <VTextField
                                            type="number"
                                            modelValue={policy.maxAttempts}
                                            onUpdate:modelValue={(v: any) => updatePoll(index, { maxAttempts: Number(v) })}
                                        />
                                    </FormField>
                                    <FormField label="timeout_seconds">
                                        <VTextField
                                            type="number"
                                            modelValue={policy.timeoutSeconds}
                                            onUpdate:modelValue={(v: any) => updatePoll(index, { timeoutSeconds: Number(v) })}
                                        />
                                    </FormField>
                                </div>
                            </WizardSection>
                        ))}
                    </WizardSection>
                </SurfaceCardText>
            </SurfaceCard>
        );
    },
    {
        props: ["model", "onChange", "onSave", "saving", "error"],
    },
);

export default StepClientAction;
