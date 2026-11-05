import { dc } from "kt-dc";
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VDialog, VIcon } from "vuetify/components";
import { MetaPill } from "@/components/ui/MetaPill";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { ExamAnswer, ExamQuestionPublic, ExamStartResponse } from "@/content/academy/apiTypes";
import { Callout } from "../ui/Callout";
import { ProgressBar } from "../ui/ProgressBar";
import { StateIcon } from "../ui/StateIcon";

type Props = {
    session: ExamStartResponse;
    submitting: boolean;
    submitError: string | null;
    onSubmit: (answers: Record<string, ExamAnswer>) => void;
};

type Draft = {
    answers: Record<string, ExamAnswer>;
    flagged: string[];
    numText: Record<string, string>;
    index: number;
};

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const draftKey = (sessionId: string) => `pg.academy.exam.draft.${sessionId}`;

export const clearExamDraft = (sessionId: string) => {
    try {
        window.sessionStorage.removeItem(draftKey(sessionId));
    } catch {
        // storage unavailable
    }
};

const readDraft = (sessionId: string): Draft | null => {
    try {
        const raw = window.sessionStorage.getItem(draftKey(sessionId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Draft;
        if (!parsed || typeof parsed !== "object") return null;
        return {
            answers: parsed.answers && typeof parsed.answers === "object" ? parsed.answers : {},
            flagged: Array.isArray(parsed.flagged) ? parsed.flagged : [],
            numText: parsed.numText && typeof parsed.numText === "object" ? parsed.numText : {},
            index: typeof parsed.index === "number" ? parsed.index : 0,
        };
    } catch {
        return null;
    }
};

const formatClock = (ms: number): string => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const two = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
};

export const ExamRunner = dc((props: Props) => {
    const { t } = useLocale();
    const sessionId = props.session.sessionId;
    const questions = props.session.questions;
    const draft = readDraft(sessionId);
    const validQids = new Set(questions.map((q) => q.qid));

    const answers = ref<Record<string, ExamAnswer>>(
        Object.fromEntries(Object.entries(draft?.answers ?? {}).filter(([qid]) => validQids.has(qid))),
    );
    const flagged = ref<string[]>((draft?.flagged ?? []).filter((qid) => validQids.has(qid)));
    const numText = ref<Record<string, string>>(draft?.numText ?? {});
    const index = ref(Math.min(Math.max(0, draft?.index ?? 0), Math.max(0, questions.length - 1)));
    const confirmOpen = ref(false);
    const root = ref<HTMLElement | null>(null);
    const heading = ref<HTMLElement | null>(null);

    const persist = () => {
        try {
            window.sessionStorage.setItem(
                draftKey(sessionId),
                JSON.stringify({ answers: answers.value, flagged: flagged.value, numText: numText.value, index: index.value } satisfies Draft),
            );
        } catch {
            // storage unavailable: answers stay in memory
        }
    };

    const isAnswered = (q: ExamQuestionPublic): boolean => {
        const a = answers.value[q.qid];
        if (a === undefined) return false;
        if (q.type === "multi") return Array.isArray(a) && a.length > 0;
        if (q.type === "order") return Array.isArray(a) && a.length > 0;
        return typeof a === "string" && a !== "";
    };

    const setAnswer = (q: ExamQuestionPublic, value: ExamAnswer | undefined) => {
        const next = { ...answers.value };
        if (value === undefined || (Array.isArray(value) && value.length === 0 && q.type === "multi") || value === "") delete next[q.qid];
        else next[q.qid] = value;
        answers.value = next;
        persist();
    };

    const go = (to: number) => {
        index.value = Math.min(Math.max(0, to), questions.length - 1);
        persist();
        void nextTick(() => heading.value?.focus());
    };

    const toggleFlag = (qid: string) => {
        flagged.value = flagged.value.includes(qid) ? flagged.value.filter((id) => id !== qid) : [...flagged.value, qid];
        persist();
    };

    // --- timer (visual every second; announced only at 10, 5 and 1 minutes) ---
    const now = ref(Date.now());
    const expiresMs = Date.parse(props.session.expiresAt);
    const announced = new Set<number>();
    const announcement = ref("");
    const remaining = computed(() => Math.max(0, expiresMs - now.value));
    const tick = () => {
        now.value = Date.now();
        const left = Math.max(0, expiresMs - now.value);
        for (const minutes of [10, 5, 1]) {
            if (left <= minutes * 60000 && !announced.has(minutes)) {
                [10, 5, 1].filter((m) => m >= minutes).forEach((m) => announced.add(m));
                announcement.value = `${minutes} ${minutes === 1 ? t("minute") : t("minutes")} ${t("remaining")}`;
                return;
            }
        }
        if (left === 0 && !announced.has(0)) {
            announced.add(0);
            announcement.value = t("The time limit has passed. Please submit your answers now.");
        }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    onBeforeUnmount(() => window.clearInterval(timer));

    // --- order questions ---
    const orderOf = (q: ExamQuestionPublic): string[] => {
        const a = answers.value[q.qid];
        return Array.isArray(a) ? a : q.options.map((o) => o.oid);
    };
    const moveItem = (q: ExamQuestionPublic, from: number, delta: -1 | 1) => {
        const list = [...orderOf(q)];
        const to = from + delta;
        if (to < 0 || to >= list.length) return;
        const [item] = list.splice(from, 1);
        if (item === undefined) return;
        list.splice(to, 0, item);
        setAnswer(q, list);
        void nextTick(() => {
            const el = root.value?.querySelector<HTMLButtonElement>(`[data-move="${item}-${delta}"]:not([disabled])`) ?? root.value?.querySelector<HTMLButtonElement>(`[data-move="${item}-${-delta}"]:not([disabled])`);
            el?.focus();
        });
    };

    const onNumber = (q: ExamQuestionPublic, raw: string) => {
        const cleaned = raw.replace(",", ".");
        if (!/^-?\d*\.?\d*$/.test(cleaned)) return;
        numText.value = { ...numText.value, [q.qid]: cleaned };
        setAnswer(q, NUMBER_RE.test(cleaned) ? cleaned : undefined);
    };

    const unanswered = computed(() => questions.filter((q) => !isAnswered(q)).length);
    const buildAnswers = (): Record<string, ExamAnswer> =>
        Object.fromEntries(
            questions.filter((q) => isAnswered(q)).map((q) => [q.qid, answers.value[q.qid] as ExamAnswer]),
        );
    const doSubmit = () => {
        confirmOpen.value = false;
        props.onSubmit(buildAnswers());
    };

    const answeredCount = computed(() => questions.length - unanswered.value);

    /** Visual tone of the clock only (the spoken announcements above are unchanged). */
    const clockTone = computed<"neutral" | "warning" | "danger">(() => (remaining.value < 60000 ? "danger" : remaining.value < 300000 ? "warning" : "neutral"));
    const CLOCK_ICON = { neutral: "mdi-timer-outline", warning: "mdi-timer-alert-outline", danger: "mdi-timer-alert" } as const;
    const clockNote = computed(() => {
        if (remaining.value <= 0) return t("The time limit has passed. Please submit your answers now.");
        if (remaining.value < 60000) return t("Less than a minute left");
        if (remaining.value < 300000) return t("Less than 5 minutes left");
        return "";
    });

    const renderQuestion = (q: ExamQuestionPublic) => {
        const a = answers.value[q.qid];
        if (q.type === "single" || q.type === "truefalse") {
            return (
                <div role="radiogroup" aria-labelledby={`stem-${q.qid}`} class="ac-choices">
                    {q.options.map((o) => (
                        <label key={o.oid} class={["ac-choice", a === o.oid ? "ac-choice--selected" : ""]}>
                            <input type="radio" name={`q-${q.qid}`} checked={a === o.oid} onChange={() => setAnswer(q, o.oid)} />
                            <span class="ac-choice__label" dir="auto">{o.text}</span>
                        </label>
                    ))}
                </div>
            );
        }
        if (q.type === "multi") {
            const chosen = Array.isArray(a) ? a : [];
            return (
                <div role="group" aria-labelledby={`stem-${q.qid}`} class="ac-stack ac-stack--sm">
                    <span class="ac-muted">{t("Select all that apply.")}</span>
                    <div class="ac-choices">
                        {q.options.map((o) => (
                            <label key={o.oid} class={["ac-choice", chosen.includes(o.oid) ? "ac-choice--selected" : ""]}>
                                <input
                                    type="checkbox"
                                    checked={chosen.includes(o.oid)}
                                    onChange={(event: Event) => {
                                        const on = (event.target as HTMLInputElement).checked;
                                        setAnswer(q, on ? [...chosen, o.oid] : chosen.filter((id) => id !== o.oid));
                                    }}
                                />
                                <span class="ac-choice__label" dir="auto">{o.text}</span>
                            </label>
                        ))}
                    </div>
                </div>
            );
        }
        if (q.type === "order") {
            const list = orderOf(q);
            const text = (oid: string) => q.options.find((o) => o.oid === oid)?.text ?? oid;
            return (
                <div class="ac-stack ac-stack--sm">
                    <span class="ac-muted">{t("Put the items in the correct order using the Up and Down buttons.")}</span>
                    <ol class="ac-choices ac-exam-order">
                        {list.map((oid, position) => (
                            <li key={oid} class="ac-choice ac-choice--locked ac-exam-order__row">
                                <span class="ac-exam-order__pos ac-num">{position + 1}.</span>
                                <span class="ac-choice__label" dir="auto">{text(oid)}</span>
                                <span class="ac-row ac-exam-order__moves">
                                    <VBtn
                                        class="ac-exam-move"
                                        size="small"
                                        variant="outlined"
                                        icon="mdi-arrow-up"
                                        disabled={position === 0}
                                        data-move={`${oid}--1`}
                                        aria-label={`${t("Move up")}: ${text(oid)}`}
                                        {...{ title: t("Up") }}
                                        onClick={() => moveItem(q, position, -1)}
                                    />
                                    <VBtn
                                        class="ac-exam-move"
                                        size="small"
                                        variant="outlined"
                                        icon="mdi-arrow-down"
                                        disabled={position === list.length - 1}
                                        data-move={`${oid}-1`}
                                        aria-label={`${t("Move down")}: ${text(oid)}`}
                                        {...{ title: t("Down") }}
                                        onClick={() => moveItem(q, position, 1)}
                                    />
                                </span>
                            </li>
                        ))}
                    </ol>
                    {!isAnswered(q) && (
                        <div>
                            <VBtn size="small" variant="tonal" onClick={() => setAnswer(q, [...list])}>
                                {t("Keep this order as my answer")}
                            </VBtn>
                        </div>
                    )}
                </div>
            );
        }
        // number
        const typed = numText.value[q.qid] ?? "";
        return (
            <div class="ac-stack ac-stack--sm ac-exam-numberfield">
                <label for={`num-${q.qid}`} class="ac-h3">
                    {t("Your answer (a number; use a dot for decimals)")}
                </label>
                <input
                    id={`num-${q.qid}`}
                    class="ac-exam-number"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    dir="ltr"
                    value={numText.value[q.qid] ?? (typeof a === "string" ? a : "")}
                    onInput={(event: Event) => onNumber(q, (event.target as HTMLInputElement).value)}
                />
                {typed !== "" && !NUMBER_RE.test(typed) && <span class="ac-muted">{t("Not counted as answered yet: enter a complete number.")}</span>}
            </div>
        );
    };

    const renderNavigator = () => (
        <nav aria-label={t("Question navigator")} class="ac-exam-nav">
            {questions.map((item, i) => {
                const done = isAnswered(item);
                const flag = flagged.value.includes(item.qid);
                const current = i === index.value;
                const state = `${done ? t("answered") : t("not answered")}${flag ? `, ${t("flagged for review")}` : ""}`;
                return (
                    <button
                        key={item.qid}
                        type="button"
                        class={["ac-exam-qbtn", done ? "ac-exam-qbtn--done" : "", flag ? "ac-exam-qbtn--flag" : "", current ? "ac-exam-qbtn--current" : ""]}
                        aria-label={`${t("Question")} ${i + 1}: ${state}`}
                        aria-current={current ? "step" : undefined}
                        onClick={() => go(i)}
                    >
                        <span class="ac-exam-qbtn__n ac-num" aria-hidden="true">{i + 1}</span>
                        {flag && <VIcon class="ac-exam-qbtn__flag" icon="mdi-flag" size={11} />}
                        {done && <VIcon class="ac-exam-qbtn__check" icon="mdi-check" size={11} />}
                    </button>
                );
            })}
        </nav>
    );

    return () => {
        const q = questions[index.value];
        const flaggedCount = flagged.value.length;
        const tone = clockTone.value;
        return (
            <div ref={root} class="ac-exam-runner">
                <div aria-live="polite" role="status" class="ac-sr-only">{announcement.value}</div>

                <div class="ac-split ac-split--reading">
                    <div class="ac-stack">
                        {q && (
                            <SurfaceCard key={q.qid} class="ac-card">
                                <div class="ac-stack">
                                    <div class="ac-between">
                                        <span class="ac-eyebrow ac-exam-qeyebrow">{`${t("Question")} ${index.value + 1}`}</span>
                                        <span class={["ac-exam-clock-compact", `ac-exam-clock-compact--${tone}`]} aria-hidden="true" dir="ltr">
                                            <VIcon icon={CLOCK_ICON[tone]} size={14} />
                                            {formatClock(remaining.value)}
                                        </span>
                                        {flagged.value.includes(q.qid) && (
                                            <MetaPill color="warning" prependIcon="mdi-flag">
                                                {t("Flagged for review")}
                                            </MetaPill>
                                        )}
                                    </div>
                                    <h2 id={`stem-${q.qid}`} ref={heading} tabindex={-1} class="ac-exam-stem" dir="auto">
                                        {q.stem}
                                    </h2>
                                    {renderQuestion(q)}
                                    <label class="ac-exam-flag">
                                        <input type="checkbox" checked={flagged.value.includes(q.qid)} onChange={() => toggleFlag(q.qid)} />
                                        <VIcon icon="mdi-flag-outline" size={16} />
                                        <span>{t("Flag this question for review")}</span>
                                    </label>
                                </div>
                            </SurfaceCard>
                        )}

                        <div class="ac-between ac-exam-actions">
                            <span class="ac-row ac-exam-pager">
                                <VBtn variant="outlined" prependIcon="mdi-chevron-left" disabled={index.value === 0} onClick={() => go(index.value - 1)}>
                                    {t("Previous")}
                                </VBtn>
                                <VBtn variant="outlined" appendIcon="mdi-chevron-right" disabled={index.value >= questions.length - 1} onClick={() => go(index.value + 1)}>
                                    {t("Next")}
                                </VBtn>
                            </span>
                            <VBtn color="primary" loading={props.submitting} disabled={props.submitting} onClick={() => (confirmOpen.value = true)}>
                                {t("Submit exam")}
                            </VBtn>
                        </div>

                        {props.submitError && (
                            <Callout tone="danger">
                                <div class="ac-between">
                                    <span>
                                        {props.submitError} {t("Your answers are still here and nothing has been lost.")}
                                    </span>
                                    <VBtn size="small" variant="outlined" disabled={props.submitting} onClick={doSubmit}>
                                        {t("Try again")}
                                    </VBtn>
                                </div>
                            </Callout>
                        )}
                    </div>

                    <aside class="ac-aside ac-exam-aside">
                        <SurfaceCard class="ac-card" color={tone === "warning" ? "warning" : tone === "danger" ? "error" : ""}>
                            <div class={["ac-exam-timer", `ac-exam-timer--${tone}`]}>
                                <VIcon class="ac-exam-timer__icon" icon={CLOCK_ICON[tone]} size={26} />
                                <div class="ac-exam-timer__body">
                                    <span class="ac-exam-timer__label">{t("Time remaining")}</span>
                                    <span role="timer" aria-live="off" aria-label={t("Time remaining")} class="ac-exam-clock ac-num" dir="ltr">
                                        {formatClock(remaining.value)}
                                    </span>
                                    {clockNote.value && <span class="ac-exam-timer__note">{clockNote.value}</span>}
                                </div>
                            </div>
                        </SurfaceCard>

                        <SurfaceCard class="ac-card">
                            <div class="ac-stack">
                                <div class="ac-stack ac-stack--sm">
                                    <p class="ac-h3 ac-num">{`${t("Question")} ${index.value + 1} / ${questions.length} · ${answeredCount.value} ${t("answered")}`}</p>
                                    <ProgressBar value={answeredCount.value} max={questions.length} label={`${answeredCount.value} / ${questions.length} ${t("answered")}`} />
                                </div>
                                <div class="ac-stack ac-stack--sm">
                                    <h3 class="ac-h3">{t("Question navigator")}</h3>
                                    {renderNavigator()}
                                    <ul class="ac-exam-legend">
                                        <li>
                                            <span class="ac-exam-swatch ac-exam-swatch--done"><VIcon icon="mdi-check" size={11} /></span>
                                            {t("Answered")}
                                        </li>
                                        <li>
                                            <span class="ac-exam-swatch"></span>
                                            {t("Not answered")}
                                        </li>
                                        <li>
                                            <span class="ac-exam-swatch ac-exam-swatch--flag"><VIcon icon="mdi-flag" size={11} /></span>
                                            {t("Flagged for review")}
                                        </li>
                                        <li>
                                            <span class="ac-exam-swatch ac-exam-swatch--current"></span>
                                            {t("Current question")}
                                        </li>
                                    </ul>
                                </div>
                            </div>
                        </SurfaceCard>
                    </aside>
                </div>

                <VDialog modelValue={confirmOpen.value} onUpdate:modelValue={(v: boolean) => (confirmOpen.value = v)} maxWidth="480">
                    <SurfaceCard title={t("Submit your exam?")}>
                        <div class="ac-stack">
                            <ul class="ac-steps">
                                <li class="ac-step">
                                    <StateIcon state={unanswered.value > 0 ? "partial" : "done"} />
                                    <span class="ac-step__title ac-num">{`${unanswered.value} ${t("unanswered")}`}</span>
                                </li>
                                <li class="ac-step">
                                    <StateIcon state={flaggedCount > 0 ? "partial" : "done"} />
                                    <span class="ac-step__title ac-num">{`${flaggedCount} ${t("flagged for review")}`}</span>
                                </li>
                            </ul>
                            <p class="ac-text">{t("Once you submit, the exam is graded and you cannot change your answers.")}</p>
                            <div class="ac-row ac-exam-confirm__actions">
                                <VBtn variant="outlined" onClick={() => (confirmOpen.value = false)}>
                                    {t("Keep working")}
                                </VBtn>
                                <VBtn color="primary" onClick={doSubmit}>
                                    {t("Submit answers")}
                                </VBtn>
                            </div>
                        </div>
                    </SurfaceCard>
                </VDialog>
            </div>
        );
    };
}, { props: ["session", "submitting", "submitError", "onSubmit"] });
