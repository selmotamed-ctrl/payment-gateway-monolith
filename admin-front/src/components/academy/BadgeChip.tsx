import { defineComponent, type PropType } from "vue";
import { useLocale } from "vuetify";
import type { TrackId } from "@/content/academy";
import type { BadgeState } from "./useAcademyProgress";

const ICON: Record<BadgeState, string> = { none: "○", valid: "✓", expiring: "⏳", expired: "✕", recertify: "⟳" };
const TONE: Record<BadgeState, string> = { none: "neutral", valid: "success", expiring: "warning", expired: "danger", recertify: "danger" };

export const BadgeChip = defineComponent({
    name: "AcademyBadgeChip",
    props: {
        track: { type: String as PropType<TrackId>, required: true },
        state: { type: String as PropType<BadgeState>, required: true },
        expiresAt: { type: String, default: "" },
        compact: { type: Boolean, default: false },
    },
    setup(props) {
        const { t } = useLocale();
        return () => {
            const label =
                props.state === "none"
                    ? t("Not earned yet")
                    : props.state === "valid"
                      ? t("Certified")
                      : props.state === "expiring"
                        ? t("Expires soon")
                        : t("Recertification required");
            const date = props.expiresAt && props.state !== "none" ? new Date(props.expiresAt).toLocaleDateString() : "";
            return (
                <span class={["ac-chip", `ac-chip--${TONE[props.state]}`]} data-track={props.track}>
                    <span aria-hidden="true">{ICON[props.state]}</span>
                    <span>
                        {label}
                        {!props.compact && date
                            ? ` · ${props.state === "expired" || props.state === "recertify" ? t("expired") : t("valid until")} ${date}`
                            : ""}
                    </span>
                </span>
            );
        };
    },
});
