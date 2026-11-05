import { computed, defineComponent, reactive, ref, watch, type PropType } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import type { Lab, LabTask } from "@/content/academy";
import { MetaPill } from "@/components/ui/MetaPill";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { Callout, type CalloutTone } from "../ui/Callout";
import { ProgressBar } from "../ui/ProgressBar";
import { StateIcon, type StepState } from "../ui/StateIcon";
import { parseDecimal, scoreLab, scoreTask, type LabScore, type TaskAnswer, type TaskScore } from "../labScoring";
import { PanelView, plainInline, renderInline, pts } from "./PanelView";
import { ChoiceTask } from "./ChoiceTask";
import { MultiTask } from "./MultiTask";
import { LedgerTask } from "./LedgerTask";
import { OrderTask, initialOrder } from "./OrderTask";
import { ChecklistTask } from "./ChecklistTask";
import { NumericTask } from "./NumericTask";
import { LabResult } from "./LabResult";

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

        /* ------------------------------------------------------------------ pieces */

        /** Calm training strip: a reminder, not an alarm (warning tokens, hairline border). */
        const ribbon = () => (
            <div role="note" class="ac-lab-ribbon">
                <VIcon icon="mdi-school-outline" size={18} aria-hidden="true" />
                <span class="ac-lab-ribbon__text">{t("TRAINING — nothing here is real")}</span>
                <MetaPill class="ac-lab-ribbon__tag" color="warning" variant="outlined" size="x-small">
                    {t("SANDBOX")}
                </MetaPill>
            </div>
        );

        const taskState = (i: number, current: LabTask): StepState => {
            const outcome = checked[current.id];
            if (outcome) return outcome.correct ? "done" : outcome.score > 0 ? "partial" : "failed";
            return stage.value === "task" && i === index.value ? "current" : "todo";
        };

        const stateWords = (state: StepState): string => {
            switch (state) {
                case "done":
                    return t("Correct");
                case "partial":
                    return t("Partly correct");
                case "failed":
                    return t("Not correct");
                case "current":
                    return t("Current task");
                default:
                    return t("To do");
            }
        };

        const aside = () => {
            const done = Object.keys(checked).length;
            const earned = Object.values(checked).reduce((sum, outcome) => sum + outcome.score, 0);
            const possible = props.lab.tasks.reduce((sum, entry) => sum + entry.points, 0);
            return (
                <aside class="ac-aside" aria-label={t("Lab progress")}>
                    <SurfaceCard class="ac-card" title={t("Lab progress")} noPadding>
                        <div class="ac-lab-aside__block">
                            <div class="ac-between">
                                <span class="ac-muted">{t("Tasks checked")}</span>
                                <span class="ac-lab-aside__value ac-num">{`${done} / ${total.value}`}</span>
                            </div>
                            <ProgressBar value={done} max={total.value} label={`${t("Tasks checked")}: ${done} / ${total.value}`} />
                        </div>
                        <ol class="ac-steps ac-steps--flush ac-lab-aside__steps" aria-label={t("Tasks")}>
                            {props.lab.tasks.map((entry, i) => {
                                const state = taskState(i, entry);
                                const outcome = checked[entry.id];
                                return (
                                    <li key={entry.id} class={["ac-step", state === "current" ? "ac-step--current" : ""]} aria-current={state === "current" ? "step" : undefined}>
                                        <StateIcon state={state} lab size={20} />
                                        <div class="ac-step__main">
                                            <span class="ac-step__title" dir="auto">
                                                {plainInline(entry.title)}
                                            </span>
                                            <span class="ac-step__sub">{stateWords(state)}</span>
                                        </div>
                                        <span class="ac-step__meta">
                                            {outcome ? `${pts(outcome.score)} / ${pts(outcome.maxScore)}` : pts(entry.points)} {t("points")}
                                        </span>
                                    </li>
                                );
                            })}
                        </ol>
                        <div class="ac-lab-aside__block">
                            {stage.value !== "brief" ? (
                                <div class="ac-between">
                                    <span class="ac-muted">{t("Points so far")}</span>
                                    <span class="ac-lab-aside__value ac-num">{`${pts(earned)} / ${pts(possible)}`}</span>
                                </div>
                            ) : null}
                            <p class="ac-muted ac-lab-aside__mark">
                                {`${t("Pass mark")}: ${props.lab.passPercent}% ${t("with no critical error")}`}
                            </p>
                        </div>
                    </SurfaceCard>
                </aside>
            );
        };

        const briefStage = () => {
            const tried = Boolean(props.best && props.best.attempts > 0);
            const passed = Boolean(props.best?.passedAt);
            return (
                <SurfaceCard class="ac-card" bodyGap="16px">
                    <h2 ref={heading} tabindex={-1} class="ac-h2 ac-lab-heading">
                        {t("Briefing")}
                    </h2>
                    <p class="ac-lead ac-lab-prose" dir="auto">
                        {renderInline(props.lab.briefing)}
                    </p>
                    <dl class="ac-lab-facts">
                        <div class="ac-lab-fact">
                            <dt>{t("Tasks")}</dt>
                            <dd class="ac-num">{props.lab.tasks.length}</dd>
                        </div>
                        <div class="ac-lab-fact">
                            <dt>{t("Duration")}</dt>
                            <dd class="ac-num">{`${props.lab.minutes} ${t("min")}`}</dd>
                        </div>
                        <div class="ac-lab-fact">
                            <dt>{t("Pass mark")}</dt>
                            <dd class="ac-num">{`${props.lab.passPercent}%`}</dd>
                            <dd class="ac-lab-fact__sub">{t("with no critical error")}</dd>
                        </div>
                    </dl>
                    <div class="ac-row ac-lab-best">
                        <VIcon icon={passed ? "mdi-trophy-outline" : tried ? "mdi-history" : "mdi-flask-empty-outline"} size={18} aria-hidden="true" />
                        <p class="ac-text">
                            {props.best && tried
                                ? `${t("Your best score")}: ${props.best.bestScore}% (${props.best.attempts} ${t("attempts")})${props.best.passedAt ? " — " + t("Passed") : ""}`
                                : t("You have not tried this lab yet.")}
                        </p>
                    </div>
                    <div>
                        <VBtn
                            color="primary"
                            size="large"
                            onClick={() => {
                                stage.value = "task";
                                focusHeading();
                            }}
                        >
                            {tried ? t("Start again") : t("Start lab")}
                        </VBtn>
                    </div>
                </SurfaceCard>
            );
        };

        const feedbackBlock = (current: LabTask, outcome: TaskScore) => {
            const feedback = feedbackFor(current);
            const tone: CalloutTone = outcome.correct ? "success" : outcome.score > 0 ? "warning" : "danger";
            const label = outcome.correct ? t("Correct") : outcome.score > 0 ? t("Partly correct") : t("Not correct");
            return (
                <>
                    <Callout
                        tone={tone}
                        role="none"
                        icon={outcome.correct ? "mdi-check-circle-outline" : outcome.score > 0 ? "mdi-circle-half-full" : "mdi-close-circle-outline"}
                        title={`${label} — ${pts(outcome.score)} / ${pts(outcome.maxScore)} ${t("points")}`}
                    >
                        {outcome.hintPenalty ? <p class="ac-lab-line">{t("Includes the 1 point hint cost.")}</p> : null}
                        {feedback ? (
                            <p class="ac-lab-line" dir="auto">
                                {feedback}
                            </p>
                        ) : null}
                    </Callout>
                    {outcome.criticalError ? (
                        <Callout tone="danger" role="alert" icon="mdi-alert-octagon-outline" title={t("Critical error")}>
                            <p class="ac-lab-line">
                                {t("This choice would be seriously harmful in real life. A lab with a critical error cannot be passed, whatever the score.")}
                            </p>
                        </Callout>
                    ) : null}
                </>
            );
        };

        const taskStage = () => {
            const current = task.value;
            const outcome = checked[current.id];
            const locked = Boolean(outcome);
            const lastTask = index.value + 1 >= total.value;
            return (
                <>
                    <SurfaceCard class="ac-card" bodyGap="8px">
                        <p class="ac-eyebrow ac-lab-eyebrow" aria-live="off">
                            {`${t("Task")} ${index.value + 1} / ${total.value} · ${current.points} ${t("points")}`}
                        </p>
                        <h2 ref={heading} tabindex={-1} class="ac-title ac-lab-heading" dir="auto">
                            {current.title}
                        </h2>
                        <p class="ac-lead ac-lab-prose" dir="auto">
                            {renderInline(current.prompt)}
                        </p>
                    </SurfaceCard>

                    {current.panels.length ? (
                        <div class="ac-grid ac-lab-panels">
                            {current.panels.map((panel, i) => (
                                <PanelView key={`${current.id}-${i}`} panel={panel} />
                            ))}
                        </div>
                    ) : null}

                    <SurfaceCard class="ac-card" key={current.id}>
                        <div class="ac-lab-answer">{renderTask(current, locked)}</div>
                        {!locked && current.hint && hintShown[current.id] ? (
                            <div class="ac-callout ac-lab-hint" role="note">
                                <VIcon class="ac-callout__icon" icon="mdi-lightbulb-on-outline" size={18} aria-hidden="true" />
                                <div class="ac-callout__body" dir="auto">
                                    <strong>{t("Hint")}:</strong> {renderInline(current.hint)}{" "}
                                    <span class="ac-muted">({t("This hint costs 1 point.")})</span>
                                </div>
                            </div>
                        ) : null}
                        {!locked ? (
                            <div class="ac-lab-actions">
                                {current.hint && !hintShown[current.id] ? (
                                    <VBtn
                                        variant="text"
                                        prependIcon="mdi-lightbulb-outline"
                                        onClick={() => {
                                            hintShown[current.id] = true;
                                        }}
                                    >
                                        {t("Show hint (costs 1 point)")}
                                    </VBtn>
                                ) : null}
                                <VBtn class="ac-lab-actions__primary" color="primary" disabled={!canCheck.value} onClick={check}>
                                    {t("Check")}
                                </VBtn>
                            </div>
                        ) : null}
                        <div aria-live="polite" role="status" class="ac-lab-feedback">
                            {outcome ? feedbackBlock(current, outcome) : null}
                        </div>
                        {outcome ? (
                            <div class="ac-lab-actions">
                                <VBtn class="ac-lab-actions__primary" color="primary" onClick={next}>
                                    {lastTask ? t("See results") : t("Next")}
                                </VBtn>
                            </div>
                        ) : null}
                    </SurfaceCard>
                </>
            );
        };

        return () => {
            let body;
            if (stage.value === "brief") {
                body = briefStage();
            } else if (stage.value === "task") {
                body = taskStage();
            } else {
                body = result.value ? (
                    <LabResult
                        lab={props.lab}
                        result={result.value}
                        answers={{ ...submitted }}
                        onRetry={reset}
                        headingRef={(el: HTMLElement | null) => (heading.value = el)}
                    />
                ) : null;
            }
            return (
                <div class="ac-lab">
                    {ribbon()}
                    <span class="ac-sr-only" role="status" aria-live="polite">
                        {stage.value === "task" ? `${t("Task")} ${index.value + 1} / ${total.value}` : ""}
                    </span>
                    <div class="ac-split">
                        <div class="ac-stack ac-lab-main">{body}</div>
                        {aside()}
                    </div>
                </div>
            );
        };
    },
});
export default LabRunner;
