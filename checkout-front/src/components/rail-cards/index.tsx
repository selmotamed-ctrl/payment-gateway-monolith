import { dc } from "kt-dc";
import { useLocale } from "vuetify";
import { VCard, VCardText, VIcon } from "vuetify/components";
import { ThemedText } from "@/components/ThemedText";
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
            <ThemedView style={{ gap: "10px", width: "100%" }}>
                <ThemedText type="defaultSemiBold">{t("Choose Payment Method")}</ThemedText>
                <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "10px" }}>
                    {(props.rails ?? []).map((rail) => {
                        const selected = rail.code === props.selectedCode;
                        const title =
                            current.value === "ar" ? rail.displayNameAr || rail.displayNameEn : rail.displayNameEn || rail.displayNameAr;
                        return (
                            <VCard
                                key={rail.code}
                                onClick={() => props.onSelect(rail)}
                                style={{
                                    minWidth: "160px",
                                    cursor: "pointer",
                                    border: selected ? "2px solid #0f6bff" : "1px solid rgba(100,116,139,0.25)",
                                    background: selected ? "rgba(15,107,255,0.08)" : undefined,
                                }}
                            >
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px" }}>
                                    <VIcon icon={collectionModeIcon(rail.collectionMode)} size={"26px"} color="primary" />
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "14px" }}>
                                        {title}
                                    </ThemedText>
                                    <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{rail.collectionMode}</ThemedText>
                                </VCardText>
                            </VCard>
                        );
                    })}
                </ThemedView>
            </ThemedView>
        );
    },
    {
        props: ["rails", "selectedCode", "onSelect"],
    },
);

export default RailCards;
