import { dc } from "@/utils/dc";
import { type HTMLAttributes, type ReservedProps, createSlot } from "vue";
import { defineComponent } from "@/utils/dc";

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
                    {createSlot("default")}
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
