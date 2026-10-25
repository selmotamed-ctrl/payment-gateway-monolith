import { dc } from "kt-dc";
import { useDisplay } from "vuetify";

const ScreenContainer = dc(
    (_, __, { slots }) => {
        const display = useDisplay();
        return () => {
            const mobile = display.mobile.value;
            return (
                <>
                    <ThemedView
                        style={{
                            flex: 1,
                            gap: mobile ? "14px" : "20px",
                            padding: !mobile ? "24px 28px 32px" : "12px",
                            width: "100%",
                            maxWidth: "1680px",
                            margin: "0 auto",
                        }}
                    >
                        {slots.default?.()}
                    </ThemedView>
                </>
            );
        };
    },
    { slots: ["default"] },
);

export default ScreenContainer;
