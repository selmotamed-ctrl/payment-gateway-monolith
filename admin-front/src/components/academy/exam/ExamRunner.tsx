import { dc } from "kt-dc";
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VDialog } from "vuetify/components";
import { SurfaceCard, SurfaceCardText } from "@/components/ui/SurfaceCard";
import type { ExamAnswer, ExamQuestionPublic, ExamStartResponse } from "@/content/academy/apiTypes";

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

    const radioStyle = {
        display: "flex",
        gap: "10px",
        alignItems: "flex-start",
        padding: "10px 12px",
        border: "1px solid var(--pg-border-subtle)",
        borderRadius: "10px",
        cursor: "pointer",
        lineHeight: 1.55,
    } as const;

    const renderQuestion = (q: ExamQuestionPublic) => {
        const a = answers.value[q.qid];
        if (q.type === "single" || q.type === "truefalse") {
            return (
                <div role="radiogroup" aria-labelledby={`stem-${q.qid}`} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {q.options.map((o) => (
                        <label key={o.oid} style={radioStyle}>
                            <input type="radio" name={`q-${q.qid}`} checked={a === o.oid} onChange={() => setAnswer(q, o.oid)} style={{ marginBlockStart: "4px" }} />
                            <span>{o.text}</span>
                        </label>
                    ))}
                </div>
            );
        }
        if (q.type === "multi") {
            const chosen = Array.isArray(a) ? a : [];
            return (
                <div role="group" aria-labelledby={`stem-${q.qid}`} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <span style={{ fontSize: "12px", opacity: 0.7 }}>{t("Select all that apply.")}</span>
                    {q.options.map((o) => (
                        <label key={o.oid} style={radioStyle}>
                            <input
                                type="checkbox"
                                checked={chosen.includes(o.oid)}
                                onChange={(event: Event) => {
                                    const on = (event.target as HTMLInputElement).checked;
                                    setAnswer(q, on ? [...chosen, o.oid] : chosen.filter((id) => id !== o.oid));
                                }}
                                style={{ marginBlockStart: "4px" }}
                            />
                            <span>{o.text}</span>
                        </label>
                    ))}
                </div>
            );
        }
        if (q.type === "order") {
            const list = orderOf(q);
            const text = (oid: string) => q.options.find((o) => o.oid === oid)?.text ?? oid;
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <span style={{ fontSize: "12px", opacity: 0.7 }}>{t("Put the items in the correct order using the Up and Down buttons.")}</span>
                    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
                        {list.map((oid, position) => (
                            <li key={oid} style={{ ...radioStyle, cursor: "default", alignItems: "center", justifyContent: "space-between" }}>
                                <span><strong>{position + 1}.</strong> {text(oid)}</span>
                                <span style={{ display: "flex", gap: "4px" }}>
                                    <VBtn size="small" variant="outlined" disabled={position === 0} data-move={`${oid}--1`} aria-label={`${t("Move up")}: ${text(oid)}`} onClick={() => moveItem(q, position, -1)}>↑ {t("Up")}</VBtn>
                                    <VBtn size="small" variant="outlined" disabled={position === list.length - 1} data-move={`${oid}-1`} aria-label={`${t("Move down")}: ${text(oid)}`} onClick={() => moveItem(q, position, 1)}>↓ {t("Down")}</VBtn>
                                </span>
                            </li>
                        ))}
                    </ol>
                    {!isAnswered(q) && (
                        <div><VBtn size="small" variant="tonal" onClick={() => setAnswer(q, [...list])}>{t("Keep this order as my answer")}</VBtn></div>
                    )}
                </div>
            );
        }
        // number
        return (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxInlineSize: "320px" }}>
                <label for={`num-${q.qid}`} style={{ fontSize: "13px" }}>{t("Your answer (a number; use a dot for decimals)")}</label>
                <input
                    id={`num-${q.qid}`}
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    dir="ltr"
                    value={numText.value[q.qid] ?? (typeof a === "string" ? a : "")}
                    onInput={(event: Event) => onNumber(q, (event.target as HTMLInputElement).value)}
                    style={{ padding: "10px 12px", border: "1px solid var(--pg-border-subtle)", borderRadius: "8px", fontSize: "16px", background: "transparent", color: "inherit" }}
                />
                {(numText.value[q.qid] ?? "") !== "" && !NUMBER_RE.test(numText.value[q.qid] ?? "") && (
                    <span style={{ fontSize: "12px", opacity: 0.75 }}>{t("Not counted as answered yet: enter a complete number.")}</span>
                )}
            </div>
        );
    };

    return () => {
        const q = questions[index.value];
        const flaggedCount = flagged.value.length;
        return (
            <div ref={root} style={{ display: "flex", flexDirection: "column", gap: "14px", maxInlineSize: "900px" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>
                        {t("Question")} {index.value + 1} / {questions.length} · {questions.length - unanswered.value} {t("answered")}
                    </span>
                    <span role="timer" aria-live="off" aria-label={t("Time remaining")} style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                        {t("Time remaining")}: <span dir="ltr">{formatClock(remaining.value)}</span>
                    </span>
                </div>
                <div aria-live="polite" role="status" style={{ position: "absolute", inlineSize: "1px", blockSize: "1px", overflow: "hidden", clip: "rect(0 0 0 0)" }}>{announcement.value}</div>

                <nav aria-label={t("Question navigator")} style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {questions.map((item, i) => {
                        const done = isAnswered(item);
                        const flag = flagged.value.includes(item.qid);
                        const state = `${done ? t("answered") : t("not answered")}${flag ? `, ${t("flagged for review")}` : ""}`;
                        return (
                            <button
                                key={item.qid}
                                type="button"
                                aria-label={`${t("Question")} ${i + 1}: ${state}`}
                                aria-current={i === index.value ? "step" : undefined}
                                onClick={() => go(i)}
                                style={{
                                    minInlineSize: "40px",
                                    blockSize: "36px",
                                    padding: "0 6px",
                                    borderRadius: "8px",
                                    cursor: "pointer",
                                    color: "inherit",
                                    border: i === index.value ? "2px solid var(--pg-ink-primary, currentColor)" : "1px solid var(--pg-border-subtle)",
                                    background: done ? "var(--pg-status-success-bg)" : "transparent",
                                    fontWeight: i === index.value ? 700 : 500,
                                }}
                            >
                                {i + 1}{done ? " ✓" : ""}{flag ? " ⚑" : ""}
                            </button>
                        );
                    })}
                </nav>
                <span style={{ fontSize: "12px", opacity: 0.7 }}>✓ {t("answered")} · ⚑ {t("flagged for review")}</span>

                {q && (
                    <SurfaceCard key={q.qid}>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <h2 id={`stem-${q.qid}`} ref={heading} tabindex={-1} style={{ fontSize: "16px", fontWeight: 600, lineHeight: 1.6, margin: 0, outline: "none", whiteSpace: "pre-wrap" }}>
                                {q.stem}
                            </h2>
                            {renderQuestion(q)}
                            <div>
                                <label style={{ display: "inline-flex", gap: "8px", alignItems: "center", cursor: "pointer" }}>
                                    <input type="checkbox" checked={flagged.value.includes(q.qid)} onChange={() => toggleFlag(q.qid)} />
                                    <span>{t("Flag this question for review")}</span>
                                </label>
                            </div>
                        </SurfaceCardText>
                    </SurfaceCard>
                )}

                <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", justifyContent: "space-between" }}>
                    <span style={{ display: "flex", gap: "8px" }}>
                        <VBtn variant="outlined" disabled={index.value === 0} onClick={() => go(index.value - 1)}>{t("Previous")}</VBtn>
                        <VBtn variant="outlined" disabled={index.value >= questions.length - 1} onClick={() => go(index.value + 1)}>{t("Next")}</VBtn>
                    </span>
                    <VBtn color="primary" loading={props.submitting} disabled={props.submitting} onClick={() => (confirmOpen.value = true)}>{t("Submit exam")}</VBtn>
                </div>

                {props.submitError && (
                    <div role="alert" style={{ padding: "12px", border: "1px solid var(--pg-status-danger-border)", background: "var(--pg-status-danger-bg)", color: "var(--pg-status-danger-text)", borderRadius: "10px", display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                        <span>{props.submitError} {t("Your answers are still here and nothing has been lost.")}</span>
                        <VBtn size="small" variant="outlined" disabled={props.submitting} onClick={doSubmit}>{t("Try again")}</VBtn>
                    </div>
                )}

                <VDialog modelValue={confirmOpen.value} onUpdate:modelValue={(v: boolean) => (confirmOpen.value = v)} maxWidth="480">
                    <SurfaceCard>
                        <SurfaceCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <h2 style={{ fontSize: "18px", margin: 0 }}>{t("Submit your exam?")}</h2>
                            <ul style={{ margin: 0, paddingInlineStart: "20px", lineHeight: 1.7 }}>
                                <li>{unanswered.value} {t("unanswered")}</li>
                                <li>{flaggedCount} {t("flagged for review")}</li>
                            </ul>
                            <p style={{ margin: 0, fontSize: "13px" }}>{t("Once you submit, the exam is graded and you cannot change your answers.")}</p>
                            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                                <VBtn variant="outlined" onClick={() => (confirmOpen.value = false)}>{t("Keep working")}</VBtn>
                                <VBtn color="primary" onClick={doSubmit}>{t("Submit answers")}</VBtn>
                            </div>
                        </SurfaceCardText>
                    </SurfaceCard>
                </VDialog>
            </div>
        );
    };
});
