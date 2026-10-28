import { dc } from "kt-dc";
import { computed, ref } from "vue";
import { VBtn, VChip, VIcon } from "vuetify/components";
import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import type { RailDescriptor } from "@/components/renderers/types";

export type PerRailInstructionsBannerProps = {
    rail: RailDescriptor | null;
    locale: "ar" | "en";
    onOpenHelp?: () => void;
};

const nonEmpty = (values: string[] | null | undefined): string[] =>
    (values ?? []).map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);

export const PerRailInstructionsBanner = dc(
    (props: PerRailInstructionsBannerProps) => {
        const expanded = ref(true);

        const isArabic = computed(() => props.locale === "ar");

        const guide = computed(() => props.rail?.helpGuide ?? null);

        const lastResort = (ar: string[], en: string[]): string[] => {
            if (isArabic.value) {
                return ar.length ? ar : en;
            }
            return en.length ? en : ar;
        };

        const steps = computed(() => {
            const value = guide.value;
            if (!value) {
                return [];
            }
            return lastResort(nonEmpty(value.steps_ar), nonEmpty(value.steps_en));
        });

        const prerequisites = computed(() => {
            const value = guide.value;
            if (!value) {
                return [];
            }
            return lastResort(nonEmpty(value.prerequisites_ar), nonEmpty(value.prerequisites_en));
        });

        const railName = computed(() => {
            const rail = props.rail;
            if (!rail) {
                return "";
            }
            return isArabic.value
                ? rail.displayNameAr || rail.displayNameEn
                : rail.displayNameEn || rail.displayNameAr;
        });

        return () => {
            if (!guide.value) {
                return null;
            }

            const title = isArabic.value
                ? `طريقة الدفع عبر ${railName.value}`
                : `How to pay with ${railName.value}`;
            const stepsLabel = isArabic.value ? "الخطوات" : "Steps";
            const prerequisitesLabel = isArabic.value ? "ما تحتاجه قبل البدء" : "Before you start";
            const expandLabel = expanded.value
                ? isArabic.value
                    ? "إخفاء التعليمات"
                    : "Hide instructions"
                : isArabic.value
                  ? "إظهار التعليمات"
                  : "Show instructions";
            const helpLabel = isArabic.value ? "المساعدة والدعم" : "Help & Support";

            return (
                <div
                    style={{
                        border: "1px solid rgba(15,107,255,0.22)",
                        background: "rgba(15,107,255,0.06)",
                        borderRadius: "12px",
                        padding: "12px 14px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "10px",
                    }}
                >
                    <ThemedView style={{ flexDirection: "row", alignItems: "center", gap: "10px" }}>
                        <VIcon icon="mdi-lightbulb-on-outline" color="primary" size={"22px"} />
                        <ThemedText type="defaultSemiBold" style={{ flex: 1, fontSize: "14px" }}>
                            {title}
                        </ThemedText>
                        <VBtn
                            icon
                            variant="text"
                            size="small"
                            aria-label={expandLabel}
                            onClick={() => (expanded.value = !expanded.value)}
                        >
                            <VIcon icon={expanded.value ? "mdi-chevron-up" : "mdi-chevron-down"} />
                        </VBtn>
                        <VBtn
                            icon
                            variant="text"
                            size="small"
                            aria-label={helpLabel}
                            onClick={() => props.onOpenHelp?.()}
                        >
                            <VIcon icon="mdi-help-circle-outline" color="primary" />
                        </VBtn>
                    </ThemedView>

                    {expanded.value && (
                        <ThemedView style={{ gap: "12px" }}>
                            {prerequisites.value.length > 0 && (
                                <ThemedView style={{ gap: "6px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "12px", opacity: 0.75 }}>
                                        {prerequisitesLabel}
                                    </ThemedText>
                                    <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "6px" }}>
                                        {prerequisites.value.map((item, index) => (
                                            <VChip
                                                key={`${item}-${index}`}
                                                size="small"
                                                variant="tonal"
                                                color="primary"
                                                prependIcon="mdi-check-circle-outline"
                                            >
                                                {item}
                                            </VChip>
                                        ))}
                                    </ThemedView>
                                </ThemedView>
                            )}

                            {steps.value.length > 0 && (
                                <ThemedView style={{ gap: "8px" }}>
                                    <ThemedText type="defaultSemiBold" style={{ fontSize: "12px", opacity: 0.75 }}>
                                        {stepsLabel}
                                    </ThemedText>
                                    {steps.value.map((step, index) => (
                                        <ThemedView
                                            key={`${step}-${index}`}
                                            style={{ flexDirection: "row", alignItems: "flex-start", gap: "10px" }}
                                        >
                                            <span
                                                style={{
                                                    width: "24px",
                                                    height: "24px",
                                                    minWidth: "24px",
                                                    borderRadius: "999px",
                                                    background: "rgb(var(--v-theme-primary))",
                                                    color: "white",
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    fontSize: "12px",
                                                    fontWeight: "800",
                                                }}
                                            >
                                                {index + 1}
                                            </span>
                                            <ThemedText style={{ fontSize: "13px", lineHeight: "1.7", flex: 1 }}>
                                                {step}
                                            </ThemedText>
                                        </ThemedView>
                                    ))}
                                </ThemedView>
                            )}
                        </ThemedView>
                    )}
                </div>
            );
        };
    },
    {
        props: ["rail", "locale", "onOpenHelp"],
    },
);

export default PerRailInstructionsBanner;
