import { dc } from "@/utils/dc";
import {PgButton, PgCard, PgCardText, PgChip, PgMenu} from "@pg/ui";
import { useLocale } from "@/utils/vael-compat";
import {ThemedView} from "@pg/ui";
import {ThemedText} from "@pg/ui";
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
                return <PgChip size={props.size ?? "x-small"} variant="tonal">{props.label ?? props.term}</PgChip>;
            }
            const meaning = isArabic() && explanation.meaningAr ? explanation.meaningAr : explanation.meaningEn;
            const action = isArabic() && explanation.actionAr ? explanation.actionAr : explanation.actionEn;
            return (
                <PgMenu openOnClick openOnHover location="bottom start" closeDelay={120}>
                    {{
                        activator: ({ props: activatorProps }: any) => (
                            <PgChip
                                {...activatorProps}
                                size={props.size ?? "x-small"}
                                color={props.tone ?? "primary"}
                                variant="tonal"
                                style={{ cursor: "help", fontWeight: 700 }}
                            >
                                {props.label ?? props.term}
                            </PgChip>
                        ),
                        default: () => (
                            <PgCard maxWidth={460} style={{ overflow: "hidden" }}>
                                <PgCardText style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                    <ThemedView style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                                        <ThemedText type="defaultSemiBold" style={{ fontSize: "16px" }}>{explanation.title}</ThemedText>
                                        <PgChip size="x-small" variant="text">{explanation.category}</PgChip>
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
                                    <PgButton
                                        size="small"
                                        variant="text"
                                        appendIcon="mdi-book-open-variant"
                                        href="#/guide"
                                        style={{ alignSelf: "flex-end" }}
                                    >
                                        Open the full guide
                                    </PgButton>
                                </PgCardText>
                            </PgCard>
                        ),
                    }}
                </PgMenu>
            );
        };
    },
    { props: ["term", "label", "tone", "size"] as any },
);

export default TermTooltip;
