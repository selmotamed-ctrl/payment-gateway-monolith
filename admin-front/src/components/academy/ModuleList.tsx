import { defineComponent, type PropType } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import { MetaPill } from "@/components/ui/MetaPill";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { Lab, Lesson, Module } from "@/content/academy";
import { IconTile } from "./ui/IconTile";
import { ProgressBar } from "./ui/ProgressBar";
import { StateIcon } from "./ui/StateIcon";
import { useAcademyProgress } from "./useAcademyProgress";

/**
 * Modules as flat cards: a header (number, title, "x/n lessons · minutes", progress) and one
 * step row per lesson and lab. State is always shown as an icon AND in words (Done / To do / Up next).
 */
export const ModuleList = defineComponent({
    name: "AcademyModuleList",
    props: {
        modules: { type: Array as PropType<Module[]>, required: true },
        lessons: { type: Array as PropType<Lesson[]>, required: true },
        labs: { type: Array as PropType<Lab[]>, required: true },
        /** Restrict lessons/labs to those in the track (module pages pass undefined to show all). */
        lessonIds: { type: Array as PropType<string[] | undefined>, default: undefined },
        labIds: { type: Array as PropType<string[] | undefined>, default: undefined },
        /** When set, labs outside this list get an "other track" marker. */
        activeLabIds: { type: Array as PropType<string[] | undefined>, default: undefined },
        showObjective: { type: Boolean, default: true },
        /** Lesson or lab id of the learner's next step (from `nextStep`); that row is marked "Up next". */
        nextId: { type: String, default: undefined },
        /** Show 1, 2, 3… tiles (a track's module sequence) instead of a generic icon. */
        numbered: { type: Boolean, default: false },
        /** Module titles link to the module page; turn off on the module page itself. */
        linkTitles: { type: Boolean, default: true },
        /** 2 when the list directly follows the page title (module page), otherwise 3. */
        headingLevel: { type: Number as PropType<2 | 3>, default: 3 },
    },
    setup(props) {
        const { t } = useLocale();
        const academy = useAcademyProgress();
        return () => {
            const Heading = props.headingLevel === 2 ? "h2" : "h3";
            return (
                <ol class="ac-learner-modules">
                    {props.modules.map((module, index) => {
                        const lessons = module.lessonIds
                            .filter((id) => !props.lessonIds || props.lessonIds.includes(id))
                            .map((id) => props.lessons.find((l) => l.id === id))
                            .filter((l): l is Lesson => Boolean(l));
                        const labs = module.labIds
                            .filter((id) => !props.labIds || props.labIds.includes(id))
                            .map((id) => props.labs.find((l) => l.id === id))
                            .filter((l): l is Lab => Boolean(l));
                        const done = lessons.filter((l) => academy.lessonDone(l.id)).length;
                        return (
                            <li key={module.id}>
                                <SurfaceCard class="ac-card ac-learner-module" noPadding>
                                    <div class={["ac-learner-module__head", lessons.length + labs.length > 0 || props.showObjective ? "ac-learner-module__head--ruled" : ""]}>
                                        {props.numbered ? (
                                            <span class="ac-tile ac-num" aria-hidden="true">
                                                {index + 1}
                                            </span>
                                        ) : (
                                            <IconTile icon="mdi-book-open-page-variant-outline" />
                                        )}
                                        <div class="ac-learner-module__titles">
                                            <Heading class="ac-h3">
                                                {props.linkTitles ? (
                                                    <RouterLink class="ac-learner-module__link" to={{ name: "AdminAcademyModule", params: { moduleId: module.id } }}>
                                                        {module.title}
                                                    </RouterLink>
                                                ) : (
                                                    module.title
                                                )}
                                            </Heading>
                                            <span class="ac-step__sub">
                                                <bdi class="ac-ltr ac-num">
                                                    {done}/{lessons.length}
                                                </bdi>{" "}
                                                {t("lessons")} · <span class="ac-num">{module.minutes}</span> {t("min")}
                                            </span>
                                        </div>
                                        {lessons.length > 0 && (
                                            <div class="ac-learner-module__bar">
                                                <ProgressBar value={done} max={lessons.length} label={`${module.title}: ${t("Lessons completed")}`} />
                                            </div>
                                        )}
                                    </div>
                                    {props.showObjective && <p class="ac-muted ac-learner-module__objective">{module.objective}</p>}
                                    {lessons.length + labs.length > 0 && (
                                        <ul class="ac-steps ac-steps--flush">
                                            {lessons.map((lesson) => {
                                                const isDone = academy.lessonDone(lesson.id);
                                                const isNext = !isDone && props.nextId === lesson.id;
                                                return (
                                                    <li key={lesson.id} class={["ac-step", isNext ? "ac-step--current" : ""]}>
                                                        <StateIcon state={isDone ? "done" : isNext ? "current" : "todo"} />
                                                        <span class="ac-step__main">
                                                            <RouterLink class="ac-step__title" to={{ name: "AdminAcademyLesson", params: { lessonId: lesson.id } }}>
                                                                {lesson.title}
                                                            </RouterLink>
                                                            <span class="ac-step__sub ac-num">
                                                                {lesson.minutes} {t("min")}
                                                            </span>
                                                        </span>
                                                        {isNext ? (
                                                            <MetaPill color="info">{t("Up next")}</MetaPill>
                                                        ) : (
                                                            <span class="ac-step__meta">{isDone ? t("Done") : t("To do")}</span>
                                                        )}
                                                    </li>
                                                );
                                            })}
                                            {labs.map((lab) => {
                                                const best = academy.labBest(lab.id);
                                                const passed = academy.labPassed(lab.id);
                                                const isNext = !passed && props.nextId === lab.id;
                                                const otherTrack = Boolean(props.activeLabIds && !props.activeLabIds.includes(lab.id));
                                                return (
                                                    <li key={lab.id} class={["ac-step", isNext ? "ac-step--current" : ""]}>
                                                        <StateIcon lab state={passed ? "done" : isNext ? "current" : "todo"} />
                                                        <span class="ac-step__main">
                                                            <span class="ac-learner-steptitle">
                                                                <RouterLink class="ac-step__title" to={{ name: "AdminAcademyLab", params: { labId: lab.id } }}>
                                                                    {t("Lab")}: {lab.title}
                                                                </RouterLink>
                                                                {otherTrack && <MetaPill>{t("Other track")}</MetaPill>}
                                                            </span>
                                                            <span class="ac-step__sub ac-num">
                                                                {best
                                                                    ? `${t("Best score")} ${best.bestScore}%${passed ? ` · ${t("Passed")}` : ` · ${t("Not passed yet")}`}`
                                                                    : `${t("Not attempted")} · ${lab.minutes} ${t("min")}`}
                                                            </span>
                                                        </span>
                                                        {isNext ? (
                                                            <MetaPill color="info">{t("Up next")}</MetaPill>
                                                        ) : (
                                                            <span class="ac-step__meta">{passed ? t("Done") : t("To do")}</span>
                                                        )}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </SurfaceCard>
                            </li>
                        );
                    })}
                </ol>
            );
        };
    },
});
