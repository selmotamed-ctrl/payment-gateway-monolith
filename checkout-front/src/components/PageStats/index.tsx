import { dc } from "kt-dc";
import { VCard, VCardText, VIcon, VProgressCircular } from "vuetify/components";
import { useDisplay, useTheme } from "vuetify";
import colors from "vuetify/util/colors";

export type PageStatItem = {
    title: string;
    value: string | number;
    icon: string;
    color?: string;
    subtitle?: string;
    secondaryValue?: string | number;
    loading?: boolean;
};

const PageStatCard = dc(
    (props: PageStatItem) => {
        const display = useDisplay();
        const isMobile = display.mobile.value;
        const theme = useTheme();
        return () => {
            const color = props.color || colors.blue.base;

            return (
                <Card
                    style={{
                        flex: 1,
                        background: theme.current.value.colors.surface+"88" ,
                    }}

                >
                    <ThemedView
                        style={{
                            alignItems: "center",
                            justifyContent: "center",
                            width: "100%",
                        }}
                    >
                        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                            <div
                                style={{
                                    background: `${color}20`,
                                    borderRadius: "12px",
                                    padding: isMobile ? "8px" : "10px",
                                    display: "flex",
                                    "align-items": "center",
                                    "justify-content": "center",
                                }}
                            >
                                <VIcon size={isMobile ? "20px" : "24px"} color={color}>
                                    {props.icon}
                                </VIcon>
                            </div>
                        </div>

                        <div>
                            <div
                                style={{
                                    "font-size": isMobile ? "11px" : "12px",
                                    opacity: 0.5,
                                    "text-transform": "uppercase",
                                    "letter-spacing": "0.8px",
                                    "font-weight": 600,
                                }}
                            >
                                {props.title}
                            </div>
                            <div
                                style={{
                                    "font-size": isMobile ? "24px" : "28px",
                                    "font-weight": 700,
                                    "line-height": 1.1,
                                    textAlign: "center",
                                    "margin-top": "4px",
                                    background: `linear-gradient(135deg, #fff 0%, ${color}80 100%)`,
                                    "-webkit-background-clip": "text",
                                    "-webkit-text-fill-color": "transparent",
                                }}
                            >
                                {props.loading ? <VProgressCircular indeterminate size="24" color="primary" /> : props.value}
                            </div>
                            {props.subtitle && !props.loading && (
                                <div
                                    style={{
                                        "font-size": isMobile ? "11px" : "12px",
                                        opacity: 0.4,
                                        textAlign: "center",
                                        "margin-top": "4px",
                                    }}
                                >
                                    {props.subtitle}
                                </div>
                            )}
                            {props.secondaryValue && !props.loading && (
                                <div
                                    style={{
                                        "font-size": isMobile ? "12px" : "13px",
                                        color: color,
                                        textAlign: "center",
                                        "margin-top": "4px",
                                        "font-weight": 500,
                                    }}
                                >
                                    {props.secondaryValue}
                                </div>
                            )}
                        </div>
                    </ThemedView>
                </Card>
            );
        };
    },
    {
        props: ["title", "value", "icon", "color", "subtitle", "secondaryValue", "loading"],
    },
);

const PageStats = dc(
    (props: { stats: PageStatItem[]; loading?: boolean; title?: string }) => {
        const display = useDisplay();
        const isMobile = display.mobile.value;

        return () => {
            return (
                <div
                    style={{
                        display: "flex",
                        "flex-direction": "column",
                        gap: isMobile ? "12px" : "22px",
                    }}
                >
                    {props.title && (
                        <div
                            style={{
                                "font-size": isMobile ? "14px" : "16px",
                                "font-weight": 600,
                                padding: "0 4px",
                                opacity: 0.8,
                            }}
                        >
                            {props.title}
                        </div>
                    )}
                    <div
                        style={{
                            display: "flex",
                            gap: isMobile ? "8px" : "22px",
                            "flex-wrap": "wrap",
                        }}
                    >
                        {props.stats.map((stat, index) => (
                            <PageStatCard key={index} {...stat} loading={props.loading} />
                        ))}
                    </div>
                </div>
            );
        };
    },
    {
        props: ["stats", "loading", "title"],
    },
);

export default PageStats;
export { PageStatCard, PageStats };
