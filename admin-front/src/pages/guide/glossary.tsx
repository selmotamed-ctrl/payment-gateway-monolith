import { computed, defineComponent, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { PageHeader } from "@/components/ui/PageHeader";
import ScreenContainer from "@/components/ScreenContainer";
import { useGuideLocale } from "@/components/guide/widgets/useGuideLocale";
import { loadGlossary, type Term } from "@/content/guide";
import { normalizeArabicText } from "@/utils/arabic";

export const AdminGuideGlossaryPage = defineComponent({
    name: "AdminGuideGlossaryPage",
    setup() {
        const route = useRoute();
        const { L } = useGuideLocale();
        const terms = ref<Term[]>([]);
        const loading = ref(true);
        const query = ref("");
        const letter = ref("");

        onMounted(async () => {
            terms.value = await loadGlossary().catch(() => []);
            loading.value = false;
        });

        const letters = computed(() => {
            const set = new Set<string>();
            for (const term of terms.value) {
                const first = term.term.trim().charAt(0).toLocaleUpperCase();
                if (first) set.add(first);
            }
            return [...set].sort((left, right) => left.localeCompare(right));
        });

        const filtered = computed(() => {
            const needle = normalizeArabicText(query.value);
            return terms.value.filter((term) => {
                if (letter.value && term.term.trim().charAt(0).toLocaleUpperCase() !== letter.value) {
                    return false;
                }
                if (!needle) return true;
                const haystack = normalizeArabicText(
                    [term.term, term.aliases.join(" "), term.ar ?? "", term.short].join(" "),
                );
                return haystack.includes(needle);
            });
        });

        const selectedSlug = computed(() => String(route.params.slug ?? ""));
        const selected = computed(() =>
            terms.value.find((term) => term.slug === selectedSlug.value),
        );
        const related = computed(() =>
            (selected.value?.related ?? [])
                .map((slug) => terms.value.find((term) => term.slug === slug))
                .filter((term): term is Term => Boolean(term)),
        );

        return () => (
            <ScreenContainer>
                <PageHeader
                    title={L("Glossary A–Z", "القاموس من أ إلى ي")}
                    subtitle={L(
                        "Every unfamiliar word in the guide, explained in plain language.",
                        "كل كلمة غير مألوفة في الدليل، مشروحة بلغة بسيطة.",
                    )}
                    breadcrumbs={[{ label: L("Guide", "الدليل"), to: "/guide" }, { label: L("Glossary", "القاموس") }]}
                />
                {loading.value ? (
                    <p class="guide-page-loading">{L("Loading glossary…", "جارٍ تحميل القاموس…")}</p>
                ) : (
                    <div class="guide-glossary-page">
                        <div class="guide-glossary-tools">
                            <input
                                type="search"
                                value={query.value}
                                placeholder={L("Filter terms…", "صفِّ المصطلحات…")}
                                aria-label={L("Filter terms", "تصفية المصطلحات")}
                                onInput={(event) => (query.value = (event.target as HTMLInputElement).value)}
                            />
                            <div class="guide-letter-bar" role="group" aria-label={L("Jump to letter", "انتقل إلى حرف")}>
                                <button type="button" class={letter.value === "" ? "is-active" : ""} onClick={() => (letter.value = "")}>
                                    {L("All", "الكل")}
                                </button>
                                {letters.value.map((entry) => (
                                    <button
                                        key={entry}
                                        type="button"
                                        class={letter.value === entry ? "is-active" : ""}
                                        onClick={() => (letter.value = letter.value === entry ? "" : entry)}
                                    >
                                        {entry}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div class="guide-glossary-layout">
                            <ul class="guide-glossary-list">
                                {filtered.value.map((term) => (
                                    <li key={term.slug} class={term.slug === selectedSlug.value ? "is-active" : ""}>
                                        <RouterLink to={{ name: "AdminGuideGlossary", params: { slug: term.slug } }}>
                                            <strong>{term.term}</strong>
                                            {term.ar ? <span dir="rtl" lang="ar">{term.ar}</span> : null}
                                            <small>{term.short}</small>
                                        </RouterLink>
                                    </li>
                                ))}
                                {filtered.value.length === 0 ? (
                                    <li class="guide-empty-line">{L("No term matches this filter.", "لا يوجد مصطلح يطابق هذا التصفية.")}</li>
                                ) : null}
                            </ul>
                            <article class="guide-glossary-detail" aria-live="polite">
                                {selected.value ? (
                                    <>
                                        <p class="guide-eyebrow">{L("Term", "مصطلح")}</p>
                                        <h2>{selected.value.term}</h2>
                                        {selected.value.ar ? (
                                            <p class="guide-glossary-arabic" dir="rtl" lang="ar">{selected.value.ar}</p>
                                        ) : null}
                                        <p class="guide-glossary-short">{selected.value.short}</p>
                                        {selected.value.aliases.length > 0 ? (
                                            <p class="guide-glossary-aliases">
                                                {L("Also called", "يُسمى أيضاً")}: {selected.value.aliases.join(", ")}
                                            </p>
                                        ) : null}
                                        {related.value.length > 0 ? (
                                            <div class="guide-glossary-related">
                                                <h3>{L("Related terms", "مصطلحات ذات صلة")}</h3>
                                                <ul>
                                                    {related.value.map((term) => (
                                                        <li key={term.slug}>
                                                            <RouterLink to={{ name: "AdminGuideGlossary", params: { slug: term.slug } }}>
                                                                {term.term}
                                                            </RouterLink>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        ) : null}
                                    </>
                                ) : (
                                    <div class="guide-empty">
                                        <p>{L("Choose a term from the list to read its definition.", "اختر مصطلحاً من القائمة لقراءة تعريفه.")}</p>
                                    </div>
                                )}
                            </article>
                        </div>
                    </div>
                )}
            </ScreenContainer>
        );
    },
});

export default AdminGuideGlossaryPage;
