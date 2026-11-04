import { defineComponent, type PropType } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import type { Lab, Lesson, Module } from "@/content/academy";
import { useAcademyProgress } from "./useAcademyProgress";

/** Modules with their lessons (todo/done) and labs (best score, passed). */
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
    },
    setup(props) {
        const { t } = useLocale();
        const academy = useAcademyProgress();
        return () => (
            <ol class="ac-modules">
                {props.modules.map((module) => {
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
                        <li key={module.id} class="ac-card">
                            <header class="ac-between">
                                <h3 class="ac-h3">
                                    <RouterLink to={{ name: "AdminAcademyModule", params: { moduleId: module.id } }}>{module.title}</RouterLink>
                                </h3>
                                <span class="ac-muted">
                                    {done}/{lessons.length} {t("lessons")} · {module.minutes} {t("min")}
                                </span>
                            </header>
                            {props.showObjective && <p class="ac-muted">{module.objective}</p>}
                            <ul class="ac-list">
                                {lessons.map((lesson) => {
                                    const isDone = academy.lessonDone(lesson.id);
                                    return (
                                        <li key={lesson.id} class="ac-row">
                                            <span class={["ac-state", isDone ? "ac-state--done" : ""]} aria-hidden="true">{isDone ? "✓" : "○"}</span>
                                            <RouterLink to={{ name: "AdminAcademyLesson", params: { lessonId: lesson.id } }}>{lesson.title}</RouterLink>
                                            <span class="ac-muted ac-grow-end">
                                                {isDone ? t("Done") : t("To do")} · {lesson.minutes} {t("min")}
                                            </span>
                                        </li>
                                    );
                                })}
                                {labs.map((lab) => {
                                    const best = academy.labBest(lab.id);
                                    const passed = academy.labPassed(lab.id);
                                    return (
                                        <li key={lab.id} class="ac-row">
                                            <span class={["ac-state", passed ? "ac-state--done" : ""]} aria-hidden="true">{passed ? "✓" : "⚗"}</span>
                                            <RouterLink to={{ name: "AdminAcademyLab", params: { labId: lab.id } }}>
                                                {t("Lab")}: {lab.title}
                                            </RouterLink>
                                            {props.activeLabIds && !props.activeLabIds.includes(lab.id) && (
                                                <span class="ac-chip">{t("Other track")}</span>
                                            )}
                                            <span class="ac-muted ac-grow-end">
                                                {best
                                                    ? `${t("Best score")} ${best.bestScore}%${passed ? ` · ${t("Passed")}` : ` · ${t("Not passed yet")}`}`
                                                    : `${t("Not attempted")} · ${lab.minutes} ${t("min")}`}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </li>
                    );
                })}
            </ol>
        );
    },
});
