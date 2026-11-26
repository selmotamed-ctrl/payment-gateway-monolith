import { defineComponent } from "@/utils/dc";
import { type PropType, type VNodeChild } from "vue";
import { VIcon } from "@/components/vael/VuetifyShim";
import { useLocale } from "@/utils/vael-compat";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MetaPill } from "@/components/ui/MetaPill";
import { SETTING_STATUS_META, settingPreview, settingTitle, type SettingEntry } from "@/components/builders/model";

const RISK_LABEL: Record<string, string> = {
    low: "Low risk",
    medium: "Medium risk",
    high: "High risk",
    critical: "Critical risk",
};

export const SettingRow = defineComponent({
    name: "SettingRow",
    props: {
        entry: { type: Object as PropType<SettingEntry>, required: true },
        onOpen: { type: Function as PropType<(entry: SettingEntry) => void>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        const status = () => SETTING_STATUS_META[props.entry.displayStatus];
        const title = () => t(settingTitle(props.entry));
        const preview = () => settingPreview(props.entry, t);
        const action = () => {
            if (props.entry.displayStatus === "UNCONFIGURED") return t("Set up");
            if (props.entry.displayStatus === "MANAGED") return t("View");
            if (props.entry.readOnly) return t("View");
            return t("Edit");
        };
        return (): VNodeChild => (
            <button
                type="button"
                class="pg-settings-row"
                onClick={() => props.onOpen(props.entry)}
                aria-label={`${title()} — ${t(status().label)}. ${t("Open setting")}`}
            >
                <span class="pg-settings-row__main">
                    <span class="pg-settings-row__heading">
                        <span class="pg-settings-row__title">{title()}</span>
                        <span class="pg-settings-row__key pg-mono-ref">{props.entry.key}</span>
                        <StatusBadge status={props.entry.displayStatus} label={t(status().label)} toneOverride={status().tone} showDot={false} />
                        {(props.entry.definition.risk === "high" || props.entry.definition.risk === "critical") && (
                            <MetaPill size="x-small" variant="text" prependIcon="mdi-shield-alert-outline">{t(RISK_LABEL[props.entry.definition.risk] ?? props.entry.definition.risk)}</MetaPill>
                        )}
                        {props.entry.latest && <MetaPill size="x-small" variant="tonal" color="primary">v{props.entry.effective?.version ?? props.entry.latest.version}</MetaPill>}
                        {props.entry.scheduled.length > 0 && <MetaPill size="x-small" variant="tonal" color="info">{t("Scheduled")}</MetaPill>}
                    </span>
                    <span class="pg-settings-row__summary">{t(props.entry.definition.summary)}</span>
                    <span class="pg-settings-row__preview">{preview()}</span>
                    <span class="pg-settings-row__effect">{t(props.entry.definition.effect)}</span>
                </span>
                <span class="pg-settings-row__action">
                    <span>{action()}</span>
                    <VIcon icon="mdi-chevron-right" size={18} />
                </span>
            </button>
        );
    },
});

export default SettingRow;
