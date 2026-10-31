import { dc } from "kt-dc";
import { ref } from "vue";
import { VAlert, VBtn, VCard, VCardText, VSelect, VTextarea, VTextField } from "vuetify/components";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { StatusChip } from "@/components/StatusChip";
import { runTransform, TRANSFORM_OPS, type TransformResult } from "@/components/guide/transform";

const MONO_STYLE = {
    margin: 0,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px",
    lineHeight: 1.55,
};

const PRESETS = [
    { title: "Moamalat Dirham: 10.5000 -> 10500", value: "moamalat" },
    { title: "DPay 2-decimal: 76.2550 -> 76.26", value: "dpay" },
    { title: "Libyan phone: ٠٩١٢٣٤٥٦٧٨ -> 0912345678", value: "phone" },
];

export const TransformPlayground = dc(() => {
    const input = ref("10.5000");
    const ops = ref<string[]>(["scale", "to_int", "to_string"]);
    const args = ref("1000");
    const result = ref<TransformResult | null>(null);

    const items = TRANSFORM_OPS.map((op) => ({ title: `${op.value} — ${op.description}`, value: op.value }));

    const applyPreset = (preset: string) => {
        result.value = null;
        if (preset === "moamalat") {
            input.value = "10.5000";
            ops.value = ["scale", "to_int", "to_string"];
            args.value = "1000";
        } else if (preset === "dpay") {
            input.value = "76.2550";
            ops.value = ["round", "format_decimal"];
            args.value = "2,2";
        } else {
            input.value = "٠٩١٢٣٤٥٦٧٨";
            ops.value = ["arabic_digits_to_ascii", "phone_normalize"];
            args.value = "LOCAL_09";
        }
    };

    return () => (
        <VCard variant="outlined">
            <VCardText style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <ThemedView style={{ flexDirection: "row", flexWrap: "wrap", gap: "8px" }}>
                    {PRESETS.map((preset) => (
                        <VBtn key={preset.value} size="small" variant="tonal" onClick={() => applyPreset(preset.value)}>
                            {preset.title}
                        </VBtn>
                    ))}
                </ThemedView>
                <VTextarea
                    modelValue={input.value}
                    onUpdate:modelValue={(value: string) => (input.value = value ?? "")}
                    label="Input value"
                    rows={2}
                />
                <VSelect
                    multiple
                    chips
                    closableChips
                    modelValue={ops.value}
                    onUpdate:modelValue={(value: string[] | null) => (ops.value = value ?? [])}
                    items={items}
                    label="TransformPipe[] (applied left to right)"
                />
                <VTextField
                    modelValue={args.value}
                    onUpdate:modelValue={(value: string) => (args.value = value ?? "")}
                    label="Arguments (comma separated)"
                    hint="Example: 1000 for scale(1000); 2,2 for round(2) then format_decimal(2)"
                    persistentHint
                />
                <VBtn prependIcon="mdi-play" onClick={() => (result.value = runTransform(input.value, ops.value, args.value))}>
                    Run TransformPipe
                </VBtn>
                {result.value ? (
                    <ThemedView style={{ gap: "8px" }}>
                        <ThemedView style={{ flexDirection: "row", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            <StatusChip
                                label={result.value.failed ? "Stopped on error" : "Completed"}
                                tone={result.value.failed ? "error" : "success"}
                            />
                            <ThemedText style={{ fontSize: "12px", opacity: 0.7 }}>{`${result.value.steps.length} steps`}</ThemedText>
                        </ThemedView>
                        {result.value.steps.map((step, index) => (
                            <VCard key={`${step.op}-${index}`} variant="outlined">
                                <VCardText style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                    <StatusChip label={`${index + 1}. ${step.op}`} tone={step.ok ? "primary" : "error"} size="x-small" />
                                    <pre style={{ ...MONO_STYLE, padding: "8px", borderRadius: "8px", background: "rgba(100,116,139,0.10)" }}>
                                        {step.output}
                                    </pre>
                                    {step.note ? <ThemedText style={{ fontSize: "11px", opacity: 0.65 }}>{step.note}</ThemedText> : null}
                                </VCardText>
                            </VCard>
                        ))}
                        <VAlert type="success" variant="tonal" density="compact">
                            <pre style={MONO_STYLE}>{result.value.final}</pre>
                        </VAlert>
                    </ThemedView>
                ) : null}
            </VCardText>
        </VCard>
    );
});

export default TransformPlayground;
