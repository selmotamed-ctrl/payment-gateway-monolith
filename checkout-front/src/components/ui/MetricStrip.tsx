import { defineComponent, type PropType, type VNodeChild } from "vue";
import { MoneyDisplay } from "./MoneyDisplay";
import { StatusBadge, type BadgeTone } from "./StatusBadge";

export interface MetricItem {
    key: string;
    label: string;
    value?: string | number;
    moneyAmount?: string | number;
    currency?: string;
    subLabel?: string;
    badge?: string;
    badgeTone?: BadgeTone;
}

export const MetricStrip = defineComponent({
    name: "MetricStrip",
    props: {
        items: { type: Array as PropType<MetricItem[]>, required: true },
        loading: { type: Boolean, default: false },
    },
    setup(props) {
        return (): VNodeChild => (
            <section
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    backgroundColor: "var(--pg-bg-surface)",
                    border: "1px solid var(--pg-border-subtle)",
                    borderRadius: "var(--pg-radius-md)",
                    boxShadow: "var(--pg-shadow-xs)",
                    marginBottom: "20px",
                    overflow: "hidden",
                }}
            >
                {props.items.map((item, idx) => (
                    <div
                        key={item.key}
                        style={{
                            padding: "16px 20px",
                            borderInlineEnd: idx < props.items.length - 1 ? "1px solid var(--pg-border-subtle)" : "none",
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "space-between",
                            gap: "6px",
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                            <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--pg-ink-muted)" }}>
                                {item.label}
                            </span>
                            {item.badge && (
                                <StatusBadge status={item.badge} toneOverride={item.badgeTone} showDot={false} />
                            )}
                        </div>
                        <div
                            class="pg-tabular"
                            style={{
                                fontSize: "22px",
                                fontWeight: 600,
                                color: "var(--pg-ink-primary)",
                                lineHeight: 1.2,
                            }}
                        >
                            {props.loading ? (
                                <span style={{ color: "var(--pg-ink-faint)", fontSize: "16px" }}>…</span>
                            ) : item.moneyAmount !== undefined ? (
                                <MoneyDisplay amount={item.moneyAmount} currency={item.currency ?? "LYD"} size="lg" />
                            ) : (
                                <span>{item.value ?? "0"}</span>
                            )}
                        </div>
                        {item.subLabel && (
                            <div style={{ fontSize: "12px", color: "var(--pg-ink-muted)" }}>{item.subLabel}</div>
                        )}
                    </div>
                ))}
            </section>
        );
    },
});

export default MetricStrip;
