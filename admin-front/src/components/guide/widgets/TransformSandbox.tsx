import { defineComponent, onMounted, ref, watch } from "vue";
import {
    TRANSFORM_LIBRARY,
    applyTransforms,
    type TransformOperation,
    type TransformResult,
} from "./engine/transforms";
import { useGuideLocale } from "./useGuideLocale";

interface OperationRow {
    op: string;
    argsText: string;
}

const parseArgs = (value: string): (string | number)[] =>
    value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const unquoted = part.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
            return /^-?\d+(\.\d+)?$/.test(unquoted) ? Number(unquoted) : unquoted;
        });

export const TransformSandbox = defineComponent({
    name: "TransformSandbox",
    setup() {
        const { L } = useGuideLocale();
        const input = ref("10.50");
        const operations = ref<OperationRow[]>([
            { op: "scale", argsText: "1000" },
            { op: "to_int", argsText: "" },
            { op: "to_string", argsText: "" },
        ]);
        const result = ref<TransformResult>({ value: "10.50", steps: [] });
        const running = ref(false);

        const run = async () => {
            running.value = true;
            try {
                const pipeline: TransformOperation[] = operations.value.map((row) => ({
                    op: row.op,
                    args: parseArgs(row.argsText),
                }));
                result.value = await applyTransforms(input.value, pipeline);
            } finally {
                running.value = false;
            }
        };

        const addOperation = () => {
            operations.value = [...operations.value, { op: "trim", argsText: "" }];
        };
        const removeOperation = (index: number) => {
            operations.value = operations.value.filter((_entry, current) => current !== index);
        };
        const moveOperation = (index: number, delta: number) => {
            const next = [...operations.value];
            const target = index + delta;
            if (target < 0 || target >= next.length) return;
            const current = next[index]!;
            next[index] = next[target]!;
            next[target] = current;
            operations.value = next;
        };
        const reset = () => {
            input.value = "10.50";
            operations.value = [
                { op: "scale", argsText: "1000" },
                { op: "to_int", argsText: "" },
                { op: "to_string", argsText: "" },
            ];
            void run();
        };

        watch([input, operations], () => void run(), { deep: true });
        onMounted(() => void run());

        return () => (
            <section class="guide-tool">
                <header class="guide-tool__header">
                    <div>
                        <h2>{L("Transform pipeline", "مسار التحويل")}</h2>
                        <p>{L("Watch each operation change the value, one step at a time.", "شاهد كل عملية تغيّر القيمة خطوة بخطوة.")}</p>
                    </div>
                    <button type="button" class="guide-secondary-button" onClick={reset}>
                        {L("Reset", "إعادة تعيين")}
                    </button>
                </header>
                <p class="guide-tool__warning">
                    {L("Teaching tool — not connected to any real system.", "أداة تعليمية — غير متصلة بأي نظام حقيقي.")}
                </p>
                <label class="guide-field">
                    <span>{L("Input", "المدخل")}</span>
                    <textarea
                        rows={2}
                        value={input.value}
                        onInput={(event) => (input.value = (event.target as HTMLTextAreaElement).value)}
                    />
                </label>
                <div class="guide-operation-list">
                    {operations.value.map((row, index) => (
                        <div class="guide-operation" key={`${row.op}-${index}`}>
                            <span class="guide-operation__index">{index + 1}</span>
                            <select
                                value={row.op}
                                onChange={(event) => {
                                    const next = [...operations.value];
                                    next[index] = { ...row, op: (event.target as HTMLSelectElement).value };
                                    operations.value = next;
                                }}
                            >
                                {TRANSFORM_LIBRARY.map((operation) => (
                                    <option key={operation} value={operation}>
                                        {operation}
                                    </option>
                                ))}
                            </select>
                            <input
                                type="text"
                                value={row.argsText}
                                placeholder={L("arguments, comma separated", "الوسائط مفصولة بفواصل")}
                                onInput={(event) => {
                                    const next = [...operations.value];
                                    next[index] = {
                                        ...row,
                                        argsText: (event.target as HTMLInputElement).value,
                                    };
                                    operations.value = next;
                                }}
                            />
                            <button type="button" onClick={() => moveOperation(index, -1)} aria-label={L("Move earlier", "نقل للأعلى")}>
                                ↑
                            </button>
                            <button type="button" onClick={() => moveOperation(index, 1)} aria-label={L("Move later", "نقل للأسفل")}>
                                ↓
                            </button>
                            <button type="button" onClick={() => removeOperation(index)} aria-label={L("Remove operation", "حذف العملية")}>
                                ×
                            </button>
                        </div>
                    ))}
                </div>
                <button type="button" class="guide-secondary-button" onClick={addOperation}>
                    {L("Add operation", "إضافة عملية")}
                </button>
                <div class="guide-tool__result" aria-live="polite">
                    <strong>{L("Result", "النتيجة")}</strong>
                    <code>{running.value ? "…" : result.value.value}</code>
                    {result.value.error ? <p class="guide-tool__error">{result.value.error}</p> : null}
                </div>
                <div class="guide-tool__explain">
                    <h3>{L("Explain this result", "اشرح هذه النتيجة")}</h3>
                    {result.value.steps.length === 0 ? (
                        <p>{L("The input passes through unchanged.", "يمر المدخل دون تغيير.")}</p>
                    ) : (
                        <ol>
                            {result.value.steps.map((step, index) => (
                                <li key={`${step.operation}-${index}`}>
                                    {L("After", "بعد")} <code>{step.operation}</code>: <code>{step.value}</code>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
            </section>
        );
    },
});

export default TransformSandbox;
