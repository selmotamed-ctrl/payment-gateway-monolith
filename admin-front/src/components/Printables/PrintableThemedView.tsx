import { dc } from "@/utils/dc";
import { defineComponent, type HTMLAttributes, type ReservedProps } from "vue";

type ThemedViewProps = HTMLAttributes &
    ReservedProps

export const PrintableThemedView = dc(
    (p: ThemedViewProps, _, { attrs, slots, }) => {

        return () => {
            const props = attrs as ThemedViewProps;
            return (
                <div
                    {...props}
                    style={[
                        {
                            display: "flex",
                            flexDirection: "column",
                        },
                        props.style,
                    ]}
                >
                    {slots.default?.()}
                </div>
            );
        };
    },
    {
        slots: ["default"],
        props: ["disabled", "animated", "noHoverable"] as any,
    },
);
export default PrintableThemedView
