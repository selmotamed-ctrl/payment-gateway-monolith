import { computed, defineComponent, ref, type PropType } from "vue";
import { RouterLink } from "vue-router";
import { useLocale } from "vuetify";
import type { Question } from "@/content/academy";

const shuffle = <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
};

/** One practice check. Never blocks progress: wrong answers can be retried. */
export const LessonCheck = defineComponent({
    name: "AcademyLessonCheck",
    props: {
        question: { type: Object as PropType<Question>, required: true },
        index: { type: Number, required: true },
        titles: { type: Object as PropType<Record<string, string>>, default: () => ({}) },
    },
    emits: { answered: (_firstTry: boolean) => true },
    setup(props, { emit }) {
        const { t } = useLocale();
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
            return (
                <section class="ac-card" aria-labelledby={`ac-q-${q.id}`}>
                    <h3 id={`ac-q-${q.id}`} class="ac-h3">
                        {t("Practice check")} {props.index + 1}
                    </h3>
                    <p class="ac-stem">{q.stem}</p>
                    <ul class="ac-options" role="list">
                        {options.value.map((option) => {
                            const wasPicked = picked.value.includes(option.id);
                            const good = wasPicked && option.correct;
                            const bad = wasPicked && !option.correct;
                            return (
                                <li key={option.id}>
                                    <button
                                        type="button"
                                        class={["ac-option", good ? "ac-option--good" : "", bad ? "ac-option--bad" : ""]}
                                        disabled={solved.value || wasPicked}
                                        aria-pressed={wasPicked}
                                        onClick={() => choose(option.id)}
                                    >
                                        <span aria-hidden="true" class="ac-option-icon">{good ? "✓" : bad ? "✗" : "○"}</span>
                                        <span>{option.text}</span>
                                        {good && <span class="ac-option-tag">{t("Correct")}</span>}
                                        {bad && <span class="ac-option-tag">{t("Not correct")}</span>}
                                    </button>
                                    {wasPicked && option.note && <p class="ac-note">{option.note}</p>}
                                </li>
                            );
                        })}
                    </ul>
                    <div aria-live="polite" class="ac-result">
                        {solved.value && (
                            <p class="ac-result--good">
                                <strong>✓ {t("Correct.")}</strong> {q.why}
                            </p>
                        )}
                        {lastWrong && (
                            <p class="ac-result--bad">
                                <strong>✗ {t("Not quite.")}</strong> {t("Read the note and try another option.")}
                            </p>
                        )}
                        {solved.value && q.refs.length > 0 && (
                            <p class="ac-muted">
                                {t("More in the Guide")}:{" "}
                                {q.refs.map((id, i) => (
                                    <span key={id}>
                                        {i > 0 ? ", " : ""}
                                        <RouterLink to={{ name: "AdminGuideArticle", params: { articleId: id } }} target="_blank">
                                            {props.titles[id] ?? id}
                                        </RouterLink>
                                    </span>
                                ))}
                            </p>
                        )}
                    </div>
                </section>
            );
        };
    },
});
