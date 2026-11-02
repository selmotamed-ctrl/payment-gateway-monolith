import { defineComponent, type PropType, type VNodeChild } from "vue";
import { MoneyDisplay } from "./MoneyDisplay";
import { StatusBadge, type BadgeTone } from "./StatusBadge";
import { DEFAULT_CURRENCY } from "@/utils/money";

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
                aria-busy={props.loading ? "true" : "false"}
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: "1px",
                    backgroundColor: "var(--pg-border-subtle)",
                    border: "1px solid var(--pg-border-subtle)",
                    borderRadius: "var(--pg-radius-md)",
                    boxShadow: "var(--pg-shadow-xs)",
                    marginBottom: "20px",
                    overflow: "hidden",
                }}
            >
                {props.items.map((item) => (
                    <div
                        key={item.key}
                        style={{
                            padding: "16px 20px",
                            backgroundColor: "var(--pg-bg-surface)",
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "space-between",
                            gap: "6px",
                            minWidth: 0,
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                            <span
                                class="pg-metric-label"
                                style={{
                                    fontSize: "11px",
                                    fontWeight: 600,
                                    letterSpacing: "0.04em",
                                    textTransform: "uppercase",
                                    color: "var(--pg-ink-muted)",
                                }}
                            >
                                {item.label}
                            </span>
                            {item.badge && (
                                <StatusBadge status={item.badge} toneOverride={item.badgeTone} showDot={false} />
                            )}
                        </div>
                        <div
                            class="pg-tabular"
                            style={{
                                fontSize: "24px",
                                fontWeight: 600,
                                color: "var(--pg-ink-primary)",
                                lineHeight: 1.2,
                                minWidth: 0,
                            }}
                        >
                            {props.loading ? (
                                <span style={{ color: "var(--pg-ink-faint)", fontSize: "16px" }}>…</span>
                            ) : item.moneyAmount !== undefined ? (
                                <MoneyDisplay
                                    amount={item.moneyAmount}
                                    currency={item.currency ?? DEFAULT_CURRENCY}
                                    size="xl"
                                />
                            ) : (
                                <span>{item.value ?? "—"}</span>
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
