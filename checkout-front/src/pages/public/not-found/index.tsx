import { dc } from "@/utils/dc";
import {PgButton} from "@pg/ui";
import { useLocale } from "@/utils/vael-compat";
import { RouterLink } from "vue-router/experimental/vapor";

import {SurfaceCard, SurfaceCardText} from "@pg/ui";
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
                        <PgButton variant="tonal">{t("Dashboard")}</PgButton>
                    </RouterLink>
                </SurfaceCardText>
            </SurfaceCard>
        </div>
    );
});

export default NotFoundPage;
