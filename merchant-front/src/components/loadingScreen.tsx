import { dc } from "kt-dc";
import ScreenContainer from "./ScreenContainer";
import { VProgressCircular } from "vuetify/components";
import { useLocale } from "vuetify";

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
