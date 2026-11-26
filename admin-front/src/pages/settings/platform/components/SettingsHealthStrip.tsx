import { defineComponent, type PropType, type VNodeChild } from "vue";
import { VBtn } from "vuetify/components";
import { useLocale } from "vuetify";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { SettingEntry } from "@/components/builders/model";

type Metric = { key: string; label: string; value: number; hint: string; tone?: "success" | "warning" | "danger" | "info" };

export const SettingsHealthStrip = defineComponent({
    name: "SettingsHealthStrip",
    props: {
        entries: { type: Array as PropType<SettingEntry[]>, required: true },
        onReviewDefaults: { type: Function as PropType<() => void>, default: undefined },
        onReviewAttention: { type: Function as PropType<() => void>, default: undefined },
    },
    setup(props) {
        const { t } = useLocale();
        const metrics = (): Metric[] => {
            const live = props.entries.filter((entry) => entry.displayStatus === "RUNTIME" || entry.displayStatus === "DYNAMIC").length;
            const configured = props.entries.filter((entry) => entry.configured).length;
            const defaults = props.entries.filter((entry) => entry.displayStatus === "UNCONFIGURED").length;
            const scheduled = props.entries.filter((entry) => entry.scheduled.length > 0).length;
            const attention = props.entries.filter((entry) => entry.displayStatus === "UNREGISTERED" || entry.displayStatus === "DEPRECATED").length;
            return [
                { key: "configured", label: t("Configured"), value: configured, hint: t("Keys with a stored value."), tone: "success" },
                { key: "live", label: t("Live policies"), value: live, hint: t("Keys the platform reads at runtime."), tone: "info" },
                { key: "defaults", label: t("Using defaults"), value: defaults, hint: t("Known runtime keys with no stored value."), tone: defaults > 0 ? "warning" : "success" },
                { key: "scheduled", label: t("Scheduled"), value: scheduled, hint: t("Keys with a future-effective version."), tone: scheduled > 0 ? "info" : "success" },
                { key: "attention", label: t("Needs review"), value: attention, hint: t("Unregistered or retired keys."), tone: attention > 0 ? "danger" : "success" },
            ];
        };
        return (): VNodeChild => (
            <SurfaceCard bodyPadding="14px 16px">
                <div class="pg-settings-health">
                    <div class="pg-settings-health__metrics">
                        {metrics().map((metric) => (
                            <div key={metric.key} class="pg-settings-health__metric">
                                <span class="pg-settings-health__label">{metric.label}</span>
                                <span class={`pg-settings-health__value pg-tabular${metric.tone ? ` pg-settings-health__value--${metric.tone}` : ""}`}>{metric.value}</span>
                                <span class="pg-settings-health__hint">{metric.hint}</span>
                            </div>
                        ))}
                    </div>
                    <div class="pg-settings-health__actions">
                        {metrics().find((metric) => metric.key === "defaults")!.value > 0 && props.onReviewDefaults && (
                            <VBtn size="small" variant="tonal" color="warning" prependIcon="mdi-tune-variant" onClick={() => props.onReviewDefaults?.()}>
                                {t("Review defaults")}
                            </VBtn>
                        )}
                        {metrics().find((metric) => metric.key === "attention")!.value > 0 && props.onReviewAttention && (
                            <VBtn size="small" variant="tonal" color="error" prependIcon="mdi-alert-outline" onClick={() => props.onReviewAttention?.()}>
                                {t("Review attention")}
                            </VBtn>
                        )}
                    </div>
                </div>
            </SurfaceCard>
        );
    },
});

export default SettingsHealthStrip;
