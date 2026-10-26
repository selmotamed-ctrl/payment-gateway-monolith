import { dc } from "kt-dc";
import { VChip } from "vuetify/components";
import { useTheme } from "vuetify";

export type StatusTone = "success" | "error" | "warning" | "info" | "primary" | "neutral";

export type StatusChipProps = {
    label: string;
    tone?: StatusTone;
    size?: "x-small" | "small" | "default";
    variant?: "tonal" | "flat" | "outlined" | "text";
};

const toneColor = (tone: StatusTone, theme: any): string => {
    switch (tone) {
        case "success":
            return theme.current.value.colors.success;
        case "error":
            return theme.current.value.colors.error;
        case "warning":
            return theme.current.value.colors.warning;
        case "info":
            return theme.current.value.colors.info;
        case "primary":
            return theme.current.value.colors.primary;
        default:
            return theme.current.value.colors["on-surface-variant"];
    }
};

export const StatusChip = dc(
    (props: StatusChipProps) => {
        const theme = useTheme();
        return () => {
            const color = toneColor(props.tone ?? "neutral", theme);
            return (
                <VChip
                    size={props.size ?? "small"}
                    variant={props.variant ?? "tonal"}
                    color={color}
                    style={{ fontWeight: "700", letterSpacing: "0.2px" }}
                >
                    {props.label}
                </VChip>
            );
        };
    },
    {
        props: ["label", "tone", "size", "variant"],
    },
);

export default StatusChip;
