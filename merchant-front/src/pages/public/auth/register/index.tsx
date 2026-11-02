import { dc } from "kt-dc";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { ref } from "vue";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { setLocale } from "@/plugins/localization";
import { RouterLink } from "vue-router";
import { normalizePhone } from "@/utils/arabic";
import AuthLayout from "@/layouts/auth";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

const RegisterPage = dc(() => {
    const { t } = useLocale();
    const fullName = ref("");
    const phone = ref("");
    const email = ref("");
    const password = ref("");
    const confirmPassword = ref("");
    const loading = ref(false);
    const error = ref<string | null>(null);
    const notice = ref<string | null>(null);

    const registerWithGoogle = async () => {
        error.value = null;
        notice.value = null;
        loading.value = true;
        try {
            const response = await api.post(urlsMap.authGoogle, { redirectUri: location.href, mode: "register" });
            const payload = response.data?.data ?? response.data ?? {};
            if (payload?.redirectUrl) {
                window.location.assign(payload.redirectUrl);
                return;
            }
            notice.value = t("Your account was created. You can sign in now.");
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    const submit = async () => {
        if (loading.value) {
            return;
        }
        error.value = null;
        notice.value = null;
        if (password.value !== confirmPassword.value) {
            error.value = t("Passwords do not match");
            return;
        }
        loading.value = true;
        try {
            const response = await api.post(urlsMap.authRegister, {
                fullName: fullName.value.trim(),
                phone: normalizePhone(phone.value, "E164"),
                email: email.value.trim(),
                password: password.value,
            });
            const payload = response.data?.data ?? response.data ?? {};
            notice.value =
                payload?.verificationRequired === false
                    ? t("Your account was created. You can sign in now.")
                    : t("A verification code was sent to your phone. You can sign in once it is confirmed.");
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    return () => (
        <AuthLayout>
            <SurfaceCard>
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <h1
                            style={{
                                margin: 0,
                                fontSize: "20px",
                                fontWeight: 600,
                                lineHeight: 1.3,
                                color: "var(--pg-ink-primary)",
                                letterSpacing: "-0.02em",
                            }}
                        >
                            {t("Create Account")}
                        </h1>
                        <p style={{ margin: 0, fontSize: "13px", color: "var(--pg-ink-muted)" }}>
                            {t("Register")}
                        </p>
                    </div>

                    {error.value && (
                        <VAlert type="error" variant="tonal" density="compact">
                            {error.value}
                        </VAlert>
                    )}
                    {notice.value && (
                        <VAlert type="success" variant="tonal" density="compact">
                            {notice.value}
                        </VAlert>
                    )}

                    <FormField label={t("Full Name")} required>
                        <VTextField
                            aria-label={t("Full Name")}
                            prependInnerIcon="mdi-account-outline"
                            autocomplete="name"
                            modelValue={fullName.value}
                            onUpdate:modelValue={(v: string) => (fullName.value = v)}
                            hideDetails
                        />
                    </FormField>

                    <FormField label={t("Phone")} required>
                        <VTextField
                            aria-label={t("Phone")}
                            prependInnerIcon="mdi-phone"
                            autocomplete="tel"
                            modelValue={phone.value}
                            onUpdate:modelValue={(v: string) => (phone.value = v)}
                            hideDetails
                        />
                    </FormField>

                    <FormField label={t("Email")} required>
                        <VTextField
                            aria-label={t("Email")}
                            prependInnerIcon="mdi-email-outline"
                            type="email"
                            autocomplete="email"
                            modelValue={email.value}
                            onUpdate:modelValue={(v: string) => (email.value = v)}
                            hideDetails
                        />
                    </FormField>

                    <FormField label={t("Password")} required>
                        <VTextField
                            aria-label={t("Password")}
                            prependInnerIcon="mdi-lock-outline"
                            type="password"
                            autocomplete="new-password"
                            modelValue={password.value}
                            onUpdate:modelValue={(v: string) => (password.value = v)}
                            hideDetails
                        />
                    </FormField>

                    <FormField label={t("Confirm Password")} required>
                        <VTextField
                            aria-label={t("Confirm Password")}
                            prependInnerIcon="mdi-lock-check-outline"
                            type="password"
                            autocomplete="new-password"
                            modelValue={confirmPassword.value}
                            onUpdate:modelValue={(v: string) => (confirmPassword.value = v)}
                            hideDetails
                        />
                    </FormField>

                    <VBtn
                        block
                        size="large"
                        loading={loading.value}
                        disabled={!fullName.value || !phone.value || !email.value || !password.value}
                        onClick={() => void submit()}
                        style={{ height: "38px" }}
                    >
                        {t("Register")}
                    </VBtn>

                    <VBtn
                        block
                        variant="tonal"
                        prependIcon="mdi-google"
                        loading={loading.value}
                        onClick={() => void registerWithGoogle()}
                        style={{ height: "38px" }}
                    >
                        {t("Login With Google")}
                    </VBtn>

                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: "8px",
                            flexWrap: "wrap",
                        }}
                    >
                        <RouterLink
                            to={{ name: "Login" }}
                            style={{
                                fontSize: "13px",
                                color: "var(--pg-accent-interactive)",
                                textDecoration: "none",
                            }}
                        >
                            {t("Already Registered")}
                        </RouterLink>
                        <div style={{ display: "flex", gap: "4px" }}>
                            <VBtn variant="text" size="small" onClick={() => setLocale("ar")}>
                                العربية
                            </VBtn>
                            <VBtn variant="text" size="small" onClick={() => setLocale("en")}>
                                English
                            </VBtn>
                        </div>
                    </div>
                </div>
            </SurfaceCard>
        </AuthLayout>
    );
});

export default RegisterPage;
