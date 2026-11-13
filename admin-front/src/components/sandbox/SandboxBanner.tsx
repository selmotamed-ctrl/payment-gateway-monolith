import { defineComponent } from "vue";
import { RouterLink } from "vue-router";
import { StatusBadge } from "@/components/ui/StatusBadge";

export const SandboxBanner = defineComponent({
    name: "AdminSandboxBanner",
    props: {
        subtitle: {
            type: String,
            default: "This section controls pg-core-sandbox (payment_gateway_sandbox). It never reads or writes Live data.",
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
                    <strong>SANDBOX EXECUTION PLANE</strong>
                    <div style={{ fontSize: "13px", marginTop: "2px" }}>{props.subtitle}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <StatusBadge status="SANDBOX" toneOverride="warning" />
                    <RouterLink
                        to="/dashboard?live=1"
                        style={{ color: "var(--pg-status-warning-text)", fontSize: "12px", fontWeight: 700, textDecoration: "underline" }}
                    >
                        Exit sandbox
                    </RouterLink>
                </div>
            </div>
        );
    },
});
