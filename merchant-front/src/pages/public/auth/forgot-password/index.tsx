import { dc } from "@/utils/dc";
import { VAlert, VBtn, VTextField } from "@/components/vael/VuetifyShim";
import { useLocale } from "@/utils/vael-compat";
import { ref } from "vue";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import router from "@/router";
import AuthLayout from "@/layouts/auth";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

const ForgotPasswordPage = dc(() => {
    const { t } = useLocale();
    const email = ref("");
    const loading = ref(false);
    const error = ref<string | null>(null);

    const submit = async () => {
        if (loading.value || !email.value.includes("@")) return;
        loading.value = true;
        error.value = null;
        try {
            await api.post(urlsMap.authPasswordForgot, { email: email.value.trim() });
            await router.push({ name: "ResetPassword", query: { email: email.value.trim().toLowerCase() } });
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    return () => (
        <AuthLayout>
            <SurfaceCard title={t("Forgot password?")} subtitle={t("We will email you a six-digit reset code.")}>
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    {error.value && <VAlert type="error" variant="tonal" density="compact">{error.value}</VAlert>}
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
                    <VBtn block size="large" loading={loading.value} disabled={!email.value.includes("@")} onClick={() => void submit()}>
                        {t("Send reset code")}
                    </VBtn>
                    <VBtn variant="text" onClick={() => void router.push({ name: "Login" })}>
                        {t("Back to sign in")}
                    </VBtn>
                </div>
            </SurfaceCard>
        </AuthLayout>
    );
});

export default ForgotPasswordPage;
