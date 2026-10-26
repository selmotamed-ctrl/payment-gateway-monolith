import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { useLocale } from "vuetify";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { normalizeArabicDigits } from "@/utils/arabic";
import type { OtpClientAction } from "./types";

export type OtpFormRendererProps = {
    action: OtpClientAction;
    submitting?: boolean;
    error?: string | null;
    onSubmit: (otp: string) => void;
    onResend?: () => void;
};

export const OtpFormRenderer = dc(
    (props: OtpFormRendererProps) => {
        const { t } = useLocale();
        const otp = ref("");
        const attemptsLeft = ref(props.action.max_attempts);
        const localError = ref<string | null>(null);

        const maskedTarget = computed(() => props.action.masked_phone ?? "");

        const submit = () => {
            const normalized = normalizeArabicDigits(otp.value).replace(/\s+/g, "");
            if (normalized.length !== props.action.otp_length) {
                localError.value = t("Invalid Code");
                return;
            }
            if (!/^\d+$/.test(normalized)) {
                localError.value = t("Invalid Code");
                return;
            }
            localError.value = null;
            props.onSubmit(normalized);
        };

        const resend = () => {
            if (!props.onResend) {
                return;
            }
            props.onResend();
            attemptsLeft.value = Math.max(0, attemptsLeft.value - 1);
        };

        return () => (
            <ThemedView style={{ gap: "14px", width: "100%" }}>
                <ThemedText type="defaultSemiBold" style={{ fontSize: "17px" }}>
                    {t("Enter Verification Code")}
                </ThemedText>
                {maskedTarget.value && (
                    <ThemedText style={{ fontSize: "13px", opacity: 0.75 }}>
                        {t("Enter The Code Sent To")} {maskedTarget.value}
                    </ThemedText>
                )}

                {(props.error || localError.value) && (
                    <VAlert type="error" variant="tonal" density="compact">
                        {props.error || localError.value}
                    </VAlert>
                )}

                <VTextField
                    label={t("One Time Password")}
                    modelValue={otp.value}
                    onUpdate:modelValue={(v: string) => {
                        otp.value = normalizeArabicDigits(v).replace(/\D/g, "").slice(0, props.action.otp_length);
                        localError.value = null;
                    }}
                    onKeydown={(e: any) => {
                        if (e?.key === "Enter") {
                            submit();
                        }
                    }}
                />

                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <ThemedText style={{ fontSize: "12px", opacity: 0.65 }}>
                        {t("Attempts Remaining")}: {attemptsLeft.value}
                    </ThemedText>
                    {props.onResend && (
                        <VBtn variant="text" size="small" onClick={resend}>
                            {t("Resend Code")}
                        </VBtn>
                    )}
                </ThemedView>

                <VBtn color="primary" size="large" block loading={props.submitting} onClick={submit}>
                    {t("Verify & Pay")}
                </VBtn>
            </ThemedView>
        );
    },
    {
        props: ["action", "submitting", "error", "onSubmit", "onResend"],
    },
);

export default OtpFormRenderer;
