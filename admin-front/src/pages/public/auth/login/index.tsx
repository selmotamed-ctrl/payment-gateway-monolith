import { computed, onUnmounted, ref } from "vue";
import { useLocale } from "@/utils/vael-compat";
import { useRoute } from "vue-router";
import { useForm } from "vael-form";
import { validator } from "vael-form/validator";

import { dc } from "@/utils/dc";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { setUserState, type UserState } from "@/state/user";
import { tokenFromLoginPayload } from "@/utils/security/sessionToken";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { setLocale } from "@/plugins/localization";
import router from "@/router";
import AuthLayout from "@/layouts/auth";
import {AppIcon, PgAlert, PgButton, PgFormField, PgOtpInput, PgTextField} from "@pg/ui";
import {SurfaceCard} from "@pg/ui";

type LoginValues = {
    identifier: string;
    password: string;
    mfaCode: string;
};

const LoginPage = dc(() => {
    const { t, current } = useLocale();
    const route = useRoute();
    const mfaChallengeId = ref<string | null>(null);
    const mfaChannels = ref<string[]>([]);
    const error = ref<string | null>(null);
    const capsLock = ref(false);
    const resending = ref(false);
    const resendWait = ref(0);
    let resendTimer: ReturnType<typeof setInterval> | null = null;

    const startResendCooldown = () => {
        if (resendTimer) clearInterval(resendTimer);
        resendWait.value = 30;
        resendTimer = setInterval(() => {
            resendWait.value -= 1;
            if (resendWait.value <= 0 && resendTimer) {
                clearInterval(resendTimer);
                resendTimer = null;
            }
        }, 1000);
    };
    onUnmounted(() => {
        if (resendTimer) clearInterval(resendTimer);
    });

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

    const schema = computed(() =>
        mfaChallengeId.value
            ? validator<LoginValues>({
                  mfaCode: [
                      (value) =>
                          /^\d{6}$/.test(String(value ?? "")) ||
                          t("Enter the six-digit code sent to your registered phone."),
                  ],
              })
            : validator<LoginValues>({
                  identifier: [
                      (value) => String(value ?? "").trim().length > 0 || t("Required"),
                  ],
                  password: [(value) => String(value ?? "").length > 0 || t("Required")],
              }),
    );

    const form = useForm({
        schema,
        defaultValues: { identifier: "", password: "", mfaCode: "" },
        showErrors: "submit",
        onSubmit: async (values) => {
            error.value = null;
            try {
                if (mfaChallengeId.value) {
                    const response = await api.post(urlsMap.authMfa, {
                        challengeId: mfaChallengeId.value,
                        code: values.mfaCode.trim(),
                    });
                    await applySession(response.data?.data ?? response.data);
                    return;
                }

                const response = await api.post(urlsMap.authLogin, {
                    identifier: values.identifier.trim(),
                    password: values.password,
                });
                const payload = response.data?.data ?? response.data;
                if (payload?.mfaRequired && payload?.challengeId) {
                    mfaChallengeId.value = String(payload.challengeId);
                    mfaChannels.value = Array.isArray(payload.deliveryChannels) ? payload.deliveryChannels.map(String) : [];
                    form.setValue("mfaCode", "");
                    startResendCooldown();
                    return;
                }
                await applySession(payload);
            } catch (caught) {
                error.value = extractApiErrorMessage(caught);
            }
        },
    });

    const resendCode = async () => {
        if (!mfaChallengeId.value || resending.value || resendWait.value > 0) return;
        resending.value = true;
        error.value = null;
        try {
            const response = await api.post(urlsMap.authMfaResend, {
                challengeId: mfaChallengeId.value,
            });
            const payload = response.data?.data ?? response.data ?? {};
            if (!payload?.challengeId) {
                throw new Error(t("The verification code could not be resent"));
            }
            mfaChallengeId.value = String(payload.challengeId);
            mfaChannels.value = Array.isArray(payload.deliveryChannels)
                ? payload.deliveryChannels.map(String)
                : mfaChannels.value;
            form.setValue("mfaCode", "");
            showSnackBar({ message: t("A new verification code was sent"), type: "success" });
        } catch (caught) {
            error.value = extractApiErrorMessage(caught);
        } finally {
            startResendCooldown();
            resending.value = false;
        }
    };

    const copySignInDiagnostics = async () => {
        const diagnostics = {
            page: window.location.pathname,
            locale: current.value,
            mfaStage: Boolean(mfaChallengeId.value),
            error: error.value,
            occurredAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
        };
        try {
            await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
            showSnackBar({ message: t("Sign-in diagnostics copied"), type: "success" });
        } catch {
            showSnackBar({ message: t("Could not copy. Select the text manually."), type: "error" });
        }
    };

    const backToCredentials = () => {
        mfaChallengeId.value = null;
        mfaChannels.value = [];
        form.setValue("mfaCode", "");
        error.value = null;
        resendWait.value = 0;
        if (resendTimer) {
            clearInterval(resendTimer);
            resendTimer = null;
        }
    };

    return () => (
        <AuthLayout>
            <SurfaceCard>
                <form
                    onSubmit={form.handleSubmit}
                    style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "6px" }}
                >
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <div
                            style={{
                                fontSize: "20px",
                                fontWeight: 600,
                                color: "var(--pg-ink-primary)",
                                letterSpacing: "-0.02em",
                            }}
                        >
                            {t("Admin Back Office")}
                        </div>
                        <div style={{ fontSize: "13px", color: "var(--pg-ink-muted)" }}>
                            {t("Sign in to continue")}
                        </div>
                    </div>

                    {typeof route.query.redirect === "string" &&
                        route.query.redirect.startsWith("/") &&
                        !route.query.redirect.startsWith("//") && (
                            <PgAlert tone="info">{t("Sign in to continue to your previous page.")}</PgAlert>
                        )}

                    {error.value && <PgAlert tone="danger">{error.value}</PgAlert>}

                    {capsLock.value && !mfaChallengeId.value && (
                        <PgAlert tone="warning">
                            {t("Caps Lock is on. Password letters may be entered in the wrong case.")}
                        </PgAlert>
                    )}

                    {mfaChallengeId.value ? (
                        <>
                            <PgAlert tone="info">
                                {mfaChannels.value.includes("EMAIL") && mfaChannels.value.includes("SMS")
                                    ? t("Enter the six-digit code sent to your email address and phone.")
                                    : mfaChannels.value.includes("SMS")
                                      ? t("Enter the six-digit code sent to your phone.")
                                      : t("Enter the six-digit code sent to your email address.")}
                            </PgAlert>
                            <PgFormField
                                label={t("MFA code")}
                                error={form.errors.mfaCode}
                                required
                            >
                                <PgOtpInput
                                    {...form.attrs.mfaCode}
                                    modelValue={form.model.mfaCode.value}
                                    onUpdate:modelValue={(value: string) => {
                                        form.model.mfaCode.value = value;
                                    }}
                                    length={6}
                                    {...{ autofocus: true }}
                                />
                            </PgFormField>
                            <PgButton
                                block
                                size="lg"
                                variant="primary"
                                type="submit"
                                loading={form.submitting.value}
                                disabled={(form.model.mfaCode.value ?? "").trim().length !== 6}
                            >
                                {t("Verify")}
                            </PgButton>
                            <div class="d-flex flex-wrap ga-2">
                                <PgButton
                                    variant="text"
                                    size="sm"
                                    loading={resending.value}
                                    disabled={resendWait.value > 0}
                                    onClick={() => void resendCode()}
                                >
                                    {resendWait.value > 0
                                        ? t("Resend in {seconds}s", { seconds: resendWait.value })
                                        : t("Resend code")}
                                </PgButton>
                                <PgButton variant="text" size="sm" onClick={backToCredentials}>
                                    {t("Back")}
                                </PgButton>
                            </div>
                        </>
                    ) : (
                        <>
                            <PgFormField
                                label={t("Email or phone")}
                                error={form.errors.identifier}
                                required
                            >
                                <PgTextField
                                    {...form.attrs.identifier}
                                    modelValue={form.model.identifier.value}
                                    onUpdate:modelValue={(value: string) => {
                                        form.model.identifier.value = value;
                                    }}
                                    autocomplete="username"
                                    autofocus
                                    leadingIcon="mdi-account-outline"
                                />
                            </PgFormField>
                            <PgFormField label={t("Password")} error={form.errors.password} required>
                                <PgTextField
                                    type="password"
                                    {...form.attrs.password}
                                    modelValue={form.model.password.value}
                                    onUpdate:modelValue={(value: string) => {
                                        form.model.password.value = value;
                                    }}
                                    autocomplete="current-password"
                                    onKeydown={onKeyState}
                                    onKeyup={onKeyState}
                                />
                            </PgFormField>
                            <PgButton
                                block
                                size="lg"
                                variant="primary"
                                type="submit"
                                loading={form.submitting.value}
                                disabled={
                                    !form.model.identifier.value || !form.model.password.value
                                }
                            >
                                {t("Login")}
                            </PgButton>
                        </>
                    )}

                    {!mfaChallengeId.value && (
                        <div class="d-flex flex-wrap ga-2 justify-space-between">
                            <PgButton
                                variant="text"
                                size="sm"
                                onClick={() => void router.push({ name: "AcceptInvitation" })}
                            >
                                {t("I have an invitation code")}
                            </PgButton>
                            <PgButton
                                variant="text"
                                size="sm"
                                onClick={() => void router.push({ name: "ForgotPassword" })}
                            >
                                {t("Forgot password?")}
                            </PgButton>
                        </div>
                    )}

                    <div
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                        }}
                    >
                        <PgButton variant="text" size="sm" onClick={() => setLocale("ar")}>
                            العربية
                        </PgButton>
                        <PgButton variant="text" size="sm" onClick={() => setLocale("en")}>
                            English
                        </PgButton>
                    </div>
                    <PgButton
                        variant="text"
                        size="sm"
                        onClick={() => void copySignInDiagnostics()}
                    >
                        {t("Copy sign-in diagnostics")}
                    </PgButton>
                </form>
            </SurfaceCard>
        </AuthLayout>
    );
});

export default LoginPage;
