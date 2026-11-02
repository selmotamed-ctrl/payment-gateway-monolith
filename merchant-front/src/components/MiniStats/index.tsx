import { dc } from "kt-dc";
import { MetricStrip, type MetricItem } from "@/components/ui/MetricStrip";
import type { BadgeTone } from "@/components/ui/StatusBadge";

export type StatItem = {
    title: string;
    value: string | number;
    icon: string;
    color?: string;
    subtitle?: string;
    trend?: {
        value: number;
        positive: boolean;
    };
};

const toMetricItem = (stat: StatItem, index: number): MetricItem => ({
    key: `${index}-${stat.title}`,
    label: stat.title,
    value: stat.value,
    subLabel: stat.subtitle,
    badge: stat.trend ? `${stat.trend.positive ? "▲" : "▼"} ${Math.abs(stat.trend.value)}%` : undefined,
    badgeTone: stat.trend ? ((stat.trend.positive ? "success" : "danger") as BadgeTone) : undefined,
});

const MiniStatCard = dc(
    (props: StatItem & { loading?: boolean }) => {
        return () => <MetricStrip items={[toMetricItem(props, 0)]} loading={!!props.loading} />;
    },
    {
        props: ["title", "value", "icon", "color", "subtitle", "loading", "trend"],
    },
);

const MiniStats = dc(
    (props: {
        stats: StatItem[];
        loading?: boolean;
        gap?: string;
    }) => {
        return () => (
            <MetricStrip
                items={props.stats.map((stat, index) => toMetricItem(stat, index))}
                loading={!!props.loading}
            />
        );
    },
    {
        props: ["stats", "loading", "gap"],
    },
);

export default MiniStats;
export { MiniStatCard, MiniStats };
