import { dc } from "kt-dc";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";

export type CheckoutLayoutProps = {
    title?: string;
};

const CheckoutLayout = dc(
    (props: CheckoutLayoutProps, _, { slots }) => {
        return () => (
            <ThemedView
                style={{
                    minHeight: "100vh",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "24px 16px 60px",
                    background: "linear-gradient(170deg, #f4f7fb 0%, #e6eefb 55%, #e7f6f3 100%)",
                }}
            >
                {props.title && (
                    <ThemedText type="defaultSemiBold" style={{ fontSize: "17px", marginBottom: "16px" }}>
                        {props.title}
                    </ThemedText>
                )}
                {slots.default?.()}
            </ThemedView>
        );
    },
    {
        slots: ["default"],
        props: ["title"],
    },
);

export default CheckoutLayout;
