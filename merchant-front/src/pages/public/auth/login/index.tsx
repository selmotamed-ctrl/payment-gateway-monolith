import { GOOGLE_REDIRECT_PATHS, isAllowedIdentityRedirect, parseIdentityHosts } from "@/utils/security/identityRedirect";
import { dc } from "kt-dc";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { ref } from "vue";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { setUserState, type UserState } from "@/state/user";
import { tokenFromLoginPayload } from "@/utils/security/sessionToken";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { setLocale } from "@/plugins/localization";
import router from "@/router";
import { RouterLink } from "vue-router";
import AuthLayout from "@/layouts/auth";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

const LoginPage = dc(() => {
    const { t } = useLocale();
    const identity = ref("");
    const password = ref("");
    const mfaCode = ref("");
    const challengeId = ref<string | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);
    const showPassword = ref(false);

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
            const response = await api.post(urlsMap.authGoogle, { redirectUri: GOOGLE_REDIRECT_PATHS.login });
            const payload = response.data?.data ?? response.data ?? {};
            if (payload?.redirectUrl) {
                if (!isAllowedIdentityRedirect(payload.redirectUrl, parseIdentityHosts(import.meta.env.VITE_IDENTITY_HOSTS))) {
                    throw new Error("untrusted redirect");
                }
                window.location.assign(payload.redirectUrl);
                return;
            }
            const session = buildSession(payload);
            if (!session.token) {
                throw new Error("missing token");
            }
            setUserState(session);
            await router.push({ name: "Dashboard" });
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
        loading.value = true;
        try {
            if (challengeId.value) {
                const response = await api.post(urlsMap.authMfaVerify, {
                    challengeId: challengeId.value,
                    code: mfaCode.value.trim(),
                });
                const session = buildSession(response.data?.data ?? response.data ?? {});
                if (!session.token) {
                    throw new Error("missing token");
                }
                setUserState(session);
                await router.push({ name: "Dashboard" });
                return;
            }
            const response = await api.post(urlsMap.authLogin, {
                identifier: identity.value.trim(),
                password: password.value,
            });
            const payload = response.data?.data ?? response.data ?? {};
            if (payload?.mfaRequired && payload?.challengeId) {
                challengeId.value = String(payload.challengeId);
                return;
            }
            const session = buildSession(payload);
            if (!session.token) {
                throw new Error("missing token");
            }
            setUserState(session);
            await router.push({ name: "Dashboard" });
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    return () => (
        <AuthLayout>
            <SurfaceCard title={t("Merchant Portal")} subtitle={t("Sign in to continue")}>
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                    {error.value && (
                        <VAlert type="error" variant="tonal" density="compact">
                            {error.value}
                        </VAlert>
                    )}

                    {challengeId.value ? (
                        <>
                            <VAlert type="info" variant="tonal" density="compact">
                                {t("Enter the six-digit code sent to your registered phone.")}
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
                            <VBtn
                                variant="text"
                                size="small"
                                onClick={() => {
                                    challengeId.value = null;
                                    mfaCode.value = "";
                                    error.value = null;
                                }}
                            >
                                {t("Back")}
                            </VBtn>
                        </>
                    ) : (
                        <>
                            <FormField label={t("Phone Or Email")} required>
                                <VTextField
                                    aria-label={t("Phone Or Email")}
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
                        <RouterLink
                            to={{ name: "Register" }}
                            style={{
                                fontSize: "13px",
                                color: "var(--pg-accent-interactive)",
                                textDecoration: "none",
                            }}
                        >
                            {t("Create Account")}
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

export default LoginPage;
