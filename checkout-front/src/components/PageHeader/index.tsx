import { useDisplay, useLocale, useTheme } from "vuetify";
import { ThemedView } from "../ThemedView";
import { dc } from "kt-dc";

export const PageHeader = dc(
    (props: { title: string; end?: () => JSX.Element }) => {
        const { t } = useLocale();
        const theme = useTheme();
        const display = useDisplay();
        return () => {
            const mobile = display.mobile.value;
            return (
                <ThemedView
                    style={{
                        flexDirection: mobile ? "column" : "row",
                        alignItems: mobile ? "stretch" : "center",
                        justifyContent: "space-between",
                        gap: "16px",
                        padding: mobile ? "6px 4px" : "2px 4px 6px",
                    }}
                >
                    <ThemedView style={{ gap: "6px" }}>
                        <span
                            style={{
                                width: "44px",
                                height: "4px",
                                borderRadius: "999px",
                                background: `linear-gradient(90deg, ${theme.current.value.colors.primary}, ${theme.current.value.colors.accent})`,
                            }}
                        ></span>
                        <span
                            style={{
                                fontSize: mobile ? "22px" : "28px",
                                fontWeight: "800",
                                lineHeight: 1.1,
                                color: theme.current.value.colors["on-surface"],
                            }}
                        >
                            {t(props.title)}
                        </span>
                    </ThemedView>
                    <ThemedView style={{ alignItems: mobile ? "stretch" : "flex-end" }}>{props.end?.()}</ThemedView>
                </ThemedView>
            );
        };
    },
    {
        props: ["title", "end"],
    },
);

export default PageHeader;
