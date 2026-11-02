import { defineComponent, type PropType, type VNodeChild } from "vue";
import Decimal from "decimal.js";
import { currencyPrecision, DEFAULT_CURRENCY } from "@/utils/money";

const FONT_SIZE = { sm: "12.5px", md: "13.5px", lg: "18px", xl: "24px" } as const;

export const MoneyDisplay = defineComponent({
    name: "MoneyDisplay",
    props: {
        amount: {
            type: [String, Number, Object] as PropType<string | number | Decimal | null | undefined>,
            default: null,
        },
        currency: { type: String, default: DEFAULT_CURRENCY },
        decimals: { type: Number, default: undefined },
        size: { type: String as PropType<keyof typeof FONT_SIZE>, default: "md" },
        colorSign: { type: Boolean, default: false },
        showCurrency: { type: Boolean, default: true },
    },
    setup(props) {
        return (): VNodeChild => {
            if (props.amount === null || props.amount === undefined || props.amount === "") {
                return <span style={{ color: "var(--pg-ink-faint)" }}>—</span>;
            }
            let dec: Decimal;
            try {
                dec = new Decimal(String(props.amount));
            } catch {
                return (
                    <span class="pg-tabular" style={{ color: "var(--pg-status-danger-text)" }} title="Invalid amount">
                        {String(props.amount)}
                    </span>
                );
            }
            const currency = (props.currency || DEFAULT_CURRENCY).toUpperCase();
            const precision = props.decimals ?? currencyPrecision(currency);
            const isNegative = dec.isNegative();
            const fixed = dec.abs().toFixed(precision);
            const [intPartRaw = "0", fracPart = ""] = fixed.split(".");
            const intPart = intPartRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
            const inkColor =
                props.colorSign && isNegative
                    ? "var(--pg-status-danger-text)"
                    : props.colorSign && dec.gt(0)
                      ? "var(--pg-status-success-text)"
                      : "var(--pg-ink-primary)";
            return (
                <span
                    class="pg-money pg-tabular"
                    dir="ltr"
                    title={`${fixed} ${currency}`}
                    aria-label={`${fixed} ${currency}`}
                    style={{
                        display: "inline-flex",
                        alignItems: "baseline",
                        gap: "4px",
                        fontSize: FONT_SIZE[props.size],
                        fontWeight: props.size === "lg" || props.size === "xl" ? 600 : 500,
                        color: inkColor,
                        whiteSpace: "nowrap",
                    }}
                >
                    <span>
                        {isNegative ? "-" : ""}
                        {intPart}
                        {fracPart && (
                            <span style={{ color: "var(--pg-ink-muted)", fontSize: "0.88em", fontWeight: 400 }}>
                                .{fracPart}
                            </span>
                        )}
                    </span>
                    {props.showCurrency && (
                        <span
                            style={{
                                fontSize: "0.78em",
                                fontWeight: 500,
                                color: "var(--pg-ink-muted)",
                                letterSpacing: "0.02em",
                            }}
                        >
                            {currency}
                        </span>
                    )}
                </span>
            );
        };
    },
});

export default MoneyDisplay;
