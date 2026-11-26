import { dc } from "kt-dc";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import router from "@/router";
import AuthLayout from "@/layouts/auth";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

const VerifyEmailPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const email = ref(typeof route.query.email === "string" ? route.query.email : "");
    const masked = ref(typeof route.query.masked === "string" ? route.query.masked : "");
    const code = ref("");
    const loading = ref(false);
    const error = ref<string | null>(null);
    const notice = ref<string | null>(null);
    const done = ref(false);

    const canSubmit = computed(() => email.value.includes("@") && /^\d{6}$/.test(code.value.trim()));

    const submit = async () => {
        if (!canSubmit.value || loading.value) return;
        loading.value = true;
        error.value = null;
        notice.value = null;
        try {
            await api.post(urlsMap.authEmailVerify, { email: email.value.trim(), code: code.value.trim() });
            done.value = true;
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    const resend = async () => {
        if (!email.value.includes("@") || loading.value) return;
        loading.value = true;
        error.value = null;
        try {
            await api.post(urlsMap.authEmailResend, { email: email.value.trim() });
            notice.value = t("A new verification code was sent.");
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    return () => (
        <AuthLayout>
            <SurfaceCard title={t("Verify your email")} subtitle={masked.value || email.value}>
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    {error.value && <VAlert type="error" variant="tonal" density="compact">{error.value}</VAlert>}
                    {notice.value && <VAlert type="success" variant="tonal" density="compact">{notice.value}</VAlert>}
                    {done.value ? (
                        <>
                            <VAlert type="success" variant="tonal" density="compact">
                                {t("Your email is verified. Sign in to continue.")}
                            </VAlert>
                            <VBtn block size="large" onClick={() => void router.push({ name: "Login" })}>
                                {t("Continue to sign in")}
                            </VBtn>
                        </>
                    ) : (
                        <>
                            <VAlert type="info" variant="tonal" density="compact">
                                {t("Enter the six-digit code sent to your email address.")}
                            </VAlert>
                            <FormField label={t("Email")} required>
                                <VTextField
                                    aria-label={t("Email")}
                                    type="email"
                                    autocomplete="email"
                                    modelValue={email.value}
                                    onUpdate:modelValue={(value: string) => (email.value = value)}
                                    hideDetails
                                />
                            </FormField>
                            <FormField label={t("Verification Code")} required>
                                <VTextField
                                    aria-label={t("Verification Code")}
                                    autocomplete="one-time-code"
                                    {...{ inputmode: "numeric", maxlength: "6", autofocus: true }}
                                    modelValue={code.value}
                                    onUpdate:modelValue={(value: string) => (code.value = value)}
                                    hideDetails
                                />
                            </FormField>
                            <VBtn block size="large" loading={loading.value} disabled={!canSubmit.value} onClick={() => void submit()}>
                                {t("Verify")}
                            </VBtn>
                            <VBtn variant="text" size="small" onClick={() => void resend()} loading={loading.value}>
                                {t("Resend Code")}
                            </VBtn>
                        </>
                    )}
                </div>
            </SurfaceCard>
        </AuthLayout>
    );
});

export default VerifyEmailPage;
