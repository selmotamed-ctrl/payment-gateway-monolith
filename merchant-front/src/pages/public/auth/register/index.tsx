import { GOOGLE_REDIRECT_PATHS, isAllowedIdentityRedirect, parseIdentityHosts } from "@/utils/security/identityRedirect";
import { dc } from "@/utils/dc";
import {VAlert, PgButton, PgTextField} from "@pg/ui";
import { useLocale } from "@/utils/vael-compat";
import { computed, ref } from "vue";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { setLocale } from "@/plugins/localization";
import { RouterLink } from "vue-router/experimental/vapor";
import router from "@/router";
import { normalizePhone } from "@/utils/arabic";
import AuthLayout from "@/layouts/auth";
import {FormField} from "@pg/ui";
import {SurfaceCard} from "@pg/ui";
import MaintenanceScreen from "@/components/communication/MaintenanceScreen";
import { appInfo, loadAppStatus } from "@/state/app";

const RegisterPage = dc(() => {
    const { t } = useLocale();
    const fullName = ref("");
    const email = ref("");
    const password = ref("");
    const confirmPassword = ref("");
    const loading = ref(false);
    const error = ref<string | null>(null);
    const statusLoading = ref(false);

    const maintenance = computed(() => appInfo.value?.communication?.maintenance ?? null);
    const googleEnabled = computed(() => appInfo.value?.communication?.googleEnabled === true);

    const loadStatus = async () => {
        statusLoading.value = true;
        await loadAppStatus();
        statusLoading.value = false;
    };
    void loadStatus();

    const registerWithGoogle = async () => {
        error.value = null;
        loading.value = true;
        try {
            const response = await api.post(urlsMap.authGoogleStart, {
                mode: "register",
                returnPath: GOOGLE_REDIRECT_PATHS.register,
            });
            const payload = response.data?.data ?? response.data ?? {};
            const authorizationUrl = payload?.authorizationUrl ?? payload?.redirectUrl;
            if (!authorizationUrl) throw new Error("missing Google authorization URL");
            if (!isAllowedIdentityRedirect(authorizationUrl, parseIdentityHosts(import.meta.env.VITE_IDENTITY_HOSTS))) {
                throw new Error("untrusted redirect");
            }
            window.location.assign(authorizationUrl);
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    const submit = async () => {
        if (loading.value) return;
        error.value = null;
        if (password.value !== confirmPassword.value) {
            error.value = t("Passwords do not match");
            return;
        }
        loading.value = true;
        try {
            const response = await api.post(urlsMap.authRegister, {
                fullName: fullName.value.trim(),
                email: email.value.trim(),
                password: password.value,
            });
            const payload = response.data?.data ?? response.data ?? {};
            await router.push({
                name: "VerifyEmail",
                query: { email: email.value.trim().toLowerCase(), ...(payload?.emailMasked ? { masked: String(payload.emailMasked) } : {}) },
            });
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    return () => (
        <AuthLayout>
            {maintenance.value ? (
                <MaintenanceScreen maintenance={maintenance.value} loading={statusLoading.value} onRefresh={() => void loadStatus()} />
            ) : (
                <SurfaceCard title={t("Create Account")} subtitle={t("Register")}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                        {error.value && (
                            <VAlert type="error" variant="tonal" density="compact">
                                {error.value}
                            </VAlert>
                        )}

                        <FormField label={t("Full Name")} required>
                            <PgTextField
                                aria-label={t("Full Name")}
                                prependInnerIcon="mdi-account-outline"
                                autocomplete="name"
                                modelValue={fullName.value}
                                onUpdate:modelValue={(v: string) => (fullName.value = v)}
                                hideDetails
                            />
                        </FormField>

                        <FormField label={t("Email")} required>
                            <PgTextField
                                aria-label={t("Email")}
                                prependInnerIcon="mdi-email-outline"
                                type="email"
                                autocomplete="email"
                                modelValue={email.value}
                                onUpdate:modelValue={(v: string) => (email.value = v)}
                                hideDetails
                            />
                        </FormField>

                        <FormField label={t("Password")} required hint={t("At least 10 characters")}>
                            <PgTextField
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
                            <PgTextField
                                aria-label={t("Confirm Password")}
                                prependInnerIcon="mdi-lock-check-outline"
                                type="password"
                                autocomplete="new-password"
                                modelValue={confirmPassword.value}
                                onUpdate:modelValue={(v: string) => (confirmPassword.value = v)}
                                hideDetails
                            />
                        </FormField>

                        <PgButton
                            block
                            size="large"
                            loading={loading.value}
                            disabled={!fullName.value || !email.value || !password.value || !confirmPassword.value}
                            onClick={() => void submit()}
                            style={{ height: "38px" }}
                        >
                            {t("Register")}
                        </PgButton>

                        {googleEnabled.value && (
                            <PgButton
                                block
                                variant="tonal"
                                prependIcon="mdi-google"
                                loading={loading.value}
                                onClick={() => void registerWithGoogle()}
                                style={{ height: "38px" }}
                            >
                                {t("Register With Google")}
                            </PgButton>
                        )}

                        <VAlert type="info" variant="tonal" density="compact">
                            {t("We will send a six-digit verification code to your email address.")}
                        </VAlert>

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
                                <PgButton variant="text" size="small" onClick={() => setLocale("ar")}>
                                    العربية
                                </PgButton>
                                <PgButton variant="text" size="small" onClick={() => setLocale("en")}>
                                    English
                                </PgButton>
                            </div>
                        </div>
                    </div>
                </SurfaceCard>
            )}
        </AuthLayout>
    );
});

export default RegisterPage;
