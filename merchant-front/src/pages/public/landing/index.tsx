import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { RouterLink } from "vue-router";
import { VBtn, VIcon } from "vuetify/components";
import LogoSvg from "@/assets/images/logo.svg";
import { setLocale } from "@/plugins/localization";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { DescriptionList } from "@/components/ui/DescriptionList";

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

const PRICING = [
    { label: "Commission", value: "3.00%" },
    { label: "Platform Clearing", value: "T+N" },
    { label: "Supported Currencies", value: "LYD · USD · EUR" },
];

const LandingPage = dc(() => {
    const { t } = useLocale();

    return () => (
        <div style={{ minHeight: "100vh", background: "var(--pg-bg-canvas)" }}>
            <header
                style={{
                    backgroundColor: "var(--pg-bg-surface)",
                    borderBottom: "1px solid var(--pg-border-subtle)",
                }}
            >
                <div
                    style={{
                        maxWidth: "1100px",
                        margin: "0 auto",
                        padding: "14px 20px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "12px",
                        flexWrap: "wrap",
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", gap: "11px" }}>
                        <div
                            style={{
                                width: "36px",
                                height: "36px",
                                borderRadius: "var(--pg-radius-md)",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                backgroundColor: "var(--pg-ink-primary)",
                            }}
                        >
                            <img
                                src={LogoSvg}
                                alt=""
                                width={22}
                                height={22}
                                style={{ filter: "brightness(0) invert(1)" }}
                            />
                        </div>
                        <div style={{ display: "flex", flexDirection: "column" }}>
                            <span style={{ color: "var(--pg-ink-primary)", fontSize: "14px", fontWeight: 600 }}>
                                {t("Payment Gateway")}
                            </span>
                            <span style={{ color: "var(--pg-ink-muted)", fontSize: "11.5px" }}>
                                {t("Merchant Portal")}
                            </span>
                        </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <StatusBadge status="LIVE" label={t("Live")} toneOverride="success" />
                        <VBtn variant="text" size="small" onClick={() => setLocale("ar")}>
                            العربية
                        </VBtn>
                        <VBtn variant="text" size="small" onClick={() => setLocale("en")}>
                            English
                        </VBtn>
                    </div>
                </div>
            </header>

            <main style={{ maxWidth: "1100px", margin: "0 auto", padding: "0 20px 60px" }}>
                <section
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
                        gap: "40px",
                        alignItems: "center",
                        padding: "64px 0 48px",
                    }}
                >
                    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <span
                                style={{
                                    color: "var(--pg-ink-muted)",
                                    fontWeight: 600,
                                    fontSize: "11.5px",
                                    letterSpacing: "0.06em",
                                    textTransform: "uppercase",
                                }}
                            >
                                {t("Featured")}
                            </span>
                            <StatusBadge status="LIVE" label={t("Live")} toneOverride="success" showDot={false} />
                        </div>

                        <h1
                            style={{
                                color: "var(--pg-ink-primary)",
                                fontSize: "clamp(30px, 4vw, 42px)",
                                fontWeight: 600,
                                lineHeight: 1.15,
                                letterSpacing: "-0.03em",
                                margin: 0,
                                maxWidth: "760px",
                            }}
                        >
                            {t("Multi-rail collection for Libyan merchants")}
                        </h1>

                        <p
                            style={{
                                color: "var(--pg-ink-secondary)",
                                fontSize: "15.5px",
                                lineHeight: 1.6,
                                maxWidth: "620px",
                                margin: 0,
                            }}
                        >
                            {t(
                                "Accept OTP, redirect, QR, wallet and card rails through a single integration with transparent pricing and instant settlement visibility.",
                            )}
                        </p>

                        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginTop: "8px" }}>
                            <RouterLink to={{ name: "Register" }} style={{ textDecoration: "none" }}>
                                <VBtn color="primary" size="large" style={{ height: "38px" }}>
                                    {t("Start Now")}
                                </VBtn>
                            </RouterLink>
                            <RouterLink to={{ name: "Login" }} style={{ textDecoration: "none" }}>
                                <VBtn
                                    variant="outlined"
                                    size="large"
                                    style={{
                                        height: "38px",
                                        color: "var(--pg-ink-primary)",
                                        borderColor: "var(--pg-border-strong)",
                                    }}
                                >
                                    {t("Login")}
                                </VBtn>
                            </RouterLink>
                        </div>
                    </div>

                    <SurfaceCard title={t("Pricing Summary")} subtitle={t("Transparent merchant pricing.")}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                            <DescriptionList
                                ariaLabel={t("Pricing Summary")}
                                items={PRICING.map((item) => ({
                                    label: t(item.label),
                                    value: item.value,
                                }))}
                            />
                            <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                                <span
                                    aria-hidden="true"
                                    style={{
                                        width: "6px",
                                        height: "6px",
                                        borderRadius: "50%",
                                        backgroundColor: "var(--pg-status-success-dot)",
                                    }}
                                />
                                <span style={{ color: "var(--pg-ink-muted)", fontSize: "12px" }}>
                                    {t("All systems operational")}
                                </span>
                            </div>
                        </div>
                    </SurfaceCard>
                </section>

                <section
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
                        gap: "16px",
                    }}
                >
                    {FEATURES.map((feature) => (
                        <SurfaceCard key={feature.title}>
                            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <span
                                    style={{
                                        width: "34px",
                                        height: "34px",
                                        borderRadius: "var(--pg-radius-sm)",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        backgroundColor: "var(--pg-bg-surface-subtle)",
                                        border: "1px solid var(--pg-border-subtle)",
                                        color: "var(--pg-ink-secondary)",
                                    }}
                                >
                                    <VIcon icon={feature.icon} size={18} />
                                </span>
                                <span
                                    style={{
                                        color: "var(--pg-ink-primary)",
                                        fontWeight: 600,
                                        fontSize: "14px",
                                    }}
                                >
                                    {t(feature.title)}
                                </span>
                                <span
                                    style={{
                                        color: "var(--pg-ink-muted)",
                                        fontSize: "13px",
                                        lineHeight: 1.55,
                                    }}
                                >
                                    {t(feature.description)}
                                </span>
                            </div>
                        </SurfaceCard>
                    ))}
                </section>

                <footer
                    style={{
                        marginTop: "48px",
                        paddingTop: "20px",
                        borderTop: "1px solid var(--pg-border-subtle)",
                        color: "var(--pg-ink-muted)",
                        fontSize: "12px",
                        textAlign: "center",
                    }}
                >
                    {t("Powered By")} · {t("Payment Gateway")}
                </footer>
            </main>
        </div>
    );
});

export default LandingPage;
