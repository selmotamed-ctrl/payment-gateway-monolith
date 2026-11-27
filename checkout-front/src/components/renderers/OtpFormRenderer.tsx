import { dc } from "@/utils/dc";
import { computed, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import {PgButton, PgTextField} from "@pg/ui";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import {FormField} from "@pg/ui";
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
        const fieldError = computed(() => props.error || localError.value || "");
        const targetHint = computed(() =>
            maskedTarget.value ? `${t("Enter The Code Sent To")} ${maskedTarget.value}` : "",
        );

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
                <ThemedText
                    type="defaultSemiBold"
                    style={{ fontSize: "17px", color: "var(--pg-ink-primary)" }}
                >
                    {t("Enter Verification Code")}
                </ThemedText>

                <FormField
                    label={t("One Time Password")}
                    hint={targetHint.value}
                    error={fieldError.value}
                    required
                >
                    <PgTextField
                        aria-label={t("One Time Password")}
                        modelValue={otp.value}
                        error={!!fieldError.value}
                        onUpdate:modelValue={(v: string) => {
                            otp.value = normalizeArabicDigits(v).replace(/\D/g, "").slice(0, props.action.otp_length);
                            localError.value = null;
                        }}
                        onKeydown={(e: KeyboardEvent) => {
                            if (e.key === "Enter") {
                                submit();
                            }
                        }}
                    />
                </FormField>

                <ThemedView style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <ThemedText style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>
                        {t("Attempts Remaining")}: {attemptsLeft.value}
                    </ThemedText>
                    {props.onResend && (
                        <PgButton variant="text" size="small" onClick={resend}>
                            {t("Resend Code")}
                        </PgButton>
                    )}
                </ThemedView>

                <PgButton color="primary" size="large" block loading={props.submitting} onClick={submit}>
                    {t("Verify & Pay")}
                </PgButton>
            </ThemedView>
        );
    },
    {
        props: ["action", "submitting", "error", "onSubmit", "onResend"],
    },
);

export default OtpFormRenderer;
