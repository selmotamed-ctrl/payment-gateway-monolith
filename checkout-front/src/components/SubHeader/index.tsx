import { useLocale } from "vuetify";
import { ThemedView } from "../ThemedView";
import { dc } from "kt-dc";

export const SubHeader = dc(
    (props: { title: string; end?: () => JSX.Element }) => {
        const { t } = useLocale();
        return () => {
            return (
                <ThemedView
                    style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "22px",
                        padding: "8px 22px",
                    }}
                >
                    <ThemedView>
                        <span
                            style={{
                                fontSize: "22px",
                                fontWeight: "600",
                            }}
                            class={"text-grey"}
                        >
                            {t(props.title)}
                        </span>
                    </ThemedView>
                    <ThemedView>{props.end?.()}</ThemedView>
                </ThemedView>
            );
        };
    },
    {
        props: ["title", "end"],
    },
);

export default SubHeader;
