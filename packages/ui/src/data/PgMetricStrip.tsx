import { computed } from "vue";
import { dc } from "../lib/dc";
import { PgIcon } from "../actions/PgIcon";
import { PgStatusBadge } from "../feedback/PgStatusBadge";
import { PgSkeleton } from "../feedback/PgEmptyState";
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
    /** Compact tone for `PgMiniStats` values. */
    tone?: MetricTone;
    icon?: string;
}

/**
 * Number of grid columns for the balanced KPI bento.
 *
 * 1-4 keep their count, 5 stays a single clean row on wide screens, 6 becomes a
 * balanced 3x2 grid, and larger strips fall back to four columns. CSS collapses
 * 5/6/4 to two columns on tablets and every strip to one on phones.
 */
const metricColumns = (count: number): string => {
    if (count <= 0) return "4";
    if (count >= 6) return count === 6 ? "3" : "4";
    return String(Math.min(count, 5));
};

const metricValue = (item: PgMetricItem) => {
    if (item.moneyAmount !== undefined && item.moneyAmount !== null && item.moneyAmount !== "") {
        return <PgMoneyText amount={item.moneyAmount} currency={item.currency} size="xl" />;
    }
    return <span class="pg-metric-text">{item.value ?? "—"}</span>;
};

/**
 * Balanced, breathable KPI strip. Every tile is an independent card with its
 * own hairline and shadow, so a wrapped row never exposes a grey dead cell.
 */
export const PgMetricStrip = dc(
    (props: { items: PgMetricItem[]; loading?: boolean; ariaLabel?: string }, _expose, { attrs }) => {
        const items = computed(() => props.items ?? []);
        return () => (
            <section
                {...attrs}
                class={["pg-metric-strip", attrs.class].filter(Boolean).join(" ")}
                data-cols={metricColumns(items.value.length)}
                aria-label={props.ariaLabel || "Key metrics"}
                aria-busy={props.loading ? "true" : "false"}
            >
                {items.value.map((item) => (
                    <div key={item.key} class="pg-metric-tile">
                        <div class="pg-metric-tile__head">
                            <span class="pg-metric-label">
                                {item.icon && <PgIcon icon={item.icon} size={14} />}
                                {item.label}
                            </span>
                            {item.badge && (
                                <PgStatusBadge
                                    status={item.badge}
                                    toneOverride={item.badgeTone}
                                    showDot={false}
                                />
                            )}
                        </div>
                        <div class="pg-metric-value">
                            {props.loading ? (
                                <span class="pg-metric-loading">
                                    <PgSkeleton height="28px" width="72%" />
                                </span>
                            ) : (
                                metricValue(item)
                            )}
                        </div>
                        {item.subLabel && <div class="pg-metric-sublabel">{item.subLabel}</div>}
                    </div>
                ))}
            </section>
        );
    },
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

export interface PgMiniStat {
    title: string;
    value: string | number;
    icon?: string;
    subtitle?: string;
    moneyAmount?: string | number;
    currency?: string;
    tone?: MetricTone;
}

/**
 * Seamless inline KPI bar for drawers and card sub-headers. Cells share a
 * single outer frame and are separated by a logical 1px inline-start hairline,
 * so RTL never doubles a border.
 */
export const PgMiniStats = dc(
    (
        props: {
            items?: PgMetricItem[];
            stats?: PgMiniStat[];
            loading?: boolean;
            ariaLabel?: string;
        },
        _expose,
        { attrs },
    ) => {
        const items = computed<PgMetricItem[]>(() =>
            props.items && props.items.length
                ? props.items
                : (props.stats ?? []).map((stat, index) => ({
                      key: `stat-${index}`,
                      label: stat.title,
                      value: stat.value,
                      moneyAmount: stat.moneyAmount,
                      currency: stat.currency,
                      subLabel: stat.subtitle,
                      icon: stat.icon,
                      tone: stat.tone,
                  })),
        );
        return () => (
            <dl
                {...attrs}
                class={["pg-mini-stats", attrs.class].filter(Boolean).join(" ")}
                aria-label={props.ariaLabel || "Key metrics"}
                aria-busy={props.loading ? "true" : "false"}
            >
                {items.value.map((item) => {
                    const tone = item.tone ?? item.badgeTone ?? "";
                    return (
                        <div key={item.key} class="pg-mini-stats__cell">
                            <dt class="pg-mini-stats__label">
                                {item.icon && <PgIcon icon={item.icon} size={13} />}
                                {item.label}
                            </dt>
                            <dd
                                class={[
                                    "pg-mini-stats__value",
                                    tone ? `pg-mini-stats__value--${tone}` : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                            >
                                {props.loading ? (
                                    <span class="pg-mini-stats__loading">
                                        <PgSkeleton height="15px" width="64%" />
                                    </span>
                                ) : item.moneyAmount !== undefined && item.moneyAmount !== null && item.moneyAmount !== "" ? (
                                    <PgMoneyText amount={item.moneyAmount} currency={item.currency} size="md" />
                                ) : (
                                    (item.value ?? "—")
                                )}
                            </dd>
                            {item.subLabel && <dd class="pg-mini-stats__hint">{item.subLabel}</dd>}
                        </div>
                    );
                })}
            </dl>
        );
    },
    {
        props: {
            items: { type: Array as () => PgMetricItem[], default: () => [] },
            stats: { type: Array as () => PgMiniStat[], default: () => [] },
            loading: { type: Boolean, default: false },
            ariaLabel: { type: String, default: "" },
        },
        inheritAttrs: true,
    },
);

export const MiniStats = PgMiniStats;
export const PageStats = PgMiniStats;
