import { dc } from "kt-dc";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { setUserState, type UserState } from "@/state/user";
import { tokenFromLoginPayload } from "@/utils/security/sessionToken";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { setLocale } from "@/plugins/localization";
import router from "@/router";
import AuthLayout from "@/layouts/auth";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

const LoginPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const username = ref("");
    const password = ref("");
    const mfaCode = ref("");
    const mfaChallengeId = ref<string | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);
    const showPassword = ref(false);
    const capsLock = ref(false);

    const applySession = async (payload: any) => {
        const session: UserState = {
            token: tokenFromLoginPayload(payload) as string,
            refreshToken: payload?.refreshToken ?? null,
            userInfo: {
                id: String(payload?.userInfo?.id ?? payload?.user?.id ?? ""),
                name: payload?.userInfo?.name ?? payload?.user?.name ?? "",
                username: payload?.userInfo?.username ?? payload?.user?.username ?? "",
                role: payload?.userInfo?.role ?? payload?.user?.role ?? "",
                email: payload?.userInfo?.email ?? null,
                phone: payload?.userInfo?.phone ?? null,
                authoritiesMap: payload?.userInfo?.authoritiesMap ?? payload?.authoritiesMap ?? {},
                isMaker: !!payload?.userInfo?.isMaker,
                isChecker: !!payload?.userInfo?.isChecker,
            },
        };
        if (!session.token) {
            throw new Error("The server did not return a session token");
        }
        setUserState(session);
        const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "";
        const safeRedirect = redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "";
        await router.push(safeRedirect || { name: "Dashboard" });
    };

    const onKeyState = (event: KeyboardEvent) => {
        capsLock.value = event.getModifierState?.("CapsLock") ?? false;
    };

    const submitOnEnter = (event: KeyboardEvent) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void submit();
    };

    const submit = async () => {
        if (loading.value) {
            return;
        }
        error.value = null;
        loading.value = true;
        try {
            if (mfaChallengeId.value) {
                const response = await api.post(urlsMap.authMfa, {
                    challengeId: mfaChallengeId.value,
                    code: mfaCode.value.trim(),
                });
                await applySession(response.data?.data ?? response.data);
                return;
            }
            const response = await api.post(urlsMap.authLogin, {
                identifier: username.value.trim(),
                password: password.value,
            });
            const payload = response.data?.data ?? response.data;
            if (payload?.mfaRequired && payload?.challengeId) {
                mfaChallengeId.value = String(payload.challengeId);
                return;
            }
            await applySession(payload);
        } catch (e) {
            error.value = extractApiErrorMessage(e);
        } finally {
            loading.value = false;
        }
    };

    return () => (
        <AuthLayout>
            <SurfaceCard>
                <div style={{ display: "flex", flexDirection: "column", gap: "18px", padding: "6px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <div style={{ fontSize: "20px", fontWeight: 600, color: "var(--pg-ink-primary)", letterSpacing: "-0.02em" }}>
                            {t("Admin Back Office")}
                        </div>
                        <div style={{ fontSize: "13px", color: "var(--pg-ink-muted)" }}>{t("Sign in to continue")}</div>
                    </div>

                    {typeof route.query.redirect === "string" &&
                        route.query.redirect.startsWith("/") &&
                        !route.query.redirect.startsWith("//") && (
                            <VAlert type="info" variant="tonal" density="compact">
                                {t("Sign in to continue to your previous page.")}
                            </VAlert>
                        )}

                    {error.value && (
                        <VAlert type="error" variant="tonal" density="compact">
                            {error.value}
                        </VAlert>
                    )}

                    {capsLock.value && !mfaChallengeId.value && (
                        <VAlert type="warning" variant="tonal" density="compact">
                            {t("Caps Lock is on. Password letters may be entered in the wrong case.")}
                        </VAlert>
                    )}

                    {mfaChallengeId.value ? (
                        <>
                            <VAlert type="info" variant="tonal" density="compact">
                                {t("Enter the six-digit code sent to your registered phone.")}
                            </VAlert>
                            <FormField label={t("MFA code")} required>
                                <VTextField
                                    prependInnerIcon="mdi-shield-key-outline"
                                    autocomplete="one-time-code"
                                    {...{ inputmode: "numeric", maxlength: "6", autofocus: true }}
                                    modelValue={mfaCode.value}
                                    onUpdate:modelValue={(value: string) =>
                                        (mfaCode.value = value.replace(/\D/g, "").slice(0, 6))
                                    }
                                    onKeydown={submitOnEnter}
                                    hideDetails
                                />
                            </FormField>
                            <VBtn
                                block
                                size="large"
                                loading={loading.value}
                                disabled={mfaCode.value.trim().length !== 6}
                                onClick={() => void submit()}
                            >
                                {t("Verify")}
                            </VBtn>
                            <VBtn
                                variant="text"
                                size="small"
                                onClick={() => {
                                    mfaChallengeId.value = null;
                                    mfaCode.value = "";
                                    error.value = null;
                                }}
                            >
                                {t("Back")}
                            </VBtn>
                        </>
                    ) : (
                        <>
                            <FormField label={t("Email or phone")} required>
                                <VTextField
                                    aria-label={t("Email or phone")}
                                    prependInnerIcon="mdi-account-outline"
                                    autocomplete="username"
                                    {...{ autofocus: true }}
                                    modelValue={username.value}
                                    onUpdate:modelValue={(value: string) => (username.value = value)}
                                    onKeydown={submitOnEnter}
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
                                    onUpdate:modelValue={(value: string) => (password.value = value)}
                                    appendInnerIcon={showPassword.value ? "mdi-eye-off-outline" : "mdi-eye-outline"}
                                    onClick:append-inner={() => (showPassword.value = !showPassword.value)}
                                    onKeydown={(event: KeyboardEvent) => {
                                        onKeyState(event);
                                        submitOnEnter(event);
                                    }}
                                    onKeyup={onKeyState}
                                    hideDetails
                                />
                            </FormField>
                            <VBtn
                                block
                                size="large"
                                loading={loading.value}
                                disabled={!username.value || !password.value}
                                onClick={() => void submit()}
                                style={{ height: "38px" }}
                            >
                                {t("Login")}
                            </VBtn>
                        </>
                    )}

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <VBtn variant="text" size="small" onClick={() => setLocale("ar")}>
                            العربية
                        </VBtn>
                        <VBtn variant="text" size="small" onClick={() => setLocale("en")}>
                            English
                        </VBtn>
                    </div>
                </div>
            </SurfaceCard>
        </AuthLayout>
    );
});

export default LoginPage;
