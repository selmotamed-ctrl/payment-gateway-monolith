import { GOOGLE_REDIRECT_PATHS, isAllowedIdentityRedirect, parseIdentityHosts } from "@/utils/security/identityRedirect";
import { dc } from "kt-dc";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { computed, ref } from "vue";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { setUserState, type UserState } from "@/state/user";
import { tokenFromLoginPayload } from "@/utils/security/sessionToken";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { setLocale } from "@/plugins/localization";
import router from "@/router";
import { RouterLink, useRoute } from "vue-router";
import AuthLayout from "@/layouts/auth";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import MaintenanceScreen from "@/components/communication/MaintenanceScreen";
import { appInfo, loadAppStatus } from "@/state/app";

const LoginPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const identity = ref("");
    const password = ref("");
    const mfaCode = ref("");
    const challengeId = ref<string | null>(null);
    const deliveryChannels = ref<string[]>([]);
    const loading = ref(false);
    const error = ref<string | null>(null);
    const notice = ref<string | null>(null);
    if (typeof route.query.error === "string") {
        error.value = t("Google sign-in failed. Please try again or use your email and password.");
    }
    const showPassword = ref(false);
    const statusLoading = ref(false);

    const maintenance = computed(() => appInfo.value?.communication?.maintenance ?? null);
    const googleEnabled = computed(() => appInfo.value?.communication?.googleEnabled === true);

    const loadStatus = async () => {
        statusLoading.value = true;
        await loadAppStatus();
        statusLoading.value = false;
    };
    void loadStatus();

    const buildSession = (payload: any): UserState => ({
        token: tokenFromLoginPayload(payload) as string,
        refreshToken: payload?.refreshToken ?? null,
        userInfo: {
            id: String(payload?.userInfo?.id ?? payload?.user?.id ?? ""),
            name: payload?.userInfo?.name ?? payload?.user?.name ?? "",
            username: payload?.userInfo?.username ?? payload?.user?.username ?? "",
            role: payload?.userInfo?.role ?? payload?.user?.role ?? "",
            email: payload?.userInfo?.email ?? null,
            phone: payload?.userInfo?.phone ?? null,
            merchantId: String(payload?.userInfo?.merchantId ?? payload?.merchant?.id ?? ""),
            merchantTradeName:
                payload?.userInfo?.merchantTradeName ?? payload?.merchant?.tradeName ?? "",
            authoritiesMap: payload?.userInfo?.authoritiesMap ?? payload?.authoritiesMap ?? {},
            appScopeIds: payload?.userInfo?.appScopeIds ?? [],
            isMaker: !!payload?.userInfo?.isMaker,
            isChecker: !!payload?.userInfo?.isChecker,
        },
    });

    const loginWithGoogle = async () => {
        error.value = null;
        loading.value = true;
        try {
            const response = await api.post(urlsMap.authGoogleStart, {
                mode: "login",
                returnPath: GOOGLE_REDIRECT_PATHS.login,
            });
            const payload = response.data?.data ?? response.data ?? {};
            const authorizationUrl = payload?.authorizationUrl ?? payload?.redirectUrl;
            if (!authorizationUrl) {
                throw new Error("missing Google authorization URL");
            }
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

    const applySession = async (payload: any) => {
        const session = buildSession(payload);
        if (!session.token) {
            throw new Error("missing token");
        }
        setUserState(session);
        await router.push({ name: "Dashboard" });
    };

    const submit = async () => {
        if (loading.value) return;
        error.value = null;
        notice.value = null;
        loading.value = true;
        try {
            if (challengeId.value) {
                const response = await api.post(urlsMap.authMfaVerify, {
                    challengeId: challengeId.value,
                    code: mfaCode.value.trim(),
                });
                await applySession(response.data?.data ?? response.data ?? {});
                return;
            }
            const response = await api.post(urlsMap.authLogin, {
                identifier: identity.value.trim(),
                password: password.value,
            });
            const payload = response.data?.data ?? response.data ?? {};
            if (payload?.mfaRequired && payload?.challengeId) {
                challengeId.value = String(payload.challengeId);
                deliveryChannels.value = Array.isArray(payload.deliveryChannels) ? payload.deliveryChannels.map(String) : [];
                return;
            }
            await applySession(payload);
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    const resend = async () => {
        if (!challengeId.value || loading.value) return;
        error.value = null;
        notice.value = null;
        loading.value = true;
        try {
            const response = await api.post(urlsMap.authMfaResend, { challengeId: challengeId.value });
            const payload = response.data?.data ?? response.data ?? {};
            if (payload?.challengeId) challengeId.value = String(payload.challengeId);
            deliveryChannels.value = Array.isArray(payload.deliveryChannels) ? payload.deliveryChannels.map(String) : deliveryChannels.value;
            notice.value = t("A new code was sent.");
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    const mfaMessage = computed(() => {
        const email = deliveryChannels.value.includes("EMAIL");
        const sms = deliveryChannels.value.includes("SMS");
        if (email && sms) return t("Enter the six-digit code sent to your email and phone.");
        if (sms) return t("Enter the six-digit code sent to your phone.");
        return t("Enter the six-digit code sent to your email.");
    });

    return () => (
        <AuthLayout>
            {maintenance.value ? (
                <MaintenanceScreen maintenance={maintenance.value} loading={statusLoading.value} onRefresh={() => void loadStatus()} />
            ) : (
                <SurfaceCard title={t("Merchant Portal")} subtitle={t("Sign in to continue")}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
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

                        {challengeId.value ? (
                            <>
                                <VAlert type="info" variant="tonal" density="compact">
                                    {mfaMessage.value}
                                </VAlert>
                                <FormField label={t("Verification Code")} required>
                                    <VTextField
                                        aria-label={t("Verification Code")}
                                        prependInnerIcon="mdi-shield-key-outline"
                                        autocomplete="one-time-code"
                                        {...{ inputmode: "numeric", maxlength: "6", autofocus: true }}
                                        modelValue={mfaCode.value}
                                        onUpdate:modelValue={(v: string) => (mfaCode.value = v)}
                                        hideDetails
                                    />
                                </FormField>
                                <VBtn
                                    block
                                    size="large"
                                    loading={loading.value}
                                    disabled={mfaCode.value.trim().length !== 6}
                                    onClick={() => void submit()}
                                    style={{ height: "38px" }}
                                >
                                    {t("Verify")}
                                </VBtn>
                                <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                                    <VBtn variant="text" size="small" onClick={() => void resend()}>
                                        {t("Resend Code")}
                                    </VBtn>
                                    <VBtn
                                        variant="text"
                                        size="small"
                                        onClick={() => {
                                            challengeId.value = null;
                                            mfaCode.value = "";
                                            deliveryChannels.value = [];
                                            error.value = null;
                                        }}
                                    >
                                        {t("Back")}
                                    </VBtn>
                                </div>
                            </>
                        ) : (
                            <>
                                <FormField label={t("Email")} required>
                                    <VTextField
                                        aria-label={t("Email")}
                                        prependInnerIcon="mdi-account-outline"
                                        autocomplete="username"
                                        {...{ autofocus: true }}
                                        modelValue={identity.value}
                                        onUpdate:modelValue={(v: string) => (identity.value = v)}
                                        hideDetails
                                    />
                                </FormField>

                                <FormField label={t("Password")} required>
                                    <VTextField
                                        aria-label={t("Password")}
                                        prependInnerIcon="mdi-lock-outline"
                                        type={showPassword.value ? "text" : "password"}
                                        autocomplete="current-password"
                                        modelValue={password.value}
                                        onUpdate:modelValue={(v: string) => (password.value = v)}
                                        appendInnerIcon={showPassword.value ? "mdi-eye-off-outline" : "mdi-eye-outline"}
                                        onClick:append-inner={() => (showPassword.value = !showPassword.value)}
                                        hideDetails
                                    />
                                </FormField>

                                <VBtn
                                    block
                                    size="large"
                                    loading={loading.value}
                                    disabled={!identity.value || !password.value}
                                    onClick={() => void submit()}
                                    style={{ height: "38px" }}
                                >
                                    {t("Login")}
                                </VBtn>

                                {googleEnabled.value && (
                                    <VBtn
                                        block
                                        variant="tonal"
                                        prependIcon="mdi-google"
                                        loading={loading.value}
                                        onClick={() => void loginWithGoogle()}
                                        style={{ height: "38px" }}
                                    >
                                        {t("Login With Google")}
                                    </VBtn>
                                )}
                            </>
                        )}

                        <div
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: "8px",
                                flexWrap: "wrap",
                            }}
                        >
                            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                                <RouterLink to={{ name: "Register" }} style={{ fontSize: "13px", color: "var(--pg-accent-interactive)", textDecoration: "none" }}>
                                    {t("Create Account")}
                                </RouterLink>
                                <RouterLink to={{ name: "ForgotPassword" }} style={{ fontSize: "13px", color: "var(--pg-accent-interactive)", textDecoration: "none" }}>
                                    {t("Forgot password?")}
                                </RouterLink>
                            </div>
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
            )}
        </AuthLayout>
    );
});

export default LoginPage;
