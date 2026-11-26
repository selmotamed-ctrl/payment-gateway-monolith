import { dc } from "@/utils/dc";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import { useLocale } from "vuetify";
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "@/state/api";
import { urlsMap } from "@/constants/urlsMap";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { setLocale } from "@/plugins/localization";
import router from "@/router";
import AuthLayout from "@/layouts/auth";
import { FormField } from "@/components/ui/FormField";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

/**
 * Public page where an invited staff member accepts the invitation emailed to them. They choose their own
 * password and the phone that receives their sign-in codes: nobody else, including the person who proposed
 * the account, ever knows either. The account then waits for a checker to approve its activation.
 */
const MIN_PASSWORD_LENGTH = 12;

const AcceptInvitationPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const token = ref(typeof route.query.token === "string" ? route.query.token : "");
    const password = ref("");
    const confirmation = ref("");
    const phone = ref("");
    const loading = ref(false);
    const done = ref(false);
    const error = ref<string | null>(null);
    const showPassword = ref(false);
    const showConfirmation = ref(false);

    const mismatch = computed(() => confirmation.value.length > 0 && confirmation.value !== password.value);
    const phoneValid = computed(() => /^\+?[0-9 ()-]{6,20}$/.test(phone.value.trim()));
    const passwordChecks = computed(() => [
        { key: "length", label: t("At least 12 characters"), ok: password.value.length >= MIN_PASSWORD_LENGTH },
        { key: "match", label: t("Passwords match"), ok: password.value.length > 0 && password.value === confirmation.value },
        { key: "phone", label: t("Phone number can receive sign-in codes"), ok: phoneValid.value },
    ]);
    const canSubmit = computed(
        () =>
            token.value.trim().length >= 16 &&
            password.value.length >= MIN_PASSWORD_LENGTH &&
            password.value === confirmation.value &&
            phoneValid.value,
    );

    const submit = async () => {
        if (loading.value || !canSubmit.value) return;
        loading.value = true;
        error.value = null;
        try {
            await api.post(urlsMap.authAcceptInvitation, {
                token: token.value.trim(),
                password: password.value,
                phone: phone.value.trim(),
            });
            done.value = true;
            password.value = "";
            confirmation.value = "";
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
                            {t("Accept invitation")}
                        </div>
                        <div style={{ fontSize: "13px", color: "var(--pg-ink-muted)" }}>
                            {t("Choose your own password and the phone that receives your sign-in codes")}
                        </div>
                    </div>

                    {error.value && (
                        <VAlert type="error" variant="tonal" density="compact">
                            {error.value}
                        </VAlert>
                    )}

                    {done.value ? (
                        <>
                            <VAlert type="success" variant="tonal" density="compact">
                                {t("Invitation accepted. Your account becomes active once a second administrator approves it.")}
                            </VAlert>
                            <VBtn block size="large" onClick={() => void router.push({ name: "Login" })}>
                                {t("Back to sign in")}
                            </VBtn>
                        </>
                    ) : (
                        <>
                            <FormField label={t("Invitation code")} required>
                                <VTextField
                                    aria-label={t("Invitation code")}
                                    autocomplete="off"
                                    modelValue={token.value}
                                    onUpdate:modelValue={(value: string) => (token.value = value)}
                                    hideDetails
                                />
                            </FormField>
                            <FormField label={t("New password")} required hint={t("At least 12 characters")}>
                                <VTextField
                                    aria-label={t("New password")}
                                    type={showPassword.value ? "text" : "password"}
                                    autocomplete="new-password"
                                    appendInnerIcon={showPassword.value ? "mdi-eye-off-outline" : "mdi-eye-outline"}
                                    onClick:appendInner={() => (showPassword.value = !showPassword.value)}
                                    modelValue={password.value}
                                    onUpdate:modelValue={(value: string) => (password.value = value)}
                                    hideDetails
                                />
                            </FormField>
                            <FormField label={t("Confirm password")} required>
                                <VTextField
                                    aria-label={t("Confirm password")}
                                    type={showConfirmation.value ? "text" : "password"}
                                    autocomplete="new-password"
                                    appendInnerIcon={showConfirmation.value ? "mdi-eye-off-outline" : "mdi-eye-outline"}
                                    onClick:appendInner={() => (showConfirmation.value = !showConfirmation.value)}
                                    modelValue={confirmation.value}
                                    onUpdate:modelValue={(value: string) => (confirmation.value = value)}
                                    error={mismatch.value}
                                    hideDetails
                                />
                            </FormField>
                            <FormField label={t("Phone for sign-in codes")} required hint={t("Include the country code; this phone receives every sign-in code")}>
                                <VTextField
                                    aria-label={t("Phone for sign-in codes")}
                                    autocomplete="tel"
                                    modelValue={phone.value}
                                    onUpdate:modelValue={(value: string) => (phone.value = value)}
                                    hideDetails
                                />
                            </FormField>
                            <div aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                {passwordChecks.value.map((check) => (
                                    <div key={check.key} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: check.ok ? "var(--pg-status-success-text)" : "var(--pg-ink-muted)" }}>
                                        <span aria-hidden="true">{check.ok ? "✓" : "○"}</span>
                                        <span>{check.label}</span>
                                    </div>
                                ))}
                            </div>
                            <VBtn block size="large" loading={loading.value} disabled={!canSubmit.value} onClick={() => void submit()}>
                                {t("Accept invitation")}
                            </VBtn>
                            <VBtn variant="text" size="small" onClick={() => void router.push({ name: "Login" })}>
                                {t("Back to sign in")}
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

export default AcceptInvitationPage;
