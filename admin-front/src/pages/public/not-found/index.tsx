import { dc } from "kt-dc";
import { ref } from "vue";
import { VBtn, VCard, VCardText, VIcon } from "vuetify/components";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { isAuthenticated } from "@/state/user";

const NotFoundPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const copied = ref(false);

    const copyAddress = async () => {
        const address = window.location.href;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(address);
            } else {
                throw new Error("clipboard unavailable");
            }
        } catch {
            const input = document.createElement("textarea");
            input.value = address;
            input.style.position = "fixed";
            input.style.opacity = "0";
            document.body.appendChild(input);
            input.select();
            document.execCommand("copy");
            input.remove();
        }
        copied.value = true;
        window.setTimeout(() => (copied.value = false), 2000);
    };

    return () => (
        <div
            style={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "24px",
            }}
        >
            <VCard style={{ width: "100%", maxWidth: "440px" }}>
                <VCardText style={{ display: "flex", flexDirection: "column", gap: "16px", alignItems: "center", textAlign: "center" }}>
                    <VIcon icon="mdi-map-marker-question-outline" size="54" color="primary" />
                    <div style={{ fontSize: "48px", fontWeight: "800", lineHeight: 1 }}>404</div>
                    <div style={{ fontSize: "15px", fontWeight: 700 }}>{t("The page you are looking for does not exist")}</div>
                    <div style={{ fontSize: "11px", opacity: 0.6, direction: "ltr", wordBreak: "break-all", maxWidth: "100%" }}>
                        {route.fullPath}
                    </div>
                    <div style={{ fontSize: "12px", opacity: 0.65 }}>
                        {t("Check the address or use one of the recovery links below. Nothing was changed.")}
                    </div>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
                        <VBtn variant="tonal" prependIcon="mdi-arrow-left" onClick={() => (window.history.length > 1 ? router.back() : void router.push({ name: "Dashboard" }))}>
                            {t("Go back")}
                        </VBtn>
                        <VBtn color="primary" variant="flat" prependIcon="mdi-view-dashboard-outline" onClick={() => void router.push({ name: "Dashboard" })}>
                            {t("Dashboard")}
                        </VBtn>
                        <VBtn variant="tonal" prependIcon="mdi-book-open-variant" onClick={() => void router.push({ name: "AdminGuide" })}>
                            {t("Interactive Guide")}
                        </VBtn>
                        <VBtn variant="tonal" prependIcon="mdi-magnify" onClick={() => void router.push({ name: "AdminGuide", query: { search: "1" } })}>
                            {t("Search guide")}
                        </VBtn>
                        <VBtn variant="text" prependIcon={copied.value ? "mdi-check" : "mdi-content-copy"} onClick={() => void copyAddress()}>
                            {copied.value ? t("Copied") : t("Copy address")}
                        </VBtn>
                        {!isAuthenticated() && (
                            <VBtn variant="text" prependIcon="mdi-login" onClick={() => void router.push({ name: "Login" })}>
                                {t("Sign in")}
                            </VBtn>
                        )}
                    </div>
                </VCardText>
            </VCard>
        </div>
    );
});

export default NotFoundPage;
