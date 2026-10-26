import { dc } from "kt-dc";
import { VAlert, VBtn, VCard, VCardText, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { ref } from "vue";
import LogoSvg from "@/assets/images/logo.svg";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { setLocale } from "@/plugins/localization";
import { RouterLink } from "vue-router";
import { normalizePhone } from "@/utils/arabic";

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
            <VCard style={{ width: "100%", maxWidth: "460px", borderRadius: "20px" }}>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "20px" }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                        <img src={LogoSvg} alt="logo" width={"52px"} height={"52px"} />
                        <div style={{ fontSize: "19px", fontWeight: "800" }}>{t("Create Account")}</div>
                        <div style={{ fontSize: "13px", opacity: 0.65 }}>{t("Register")}</div>
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

                    <VTextField
                        label={t("Full Name")}
                        modelValue={fullName.value}
                        onUpdate:modelValue={(v: string) => (fullName.value = v)}
                        hideDetails
                    />
                    <VTextField
                        label={t("Phone")}
                        prependInnerIcon="mdi-phone"
                        modelValue={phone.value}
                        onUpdate:modelValue={(v: string) => (phone.value = v)}
                        hideDetails
                    />
                    <VTextField
                        label={t("Email")}
                        prependInnerIcon="mdi-email-outline"
                        type="email"
                        modelValue={email.value}
                        onUpdate:modelValue={(v: string) => (email.value = v)}
                        hideDetails
                    />
                    <VTextField
                        label={t("Password")}
                        prependInnerIcon="mdi-lock-outline"
                        type="password"
                        modelValue={password.value}
                        onUpdate:modelValue={(v: string) => (password.value = v)}
                        hideDetails
                    />
                    <VTextField
                        label={t("Confirm Password")}
                        prependInnerIcon="mdi-lock-check-outline"
                        type="password"
                        modelValue={confirmPassword.value}
                        onUpdate:modelValue={(v: string) => (confirmPassword.value = v)}
                        hideDetails
                    />

                    <VBtn
                        block
                        size="large"
                        loading={loading.value}
                        disabled={!fullName.value || !phone.value || !email.value || !password.value}
                        onClick={() => void submit()}
                    >
                        {t("Register")}
                    </VBtn>

                    <VBtn
                        block
                        variant="tonal"
                        prependIcon="mdi-google"
                        loading={loading.value}
                        onClick={() => void registerWithGoogle()}
                    >
                        {t("Login With Google")}
                    </VBtn>

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <RouterLink to={{ name: "Login" }} style={{ fontSize: "13px" }}>
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
                </VCardText>
            </VCard>
        </div>
    );
});

export default RegisterPage;
