import { defineComponent } from "vue";
import { useLocale } from "vuetify";
import LogoSvg from "@/assets/images/logo.svg";
import { StatusBadge } from "@/components/ui/StatusBadge";
import ThemeMenu from "@/components/ThemeMenu";

export const AuthLayout = defineComponent({
    name: "AuthLayout",
    setup(_, { slots }) {
        const { t } = useLocale();
        return () => (
            <div class="pg-auth-shell">
                <aside class="pg-auth-aside pg-login-grid">
                    <div class="pg-auth-brand">
                        <div class="pg-auth-brand__mark">
                            <img src={LogoSvg} alt="" width={24} height={24} />
                        </div>
                        <div>
                            <div class="pg-auth-brand__title">{t("Payment Gateway")}</div>
                            <div class="pg-auth-brand__subtitle">{t("Admin Back Office")}</div>
                        </div>
                    </div>

                    <div class="pg-auth-posture">
                        <h2>{t("Institutional payment controls.")}</h2>
                        <p>
                            {t(
                                "Every operator action is authenticated, authorised, and audited. Ledger changes require independent four-eyes approval.",
                            )}
                        </p>
                        <div class="pg-auth-badges">
                            <StatusBadge status="TLS 1.3 mTLS Verified" label={t("TLS 1.3 mTLS Verified")} toneOverride="success" />
                            <StatusBadge status="AES-256-GCM Vault" label={t("AES-256-GCM Hardware Vault")} toneOverride="success" />
                            <StatusBadge status="Four-Eyes Governance" label={t("Four-Eyes Governance")} toneOverride="info" />
                        </div>
                    </div>

                    <div class="pg-auth-aside__footer">
                        <span class="pg-auth-status-dot" />
                        {t("All systems operational")}
                    </div>
                </aside>

                <main class="pg-auth-main" style={{ position: "relative" }}>
                    <div style={{ position: "absolute", top: "16px", insetInlineEnd: "16px", zIndex: 2 }}>
                        <ThemeMenu />
                    </div>
                    <div class="pg-auth-panel">{slots.default?.()}</div>
                </main>
            </div>
        );
    },
});

export default AuthLayout;
