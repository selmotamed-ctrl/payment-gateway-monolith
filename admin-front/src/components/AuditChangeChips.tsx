import { computed, defineComponent, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { MetaPill } from "@/components/ui/MetaPill";
import { auditChangeChips, summarizeAuditChange } from "@/utils/auditSummary";

/**
 * Compact "what changed" chips for an audit row: up to `max` humanised key
 * labels plus a "+N more" counter. Pass either `before`/`after` snapshots or
 * ready-made `labels`.
 */
export const AuditChangeChips = defineComponent({
    name: "AuditChangeChips",
    props: {
        before: { type: null as unknown as PropType<unknown> },
        after: { type: null as unknown as PropType<unknown> },
        labels: { type: Array as PropType<string[] | undefined>, default: undefined },
        max: { type: Number, default: 3 },
    },
    setup(props) {
        const { t } = useLocale();
        const chips = computed(() => auditChangeChips(props.labels ?? summarizeAuditChange(props.before, props.after), props.max));
        return (): VNodeChild =>
            chips.value.visible.length === 0 ? (
                <span style={{ color: "var(--pg-ink-faint)" }}>—</span>
            ) : (
                <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
                    {chips.value.visible.map((label) => (
                        <MetaPill key={label} size="x-small" color="info">
                            {t(label)}
                        </MetaPill>
                    ))}
                    {chips.value.more > 0 && (
                        <MetaPill size="x-small" variant="outlined">
                            {`+${chips.value.more} ${t("more")}`}
                        </MetaPill>
                    )}
                </span>
            );
    },
});

export default AuditChangeChips;
