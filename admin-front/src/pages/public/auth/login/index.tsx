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

const LoginPage = dc(() => {
    const { t } = useLocale();
    const username = ref("");
    const password = ref("");
    const loading = ref(false);
    const error = ref<string | null>(null);
    const showPassword = ref(false);

    const submit = async () => {
        if (loading.value) {
            return;
        }
        error.value = null;
        loading.value = true;
        try {
            const response = await api.post(urlsMap.authLogin, {
                username: username.value.trim(),
                password: password.value,
            });
            const payload = response.data?.data ?? response.data;
            const session: UserState = {
                token: payload?.token,
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
            <VCard
                style={{
                    width: "100%",
                    maxWidth: "420px",
                    padding: "8px",
                    borderRadius: "20px",
                }}
            >
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "18px", padding: "18px" }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                        <img src={LogoSvg} alt="logo" width={"56px"} height={"56px"} />
                        <div style={{ fontSize: "20px", fontWeight: "800" }}>{t("Admin Back Office")}</div>
                        <div style={{ fontSize: "13px", opacity: 0.6 }}>{t("Sign in to continue")}</div>
                    </div>

                    {error.value && (
                        <VAlert type="error" variant="tonal" density="compact">
                            {error.value}
                        </VAlert>
                    )}

                    <VTextField
                        label={t("Username")}
                        prependInnerIcon="mdi-account-outline"
                        autocomplete="username"
                        modelValue={username.value}
                        onUpdate:modelValue={(v: string) => (username.value = v)}
                        hideDetails
                    />

                    <VTextField
                        label={t("Password")}
                        prependInnerIcon="mdi-lock-outline"
                        type={showPassword.value ? "text" : "password"}
                        autocomplete="current-password"
                        modelValue={password.value}
                        onUpdate:modelValue={(v: string) => (password.value = v)}
                        appendInnerIcon={showPassword.value ? "mdi-eye-off-outline" : "mdi-eye-outline"}
                        onClick:append-inner={() => (showPassword.value = !showPassword.value)}
                        hideDetails
                    />

                    <VBtn
                        block
                        size="large"
                        loading={loading.value}
                        disabled={!username.value || !password.value}
                        onClick={() => void submit()}
                    >
                        {t("Login")}
                    </VBtn>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <VBtn variant="text" size="small" onClick={() => setLocale("ar")}>
                            العربية
                        </VBtn>
                        <VBtn variant="text" size="small" onClick={() => setLocale("en")}>
                            English
                        </VBtn>
                    </div>
                </VCardText>
            </VCard>
        </div>
    );
});

export default LoginPage;
