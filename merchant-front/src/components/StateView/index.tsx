import { dc } from "kt-dc";
import { VBtn, VIcon, VProgressCircular } from "vuetify/components";
import { useLocale } from "vuetify";
import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { EmptyState } from "@/components/ui/EmptyState";

export type StateViewProps = {
    loading?: boolean;
    error?: string | null;
    empty?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
    minHeight?: string;
    onRetry?: () => void;
};

export const StateView = dc(
    (props: StateViewProps, _, { slots }) => {
        const { t } = useLocale();

        return () => {
            if (props.loading) {
                return (
                    <ThemedView
                        style={{
                            alignItems: "center",
                            justifyContent: "center",
                            flexDirection: "column",
                            gap: "14px",
                            minHeight: props.minHeight ?? "240px",
                            width: "100%",
                        }}
                    >
                        <VProgressCircular indeterminate size={48} color="primary" width={4} />
                        <ThemedText style={{ fontSize: "14px", color: "var(--pg-ink-muted)" }}>{t("Loading")}</ThemedText>
                    </ThemedView>
                );
            }

            if (props.error) {
                return (
                    <ThemedView
                        style={{
                            alignItems: "center",
                            justifyContent: "center",
                            flexDirection: "column",
                            gap: "12px",
                            minHeight: props.minHeight ?? "240px",
                            width: "100%",
                        }}
                    >
                        <VIcon icon={"mdi-alert-circle-outline"} size={40} style={{ color: "var(--pg-status-danger-text)" }} />
                        <ThemedText style={{ fontSize: "15px", textAlign: "center", color: "var(--pg-ink-primary)" }}>{props.error}</ThemedText>
                        {props.onRetry && (
                            <VBtn variant="tonal" color="primary" onClick={() => props.onRetry?.()}>
                                {t("Retry")}
                            </VBtn>
                        )}
                    </ThemedView>
                );
            }

            if (props.empty) {
                return (
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            minHeight: props.minHeight ?? "240px",
                            width: "100%",
                        }}
                    >
                        <EmptyState
                            icon="mdi-inbox-outline"
                            title={props.emptyTitle ? t(props.emptyTitle) : t("No Data Found")}
                            description={props.emptyDescription ? t(props.emptyDescription) : ""}
                        />
                    </div>
                );
            }

            return <>{slots.default?.()}</>;
        };
    },
    {
        slots: ["default"],
        props: [
            "loading",
            "error",
            "empty",
            "emptyTitle",
            "emptyDescription",
            "minHeight",
            "onRetry",
        ] as any,
    },
);

export default StateView;
