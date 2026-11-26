import { dc } from "@/utils/dc";
import { ref } from "vue";
import { VBtn, VIcon } from "@/components/vael/VuetifyShim";
import { useLocale } from "@/utils/vael-compat";
import { useRoute, useRouter } from "vue-router";
import { isAuthenticated } from "@/state/user";

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
const NotFoundPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();
    const copied = ref(false);
    const diagnosticsCopied = ref(false);

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

    const copyDiagnostics = async () => {
        const diagnostics = {
            path: route.fullPath,
            url: window.location.href,
            referrer: document.referrer || null,
            occurredAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
        };
        try {
            await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
            diagnosticsCopied.value = true;
            window.setTimeout(() => (diagnosticsCopied.value = false), 2000);
        } catch {
            diagnosticsCopied.value = false;
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
            }}
        >
            <SurfaceCard style={{ width: "100%", maxWidth: "440px" }}>
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "16px", alignItems: "center", textAlign: "center" }}>
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
                        <VBtn variant="text" prependIcon={diagnosticsCopied.value ? "mdi-check" : "mdi-bug-outline"} onClick={() => void copyDiagnostics()}>
                            {diagnosticsCopied.value ? t("Copied") : t("Copy diagnostics")}
                        </VBtn>
                        {!isAuthenticated() && (
                            <VBtn variant="text" prependIcon="mdi-login" onClick={() => void router.push({ name: "Login" })}>
                                {t("Sign in")}
                            </VBtn>
                        )}
                        {isAuthenticated() && (
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "center", borderTop: "1px solid var(--pg-border-subtle)", paddingTop: "12px", inlineSize: "100%" }}>
                                <span style={{ fontSize: "11px", opacity: 0.6, inlineSize: "100%" }}>{t("Or continue with a common screen")}</span>
                                <VBtn size="small" variant="text" prependIcon="mdi-storefront-outline" onClick={() => void router.push({ name: "Merchants" })}>{t("Merchants")}</VBtn>
                                <VBtn size="small" variant="text" prependIcon="mdi-clipboard-alert-outline" onClick={() => void router.push({ name: "OperatorCases" })}>{t("Operator cases")}</VBtn>
                                <VBtn size="small" variant="text" prependIcon="mdi-shield-search" onClick={() => void router.push({ name: "AuditLog" })}>{t("Audit log")}</VBtn>
                            </div>
                        )}
                    </div>
                </SurfaceCardText>
            </SurfaceCard>
        </div>
    );
});

export default NotFoundPage;
