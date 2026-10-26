import { dc } from "kt-dc";
import { VAlert, VBtn, VIcon, VProgressCircular } from "vuetify/components";
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
                        style={{
                            alignItems: "center",
                            justifyContent: "center",
                            flexDirection: "column",
                            gap: "14px",
                            minHeight: props.minHeight ?? "240px",
                            width: "100%",
                        }}
                    >
                        <VProgressCircular indeterminate size={"48px"} color="primary" width={4} />
                        <ThemedText style={{ fontSize: "14px", opacity: 0.7 }}>{t("Loading")}</ThemedText>
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
                        <VIcon icon={"mdi-alert-circle-outline"} size={"40px"} color="error" />
                        <ThemedText style={{ fontSize: "15px", textAlign: "center" }}>{props.error}</ThemedText>
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
                    <ThemedView
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
                        <VIcon icon={"mdi-inbox-outline"} size={"38px"} color="on-surface-variant" />
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
