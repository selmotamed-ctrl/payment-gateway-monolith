import { computed, defineComponent, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { PageHeader } from "@/components/ui/PageHeader";
import ScreenContainer from "@/components/ScreenContainer";
import { MarkdownView } from "@/components/guide/MarkdownView";
import { useGuideLocale } from "@/components/guide/widgets/useGuideLocale";
import {
    loadArticles,
    loadEdgeCases,
    loadPlaybook,
    type Article,
    type EdgeCase,
    type Situation,
} from "@/content/guide";
import { normalizeArabicText } from "@/utils/arabic";

export const AdminGuidePlaybookPage = defineComponent({
    name: "AdminGuidePlaybookPage",
    setup() {
        const route = useRoute();
        const { L } = useGuideLocale();
        const situations = ref<Situation[]>([]);
        const articles = ref<Article[]>([]);
        const edgeCases = ref<EdgeCase[]>([]);
        const loading = ref(true);
        const query = ref("");
        const screenFilter = ref("");

        onMounted(async () => {
            const [loadedSituations, loadedArticles, loadedEdgeCases] = await Promise.all([
                loadPlaybook(),
                loadArticles("en"),
                loadEdgeCases(),
            ]);
            situations.value = loadedSituations;
            articles.value = loadedArticles;
            edgeCases.value = loadedEdgeCases;
            loading.value = false;
        });

        const screens = computed(() => {
            const set = new Set<string>();
            for (const situation of situations.value) {
                for (const screen of situation.screens) set.add(screen);
            }
            return [...set].sort();
        });
        const filtered = computed(() => {
            const needle = normalizeArabicText(query.value);
            return situations.value.filter((situation) => {
                if (screenFilter.value && !situation.screens.includes(screenFilter.value)) return false;
                if (!needle) return true;
                return normalizeArabicText(
                    [situation.title, situation.body, situation.screens.join(" ")].join(" "),
                ).includes(needle);
            });
        });
        const selectedId = computed(() => String(route.params.id ?? ""));
        const selected = computed(() => situations.value.find((situation) => situation.id === selectedId.value));
        const selectedArticles = computed(() =>
            (selected.value?.articles ?? [])
                .map((id) => articles.value.find((article) => article.id === id))
                .filter((article): article is Article => Boolean(article)),
        );
        const selectedCases = computed(() => {
            const numbers = new Set(selected.value?.cases ?? []);
            return edgeCases.value.filter((edgeCase) => numbers.has(edgeCase.n));
        });

        return () => (
            <ScreenContainer>
                <PageHeader
                    title={L("Situation playbook", "دليل المواقف")}
                    subtitle={L(
                        "What you may see, what it means, what to do, and what not to do.",
                        "ما قد تراه، وما يعنيه، وما يجب فعله، وما يجب تجنبه.",
                    )}
                    breadcrumbs={[{ label: L("Guide", "الدليل"), to: "/guide" }, { label: L("Playbook", "دليل المواقف") }]}
                />
                {loading.value ? (
                    <p class="guide-page-loading">{L("Loading playbook…", "جارٍ تحميل دليل المواقف…")}</p>
                ) : (
                    <div class="guide-playbook-page">
                        <div class="guide-playbook-tools">
                            <input
                                type="search"
                                value={query.value}
                                placeholder={L("Search situations…", "ابحث في المواقف…")}
                                aria-label={L("Search situations", "البحث في المواقف")}
                                onInput={(event) => (query.value = (event.target as HTMLInputElement).value)}
                            />
                            <select value={screenFilter.value} onChange={(event) => (screenFilter.value = (event.target as HTMLSelectElement).value)}>
                                <option value="">{L("All screens", "كل الشاشات")}</option>
                                {screens.value.map((screen) => (
                                    <option key={screen} value={screen}>{screen}</option>
                                ))}
                            </select>
                        </div>
                        <div class="guide-playbook-layout">
                            <ul class="guide-playbook-list">
                                {filtered.value.map((situation) => (
                                    <li key={situation.id} class={situation.id === selectedId.value ? "is-active" : ""}>
                                        <RouterLink to={{ name: "AdminGuidePlaybook", params: { id: situation.id } }}>
                                            <strong>{situation.title}</strong>
                                            <small>{situation.screens.join(", ")} · {L("cases", "حالة")} {situation.cases.join(", ")}</small>
                                        </RouterLink>
                                    </li>
                                ))}
                            </ul>
                            <article class="guide-playbook-detail" aria-live="polite">
                                {selected.value ? (
                                    <>
                                        <h2>{selected.value.title}</h2>
                                        <MarkdownView source={selected.value.body} />
                                        {selectedArticles.value.length > 0 ? (
                                            <section class="guide-related">
                                                <h3>{L("Read next", "اقرأ بعد ذلك")}</h3>
                                                <ul>
                                                    {selectedArticles.value.map((article) => (
                                                        <li key={article.id}>
                                                            <RouterLink to={{ name: "AdminGuideArticle", params: { articleId: article.id } }}>
                                                                {article.title}
                                                            </RouterLink>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </section>
                                        ) : null}
                                        {selectedCases.value.length > 0 ? (
                                            <section class="guide-related">
                                                <h3>{L("Edge cases", "حالات الحافة")}</h3>
                                                <ul>
                                                    {selectedCases.value.map((edgeCase) => (
                                                        <li key={edgeCase.n}>
                                                            <RouterLink to={{ name: "AdminGuideEdgeCases", query: { case: String(edgeCase.n) } }}>
                                                                Case {edgeCase.n}: {edgeCase.scenario}
                                                            </RouterLink>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </section>
                                        ) : null}
                                    </>
                                ) : (
                                    <div class="guide-empty">
                                        <p>{L("Choose a situation from the list.", "اختر موقفاً من القائمة.")}</p>
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

export default AdminGuidePlaybookPage;
