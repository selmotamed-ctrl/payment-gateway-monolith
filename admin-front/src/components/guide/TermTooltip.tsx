import { dc } from "kt-dc";
import { VBtn, VCard, VCardText, VChip, VMenu } from "vuetify/components";
import { useLocale } from "vuetify";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { lookupTerm } from "@/content/guide/legacy";

type TermTooltipProps = {
    term: string;
    label?: string;
    tone?: "primary" | "success" | "warning" | "error" | "info" | "neutral";
    size?: "x-small" | "small";
};

export const TermTooltip = dc(
    (props: TermTooltipProps) => {
        const { current } = useLocale();
        const isArabic = () => current.value === "ar";
        return () => {
            const explanation = lookupTerm(props.term);
            if (!explanation) {
                return <VChip size={props.size ?? "x-small"} variant="tonal">{props.label ?? props.term}</VChip>;
            }
            const meaning = isArabic() && explanation.meaningAr ? explanation.meaningAr : explanation.meaningEn;
            const action = isArabic() && explanation.actionAr ? explanation.actionAr : explanation.actionEn;
            return (
                <VMenu openOnClick openOnHover location="bottom start" closeDelay={120}>
                    {{
                        activator: ({ props: activatorProps }: any) => (
                            <VChip
                                {...activatorProps}
                                size={props.size ?? "x-small"}
                                color={props.tone ?? "primary"}
                                variant="tonal"
                                style={{ cursor: "help", fontWeight: 700 }}
                            >
                                {props.label ?? props.term}
                            </VChip>
                        ),
                        default: () => (
                            <VCard maxWidth={460} style={{ overflow: "hidden" }}>
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{explanation.title}</ThemedText>
                                        <VChip size="x-small" variant="text">{explanation.category}</VChip>
                                    </ThemedView>
                                    <ThemedText style={{ fontSize: "13px", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{meaning}</ThemedText>
                                    {action ? (
                                        <div
                                            style={{
                                                fontSize: "12px",
                                                lineHeight: 1.6,
                                                padding: "8px 10px",
                                                borderRadius: "8px",
                                                background: "rgba(239,68,68,0.08)",
                                                whiteSpace: "pre-wrap",
                                            }}
                                        >
                                            {action}
                                        </div>
                                    ) : null}
                                    <VBtn
                                        size="small"
                                        variant="text"
                                        appendIcon="mdi-book-open-variant"
                                        href="#/guide"
                                        style={{ alignSelf: "flex-end" }}
                                    >
                                        Open the full guide
                                    </VBtn>
                                </VCardText>
                            </VCard>
                        ),
                    }}
                </VMenu>
            );
        };
    },
    { props: ["term", "label", "tone", "size"] as any },
);

export default TermTooltip;
