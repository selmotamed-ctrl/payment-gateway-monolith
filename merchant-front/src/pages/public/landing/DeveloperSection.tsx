import { defineComponent, onBeforeUnmount, ref, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VBtn, VIcon } from "vuetify/components";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import {
    LANDING_SNIPPETS,
    LANDING_SNIPPET_RESPONSE,
    type LandingSnippetLanguage,
} from "@/content/landing/landingModel";

const LANGUAGES: { value: LandingSnippetLanguage; label: string }[] = [
    { value: "curl", label: "cURL" },
    { value: "typescript", label: "TypeScript" },
    { value: "python", label: "Python" },
];

/** Tiny tokenizer: strings, comments, numbers and JSON keys. No dependency, no innerHTML. */
const highlight = (source: string): VNodeChild[] => {
    const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|((?<![:\w])\/\/[^\n]*|(?<=\s)#[^\n{]*$)|(\b\d+(?:\.\d+)?\b)/gm;
    const out: VNodeChild[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = pattern.exec(source))) {
        if (match.index > last) out.push(source.slice(last, match.index));
        const [text, str, comment, num] = match;
        const isKey = !!str && /^\s*:/.test(source.slice(match.index + text.length));
        const cls = comment ? "tok-c" : str ? (isKey ? "tok-k" : "tok-s") : num ? "tok-n" : "";
        out.push(
            <span key={key++} class={cls}>
                {text}
            </span>,
        );
        last = match.index + text.length;
    }
    if (last < source.length) out.push(source.slice(last));
    return out;
};

const POINTS = [
    { icon: "mdi-key-variant", title: "pg_live_ bearer tokens", text: "Scoped, shown once, stored only as a hash, revocable at any time." },
    { icon: "mdi-ip-network-outline", title: "IP CIDR allowlists", text: "Lock a token to your servers so a leaked secret is useless elsewhere." },
    { icon: "mdi-decimal", title: "Decimal-string amounts", text: "Money travels as strings like \"250.000\" and is re-validated by the core. Never floats." },
    { icon: "mdi-magnify-scan", title: "Verify, don't trust the browser", text: "Confirm with GET /links/:key or /payments/:reference before you ship the order." },
];

export const DeveloperSection = defineComponent({
    name: "LandingDeveloperSection",
    setup() {
        const { t, current } = useLocale();
        const language = ref<LandingSnippetLanguage>("curl");
        const copied = ref(false);
        let resetTimer: ReturnType<typeof setTimeout> | null = null;

        const copy = async () => {
            try {
                await navigator.clipboard?.writeText(LANDING_SNIPPETS[language.value]);
                copied.value = true;
                if (resetTimer) clearTimeout(resetTimer);
                resetTimer = setTimeout(() => (copied.value = false), 1800);
            } catch {
                copied.value = false;
            }
        };
        onBeforeUnmount(() => resetTimer && clearTimeout(resetTimer));

        return () => (
            <div class="pgl-dev">
                <div class="pgl-dev__copy">
                    <ul class="pgl-dev__points">
                        {POINTS.map((point, index) => (
                            <li key={point.title} data-reveal style={{ "--pgl-i": index }}>
                                <span class="pgl-icon-tile" aria-hidden="true">
                                    <VIcon icon={point.icon} size={18} />
                                </span>
                                <div>
                                    <h3 class="pgl-h4">{t(point.title)}</h3>
                                    <p>{t(point.text)}</p>
                                </div>
                            </li>
                        ))}
                    </ul>
                    <div class="pgl-cta-row">
                        <VBtn
                            to={{ name: "MerchantDeveloperGuide" }}
                            variant="outlined"
                            class="pgl-btn-secondary"
                            appendIcon={current.value === "ar" ? "mdi-arrow-left" : "mdi-arrow-right"}
                        >
                            {t("Read the developer guide")}
                        </VBtn>
                        <span class="pgl-muted-note">{t("Sign-in required")}</span>
                    </div>
                </div>

                <div class="pgl-code" data-reveal dir="ltr">
                    <div class="pgl-code__bar">
                        <SegmentedTabs
                            ariaLabel={t("Code language")}
                            modelValue={language.value}
                            tabs={LANGUAGES}
                            {...{ "onUpdate:modelValue": (value: string) => (language.value = value as LandingSnippetLanguage) }}
                        />
                        <button type="button" class="pgl-icon-btn pgl-code__copy" onClick={copy} aria-label={t("Copy")}>
                            <VIcon icon={copied.value ? "mdi-check" : "mdi-content-copy"} size={15} aria-hidden="true" />
                        </button>
                        <span class="pgl-sr-only" aria-live="polite">
                            {copied.value ? t("Copied") : ""}
                        </span>
                    </div>
                    <div class="pgl-code__req">
                        <span class="pgl-code__verb">POST</span>
                        <span class="pgl-mono">/api/v1/external/links</span>
                    </div>
                    <pre class="pgl-code__pre" role="region" tabindex={0} aria-label={t("Create a payment link request")}>
                        <code>{highlight(LANDING_SNIPPETS[language.value])}</code>
                    </pre>
                    <div class="pgl-code__res">
                        <span class="pgl-code__status">201 Created</span>
                    </div>
                    <pre class="pgl-code__pre pgl-code__pre--res" role="region" tabindex={0} aria-label={t("Example response")}>
                        <code>{highlight(LANDING_SNIPPET_RESPONSE)}</code>
                    </pre>
                </div>
            </div>
        );
    },
});

export default DeveloperSection;
