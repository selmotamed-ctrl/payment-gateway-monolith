import { defineComponent } from "vue";
import { RouterLink } from "vue-router";

/** The high-visibility Sandbox frame shown on every `/sandbox/*` page. */
export const SandboxBanner = defineComponent({
    name: "SandboxBanner",
    props: {
        subtitle: {
            type: String,
            default:
                "This page reads and writes payment_gateway_sandbox only. No real money, no Live wallets, no Live reports.",
        },
    },
    setup(props) {
        return () => (
            <div
                style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "16px",
                    flexWrap: "wrap",
                    padding: "12px 16px",
                    marginBottom: "20px",
                    borderRadius: "10px",
                    border: "1px solid var(--pg-status-warning-border)",
                    background: "var(--pg-status-warning-bg)",
                    color: "var(--pg-status-warning-text)",
                }}
            >
                <div>
                    <strong>SANDBOX TESTING &amp; EMPLOYEE TRAINING ENVIRONMENT</strong>
                    <div style={{ fontSize: "13px", marginTop: "2px" }}>{props.subtitle}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span
                        style={{
                            background: "var(--pg-status-warning-dot)",
                            color: "#ffffff",
                            padding: "4px 10px",
                            borderRadius: "6px",
                            fontWeight: 700,
                            fontSize: "12px",
                        }}
                    >
                        SANDBOX ONLY
                    </span>
                    <RouterLink
                        to={`/dashboard?live=1`}
                        style={{ color: "var(--pg-status-warning-text)", fontSize: "12px", fontWeight: 700, textDecoration: "underline" }}
                    >
                        Exit sandbox
                    </RouterLink>
                </div>
            </div>
        );
    },
});
