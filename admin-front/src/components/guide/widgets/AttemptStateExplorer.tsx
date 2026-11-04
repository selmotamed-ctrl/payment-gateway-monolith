import { computed, defineComponent, onMounted, ref } from "vue";
import { loadData, type AttemptTransitionsData } from "@/content/guide";
import {
    applyAttemptEvent,
    attemptStateById,
    availableEvents,
    runAttemptPath,
    type AttemptStepResult,
} from "./engine/attemptStates";
import { useGuideLocale } from "./useGuideLocale";

export const AttemptStateExplorer = defineComponent({
    name: "AttemptStateExplorer",
    setup() {
        const { L } = useGuideLocale();
        const data = ref<AttemptTransitionsData | null>(null);
        const currentState = ref("CREATED");
        const history = ref<AttemptStepResult[]>([]);

        onMounted(async () => {
            const loaded = await loadData().catch(() => null);
            data.value = loaded?.["attempt-transitions"] ?? null;
            if (data.value) currentState.value = data.value.initial;
        });

        const state = computed(() =>
            data.value ? attemptStateById(data.value, currentState.value) : undefined,
        );
        const events = computed(() =>
            data.value ? availableEvents(data.value, currentState.value) : [],
        );

        const apply = (eventId: string) => {
            if (!data.value) return;
            const result = applyAttemptEvent(data.value, currentState.value, eventId);
            if (!result) return;
            history.value = [...history.value, result];
            currentState.value = result.state.stateId;
        };

        const reset = () => {
            if (!data.value) return;
            currentState.value = data.value.initial;
            history.value = [];
        };

        const preset = (eventIds: string[]) => {
            if (!data.value) return;
            const results = runAttemptPath(data.value, eventIds);
            history.value = results;
            currentState.value = results[results.length - 1]?.state.stateId ?? data.value.initial;
        };

        return () => (
            <section class="guide-tool">
                <header class="guide-tool__header">
                    <div>
                        <h2>{L("Payment state explorer", "مستكشف حالة الدفع")}</h2>
                        <p>{L("Click what happens next and watch the state, the slot and the money.", "اضغط ما سيحدث بعد ذلك وشاهد الحالة والخانة والمال.")}</p>
                    </div>
                    <button type="button" class="guide-secondary-button" onClick={reset}>
                        {L("Reset", "إعادة تعيين")}
                    </button>
                </header>
                <p class="guide-tool__warning">
                    {L("Teaching model — the real engine in core-back is authoritative.", "نموذج تعليمي — المحرك الحقيقي في core-back هو المرجع.")}
                </p>
                {!data.value ? (
                    <p>{L("Loading teaching data…", "جارٍ تحميل البيانات التعليمية…")}</p>
                ) : (
                    <>
                        <div class="guide-attempt-state" aria-live="polite">
                            <span>{L("Current state", "الحالة الحالية")}</span>
                            <strong>{state.value?.id ?? currentState.value}</strong>
                            <dl>
                                <div>
                                    <dt>{L("Link slot", "خانة الرابط")}</dt>
                                    <dd>{state.value?.slot}</dd>
                                </div>
                                <div>
                                    <dt>{L("Money", "المال")}</dt>
                                    <dd>{state.value?.money}</dd>
                                </div>
                                <div>
                                    <dt>{L("What a human should do", "ما يجب على الإنسان فعله")}</dt>
                                    <dd>{state.value?.human}</dd>
                                </div>
                            </dl>
                        </div>
                        <div class="guide-event-buttons">
                            {events.value.map((event) => (
                                <button
                                    key={event.id}
                                    type="button"
                                    class="guide-event-button"
                                    onClick={() => apply(event.id)}
                                >
                                    {event.label}
                                </button>
                            ))}
                        </div>
                        <div class="guide-preset-buttons">
                            <button type="button" onClick={() => preset(["ev-start", "ev-start-ok", "ev-customer-submits", "ev-confirm-timeout"])}>
                                {L("Preset: confirmation times out", "مثال: انتهاء مهلة التأكيد")}
                            </button>
                            <button type="button" onClick={() => preset(["ev-start", "ev-start-ok", "ev-customer-submits", "ev-confirm-success"])}>
                                {L("Preset: success", "مثال: نجاح")}
                            </button>
                            <button type="button" onClick={() => preset(["ev-start", "ev-start-ok", "ev-customer-submits", "ev-wrong-otp", "ev-wrong-otp-last"])}>
                                {L("Preset: third wrong code", "مثال: ثالث رمز خاطئ")}
                            </button>
                        </div>
                        <div class="guide-tool__explain">
                            <h3>{L("Explain this result", "اشرح هذه النتيجة")}</h3>
                            {history.value.length === 0 ? (
                                <p>{L("Choose an event to see what changes and why.", "اختر حدثاً لترى ما يتغير ولماذا.")}</p>
                            ) : (
                                <ol>
                                    {history.value.map((step, index) => (
                                        <li key={`${step.event.id}-${index}`}>
                                            <strong>{step.event.label}</strong> → {step.state.stateId}
                                            {step.note ? <em> — {step.note}</em> : null}
                                        </li>
                                    ))}
                                </ol>
                            )}
                            <p>
                                {L(
                                    "UNKNOWN never becomes FAILED by guessing. A timeout on confirm is UNKNOWN because money may have moved.",
                                    "لا تتحول UNKNOWN إلى FAILED بالتخمين. انتهاء المهلة عند التأكيد يعني UNKNOWN لأن المال قد يكون تحرك.",
                                )}
                            </p>
                        </div>
                    </>
                )}
            </section>
        );
    },
});

export default AttemptStateExplorer;
