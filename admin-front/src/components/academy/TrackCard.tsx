import { defineComponent, type PropType } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import { MetaPill } from "@/components/ui/MetaPill";
import type { Track } from "@/content/academy";
import { BadgeChip } from "./BadgeChip";
import type { TrackStats } from "./nextStep";
import { IconTile } from "./ui/IconTile";
import { ProgressBar } from "./ui/ProgressBar";
import { trackIcon } from "./ui/trackMeta";
import type { BadgeState } from "./useAcademyProgress";

/** hours · modules · lessons · labs as a real description list (numbers first, tabular). */
export const TrackFacts = defineComponent({
    name: "AcademyTrackFacts",
    props: { track: { type: Object as PropType<Track>, required: true } },
    setup(props) {
        const { t } = useLocale();
        return () => {
            const track = props.track;
            const facts: [string, string][] = [
                [t("Estimated time"), `${track.hours} ${t("hours")}`],
                [t("Modules"), String(track.moduleIds.length)],
                [t("Lessons"), String(track.lessonIds.length)],
                [t("Labs"), String(track.labIds.length)],
            ];
            return (
                <dl class="ac-learner-facts">
                    {facts.map(([label, value]) => (
                        <div key={label} class="ac-learner-fact">
                            <dt>{label}</dt>
                            <dd class="ac-num">{value}</dd>
                        </div>
                    ))}
                </dl>
            );
        };
    },
});

/**
 * One track as a calm card: the title is the card's link target, "Open track" the explicit action
 * (two plain links, no nested interactive elements).
 */
export const TrackCard = defineComponent({
    name: "AcademyTrackCard",
    props: {
        track: { type: Object as PropType<Track>, required: true },
        state: { type: String as PropType<BadgeState>, default: "none" },
        expiresAt: { type: String, default: "" },
        requiresTitles: { type: Array as PropType<string[]>, default: () => [] },
        active: { type: Boolean, default: false },
        /** Part of the learner's required set (Foundation + role track). */
        required: { type: Boolean, default: false },
        /** Lessons/labs/exam progress; the progress bar is hidden when absent. */
        stats: { type: Object as PropType<TrackStats>, default: undefined },
    },
    setup(props) {
        const { t } = useLocale();
        return () => {
            const track = props.track;
            const headingId = `ac-track-${track.id}-h`;
            const to = { name: "AdminAcademyTrack", params: { trackId: track.id } };
            const stats = props.stats;
            const done = stats ? stats.lessonsDone + stats.labsPassed : 0;
            const total = stats ? stats.lessonsTotal + stats.labsTotal : 0;
            return (
                <article class={["ac-card", "ac-learner-track", props.active ? "ac-card--active" : ""]} aria-labelledby={headingId}>
                    <header class="ac-learner-track__head">
                        <IconTile icon={trackIcon(track.id)} large />
                        <div class="ac-learner-track__titles">
                            <h2 id={headingId} class="ac-h2">
                                <RouterLink class="ac-learner-track__link" to={to}>
                                    {track.title}
                                </RouterLink>
                            </h2>
                            <div class="ac-row ac-row--wrap">
                                <BadgeChip track={track.id} state={props.state} expiresAt={props.expiresAt} compact />
                                {props.required && <MetaPill color="neutral">{t("Required for you")}</MetaPill>}
                                {props.active && <MetaPill color="info">{t("Active")}</MetaPill>}
                            </div>
                        </div>
                    </header>
                    <p class="ac-text ac-learner-clamp">{track.description}</p>
                    <TrackFacts track={track} />
                    <p class="ac-muted ac-learner-requires">
                        <span class="ac-learner-requires__label">{t("Requires")}:</span>{" "}
                        {props.requiresTitles.length > 0 ? props.requiresTitles.join(", ") : t("Nothing")}
                    </p>
                    <div class="ac-learner-track__foot">
                        {stats && (
                            <div class="ac-learner-track__progress">
                                <div class="ac-between">
                                    <span class="ac-muted">{t("Lessons and labs completed")}</span>
                                    <bdi class="ac-muted ac-ltr ac-num">
                                        {done} / {total}
                                    </bdi>
                                </div>
                                <ProgressBar value={done} max={total} label={`${track.title}: ${t("Lessons and labs completed")}`} />
                            </div>
                        )}
                        <VBtn class="ac-learner-track__open" variant="outlined" size="small" height={32} to={to} aria-label={`${t("Open track")}: ${track.title}`}>
                            {t("Open track")}
                        </VBtn>
                    </div>
                </article>
            );
        };
    },
});
