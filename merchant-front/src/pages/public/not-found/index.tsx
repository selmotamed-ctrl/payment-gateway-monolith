import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { useRoute, useRouter } from "vue-router";

import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { MonoRef } from "@/components/ui/MonoRef";

const NotFoundPage = dc(() => {
    const { t } = useLocale();
    const route = useRoute();
    const router = useRouter();

    return () => (
        <div
            style={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "24px",
                background: "var(--pg-bg-canvas)",
            }}
        >
            <SurfaceCard style={{ width: "100%", maxWidth: "480px" }}>
                <SurfaceCardText>
                    <EmptyState
                        icon="mdi-map-marker-question-outline"
                        title="404"
                        description={t("The page you are looking for does not exist")}
                        actionLabel={t("Dashboard")}
                        actionVariant="tonal"
                        onAction={() => void router.push({ name: "Dashboard" })}
                    >
                        <MonoRef value={route.fullPath} truncate={64} />
                    </EmptyState>
                </SurfaceCardText>
            </SurfaceCard>
        </div>
    );
});

export default NotFoundPage;
