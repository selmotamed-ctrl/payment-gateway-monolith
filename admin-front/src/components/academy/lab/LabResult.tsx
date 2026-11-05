import { defineComponent, onMounted, ref, type PropType } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn } from "vuetify/components";
import type { Lab, LabTask } from "@/content/academy";
import { loadArticles } from "@/content/guide";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { Callout } from "../ui/Callout";
import { IconTile } from "../ui/IconTile";
import { ProgressBar } from "../ui/ProgressBar";
import { StateIcon } from "../ui/StateIcon";
import type { LabScore, TaskAnswer } from "../labScoring";
import { pts, renderInline } from "./PanelView";

/** Verbatim authored text describing what the learner's decision would cause in real life. */
const realLifeNotes = (task: LabTask, answer: any): string[] => {
    switch (task.kind) {
        case "choice": {
            const chosen = task.options.find((option) => option.id === answer?.selected);
            const correct = task.options.find((option) => option.correct);
            const notes: string[] = [];
            if (chosen) notes.push(chosen.feedback);
            if (correct && correct !== chosen) notes.push(correct.feedback);
            return notes;
        }
        case "multi": {
            const selected = new Set<string>(answer?.selected ?? []);
            return task.options.filter((option) => selected.has(option.id) || option.correct).map((option) => option.feedback);
        }
        case "checklist":
            return task.items.map((item) => item.why);
        default:
            return [task.feedback];
    }
};

export const LabResult = defineComponent({
    name: "AcademyLabResult",
    props: {
        lab: { type: Object as PropType<Lab>, required: true },
        result: { type: Object as PropType<LabScore>, required: true },
        answers: { type: Object as PropType<Record<string, TaskAnswer | undefined>>, required: true },
        onRetry: { type: Function as PropType<() => void>, required: true },
        headingRef: { type: Function as PropType<(el: HTMLElement | null) => void>, default: undefined },
    },
    setup(props) {
        const { t } = useLocale();
        const titles = ref<Record<string, string>>({});
        onMounted(async () => {
            try {
                const articles = await loadArticles();
                titles.value = Object.fromEntries(articles.map((article) => [article.id, article.title]));
            } catch {
                titles.value = {};
            }
        });
        const refLink = (id: string) => (
            <RouterLink class="ac-link" to={{ name: "AdminGuideArticle", params: { articleId: id } }}>
                {titles.value[id] ?? id}
            </RouterLink>
        );
        return () => {
            const { result, lab } = props;
            const criticalFail = result.criticalErrors > 0;
            const belowMark = !criticalFail && result.score < lab.passPercent;
            return (
                <div class="ac-stack ac-lab-result">
                    <SurfaceCard class="ac-card" color={result.passed ? "success" : "danger"}>
                        <div aria-live="polite" role="status" class="ac-lab-verdict">
                            <IconTile
                                large
                                tone={result.passed ? "success" : "danger"}
                                icon={result.passed ? "mdi-check-circle-outline" : "mdi-close-circle-outline"}
                            />
                            <div class="ac-lab-verdict__main">
                                <h2 ref={props.headingRef as any} tabindex={-1} class="ac-title ac-lab-heading">
                                    {result.passed ? t("Lab passed") : t("Lab not passed yet")}
                                </h2>
                                <p class="ac-lab-verdict__score ac-num">
                                    {`${t("Score")}: ${result.score}% (${pts(result.earned)} / ${pts(result.possible)} ${t("points")}) · ${t("Pass mark")}: ${lab.passPercent}%`}
                                </p>
                                <ProgressBar
                                    large
                                    value={result.score}
                                    max={100}
                                    label={t("Score")}
                                    tone={result.passed ? "success" : criticalFail ? "danger" : "warning"}
                                />
                                {belowMark ? <p class="ac-text">{t("You need at least the pass mark to pass. Review the notes below and try again.")}</p> : null}
                            </div>
                        </div>
                    </SurfaceCard>

                    {criticalFail ? (
                        <Callout tone="danger" role="alert" icon="mdi-alert-octagon-outline" title={t("Failed because of a critical error")}>
                            <p class="ac-lab-line">
                                {t(
                                    "A critical error means a choice that would be seriously harmful in real life, such as losing money, exposing private data or bypassing a control. You cannot pass a lab with a critical error, even with a high score. Read the notes below, then try again.",
                                )}
                            </p>
                        </Callout>
                    ) : null}

                    <section class="ac-stack ac-lab-review" aria-labelledby="ac-lab-review-title">
                        <h3 id="ac-lab-review-title" class="ac-h2">
                            {t("Task by task")}
                        </h3>
                        {lab.tasks.map((task, i) => {
                            const scored = result.tasks[i];
                            if (!scored) return null;
                            const answer = props.answers[task.id];
                            const refs = Array.from(new Set([...(task.refs ?? []), ...lab.refs]));
                            const notes = realLifeNotes(task, answer);
                            const headingId = `ac-lab-review-${task.id}`;
                            const partial = !scored.correct && scored.score > 0;
                            return (
                                <article key={task.id} class="ac-card ac-card--pad ac-lab-review__item" aria-labelledby={headingId}>
                                    <header class="ac-lab-review__head">
                                        <StateIcon state={scored.correct ? "done" : partial ? "partial" : "failed"} />
                                        <h4 id={headingId} class="ac-h3 ac-grow" dir="auto">
                                            {task.title}
                                        </h4>
                                        <StatusBadge
                                            status={scored.correct ? "RIGHT" : partial ? "PARTLY_CORRECT" : "WRONG"}
                                            label={scored.correct ? t("Right") : partial ? t("Partly correct") : t("Wrong")}
                                            toneOverride={scored.correct ? "success" : partial ? "warning" : "danger"}
                                        />
                                        {scored.criticalError ? (
                                            <StatusBadge status="CRITICAL_ERROR" label={t("Critical error")} toneOverride="danger" showDot={false} />
                                        ) : null}
                                        <span class="ac-step__meta">
                                            {`${pts(scored.score)} / ${pts(scored.maxScore)} ${t("points")}`}
                                            {scored.hintPenalty ? ` (${t("hint used")})` : ""}
                                        </span>
                                    </header>
                                    <p class="ac-text" dir="auto">
                                        {renderInline(task.prompt)}
                                    </p>
                                    {notes.length ? (
                                        <div class="ac-lab-notes">
                                            <strong class="ac-h3">{t("What would have happened in real life")}</strong>
                                            <ul class="ac-lab-ul">
                                                {notes.map((note) => (
                                                    <li dir="auto">{note}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    ) : null}
                                    {refs.length ? (
                                        <p class="ac-muted ac-lab-refs">
                                            <strong>{t("Guide references")}:</strong>{" "}
                                            {refs.map((id, n) => (
                                                <>
                                                    {n > 0 ? ", " : ""}
                                                    {refLink(id)}
                                                </>
                                            ))}
                                        </p>
                                    ) : null}
                                </article>
                            );
                        })}
                    </section>

                    <div class="ac-row ac-row--wrap">
                        <VBtn color="primary" onClick={() => props.onRetry()}>
                            {t("Try again")}
                        </VBtn>
                        <VBtn variant="outlined" to={{ name: "AdminAcademyModule", params: { moduleId: lab.module } }}>
                            {t("Back to the module")}
                        </VBtn>
                    </div>
                </div>
            );
        };
    },
});

export default LabResult;
