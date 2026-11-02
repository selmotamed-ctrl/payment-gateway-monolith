import { defineComponent, type PropType, type VNodeChild } from "vue";
import { MoneyDisplay } from "./MoneyDisplay";
import { DEFAULT_CURRENCY } from "@/utils/money";

export interface DescriptionItem {
    label: string;
    value?: VNodeChild | string | number | null;
    mono?: boolean;
    money?: boolean;
    currency?: string;
}

export const DescriptionList = defineComponent({
    name: "DescriptionList",
    props: {
        items: { type: Array as PropType<DescriptionItem[]>, required: true },
        columns: { type: Number as PropType<1 | 2>, default: 1 },
        ariaLabel: { type: String, default: "" },
    },
    setup(props) {
        return (): VNodeChild => {
            if (!props.items.length) return null;
            return (
                <dl
                    aria-label={props.ariaLabel || undefined}
                    style={{
                        display: "grid",
                        gridTemplateColumns: props.columns === 2 ? "repeat(auto-fit, minmax(260px, 1fr))" : "1fr",
                        columnGap: 0,
                        rowGap: 0,
                        margin: 0,
                        borderTop: "1px solid var(--pg-border-subtle)",
                    }}
                >
                    {props.items.map((item, idx) => (
                        <div
                            key={`${item.label}-${idx}`}
                            style={{
                                display: "flex",
                                alignItems: "baseline",
                                justifyContent: "space-between",
                                gap: "16px",
                                padding: "9px 0",
                                paddingInlineEnd: props.columns === 2 ? "24px" : 0,
                                borderBottom: "1px solid var(--pg-border-subtle)",
                                minWidth: 0,
                            }}
                        >
                            <dt style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)", flex: "0 0 auto", margin: 0 }}>
                                {item.label}
                            </dt>
                            <dd
                                style={{
                                    fontSize: "13.5px",
                                    color: "var(--pg-ink-primary)",
                                    textAlign: "end",
                                    minWidth: 0,
                                    overflowWrap: "anywhere",
                                    margin: 0,
                                }}
                            >
                                {item.money ? (
                                    <MoneyDisplay
                                        amount={
                                            typeof item.value === "string" || typeof item.value === "number"
                                                ? item.value
                                                : null
                                        }
                                        currency={item.currency ?? DEFAULT_CURRENCY}
                                    />
                                ) : item.mono ? (
                                    <span class="pg-mono">{item.value ?? "—"}</span>
                                ) : (
                                    item.value ?? "—"
                                )}
                            </dd>
                        </div>
                    ))}
                </dl>
            );
        };
    },
});

export default DescriptionList;
