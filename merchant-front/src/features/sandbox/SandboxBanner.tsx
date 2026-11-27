import { defineComponent } from "@/utils/dc";
import { RouterLink } from "vue-router/experimental/vapor";
import {PgAlert, StatusBadge} from "@pg/ui";

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
            <PgAlert
                tone="warning"
                title="SANDBOX TESTING & EMPLOYEE TRAINING ENVIRONMENT"
                v-slots={{
                    actions: () => (
                        <>
                            <StatusBadge status="SANDBOX" toneOverride="warning" />
                            <RouterLink
                                to="/dashboard?live=1"
                                style={{ color: "inherit", fontSize: "12px", fontWeight: 700, textDecoration: "underline" }}
                            >
                                Exit sandbox
                            </RouterLink>
                        </>
                    ),
                }}
            >
                <span>{props.subtitle}</span>
            </PgAlert>
        );
    },
});
