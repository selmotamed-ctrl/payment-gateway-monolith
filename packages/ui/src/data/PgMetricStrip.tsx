import { dc } from "../lib/dc";
import { PgIcon } from "../actions/PgIcon";
import { PgStatusBadge } from "../feedback/PgStatusBadge";
import { PgMoneyText } from "./PgMoneyText";

export type MetricTone = "success" | "warning" | "danger" | "info" | "neutral";

export interface PgMetricItem {
    key: string;
    label: string;
    value?: string | number;
    moneyAmount?: string | number;
    currency?: string;
    subLabel?: string;
    badge?: string;
    badgeTone?: MetricTone;
    icon?: string;
}

/**
 * Seamless zero-gap KPI bento. Every tile paints its own hairline with an inset
 * shadow and a negative margin, so wrapping rows never expose a gray dead cell
 * (the old `gap: 1px` + background trick did).
 */
export const PgMetricStrip = dc(
    (props: { items: PgMetricItem[]; loading?: boolean; ariaLabel?: string }, _expose, { attrs }) => () => (
        <section
            {...attrs}
            class={["pg-metric-strip", attrs.class].filter(Boolean).join(" ")}
            aria-label={props.ariaLabel || "Key metrics"}
            aria-busy={props.loading ? "true" : "false"}
        >
            {props.items.map((item) => (
                <div key={item.key} class="pg-metric-tile">
                    <div class="pg-metric-tile__head">
                        <span class="pg-metric-label">
                            {item.icon && <PgIcon icon={item.icon} size={14} />}
                            {item.label}
                        </span>
                        {item.badge && <PgStatusBadge status={item.badge} toneOverride={item.badgeTone} showDot={false} />}
                    </div>
                    <div class="pg-metric-value">
                        {props.loading ? (
                            <span class="pg-metric-loading">…</span>
                        ) : item.moneyAmount !== undefined ? (
                            <PgMoneyText amount={item.moneyAmount} currency={item.currency} size="xl" />
                        ) : (
                            <span>{item.value ?? "—"}</span>
                        )}
                    </div>
                    {item.subLabel && <div class="pg-metric-sub">{item.subLabel}</div>}
                </div>
            ))}
        </section>
    ),
    {
        props: {
            items: { type: Array as () => PgMetricItem[], default: () => [] },
            loading: { type: Boolean, default: false },
            ariaLabel: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);

export const MetricStrip = PgMetricStrip;

/** Compatibility wrapper for the old `MiniStats` shape. */
export const PgMiniStats = dc(
    (props: { stats: Array<{ title: string; value: string | number; icon?: string; subtitle?: string }>; loading?: boolean }, _expose, { attrs }) => () => (
        <PgMetricStrip
            {...attrs}
            loading={props.loading}
            items={(props.stats ?? []).map((stat, index) => ({
                key: `stat-${index}`,
                label: stat.title,
                value: stat.value,
                subLabel: stat.subtitle,
                icon: stat.icon,
            }))}
        />
    ),
    { props: { stats: { type: Array as () => any[], default: () => [] }, loading: { type: Boolean, default: false } }, inheritAttrs: true },
);

export const MiniStats = PgMiniStats;
