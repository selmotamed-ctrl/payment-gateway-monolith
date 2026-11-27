import { defineComponent } from "@/utils/dc";
import { type PropType } from "vue";
import {VAlert, PgButton} from "@pg/ui";
import { useLocale } from "@/utils/vael-compat";
import { RouterLink } from "vue-router/experimental/vapor";
import {SurfaceCard} from "@pg/ui";
import {ThemedText} from "@pg/ui";
import type { CommunicationMaintenance } from "@/state/app";

/**
 * The merchant channel is unusable while email delivery is not configured: registration and sign-in are the two
 * entry points, so both render this state and the API refuses them with 503 AUTH_MAINTENANCE_EMAIL_NOT_CONFIGURED.
 */
export const MaintenanceScreen = defineComponent({
    name: "CommunicationMaintenanceScreen",
    props: {
        maintenance: { type: Object as PropType<CommunicationMaintenance | null>, default: null },
        loading: { type: Boolean, default: false },
        onRefresh: { type: Function as PropType<() => void>, default: undefined },
    },
    setup(props) {
        const { t } = useLocale();
        return () => (
            <SurfaceCard title={t("Platform under maintenance")} subtitle={t("Merchant registration and sign-in are temporarily unavailable")}>
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    <VAlert type="warning" variant="tonal" density="compact">
                        {props.maintenance?.message ?? t("Email delivery is not configured. Please try again later.")}
                    </VAlert>
                    <ThemedText style={{ fontSize: "13px", opacity: 0.75 }}>
                        {t("The platform administrator has been notified. Email delivery must be configured before registration or sign-in can continue.")}
                    </ThemedText>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        {props.onRefresh ? (
                            <PgButton variant="tonal" loading={props.loading} onClick={() => props.onRefresh?.()}>
                                {t("Check again")}
                            </PgButton>
                        ) : null}
                        <RouterLink to={{ name: "Landing" }} style={{ textDecoration: "none" }}>
                            <PgButton variant="text">{t("Back to home")}</PgButton>
                        </RouterLink>
                    </div>
                </div>
            </SurfaceCard>
        );
    },
});

export default MaintenanceScreen;
