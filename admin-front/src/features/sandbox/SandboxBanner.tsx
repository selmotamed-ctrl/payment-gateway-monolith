import { defineComponent } from "@/utils/dc";
import { RouterLink } from "vue-router/experimental/vapor";
import {PgAlert, StatusBadge} from "@pg/ui";

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
            <PgAlert
                tone="warning"
                title="SANDBOX EXECUTION PLANE"
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
