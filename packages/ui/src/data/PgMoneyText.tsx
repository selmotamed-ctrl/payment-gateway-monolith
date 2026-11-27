import Decimal from "decimal.js";
import { computed } from "vue";
import { dc } from "../lib/dc";
import { currencyPrecision, DEFAULT_CURRENCY, formatMoney, isMoneyInput, toDecimal, type FormatMoneyOptions, type MoneyInput } from "../lib/money";

export type PgMoneySize = "sm" | "md" | "lg" | "xl";

type MoneyRender = {
    empty: boolean;
    full: string;
    bodyInteger: string;
    fraction: string;
    currency: string;
    tone: "positive" | "negative" | "zero";
};

const moneyRender = (
    amount: MoneyInput,
    currency: string,
    precision: number,
    signed: boolean,
): MoneyRender => {
    const empty = !isMoneyInput(amount);
    const decimal = empty ? null : toDecimal(amount);
    const full = empty ? "—" : formatMoney(amount, { currency, precision, showSign: signed });
    if (!decimal) {
        return { empty: true, full, bodyInteger: "—", fraction: "", currency, tone: "zero" };
    }
    const options: FormatMoneyOptions = { currency, precision, showCurrency: false, showSign: signed };
    const body = formatMoney(amount, options);
    const fractionIndex = body.lastIndexOf(".");
    return {
        empty: false,
        full,
        bodyInteger: fractionIndex >= 0 ? body.slice(0, fractionIndex) : body,
        fraction: fractionIndex >= 0 ? body.slice(fractionIndex) : "",
        currency,
        tone: decimal.isNegative() && !decimal.isZero() ? "negative" : decimal.gt(0) ? "positive" : "zero",
    };
};

/**
 * Strict tabular currency display.
 *
 * Formatting is delegated to `formatMoney` (decimal.js, never IEEE-754), and
 * the number is always rendered in an LTR isolate so `-1,250.500 LYD` keeps its
 * minus sign and order inside RTL table cells. The currency code is a smaller,
 * muted suffix and decimals can be muted independently.
 */
export const PgMoneyText = dc(
    (
        props: {
            amount?: MoneyInput;
            currency?: string;
            decimals?: number;
            size?: PgMoneySize;
            signed?: boolean;
            colorSign?: boolean;
            showCurrency?: boolean;
            mutedDecimals?: boolean;
        },
        _expose,
        { attrs },
    ) => {
        const render = computed(() => {
            const currency = (props.currency || DEFAULT_CURRENCY).toUpperCase();
            const precision = props.decimals ?? currencyPrecision(currency);
            return moneyRender(props.amount, currency, precision, Boolean(props.signed));
        });
        const showTone = computed(() => Boolean(props.signed || props.colorSign));

        return () => {
            return (
                <span
                    {...attrs}
                    class={[
                        "pg-money",
                        render.value.empty ? "pg-money--empty" : `pg-money--${props.size ?? "md"}`,
                        !render.value.empty && showTone.value ? `pg-money--${render.value.tone}` : "",
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    dir="ltr"
                    style={[{ unicodeBidi: "isolate" }, (attrs as { style?: any }).style]}
                    title={render.value.full}
                    aria-label={render.value.full}
                >
                    {render.value.empty ? (
                        "—"
                    ) : (
                        <>
                            <span class="pg-money__amount">
                                {render.value.bodyInteger}
                                {render.value.fraction && (
                                    <span
                                        class={[
                                            "pg-money__fraction",
                                            props.mutedDecimals ? "pg-money__fraction--muted" : "",
                                        ]
                                            .filter(Boolean)
                                            .join(" ")}
                                    >
                                        {render.value.fraction}
                                    </span>
                                )}
                            </span>
                            {props.showCurrency !== false && (
                                <span class="pg-money__currency">{render.value.currency}</span>
                            )}
                        </>
                    )}
                </span>
            );
        };
    },
    {
        props: {
            amount: { type: [String, Number, Object], default: null },
            currency: { type: String, default: DEFAULT_CURRENCY },
            decimals: { type: Number, default: undefined },
            size: { type: String, default: "md" },
            signed: { type: Boolean, default: false },
            colorSign: { type: Boolean, default: false },
            showCurrency: { type: Boolean, default: true },
            mutedDecimals: { type: Boolean, default: false },
        },
        inheritAttrs: true,
    },
);

/** No-op reference keeps the imported `Decimal` type visible to callers that pass one. */
export type PgMoneyDecimal = Decimal;

export const MoneyDisplay = PgMoneyText;
export const MoneyText = PgMoneyText;
