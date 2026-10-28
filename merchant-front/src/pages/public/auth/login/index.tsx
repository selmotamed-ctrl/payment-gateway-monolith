import { dc } from "kt-dc";
import { VAlert, VBtn, VCard, VCardText, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { ref } from "vue";
import LogoSvg from "@/assets/images/logo.svg";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { setUserState, type UserState } from "@/state/user";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { setLocale } from "@/plugins/localization";
import router from "@/router";
import { RouterLink } from "vue-router";

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
        token: payload?.token,
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
            const response = await api.post(urlsMap.authGoogle, { redirectUri: location.href });
            const payload = response.data?.data ?? response.data ?? {};
            if (payload?.redirectUrl) {
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
        <div
            style={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "24px",
                background: "linear-gradient(135deg, #0f172a 0%, #123a6b 55%, #0b7d72 100%)",
            }}
        >
            <VCard style={{ width: "100%", maxWidth: "420px", borderRadius: "20px" }}>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "20px" }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                        <img src={LogoSvg} alt="logo" width={"52px"} height={"52px"} />
                        <div style={{ fontSize: "19px", fontWeight: "800" }}>{t("Payment Gateway")}</div>
                        <div style={{ fontSize: "13px", opacity: 0.65 }}>{t("Sign in to continue")}</div>
                    </div>

                    {error.value && (
                        <VAlert type="error" variant="tonal" density="compact">
                            {error.value}
                        </VAlert>
                    )}

                    <VTextField
                        label={t("Phone Or Email")}
                        prependInnerIcon="mdi-account-outline"
                        modelValue={identity.value}
                        onUpdate:modelValue={(v: string) => (identity.value = v)}
                        hideDetails
                    />

                    <VTextField
                        label={t("Password")}
                        prependInnerIcon="mdi-lock-outline"
                        type={showPassword.value ? "text" : "password"}
                        modelValue={password.value}
                        onUpdate:modelValue={(v: string) => (password.value = v)}
                        appendInnerIcon={showPassword.value ? "mdi-eye-off-outline" : "mdi-eye-outline"}
                        onClick:append-inner={() => (showPassword.value = !showPassword.value)}
                        hideDetails
                    />

                    {challengeId.value && (
                        <>
                            <VAlert type="info" variant="tonal" density="compact">
                                {t("Enter the six-digit code sent to your registered phone.")}
                            </VAlert>
                            <VTextField
                                label={t("Verification Code")}
                                prependInnerIcon="mdi-shield-key-outline"
                                modelValue={mfaCode.value}
                                onUpdate:modelValue={(v: string) => (mfaCode.value = v)}
                                hideDetails
                            />
                        </>
                    )}

                    <VBtn
                        block
                        size="large"
                        loading={loading.value}
                        disabled={challengeId.value ? mfaCode.value.trim().length !== 6 : !identity.value || !password.value}
                        onClick={() => void submit()}
                    >
                        {challengeId.value ? t("Verify") : t("Login")}
                    </VBtn>

                    {challengeId.value && (
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
                    )}

                    <VBtn
                        block
                        variant="tonal"
                        prependIcon="mdi-google"
                        loading={loading.value}
                        onClick={() => void loginWithGoogle()}
                    >
                        {t("Login With Google")}
                    </VBtn>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <RouterLink to={{ name: "Register" }} style={{ fontSize: "13px" }}>
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
                </VCardText>
            </VCard>
        </div>
    );
});

export default LoginPage;
