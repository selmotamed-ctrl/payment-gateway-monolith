import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { RouterLink } from "vue-router";
import { VBtn, VCard, VCardText } from "vuetify/components";
import LogoSvg from "@/assets/images/logo.svg";
import { setLocale } from "@/plugins/localization";

const FEATURES = [
    {
        icon: "mdi-link-variant",
        title: "Payment Links & QR",
        description: "Create single-use or multi-use links with a bilingual hosted checkout and instant QR codes.",
    },
    {
        icon: "mdi-point-of-sale",
        title: "POS Terminals",
        description: "Pair cashier and customer displays and follow every payment in real time.",
    },
    {
        icon: "mdi-shield-check-outline",
        title: "Compliance Built In",
        description: "KYB, beneficial owners and AML screening handled before the first live transaction.",
    },
    {
        icon: "mdi-chart-line",
        title: "Ledger-Derived Statistics",
        description: "Volume, commission, net credited and statements reconcile exactly to your wallet.",
    },
];

const LandingPage = dc(() => {
    const { t } = useLocale();

    return () => (
        <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #0b1524 0%, #0f2f5c 55%, #0b7d72 100%)" }}>
            <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "28px 20px 60px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <img src={LogoSvg} alt="logo" width={"42px"} height={"42px"} />
                        <span style={{ color: "#ffffff", fontSize: "18px", fontWeight: "800" }}>
                            {t("Payment Gateway")}
                        </span>
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                        <VBtn variant="text" style={{ color: "#ffffff" }} onClick={() => setLocale("ar")}>
                            العربية
                        </VBtn>
                        <VBtn variant="text" style={{ color: "#ffffff" }} onClick={() => setLocale("en")}>
                            English
                        </VBtn>
                    </div>
                </div>

                <section style={{ display: "flex", flexDirection: "column", gap: "18px", padding: "64px 0 36px" }}>
                    <span style={{ color: "#7dd3fc", fontWeight: "700", fontSize: "13px", letterSpacing: "1px" }}>
                        {t("Featured")}
                    </span>
                    <h1 style={{ color: "#ffffff", fontSize: "38px", lineHeight: 1.2, margin: 0, maxWidth: "760px" }}>
                        {t("Multi-rail collection for Libyan merchants")}
                    </h1>
                    <p style={{ color: "#cbd5e1", fontSize: "16px", maxWidth: "640px", margin: 0 }}>
                        {t("Accept OTP, redirect, QR, wallet and card rails through a single integration with transparent pricing and instant settlement visibility.")}
                    </p>
                    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginTop: "8px" }}>
                        <RouterLink to={{ name: "Register" }}>
                            <VBtn color="primary" size="large">
                                {t("Start Now")}
                            </VBtn>
                        </RouterLink>
                        <RouterLink to={{ name: "Login" }}>
                            <VBtn variant="outlined" size="large" style={{ color: "#ffffff" }}>
                                {t("Login")}
                            </VBtn>
                        </RouterLink>
                    </div>
                </section>

                <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px" }}>
                    {FEATURES.map((feature) => (
                        <VCard key={feature.title} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>
                            <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                <span style={{ color: "#5ea1ff", fontSize: "26px" }}>{feature.icon}</span>
                                <span style={{ color: "#ffffff", fontWeight: "700" }}>{feature.title}</span>
                                <span style={{ color: "#cbd5e1", fontSize: "13px" }}>{feature.description}</span>
                            </VCardText>
                        </VCard>
                    ))}
                </section>

                <section style={{ marginTop: "44px" }}>
                    <VCard style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>
                        <VCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <span style={{ color: "#ffffff", fontWeight: "800", fontSize: "18px" }}>
                                {t("Pricing Summary")}
                            </span>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" }}>
                                {[
                                    { label: t("Commission"), value: "3.00%" },
                                    { label: t("Platform Clearing"), value: "T+N" },
                                    { label: t("Supported Currencies"), value: "LYD · USD · EUR" },
                                ].map((item) => (
                                    <div key={item.label} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                        <span style={{ color: "#94a3b8", fontSize: "12px" }}>{item.label}</span>
                                        <span style={{ color: "#ffffff", fontSize: "20px", fontWeight: "700" }}>{item.value}</span>
                                    </div>
                                ))}
                            </div>
                        </VCardText>
                    </VCard>
                </section>

                <footer style={{ marginTop: "40px", color: "#94a3b8", fontSize: "12px", textAlign: "center" }}>
                    {t("Powered By")} · {t("Payment Gateway")}
                </footer>
            </div>
        </div>
    );
});

export default LandingPage;
