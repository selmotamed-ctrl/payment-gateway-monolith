import ThemedView from "@/components/ThemedView/index";
import { dc } from "@/utils/dc";
import LogoSvg from "@/assets/images/logo.svg";
import { useLocale } from "@/utils/vael-compat";
import { useTheme } from "@/utils/vuetify-compat";
import { VDivider } from "@/components/vael/VuetifyShim";

export const PrintHeader = dc(() => {
    const { t } = useLocale();
    const theme = useTheme();
    return () => {
        return (
            <>
                <ThemedView
                    style={{
                        width: "100%",
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                    }}
                >
                    <ThemedView
                        style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: "12px",
                            paddingLeft: "12px",
                            borderLeft: theme.current.value.dark ? "1px solid rgba(255, 255, 255, 0.1)" : "1px solid rgba(0, 0, 0, 0.08)",

                            minWidth: 0,
                        }}
                    >
                        <img
                            src={LogoSvg}
                            style={{
                                height: "22px",
                            }}
                        ></img>
                        <VDivider vertical></VDivider>
                        <ThemedView>{"Neom"}</ThemedView>
                    </ThemedView>
                </ThemedView>
            </>
        );
    };
});
export default PrintHeader;
