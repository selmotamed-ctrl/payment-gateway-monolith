import { defineComponent, type PropType } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import type { Track } from "@/content/academy";
import { BadgeChip } from "./BadgeChip";
import type { BadgeState } from "./useAcademyProgress";

export const TrackCard = defineComponent({
    name: "AcademyTrackCard",
    props: {
        track: { type: Object as PropType<Track>, required: true },
        state: { type: String as PropType<BadgeState>, default: "none" },
        expiresAt: { type: String, default: "" },
        requiresTitles: { type: Array as PropType<string[]>, default: () => [] },
        active: { type: Boolean, default: false },
    },
    setup(props) {
        const { t } = useLocale();
        return () => {
            const track = props.track;
            return (
                <article class={["ac-card", props.active ? "ac-card--active" : ""]}>
                    <header class="ac-between">
                        <h2 class="ac-h2">
                            <RouterLink to={{ name: "AdminAcademyTrack", params: { trackId: track.id } }}>{track.title}</RouterLink>
                        </h2>
                        <BadgeChip track={track.id} state={props.state} expiresAt={props.expiresAt} compact />
                    </header>
                    <p>{track.description}</p>
                    <dl class="ac-facts">
                        <div><dt>{t("Estimated time")}</dt><dd>{track.hours} {t("hours")}</dd></div>
                        <div><dt>{t("Modules")}</dt><dd>{track.moduleIds.length}</dd></div>
                        <div><dt>{t("Lessons")}</dt><dd>{track.lessonIds.length}</dd></div>
                        <div><dt>{t("Labs")}</dt><dd>{track.labIds.length}</dd></div>
                        <div>
                            <dt>{t("Requires")}</dt>
                            <dd>{props.requiresTitles.length > 0 ? props.requiresTitles.join(", ") : t("Nothing")}</dd>
                        </div>
                    </dl>
                    <RouterLink class="ac-btn ac-btn--secondary" to={{ name: "AdminAcademyTrack", params: { trackId: track.id } }}>
                        {t("Open track")}
                    </RouterLink>
                </article>
            );
        };
    },
});
