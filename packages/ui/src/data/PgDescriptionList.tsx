import { computed } from "vue";
import { dc } from "../lib/dc";
import { isEmpty } from "../lib/rules";
import { PgMoneyText } from "./PgMoneyText";
import { PgStatusBadge } from "../feedback/PgStatusBadge";

export type PgDescriptionType = "text" | "mono" | "money" | "status";

export interface PgDescriptionItem {
    label: string;
    value?: any;
    mono?: boolean;
    money?: boolean;
    type?: PgDescriptionType;
    currency?: string;
}

/**
 * Compact key/value list for drawers and summary cards. Uses native dl/dt/dd
 * semantics, logical hairlines and a responsive CSS grid; money and identifiers
 * stay LTR-isolated inside Arabic layouts.
 */
export const PgDescriptionList = dc(
    (
        props: {
            items?: PgDescriptionItem[];
            columns?: number;
            layout?: "stacked" | "horizontal";
            ariaLabel?: string;
        },
        _expose,
        { attrs, slots },
    ) => {
        const items = computed(() => props.items ?? []);
        const columns = computed(() => Math.max(1, Math.min(4, Number(props.columns) || 1)));
        return () => {
            const layout = props.layout === "stacked" ? "stacked" : "horizontal";
            return (
                <dl
                    {...attrs}
                    class={[
                        "pg-description-list",
                        `pg-description-list--${layout}`,
                        columns.value > 1 ? "pg-description-list--grid" : "",
                        attrs.class,
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    data-columns={String(columns.value)}
                    aria-label={props.ariaLabel || undefined}
                >
                    {items.value.map((item, index) => {
                        const type: PgDescriptionType =
                            item.type ?? (item.money ? "money" : item.mono ? "mono" : "text");
                        const empty = isEmpty(item.value);
                        return (
                            <div key={`${item.label}-${index}`} class="pg-description-list__row">
                                <dt>{item.label}</dt>
                                <dd>
                                    {empty ? (
                                        "—"
                                    ) : slots[`value-${index}`] ? (
                                        slots[`value-${index}`]?.()
                                    ) : type === "money" ? (
                                        <PgMoneyText amount={item.value as string | number} currency={item.currency} size="md" />
                                    ) : type === "status" ? (
                                        <PgStatusBadge status={String(item.value)} showDot={false} />
                                    ) : type === "mono" ? (
                                        <span class="pg-mono" dir="ltr">
                                            {String(item.value)}
                                        </span>
                                    ) : (
                                        item.value
                                    )}
                                </dd>
                            </div>
                        );
                    })}
                    {slots.default?.()}
                </dl>
            );
        };
    },
    {
        props: {
            items: { type: Array as () => PgDescriptionItem[], default: () => [] },
            columns: { type: Number, default: 1 },
            layout: { type: String, default: "horizontal" },
            ariaLabel: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);

export const DescriptionList = PgDescriptionList;
