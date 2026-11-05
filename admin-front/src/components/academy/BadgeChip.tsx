import { defineComponent, type PropType } from "vue";
import { useLocale } from "vuetify";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { TrackId } from "@/content/academy";
import { BADGE_TONE } from "./ui/trackMeta";
import type { BadgeState } from "./useAcademyProgress";

/**
 * Certification state of one track as a `StatusBadge`. The wrapper keeps the `.ac-chip[data-track]`
 * hook the e2e specs and the team view rely on; the visible text always names the state in words.
 */
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
            const full =
                !props.compact && date
                    ? `${label} · ${props.state === "expired" || props.state === "recertify" ? t("expired") : t("valid until")} ${date}`
                    : label;
            return (
                <span class="ac-chip" data-track={props.track} style={{ display: "inline-flex", maxInlineSize: "100%" }}>
                    <StatusBadge status={props.state} label={full} toneOverride={BADGE_TONE[props.state]} />
                </span>
            );
        };
    },
});
