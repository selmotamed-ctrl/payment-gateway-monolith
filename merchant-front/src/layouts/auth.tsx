import { defineComponent } from "vue";
import { useLocale } from "vuetify";
import LogoSvg from "@/assets/images/logo.svg";
import { StatusBadge } from "@/components/ui/StatusBadge";

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
                            <div class="pg-auth-brand__subtitle">{t("Merchant Portal")}</div>
                        </div>
                    </div>

                    <div class="pg-auth-posture">
                        <h2>{t("Payments, reconciled by design.")}</h2>
                        <p>
                            {t(
                                "Track every collection, settlement, and dispute from one secure merchant workspace. Your ledger stays aligned with every rail.",
                            )}
                        </p>
                        <div class="pg-auth-badges">
                            <StatusBadge
                                status="TLS 1.3 Encrypted"
                                label={t("TLS 1.3 Encrypted")}
                                toneOverride="success"
                            />
                            <StatusBadge
                                status="AES-256-GCM Vault"
                                label={t("AES-256-GCM Hardware Vault")}
                                toneOverride="success"
                            />
                            <StatusBadge
                                status="Ledger Reconciled"
                                label={t("Ledger Reconciled")}
                                toneOverride="info"
                            />
                        </div>
                    </div>

                    <div class="pg-auth-aside__footer">
                        <span class="pg-auth-status-dot" />
                        {t("All systems operational")}
                    </div>
                </aside>

                <main class="pg-auth-main">
                    <div class="pg-auth-panel">{slots.default?.()}</div>
                </main>
            </div>
        );
    },
});

export default AuthLayout;
