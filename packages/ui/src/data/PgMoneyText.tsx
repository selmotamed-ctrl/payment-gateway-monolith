import Decimal from "decimal.js";
import { dc } from "../lib/dc";
import { currencyPrecision, DEFAULT_CURRENCY } from "../lib/money";

const FONT_SIZE = { sm: "12.5px", md: "13.5px", lg: "18px", xl: "24px" } as const;

/** Strict tabular currency display; LYD keeps three decimals. */
export const PgMoneyText = dc(
    (props: {
        amount?: string | number | Decimal | null;
        currency?: string;
        decimals?: number;
        size?: keyof typeof FONT_SIZE;
        colorSign?: boolean;
        showCurrency?: boolean;
    }, _expose, { attrs }) => () => {
        const empty = props.amount === null || props.amount === undefined || props.amount === "";
        let decimal: Decimal | null = null;
        try {
            decimal = empty ? null : new Decimal(String(props.amount));
        } catch {
            decimal = null;
        }
        const renderValue = (value: Decimal) => {
            const currency = (props.currency || DEFAULT_CURRENCY).toUpperCase();
            const precision = props.decimals ?? currencyPrecision(currency);
            const negative = value.isNegative();
            const fixed = value.abs().toFixed(precision);
            const [integerRaw = "0", fraction = ""] = fixed.split(".");
            const integer = integerRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
            const color =
                props.colorSign && negative
                    ? "var(--pg-status-danger-text)"
                    : props.colorSign && value.gt(0)
                      ? "var(--pg-status-success-text)"
                      : "var(--pg-ink-primary)";
            return (
                <span
                    {...attrs}
                    class={["pg-money", "pg-tabular", attrs.class].filter(Boolean).join(" ")}
                    dir="ltr"
                    title={`${fixed} ${currency}`}
                    aria-label={`${fixed} ${currency}`}
                    style={[
                        {
                            display: "inline-flex",
                            alignItems: "baseline",
                            gap: "4px",
                            fontSize: FONT_SIZE[props.size ?? "md"],
                            fontWeight: props.size === "lg" || props.size === "xl" ? 650 : 500,
                            color,
                            whiteSpace: "nowrap",
                        },
                        (attrs as { style?: any }).style,
                    ]}
                >
                    <span>
                        {negative ? "-" : ""}
                        {integer}
                        {fraction && <span class="pg-money__fraction">.{fraction}</span>}
                    </span>
                    {props.showCurrency !== false && <span class="pg-money__currency">{currency}</span>}
                </span>
            );
        };
        return empty ? (
            <span {...attrs} class={["pg-money", "pg-money--empty", attrs.class].filter(Boolean).join(" ")}>—</span>
        ) : !decimal ? (
            <span {...attrs} class={["pg-money", "pg-money--invalid", attrs.class].filter(Boolean).join(" ")}>{String(props.amount)}</span>
        ) : (
            renderValue(decimal)
        );
    },
    {
        props: {
            amount: { type: [String, Number, Object], default: null },
            currency: { type: String, default: DEFAULT_CURRENCY },
            decimals: { type: Number, default: undefined },
            size: { type: String, default: "md" },
            colorSign: { type: Boolean, default: false },
            showCurrency: { type: Boolean, default: true },
        },
        inheritAttrs: true,
    },
);

export const MoneyDisplay = PgMoneyText;
export const MoneyText = PgMoneyText;
