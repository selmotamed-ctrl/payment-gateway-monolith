import { defineComponent, type PropType } from "vue";
import { lookupTerm } from "@/content/guide";
import { StatusBadge, type BadgeTone } from "@/components/ui/StatusBadge";

export type StatusTone = "success" | "error" | "warning" | "info" | "primary" | "neutral";

export type StatusChipProps = {
    label: string;
    tone?: StatusTone;
    size?: "x-small" | "small" | "default";
    variant?: "tonal" | "flat" | "outlined" | "text";
};

const toBadgeTone = (tone: StatusTone | undefined): BadgeTone => {
    if (tone === "error") return "danger";
    if (tone === "primary") return "info";
    return tone ?? "neutral";
};

export const StatusChip = defineComponent({
    name: "StatusChip",
    props: {
        label: { type: String, required: true },
        tone: { type: String as PropType<StatusTone>, default: "neutral" },
        size: { type: String, default: "small" },
        variant: { type: String, default: "tonal" },
    },
    setup(props) {
        return () => {
            const label = String(props.label ?? "");
            const explanation = label ? lookupTerm(label) : undefined;
            return (
                <span
                    title={explanation ? `${explanation.title} — ${explanation.meaningEn}` : undefined}
                    style={{ display: "inline-flex", cursor: explanation ? "help" : undefined }}
                >
                    <StatusBadge
                        status={label}
                        label={label}
                        toneOverride={toBadgeTone(props.tone)}
                    />
                </span>
            );
        };
    },
});

export default StatusChip;
