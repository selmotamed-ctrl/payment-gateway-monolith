import { defineComponent, ref } from "vue";
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
                    <label class="guide-field">
                        <span>{L("Mode", "الوضع")}</span>
                        <select value={mode.value} onChange={(event) => (mode.value = (event.target as HTMLSelectElement).value as CryptoMode)}>
                            <option value="SORTED_KEY_VALUE_AMP">SORTED_KEY_VALUE_AMP</option>
                            <option value="SORTED_VALUES_HASH">SORTED_VALUES_HASH</option>
                            <option value="TIMESTAMP_DOT_RAW_BODY">TIMESTAMP_DOT_RAW_BODY</option>
                            <option value="RAW_BODY">RAW_BODY</option>
                        </select>
                    </label>
                    <label class="guide-field">
                        <span>{L("Key encoding", "ترميز المفتاح")}</span>
                        <select value={keyEncoding.value} onChange={(event) => (keyEncoding.value = (event.target as HTMLSelectElement).value as KeyEncoding)}>
                            <option value="UTF8">UTF8</option>
                            <option value="HEX">HEX</option>
                            <option value="BASE64">BASE64</option>
                        </select>
                    </label>
                    <label class="guide-field">
                        <span>{L("Output encoding", "ترميز الخرج")}</span>
                        <select value={outputEncoding.value} onChange={(event) => (outputEncoding.value = (event.target as HTMLSelectElement).value as OutputEncoding)}>
                            <option value="HEX_UPPER">HEX_UPPER</option>
                            <option value="HEX_LOWER">HEX_LOWER</option>
                            <option value="BASE64">BASE64</option>
                        </select>
                    </label>
                </div>
                <label class="guide-field">
                    <span>{L("Key", "المفتاح")}</span>
                    <textarea rows={2} value={key.value} onInput={(event) => (key.value = (event.target as HTMLTextAreaElement).value)} />
                </label>
                {mode.value === "TIMESTAMP_DOT_RAW_BODY" ? (
                    <label class="guide-field">
                        <span>{L("Timestamp", "الطابع الزمني")}</span>
                        <input value={timestamp.value} onInput={(event) => (timestamp.value = (event.target as HTMLInputElement).value)} />
                    </label>
                ) : null}
                {mode.value === "SORTED_KEY_VALUE_AMP" || mode.value === "SORTED_VALUES_HASH" ? (
                    <label class="guide-field">
                        <span>{L("Fields (one key=value per line)", "الحقول (مفتاح=قيمة في كل سطر)")}</span>
                        <textarea rows={6} value={fields.value} onInput={(event) => (fields.value = (event.target as HTMLTextAreaElement).value)} />
                    </label>
                ) : (
                    <label class="guide-field">
                        <span>{L("Raw body", "النص الخام")}</span>
                        <textarea rows={4} value={body.value} onInput={(event) => (body.value = (event.target as HTMLTextAreaElement).value)} />
                    </label>
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
                <label class="guide-field">
                    <span>{L("Compare with partner's signature", "قارن مع توقيع الشريك")}</span>
                    <input value={comparison.value} onInput={(event) => (comparison.value = (event.target as HTMLInputElement).value)} />
                </label>
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
