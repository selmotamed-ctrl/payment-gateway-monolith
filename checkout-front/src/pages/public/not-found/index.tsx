import { dc } from "kt-dc";
import { VBtn } from "vuetify/components";
import { useLocale } from "vuetify";
import { RouterLink } from "vue-router";

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
const NotFoundPage = dc(() => {
    const { t } = useLocale();
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
                <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px", alignItems: "center" }}>
                    <div style={{ fontSize: "48px", fontWeight: "800" }}>404</div>
                    <div style={{ opacity: 0.7 }}>{t("The page you are looking for does not exist")}</div>
                    <RouterLink to={{ name: "Dashboard" }}>
                        <VBtn variant="tonal">{t("Dashboard")}</VBtn>
                    </RouterLink>
                </SurfaceCardText>
            </SurfaceCard>
        </div>
    );
});

export default NotFoundPage;
