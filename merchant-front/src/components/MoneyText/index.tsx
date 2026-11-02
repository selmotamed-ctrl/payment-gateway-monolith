import { defineComponent, type PropType, type StyleValue } from "vue";
import { MoneyDisplay } from "@/components/ui/MoneyDisplay";
import type { MoneyInput } from "@/utils/money";

export type MoneyTextProps = {
    value: MoneyInput;
    currency?: string | null;
    showCurrency?: boolean;
    color?: string;
    style?: StyleValue;
    bold?: boolean;
};

export const MoneyText = defineComponent({
    name: "MoneyText",
    props: {
        value: { type: [String, Number, Object] as PropType<MoneyInput>, default: null },
        currency: { type: String as PropType<string | null>, default: null },
        showCurrency: { type: Boolean, default: true },
        color: { type: String, default: "" },
        style: { type: [Object, String, Array] as PropType<StyleValue>, default: undefined },
        bold: { type: Boolean, default: false },
    },
    setup(props) {
        return () => (
            <span style={props.style}>
                <MoneyDisplay
                    amount={props.value as any}
                    currency={(props.currency || "LYD").toUpperCase()}
                    showCurrency={props.showCurrency}
                    size={props.bold ? "lg" : "md"}
                />
            </span>
        );
    },
});

export default MoneyText;
