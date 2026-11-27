import { dc } from "@/utils/dc";
import {PgAlert, PgButton, PgTextField} from "@pg/ui";
import { useLocale } from "@/utils/vael-compat";
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import router from "@/router";
import AuthLayout from "@/layouts/auth";
import {FormField} from "@pg/ui";
import {SurfaceCard} from "@pg/ui";

const ResetPasswordPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const email = ref(typeof route.query.email === "string" ? route.query.email : "");
    const code = ref("");
    const password = ref("");
    const confirmPassword = ref("");
    const loading = ref(false);
    const error = ref<string | null>(null);

    const canSubmit = computed(
        () =>
            email.value.includes("@") &&
            /^\d{6}$/.test(code.value.trim()) &&
            password.value.length >= 10 &&
            password.value === confirmPassword.value,
    );

    const submit = async () => {
        if (!canSubmit.value || loading.value) return;
        loading.value = true;
        error.value = null;
        try {
            await api.post(urlsMap.authPasswordReset, {
                email: email.value.trim(),
                code: code.value.trim(),
                newPassword: password.value,
            });
            await router.push({ name: "Login" });
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    return () => (
        <AuthLayout>
            <SurfaceCard title={t("Reset password")} subtitle={t("Enter the code from your email and choose a new password.")}>
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    {error.value && <PgAlert tone="danger" density="compact">{error.value}</PgAlert>}
                    <FormField label={t("Email")} required>
                        <PgTextField
                            aria-label={t("Email")}
                            type="email"
                            autocomplete="email"
                            modelValue={email.value}
                            onUpdate:modelValue={(value: string) => (email.value = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Verification Code")} required>
                        <PgTextField
                            aria-label={t("Verification Code")}
                            autocomplete="one-time-code"
                            {...{ inputmode: "numeric", maxlength: "6" }}
                            modelValue={code.value}
                            onUpdate:modelValue={(value: string) => (code.value = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("New password")} required hint={t("At least 10 characters")}>
                        <PgTextField
                            aria-label={t("New password")}
                            type="password"
                            autocomplete="new-password"
                            modelValue={password.value}
                            onUpdate:modelValue={(value: string) => (password.value = value)}
                            hideDetails
                        />
                    </FormField>
                    <FormField label={t("Confirm Password")} required>
                        <PgTextField
                            aria-label={t("Confirm Password")}
                            type="password"
                            autocomplete="new-password"
                            modelValue={confirmPassword.value}
                            onUpdate:modelValue={(value: string) => (confirmPassword.value = value)}
                            hideDetails
                        />
                    </FormField>
                    <PgButton block variant="primary" size="large" loading={loading.value} disabled={!canSubmit.value} onClick={() => void submit()}>
                        {t("Reset password")}
                    </PgButton>
                    <PgButton variant="text" onClick={() => void router.push({ name: "Login" })}>
                        {t("Back to sign in")}
                    </PgButton>
                </div>
            </SurfaceCard>
        </AuthLayout>
    );
});

export default ResetPasswordPage;
