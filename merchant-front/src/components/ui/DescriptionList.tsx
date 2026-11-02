import { defineComponent, type PropType, type VNodeChild } from "vue";
import { MoneyDisplay } from "./MoneyDisplay";

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
    },
    setup(props) {
        return (): VNodeChild => (
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: props.columns === 2 ? "repeat(auto-fit, minmax(260px, 1fr))" : "1fr",
                    gap: "0 24px",
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
                            borderBottom: "1px solid var(--pg-border-subtle)",
                            minWidth: 0,
                        }}
                    >
                        <span style={{ fontSize: "12.5px", color: "var(--pg-ink-muted)", flex: "0 0 auto" }}>
                            {item.label}
                        </span>
                        <span
                            style={{
                                fontSize: "13.5px",
                                color: "var(--pg-ink-primary)",
                                textAlign: "end",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                            }}
                        >
                            {item.money ? (
                                <MoneyDisplay
                                    amount={item.value as string | number | null | undefined}
                                    currency={item.currency ?? "LYD"}
                                />
                            ) : item.mono ? (
                                <span class="pg-mono">{item.value ?? "—"}</span>
                            ) : (
                                item.value ?? "—"
                            )}
                        </span>
                    </div>
                ))}
            </div>
        );
    },
});

export default DescriptionList;
