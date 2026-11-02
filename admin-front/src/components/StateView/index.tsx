import { dc } from "kt-dc";
import { VBtn, VIcon, VProgressCircular } from "vuetify/components";
import { useLocale } from "vuetify";
import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";

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
                        {...{ role: "status", "aria-live": "polite", "aria-busy": "true" }}
                        style={{
                            alignItems: "center",
                            justifyContent: "center",
                            flexDirection: "column",
                            gap: "14px",
                            minHeight: props.minHeight ?? "240px",
                            width: "100%",
                        }}
                    >
                        <VProgressCircular indeterminate size={48} color="primary" width={4} aria-label={t("Loading")} />
                        <ThemedText style={{ fontSize: "14px", opacity: 0.7 }}>{t("Loading")}</ThemedText>
                    </ThemedView>
                );
            }

            if (props.error) {
                return (
                    <ThemedView
                        {...{ role: "alert", "aria-live": "assertive", "aria-atomic": "true" }}
                        style={{
                            alignItems: "center",
                            justifyContent: "center",
                            flexDirection: "column",
                            gap: "12px",
                            minHeight: props.minHeight ?? "240px",
                            width: "100%",
                        }}
                    >
                        <VIcon icon={"mdi-alert-circle-outline"} size={"40px"} color="error" aria-hidden="true" />
                        <ThemedText style={{ fontSize: "15px", textAlign: "center" }}>{props.error}</ThemedText>
                        {props.onRetry && (
                            <VBtn variant="tonal" color="primary" onClick={() => props.onRetry?.()} aria-label={t("Retry")}>
                                {t("Retry")}
                            </VBtn>
                        )}
                    </ThemedView>
                );
            }

            if (props.empty) {
                return (
                    <ThemedView
                        {...{ role: "status", "aria-live": "polite" }}
                        style={{
                            alignItems: "center",
                            justifyContent: "center",
                            flexDirection: "column",
                            gap: "10px",
                            minHeight: props.minHeight ?? "240px",
                            width: "100%",
                            borderRadius: "12px",
                            border: "1px dashed rgba(100,116,139,0.4)",
                        }}
                    >
                        <VIcon icon={"mdi-inbox-outline"} size={"38px"} color="on-surface-variant" aria-hidden="true" />
                        <ThemedText type="defaultSemiBold">
                            {props.emptyTitle ? t(props.emptyTitle) : t("No Data Found")}
                        </ThemedText>
                        {props.emptyDescription && (
                            <ThemedText style={{ fontSize: "13px", opacity: 0.7, textAlign: "center" }}>
                                {t(props.emptyDescription)}
                            </ThemedText>
                        )}
                    </ThemedView>
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
