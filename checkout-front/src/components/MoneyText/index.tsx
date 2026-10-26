import { dc } from "kt-dc";
import { formatMoney, type MoneyInput } from "@/utils/money";
import { adaptedLocale } from "@/plugins/localization";
import { ThemedText } from "@/components/ThemedText";
import type { StyleValue } from "vue";

export type MoneyTextProps = {
    value: MoneyInput;
    currency?: string | null;
    showCurrency?: boolean;
    color?: string;
    style?: StyleValue;
    bold?: boolean;
};

export const MoneyText = dc(
    (props: MoneyTextProps) => {
        return () => {
            const text = formatMoney(props.value, {
                currency: props.currency,
                locale: adaptedLocale.current.value === "ar" ? "ar" : "en",
                showCurrency: props.showCurrency !== false,
            });
            return (
                <ThemedText
                    type={props.bold ? "defaultSemiBold" : "default"}
                    style={[
                        {
                            color: props.color,
                            direction: "ltr",
                            unicodeBidi: "isolate",
                            display: "inline-block",
                        },
                        props.style,
                    ]}
                >
                    {text}
                </ThemedText>
            );
        };
    },
    {
        props: ["value", "currency", "showCurrency", "color", "style", "bold"],
    },
);

export default MoneyText;
