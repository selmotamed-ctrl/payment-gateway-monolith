import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import { ThemedText } from "@/components/ThemedText";
import { MetaPill, SurfaceCard } from "@/components/ui";
import type { RailDescriptor } from "@/components/renderers/types";

export type RailCardsProps = {
    rails: RailDescriptor[];
    selectedCode: string | null;
    onSelect: (rail: RailDescriptor) => void;
};

const collectionModeIcon = (mode: string): string => {
    switch (mode) {
        case "OTP_PULL":
            return "mdi-message-badge-outline";
        case "REDIRECT":
            return "mdi-open-in-new";
        case "EMBEDDED":
            return "mdi-credit-card-outline";
        case "QR_DISPLAY":
        case "PAY_CODE":
            return "mdi-qrcode";
        case "PUSH_APPROVAL":
            return "mdi-cellphone-message";
        case "DEEP_LINK":
            return "mdi-link-variant";
        default:
            return "mdi-cash-multiple";
    }
};

export const RailCards = dc(
    (props: RailCardsProps) => {
        const { t, current } = useLocale();

        return () => (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%" }}>
                <ThemedText type="defaultSemiBold" style={{ color: "var(--pg-ink-primary)" }}>
                    {t("Choose Payment Method")}
                </ThemedText>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
                    {(props.rails ?? []).map((rail) => {
                        const selected = rail.code === props.selectedCode;
                        const title =
                            current.value === "ar" ? rail.displayNameAr || rail.displayNameEn : rail.displayNameEn || rail.displayNameAr;
                        return (
                            <SurfaceCard
                                key={rail.code}
                                onClick={() => props.onSelect(rail)}
                                color={selected ? "info" : ""}
                                bodyPadding="12px"
                                bodyGap="6px"
                                style={{
                                    minWidth: "160px",
                                    flex: "1 1 160px",
                                }}
                            >
                                <VIcon
                                    icon={collectionModeIcon(rail.collectionMode)}
                                    size={24}
                                    style={{
                                        color: selected
                                            ? "var(--pg-status-info-text)"
                                            : "var(--pg-ink-secondary)",
                                    }}
                                />
                                <ThemedText
                                    type="defaultSemiBold"
                                    style={{ fontSize: "14px", color: "var(--pg-ink-primary)" }}
                                >
                                    {title}
                                </ThemedText>
                                <MetaPill size="x-small" variant="tonal">
                                    {rail.collectionMode}
                                </MetaPill>
                            </SurfaceCard>
                        );
                    })}
                </div>
            </div>
        );
    },
    {
        props: ["rails", "selectedCode", "onSelect"],
    },
);

export default RailCards;
