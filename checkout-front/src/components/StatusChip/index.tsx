import { defineComponent, type PropType } from "vue";
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
        return () => (
            <StatusBadge status={String(props.label ?? "")} label={String(props.label ?? "")} toneOverride={toBadgeTone(props.tone)} />
        );
    },
});

export default StatusChip;
