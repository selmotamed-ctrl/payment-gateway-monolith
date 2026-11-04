import { defineComponent, onMounted, ref, type PropType } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import type { Lab, LabTask } from "@/content/academy";
import { loadArticles } from "@/content/guide";
import type { LabScore, TaskAnswer } from "../labScoring";
import { labBorder, labCard, renderInline } from "./PanelView";

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
            <RouterLink to={{ name: "AdminGuideArticle", params: { articleId: id } }}>{titles.value[id] ?? id}</RouterLink>
        );
        return () => {
            const { result, lab } = props;
            const criticalFail = result.criticalErrors > 0;
            return (
                <div style={{ display: "grid", gap: "16px" }}>
                    <section
                        aria-live="polite"
                        role="status"
                        style={{
                            ...labCard,
                            borderInlineStart: `6px solid rgb(var(--v-theme-${result.passed ? "success" : "error"}))`,
                        }}
                    >
                        <h2 ref={props.headingRef as any} tabindex={-1} style={{ margin: 0, fontSize: "1.3rem" }}>
                            <VIcon icon={result.passed ? "mdi-check-circle" : "mdi-close-circle"} color={result.passed ? "success" : "error"} aria-hidden="true" />{" "}
                            {result.passed ? t("Lab passed") : t("Lab not passed yet")}
                        </h2>
                        <p style={{ margin: "6px 0 0", fontSize: "1.1rem" }}>
                            {`${t("Score")}: ${result.score}% (${result.earned} / ${result.possible} ${t("points")}) · ${t("Pass mark")}: ${lab.passPercent}%`}
                        </p>
                    </section>

                    {criticalFail ? (
                        <section role="alert" style={{ border: "2px solid rgb(var(--v-theme-error))", borderRadius: "10px", padding: "12px 16px" }}>
                            <strong>
                                <VIcon icon="mdi-alert-octagon" color="error" aria-hidden="true" /> {t("Failed because of a critical error")}
                            </strong>
                            <p style={{ margin: "6px 0 0" }}>
                                {t("A critical error means a choice that would be seriously harmful in real life, such as losing money, exposing private data or bypassing a control. You cannot pass a lab with a critical error, even with a high score. Read the notes below, then try again.")}
                            </p>
                        </section>
                    ) : result.score < lab.passPercent ? (
                        <p style={{ margin: 0 }}>{t("You need at least the pass mark to pass. Review the notes below and try again.")}</p>
                    ) : null}

                    <section style={{ display: "grid", gap: "12px" }}>
                        <h3 style={{ margin: 0 }}>{t("Task by task")}</h3>
                        {lab.tasks.map((task, i) => {
                            const scored = result.tasks[i];
                            if (!scored) return null;
                            const answer = props.answers[task.id];
                            const refs = Array.from(new Set([...(task.refs ?? []), ...lab.refs]));
                            const notes = realLifeNotes(task, answer);
                            return (
                                <article style={labCard} aria-label={task.title}>
                                    <h4 style={{ margin: 0 }}>
                                        <VIcon
                                            icon={scored.correct ? "mdi-check-circle" : "mdi-close-circle"}
                                            color={scored.correct ? "success" : "error"}
                                            size={20}
                                            aria-hidden="true"
                                        />{" "}
                                        <span style={srOnlyInline}>{scored.correct ? t("Right") : t("Wrong")}: </span>
                                        {task.title}
                                        <span style={{ fontWeight: 400, opacity: 0.85 }}>
                                            {` — ${scored.score} / ${scored.maxScore} ${t("points")}`}
                                            {scored.hintPenalty ? ` (${t("hint used")})` : ""}
                                        </span>
                                    </h4>
                                    {scored.criticalError ? (
                                        <p style={{ margin: "6px 0 0", fontWeight: 700 }}>
                                            <VIcon icon="mdi-alert-octagon" color="error" size={18} aria-hidden="true" /> {t("Critical error")}
                                        </p>
                                    ) : null}
                                    <p style={{ margin: "6px 0 0", opacity: 0.85 }}>{renderInline(task.prompt)}</p>
                                    {notes.length ? (
                                        <div style={{ marginTop: "8px", borderTop: labBorder, paddingTop: "8px" }}>
                                            <strong>{t("What would have happened in real life")}</strong>
                                            <ul style={{ margin: "4px 0 0", paddingInlineStart: "1.2em" }}>
                                                {notes.map((note) => (
                                                    <li>{note}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    ) : null}
                                    {refs.length ? (
                                        <p style={{ margin: "8px 0 0" }}>
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

                    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
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

const srOnlyInline = {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
} as const;

export default LabResult;
