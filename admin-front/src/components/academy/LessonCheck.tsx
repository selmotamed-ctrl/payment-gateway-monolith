import { computed, defineComponent, ref, type PropType } from "vue";
import { useRouter } from "vue-router";
import { useLocale } from "vuetify";
import { VIcon } from "vuetify/components";
import type { Question } from "@/content/academy";
import { Callout } from "./ui/Callout";

const shuffle = <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
};

/**
 * One practice check. Never blocks progress: wrong answers can be retried.
 * Contract (specs): `<section aria-labelledby>` named "Practice check N", the stem as an exact text node,
 * option buttons whose name is the option text (+ " Correct" / " Not correct"), and a polite live result area.
 */
export const LessonCheck = defineComponent({
    name: "AcademyLessonCheck",
    props: {
        question: { type: Object as PropType<Question>, required: true },
        index: { type: Number, required: true },
        /** How many checks the lesson has (progress dots only). */
        total: { type: Number, default: 2 },
        titles: { type: Object as PropType<Record<string, string>>, default: () => ({}) },
    },
    emits: { answered: (_firstTry: boolean) => true },
    setup(props, { emit }) {
        const { t } = useLocale();
        const router = useRouter();
        const options = computed(() => shuffle(props.question.options));
        const picked = ref<string[]>([]);
        const solved = ref(false);
        let reported = false;

        const choose = (id: string) => {
            if (solved.value || picked.value.includes(id)) return;
            const correct = Boolean(props.question.options.find((o) => o.id === id)?.correct);
            picked.value = [...picked.value, id];
            if (correct) solved.value = true;
            if (!reported) {
                reported = true;
                emit("answered", correct);
            }
        };

        return () => {
            const q = props.question;
            const lastWrong = !solved.value && picked.value.length > 0;
            const stemId = `ac-stem-${q.id}`;
            return (
                <section class="ac-card ac-lesson-check" aria-labelledby={`ac-q-${q.id}`}>
                    <div class="ac-lesson-check__head">
                        <h3 id={`ac-q-${q.id}`} class="ac-h3">
                            {t("Practice check")} {props.index + 1}
                        </h3>
                        <span class="ac-lesson-dots" aria-hidden="true">
                            {Array.from({ length: Math.max(props.total, props.index + 1) }, (_, i) => (
                                <span
                                    key={i}
                                    class={[
                                        "ac-lesson-dot",
                                        i < props.index || (i === props.index && solved.value) ? "ac-lesson-dot--done" : i === props.index ? "ac-lesson-dot--current" : "",
                                    ]}
                                />
                            ))}
                        </span>
                    </div>
                    <p id={stemId} class="ac-lesson-stem" dir="auto">
                        {q.stem}
                    </p>
                    <ul class="ac-choices ac-lesson-options" role="list" aria-labelledby={stemId}>
                        {options.value.map((option) => {
                            const wasPicked = picked.value.includes(option.id);
                            const good = wasPicked && Boolean(option.correct);
                            const bad = wasPicked && !option.correct;
                            return (
                                <li key={option.id} class="ac-lesson-option">
                                    <button
                                        type="button"
                                        class={["ac-choice", good ? "ac-choice--good" : "", bad ? "ac-choice--bad" : "", solved.value && !wasPicked ? "ac-lesson-choice--dim" : ""]}
                                        disabled={solved.value || wasPicked}
                                        aria-pressed={wasPicked}
                                        onClick={() => choose(option.id)}
                                    >
                                        <VIcon
                                            class="ac-lesson-choice__icon"
                                            icon={good ? "mdi-check-circle" : bad ? "mdi-close-circle" : "mdi-circle-outline"}
                                            size={18}
                                            aria-hidden="true"
                                        />
                                        <span class="ac-choice__label" dir="auto">
                                            {option.text}
                                        </span>
                                        {good && (
                                            <>
                                                {" "}
                                                <span class="ac-choice__tag">{t("Correct")}</span>
                                            </>
                                        )}
                                        {bad && (
                                            <>
                                                {" "}
                                                <span class="ac-choice__tag">{t("Not correct")}</span>
                                            </>
                                        )}
                                    </button>
                                    {wasPicked && option.note && (
                                        <p class={["ac-choice__note", "ac-lesson-note", good ? "ac-lesson-note--good" : "ac-lesson-note--bad"]} dir="auto">
                                            {option.note}
                                        </p>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    <div aria-live="polite" class="ac-lesson-result">
                        {solved.value && (
                            <Callout tone="success" role="none" title={t("Correct.")}>
                                {q.why ? <span dir="auto">{q.why}</span> : null}
                            </Callout>
                        )}
                        {lastWrong && (
                            <Callout tone="warning" role="none" title={t("Not quite.")}>
                                {t("Read the note and try another option.")}
                            </Callout>
                        )}
                        {solved.value && q.refs.length > 0 && (
                            <p class="ac-muted ac-lesson-refs">
                                <VIcon icon="mdi-book-open-page-variant-outline" size={16} aria-hidden="true" />
                                <span>
                                    {t("More in the Guide")}:{" "}
                                    {q.refs.map((id, i) => (
                                        <span key={id}>
                                            {i > 0 ? ", " : ""}
                                            <a class="ac-link" href={router.resolve({ name: "AdminGuideArticle", params: { articleId: id } }).href} target="_blank" rel="noopener" dir="auto">
                                                {props.titles[id] ?? id}
                                            </a>
                                        </span>
                                    ))}
                                </span>
                            </p>
                        )}
                    </div>
                </section>
            );
        };
    },
});
