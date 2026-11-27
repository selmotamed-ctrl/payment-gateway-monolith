import { ref } from "vue";
import { defineComponent } from "@/utils/dc";
import {
    COMMON_SIGNATURE_FAILURES,
    hmacSha256,
    signaturesMatch,
    type CryptoMode,
    type CryptoResult,
    type KeyEncoding,
    type OutputEncoding,
} from "./engine/crypto";
import { useGuideLocale } from "./useGuideLocale";
import { PgAutocomplete, PgTextarea, PgTextField } from "@pg/ui";

const parseFields = (value: string): Record<string, string> => {
    const fields: Record<string, string> = {};
    for (const line of value.split("\n")) {
        const separator = line.indexOf("=");
        if (separator < 0) continue;
        const key = line.slice(0, separator).trim();
        if (!key) continue;
        fields[key] = line.slice(separator + 1).trim();
    }
    return fields;
};

export const CryptoLab = defineComponent({
    name: "CryptoLab",
    setup() {
        const { L } = useGuideLocale();
        const mode = ref<CryptoMode>("SORTED_KEY_VALUE_AMP");
        const key = ref("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        const keyEncoding = ref<KeyEncoding>("HEX");
        const outputEncoding = ref<OutputEncoding>("HEX_UPPER");
        const fields = ref(
            "MerchantReference=1234567890\nAmountTrxn=10500\nMerchantId=10081014649\nTerminalId=99179395\nDateTimeLocalTrxn=202610311030",
        );
        const timestamp = ref("1761900000");
        const body = ref('{"event":"payment.completed","id":"evt_001","amount":"100.00"}');
        const result = ref<CryptoResult | null>(null);
        const comparison = ref("");
        const running = ref(false);

        const run = async () => {
            running.value = true;
            try {
                result.value = await hmacSha256({
                    mode: mode.value,
                    key: key.value,
                    keyEncoding: keyEncoding.value,
                    outputEncoding: outputEncoding.value,
                    fields: parseFields(fields.value),
                    timestamp: timestamp.value,
                    body: body.value,
                });
            } finally {
                running.value = false;
            }
        };

        const reset = () => {
            mode.value = "SORTED_KEY_VALUE_AMP";
            key.value = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
            keyEncoding.value = "HEX";
            outputEncoding.value = "HEX_UPPER";
            fields.value =
                "MerchantReference=1234567890\nAmountTrxn=10500\nMerchantId=10081014649\nTerminalId=99179395\nDateTimeLocalTrxn=202610311030";
            timestamp.value = "1761900000";
            body.value = '{"event":"payment.completed","id":"evt_001","amount":"100.00"}';
            comparison.value = "";
            void run();
        };

        void run();

        return () => (
            <section class="guide-tool">
                <header class="guide-tool__header">
                    <div>
                        <h2>{L("Signature lab", "مختبر التوقيع")}</h2>
                        <p>{L("See the exact text that is signed, then compare signatures.", "شاهد النص الدقيق الذي يُوقّع ثم قارن التوقيعات.")}</p>
                    </div>
                    <button type="button" class="guide-secondary-button" onClick={reset}>
                        {L("Reset", "إعادة تعيين")}
                    </button>
                </header>
                <p class="guide-tool__warning">
                    {L("Teaching tool — not connected to any real system. Example data, not a real partner's contract.", "أداة تعليمية — غير متصلة بأي نظام حقيقي. بيانات مثال وليست عقد شريك حقيقي.")}
                </p>
                <div class="guide-tool__grid">
                    <div class="guide-field">
                        <span>{L("Mode", "الوضع")}</span>
                        <PgAutocomplete
                            density="compact"
                            searchable={false}
                            clearable={false}
                            items={["SORTED_KEY_VALUE_AMP", "SORTED_VALUES_HASH", "TIMESTAMP_DOT_RAW_BODY", "RAW_BODY"]}
                            modelValue={mode.value}
                            onUpdate:modelValue={(value: CryptoMode) => (mode.value = value)}
                        />
                    </div>
                    <div class="guide-field">
                        <span>{L("Key encoding", "ترميز المفتاح")}</span>
                        <PgAutocomplete
                            density="compact"
                            searchable={false}
                            clearable={false}
                            items={["UTF8", "HEX", "BASE64"]}
                            modelValue={keyEncoding.value}
                            onUpdate:modelValue={(value: KeyEncoding) => (keyEncoding.value = value)}
                        />
                    </div>
                    <div class="guide-field">
                        <span>{L("Output encoding", "ترميز الخرج")}</span>
                        <PgAutocomplete
                            density="compact"
                            searchable={false}
                            clearable={false}
                            items={["HEX_UPPER", "HEX_LOWER", "BASE64"]}
                            modelValue={outputEncoding.value}
                            onUpdate:modelValue={(value: OutputEncoding) => (outputEncoding.value = value)}
                        />
                    </div>
                </div>
                <div class="guide-field">
                    <span>{L("Key", "المفتاح")}</span>
                    <PgTextarea rows={2} density="compact" modelValue={key.value} onUpdate:modelValue={(value: string) => (key.value = value)} />
                </div>
                {mode.value === "TIMESTAMP_DOT_RAW_BODY" ? (
                    <div class="guide-field">
                        <span>{L("Timestamp", "الطابع الزمني")}</span>
                        <PgTextField density="compact" modelValue={timestamp.value} onUpdate:modelValue={(value: string) => (timestamp.value = value)} />
                    </div>
                ) : null}
                {mode.value === "SORTED_KEY_VALUE_AMP" || mode.value === "SORTED_VALUES_HASH" ? (
                    <div class="guide-field">
                        <span>{L("Fields (one key=value per line)", "الحقول (مفتاح=قيمة في كل سطر)")}</span>
                        <PgTextarea rows={6} density="compact" modelValue={fields.value} onUpdate:modelValue={(value: string) => (fields.value = value)} />
                    </div>
                ) : (
                    <div class="guide-field">
                        <span>{L("Raw body", "النص الخام")}</span>
                        <PgTextarea rows={4} density="compact" modelValue={body.value} onUpdate:modelValue={(value: string) => (body.value = value)} />
                    </div>
                )}
                <button type="button" class="guide-primary-button" onClick={() => void run()} disabled={running.value}>
                    {L("Sign", "وقّع")}
                </button>
                {result.value ? (
                    <div class="guide-tool__result" aria-live="polite">
                        {result.value.error ? <p class="guide-tool__error">{result.value.error}</p> : null}
                        <p><strong>{L("Canonical string", "النص القانوني")}</strong></p>
                        <code class="guide-canonical">{result.value.canonicalVisible || "(empty)"}</code>
                        <p><strong>{L("Key bytes", "بايتات المفتاح")}</strong> {result.value.keyBytes}</p>
                        <p><strong>{L("Signature", "التوقيع")}</strong></p>
                        <code class="guide-signature">{result.value.output}</code>
                    </div>
                ) : null}
                <div class="guide-field">
                    <span>{L("Compare with partner's signature", "قارن مع توقيع الشريك")}</span>
                    <PgTextField density="compact" modelValue={comparison.value} onUpdate:modelValue={(value: string) => (comparison.value = value)} />
                </div>
                {comparison.value && result.value ? (
                    <div class={signaturesMatch(comparison.value, result.value.output) ? "guide-match" : "guide-no-match"} role="status">
                        <strong>{signaturesMatch(comparison.value, result.value.output) ? "MATCH" : "NO MATCH"}</strong>
                        {signaturesMatch(comparison.value, result.value.output) ? null : (
                            <ul>
                                {COMMON_SIGNATURE_FAILURES.map((failure) => (
                                    <li key={failure}>{failure}</li>
                                ))}
                            </ul>
                        )}
                    </div>
                ) : null}
                <div class="guide-tool__explain">
                    <h3>{L("Explain this result", "اشرح هذه النتيجة")}</h3>
                    <p>
                        {L(
                            "The partner and this lab must build exactly the same canonical string, use exactly the same key bytes, and format the result the same way. One difference changes every character of the signature.",
                            "يجب أن يبني الشريك وهذا المختبر نفس النص القانوني ونفس بايتات المفتاح وأن ينسقا النتيجة بالطريقة نفسها. أي اختلاف يغيّر كل حرف في التوقيع.",
                        )}
                    </p>
                </div>
            </section>
        );
    },
});

export default CryptoLab;
