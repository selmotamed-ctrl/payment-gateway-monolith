import { computed, defineComponent, reactive, ref, watch, type PropType } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import type { Lab, LabTask } from "@/content/academy";
import { scoreLab, scoreTask, type LabScore, type TaskAnswer, type TaskScore } from "../labScoring";
import { PanelView, labBorder, labCard, renderInline, srOnly } from "./PanelView";
import { ChoiceTask } from "./ChoiceTask";
import { MultiTask } from "./MultiTask";
import { LedgerTask } from "./LedgerTask";
import { OrderTask, initialOrder } from "./OrderTask";
import { ChecklistTask } from "./ChecklistTask";
import { NumericTask } from "./NumericTask";
import { LabResult } from "./LabResult";
import { parseDecimal } from "../labScoring";

export interface LabBest {
    bestScore: number;
    attempts: number;
    passedAt?: string;
}

export const LabRunner = defineComponent({
    name: "AcademyLabRunner",
    props: {
        lab: { type: Object as PropType<Lab>, required: true },
        best: { type: Object as PropType<LabBest | undefined>, default: undefined },
        onFinish: { type: Function as PropType<(result: LabScore) => void>, required: true },
    },
    setup(props) {
        const { t } = useLocale();
        const stage = ref<"brief" | "task" | "result">("brief");
        const index = ref(0);
        const draft = reactive<Record<string, TaskAnswer>>({});
        const submitted = reactive<Record<string, TaskAnswer>>({});
        const checked = reactive<Record<string, TaskScore>>({});
        const hintShown = reactive<Record<string, boolean>>({});
        const result = ref<LabScore | null>(null);
        const heading = ref<HTMLElement | null>(null);

        const reset = () => {
            for (const bag of [draft, submitted, checked, hintShown] as Record<string, unknown>[]) {
                for (const key of Object.keys(bag)) delete bag[key];
            }
            stage.value = "brief";
            index.value = 0;
            result.value = null;
        };
        watch(() => props.lab.id, reset);

        const task = computed<LabTask>(() => props.lab.tasks[index.value] as LabTask);
        const total = computed(() => props.lab.tasks.length);

        const focusHeading = () => {
            requestAnimationFrame(() => heading.value?.focus());
        };

        const currentAnswer = (): TaskAnswer | undefined => draft[task.value.id];
        const canCheck = computed(() => {
            const current = task.value;
            const answer = draft[current.id] as any;
            if (current.kind === "choice") return Boolean(answer?.selected);
            if (current.kind === "numeric") return parseDecimal(answer?.value) !== null;
            return true;
        });

        const check = () => {
            const current = task.value;
            let answer = currentAnswer();
            if (current.kind === "order" && !answer) answer = { order: initialOrder(current) };
            if (!answer) answer = {} as TaskAnswer;
            const hintUsed = Boolean(hintShown[current.id]);
            submitted[current.id] = { ...answer, hintUsed } as TaskAnswer;
            checked[current.id] = scoreTask(current, answer, { hintUsed });
        };

        const next = () => {
            if (index.value + 1 < total.value) {
                index.value += 1;
                focusHeading();
                return;
            }
            const hints: Record<string, boolean> = {};
            for (const key of Object.keys(hintShown)) hints[key] = Boolean(hintShown[key]);
            result.value = scoreLab(props.lab, { ...submitted }, hints);
            stage.value = "result";
            props.onFinish(result.value);
            focusHeading();
        };

        const renderTask = (current: LabTask, locked: boolean) => {
            const common = {
                locked,
                answer: draft[current.id] as any,
                onChange: (answer: TaskAnswer) => {
                    draft[current.id] = answer;
                },
            };
            switch (current.kind) {
                case "choice":
                    return <ChoiceTask task={current} {...common} />;
                case "multi":
                    return <MultiTask task={current} {...common} />;
                case "ledger":
                    return <LedgerTask task={current} {...common} />;
                case "order": {
                    const answer = draft[current.id] ?? { order: initialOrder(current) };
                    return <OrderTask task={current} {...common} answer={answer as any} />;
                }
                case "checklist":
                    return <ChecklistTask task={current} {...common} />;
                case "numeric":
                    return <NumericTask task={current} {...common} />;
            }
        };

        const feedbackFor = (current: LabTask): string | null =>
            current.kind === "ledger" || current.kind === "order" || current.kind === "numeric" ? current.feedback : null;

        const ribbon = () => (
            <div
                role="note"
                style={{
                    position: "sticky",
                    top: 0,
                    zIndex: 2,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "8px",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 16px",
                    borderRadius: "8px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    background: "rgb(var(--v-theme-warning))",
                    color: "rgb(var(--v-theme-on-warning))",
                }}
            >
                <span>
                    <VIcon icon="mdi-school" size={18} aria-hidden="true" /> {t("TRAINING — nothing here is real")}
                </span>
                <span
                    style={{
                        border: "2px solid currentColor",
                        borderRadius: "4px",
                        padding: "0 8px",
                        fontSize: "0.8rem",
                    }}
                >
                    {t("SANDBOX")}
                </span>
            </div>
        );

        return () => {
            let body;
            if (stage.value === "brief") {
                body = (
                    <section style={{ ...labCard, display: "grid", gap: "12px" }}>
                        <h2 ref={heading} tabindex={-1} style={{ margin: 0, fontSize: "1.2rem" }}>
                            {t("Briefing")}
                        </h2>
                        <p style={{ margin: 0 }}>{renderInline(props.lab.briefing)}</p>
                        <p style={{ margin: 0, opacity: 0.85 }}>
                            {`${props.lab.tasks.length} ${t("tasks")} · ${props.lab.minutes} ${t("min")} · ${t("Pass mark")}: ${props.lab.passPercent}% ${t("with no critical error")}`}
                        </p>
                        <p style={{ margin: 0 }}>
                            {props.best && props.best.attempts > 0
                                ? `${t("Your best score")}: ${props.best.bestScore}% (${props.best.attempts} ${t("attempts")})${props.best.passedAt ? " — " + t("Passed") : ""}`
                                : t("You have not tried this lab yet.")}
                        </p>
                        <div>
                            <VBtn color="primary" size="large" onClick={() => { stage.value = "task"; focusHeading(); }}>
                                {props.best && props.best.attempts > 0 ? t("Start again") : t("Start lab")}
                            </VBtn>
                        </div>
                    </section>
                );
            } else if (stage.value === "task") {
                const current = task.value;
                const outcome = checked[current.id];
                const locked = Boolean(outcome);
                const feedback = feedbackFor(current);
                body = (
                    <div style={{ display: "grid", gap: "14px" }}>
                        <div style={{ opacity: 0.8 }} aria-live="off">
                            {`${t("Task")} ${index.value + 1} / ${total.value} · ${current.points} ${t("points")}`}
                        </div>
                        <h2 ref={heading} tabindex={-1} style={{ margin: 0, fontSize: "1.2rem" }}>
                            {current.title}
                        </h2>
                        {current.panels.length ? (
                            <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                                {current.panels.map((panel) => (
                                    <PanelView panel={panel} />
                                ))}
                            </div>
                        ) : null}
                        <p style={{ margin: 0, fontSize: "1.05rem" }}>{renderInline(current.prompt)}</p>
                        {renderTask(current, locked)}
                        {!locked && current.hint ? (
                            hintShown[current.id] ? (
                                <div style={{ ...labCard, borderStyle: "dashed" }} role="note">
                                    <strong>{t("Hint")}:</strong> {renderInline(current.hint)}{" "}
                                    <span style={{ opacity: 0.8 }}>({t("This hint costs 1 point.")})</span>
                                </div>
                            ) : (
                                <div>
                                    <VBtn variant="text" prependIcon="mdi-lightbulb-outline" onClick={() => { hintShown[current.id] = true; }}>
                                        {t("Show hint (costs 1 point)")}
                                    </VBtn>
                                </div>
                            )
                        ) : null}
                        {!locked ? (
                            <div>
                                <VBtn color="primary" disabled={!canCheck.value} onClick={check}>
                                    {t("Check")}
                                </VBtn>
                            </div>
                        ) : null}
                        <div aria-live="polite" role="status">
                            {outcome ? (
                                <div style={{ display: "grid", gap: "10px" }}>
                                    <div
                                        style={{
                                            ...labCard,
                                            borderInlineStart: `6px solid rgb(var(--v-theme-${outcome.correct ? "success" : outcome.score > 0 ? "warning" : "error"}))`,
                                        }}
                                    >
                                        <strong>
                                            <VIcon
                                                icon={outcome.correct ? "mdi-check-circle" : "mdi-close-circle"}
                                                color={outcome.correct ? "success" : "error"}
                                                size={20}
                                                aria-hidden="true"
                                            />{" "}
                                            {outcome.correct ? t("Correct") : outcome.score > 0 ? t("Partly correct") : t("Not correct")}
                                            {` — ${outcome.score} / ${outcome.maxScore} ${t("points")}`}
                                        </strong>
                                        {outcome.hintPenalty ? <div style={{ opacity: 0.85 }}>{t("Includes the 1 point hint cost.")}</div> : null}
                                        {feedback ? <p style={{ margin: "8px 0 0" }}>{feedback}</p> : null}
                                    </div>
                                    {outcome.criticalError ? (
                                        <div
                                            role="alert"
                                            style={{
                                                border: "2px solid rgb(var(--v-theme-error))",
                                                borderRadius: "10px",
                                                padding: "12px 16px",
                                            }}
                                        >
                                            <strong>
                                                <VIcon icon="mdi-alert-octagon" color="error" size={20} aria-hidden="true" /> {t("Critical error")}
                                            </strong>
                                            <p style={{ margin: "6px 0 0" }}>
                                                {t("This choice would be seriously harmful in real life. A lab with a critical error cannot be passed, whatever the score.")}
                                            </p>
                                        </div>
                                    ) : null}
                                    <div>
                                        <VBtn color="primary" onClick={next}>
                                            {index.value + 1 < total.value ? t("Next") : t("See results")}
                                        </VBtn>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    </div>
                );
            } else {
                body = result.value ? (
                    <LabResult lab={props.lab} result={result.value} answers={{ ...submitted }} onRetry={reset} headingRef={(el: HTMLElement | null) => (heading.value = el)} />
                ) : null;
            }
            return (
                <div style={{ display: "grid", gap: "14px" }}>
                    {ribbon()}
                    <div style={{ borderBottom: labBorder }} aria-hidden="true" />
                    <span style={srOnly} role="status" aria-live="polite">
                        {stage.value === "task" ? `${t("Task")} ${index.value + 1} / ${total.value}` : ""}
                    </span>
                    {body}
                </div>
            );
        };
    },
});
export default LabRunner;
