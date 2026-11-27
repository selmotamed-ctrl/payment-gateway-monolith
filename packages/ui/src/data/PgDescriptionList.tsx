import { dc } from "../lib/dc";
import { PgMoneyText } from "./PgMoneyText";

export interface PgDescriptionItem {
    label: string;
    value?: any;
    mono?: boolean;
    money?: boolean;
    currency?: string;
}

/** Spacious key-value detail grid with copyable mono values and money. */
export const PgDescriptionList = dc(
    (props: { items: PgDescriptionItem[]; columns?: 1 | 2; ariaLabel?: string }, _expose, { slots }) => () => {
        return (
            <dl class={["pg-description-list", props.columns === 2 ? "pg-description-list--two" : ""]} aria-label={props.ariaLabel || undefined}>
                {props.items.map((item, index) => (
                    <div key={`${item.label}-${index}`} class="pg-description-list__row">
                        <dt>{item.label}</dt>
                        <dd>
                            {item.money ? (
                                <PgMoneyText amount={typeof item.value === "string" || typeof item.value === "number" ? item.value : null} currency={item.currency} />
                            ) : item.mono ? (
                                <span class="pg-mono">{item.value ?? "—"}</span>
                            ) : (
                                (item.value ?? "—")
                            )}
                        </dd>
                    </div>
                ))}
                {slots.default?.()}
            </dl>
        );
    },
    {
        props: {
            items: { type: Array as () => PgDescriptionItem[], default: () => [] },
            columns: { type: Number, default: 1 },
            ariaLabel: { type: String, default: "" },
        },
    },
);

export const DescriptionList = PgDescriptionList;
