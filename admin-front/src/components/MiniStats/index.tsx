import { dc } from "kt-dc";
import { VCard, VCardText, VIcon, VProgressCircular } from "vuetify/components";
import { useDisplay } from "vuetify";
import colors from "vuetify/util/colors";

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

const MiniStatCard = dc((props: StatItem & { loading?: boolean }) => {
    const display = useDisplay();
    const isMobile = display.mobile.value;

    return () => {
        const color = props.color || colors.blue.base;

        return (
            <VCard
                style={{
                    minWidth: isMobile ? "140px" : "180px",
                    flex: "1",
                }}
            >
                <VCardText style={{ padding: isMobile ? "12px" : "16px" }}>
                    <div style={{ display: "flex", "align-items": "flex-start", gap: "12px" }}>
                        {props.loading ? (
                            <VProgressCircular indeterminate size={"32px"} color="primary" />
                        ) : (
                            <div
                                style={{
                                    background: `${color}15`,
                                    borderRadius: "10px",
                                    padding: "8px",
                                    display: "flex",
                                    "align-items": "center",
                                    "justify-content": "center",
                                }}
                            >
                                <VIcon size={"24px"} color={color}>{props.icon}</VIcon>
                            </div>
                        )}
                        <div style={{ flex: 1, "min-width": 0 }}>
                            <div
                                style={{
                                    "font-size": isMobile ? "10px" : "11px",
                                    opacity: 0.6,
                                    "text-transform": "uppercase",
                                    "letter-spacing": "0.5px",
                                    "font-weight": 500,
                                }}
                            >
                                {props.title}
                            </div>
                            <div
                                style={{
                                    "font-size": isMobile ? "18px" : "22px",
                                    "font-weight": 700,
                                    "line-height": 1.2,
                                    "margin-top": "2px",
                                    "white-space": "nowrap",
                                    "overflow": "hidden",
                                    "text-overflow": "ellipsis",
                                }}
                            >
                                {props.loading ? "..." : props.value}
                            </div>
                            {props.subtitle && !props.loading && (
                                <div
                                    style={{
                                        "font-size": isMobile ? "10px" : "11px",
                                        opacity: 0.5,
                                        "margin-top": "2px",
                                    }}
                                >
                                    {props.subtitle}
                                </div>
                            )}
                            {props.trend && !props.loading && (
                                <div
                                    style={{
                                        "font-size": "11px",
                                        "margin-top": "4px",
                                        color: props.trend.positive ? colors.green.base : colors.red.base,
                                        display: "flex",
                                        "align-items": "center",
                                        gap: "2px",
                                    }}
                                >
                                    <VIcon size="14px">
                                        {props.trend.positive ? "mdi-trending-up" : "mdi-trending-down"}
                                    </VIcon>
                                    {Math.abs(props.trend.value)}%
                                </div>
                            )}
                        </div>
                    </div>
                </VCardText>
            </VCard>
        );
    };
}, {
    props: ["title", "value", "icon", "color", "subtitle", "loading", "trend"]
});

const MiniStats = dc((props: {
    stats: StatItem[];
    loading?: boolean;
    gap?: string;
}) => {
    const display = useDisplay();
    const isMobile = display.mobile.value;
    const isTablet = display.sm.value;

    return () => {
        const gap = props.gap || (isMobile ? "8px" : "12px");

        return (
            <div
                style={{
                    display: "flex",
                    gap: gap,
                    "flex-wrap": "wrap",
                    padding: isMobile ? "12px" : "16px",
                }}
            >
                {props.stats.map((stat, index) => (
                    <MiniStatCard
                        key={index}
                        {...stat}
                        loading={props.loading}
                    />
                ))}
            </div>
        );
    };
}, {
    props: ["stats", "loading", "gap"]
});

export default MiniStats;
export { MiniStatCard, MiniStats };
