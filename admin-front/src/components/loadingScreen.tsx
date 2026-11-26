import ThemedView from "@/components/ThemedView/index";
import { dc } from "@/utils/dc";
import ScreenContainer from "./ScreenContainer";
import { VProgressCircular } from "@/components/vael/VuetifyShim";
import { useLocale } from "@/utils/vael-compat";

const LoadingScreen = dc(
    (props: { msg?: string }) => {
        const { t } = useLocale();
        return () => {
            return (
                <ScreenContainer>
                    <ThemedView style={{ gap: "22px", padding: "12px", alignItems: "center", justifyContent: "center", flex: "1", width: "100%" }}>
                        <VProgressCircular color="primary" indeterminate size={48}></VProgressCircular>
                        {props.msg && (
                            <>
                                <ThemedView>{t(props.msg)}...</ThemedView>
                            </>
                        )}
                    </ThemedView>
                </ScreenContainer>
            );
        };
    },
    {
        props: ["msg"],
    },
);
export default LoadingScreen;
