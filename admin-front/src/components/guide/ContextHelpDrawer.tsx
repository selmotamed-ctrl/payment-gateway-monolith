import { computed, defineComponent, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { VNavigationDrawer } from "vuetify/components";
import {
    loadArticles,
    loadCards,
    loadContextMap,
    loadPlaybook,
    type Article,
    type Card,
    type ContextMap,
    type ContextScreen,
    type Situation,
} from "@/content/guide";
import { MarkdownView } from "./MarkdownView";
import { useContextHelp } from "./useContextHelp";

export const ContextHelpDrawer = defineComponent({
    name: "ContextHelpDrawer",
    setup() {
        const router = useRouter();
        const { open, routeName, closeContextHelp } = useContextHelp();
        const contextMap = ref<ContextMap | null>(null);
        const cards = ref<Card[]>([]);
        const situations = ref<Situation[]>([]);
        const articles = ref<Article[]>([]);
        const loading = ref(true);

        const screen = computed<ContextScreen | null>(() => {
            const map = contextMap.value;
            if (!map) return null;
            const matched = map.screens.find((entry) => entry.routeNames.includes(routeName.value));
            return matched ?? map.screens.find((entry) => entry.screenId === map.fallbackScreenId) ?? null;
        });

        const cardsById = computed(() => new Map(cards.value.map((card) => [card.id, card])));
        const situationsById = computed(
            () => new Map(situations.value.map((situation) => [situation.id, situation])),
        );
        const articlesById = computed(() => new Map(articles.value.map((article) => [article.id, article])));
        const screenCards = computed(() =>
            (screen.value?.cards ?? [])
                .map((id) => cardsById.value.get(id))
                .filter((card): card is Card => Boolean(card)),
        );
        const screenSituations = computed(() =>
            (screen.value?.situations ?? [])
                .map((id) => situationsById.value.get(id))
                .filter((situation): situation is Situation => Boolean(situation)),
        );
        const screenArticles = computed(() =>
            (screen.value?.articles ?? [])
                .map((id) => articlesById.value.get(id))
                .filter((article): article is Article => Boolean(article)),
        );

        onMounted(async () => {
            try {
                const [map, loadedCards, loadedSituations, loadedArticles] = await Promise.all([
                    loadContextMap(),
                    loadCards(),
                    loadPlaybook(),
                    loadArticles("en"),
                ]);
                contextMap.value = map;
                cards.value = loadedCards;
                situations.value = loadedSituations;
                articles.value = loadedArticles;
            } finally {
                loading.value = false;
            }
        });

        const go = (name: string, params?: Record<string, string>) => {
            closeContextHelp();
            void router.push({ name, params });
        };

        return () => (
            <VNavigationDrawer
                modelValue={open.value}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value) closeContextHelp();
                }}
                location="end"
                temporary
                width={420}
                scrim={false}
                class="guide-context-drawer"
                aria-label="How this page works"
            >
                <div class="guide-context-drawer__header">
                    <div>
                        <p class="guide-context-drawer__eyebrow">Help for this screen</p>
                        <h2>{screen.value?.screenId ?? "General"}</h2>
                    </div>
                    <button
                        type="button"
                        class="guide-popover__close"
                        aria-label="Close help"
                        onClick={closeContextHelp}
                    >
                        ×
                    </button>
                </div>
                <div class="guide-context-drawer__body">
                    {loading.value ? (
                        <p>Loading help…</p>
                    ) : !screen.value ? (
                        <p>No help is mapped to this screen yet. Open the full guide to search.</p>
                    ) : (
                        <>
                            <section>
                                <h3>What this screen is for</h3>
                                <p>{screen.value.summary}</p>
                            </section>
                            {screenCards.value.length > 0 ? (
                                <section>
                                    <h3>Before you act</h3>
                                    <div class="guide-context-cards">
                                        {screenCards.value.map((card) => (
                                            <details key={card.id} class={`guide-context-card guide-risk-${card.risk.toLowerCase()}`}>
                                                <summary>
                                                    <span>{card.title}</span>
                                                    <span class="guide-risk-badge">{card.risk}</span>
                                                </summary>
                                                <div class="guide-context-card__body">
                                                    <MarkdownView source={card.body} compact disableGlossaryLinks />
                                                    {card.irreversible ? (
                                                        <p class="guide-irreversible">This action cannot be undone.</p>
                                                    ) : null}
                                                </div>
                                            </details>
                                        ))}
                                    </div>
                                </section>
                            ) : null}
                            {screenSituations.value.length > 0 ? (
                                <section>
                                    <h3>Common problems</h3>
                                    <ul class="guide-context-list">
                                        {screenSituations.value.map((situation) => (
                                            <li key={situation.id}>
                                                <button
                                                    type="button"
                                                    class="guide-link-button"
                                                    onClick={() => go("AdminGuidePlaybook", { id: situation.id })}
                                                >
                                                    {situation.title}
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            ) : null}
                            {screenArticles.value.length > 0 ? (
                                <section>
                                    <h3>Learn more</h3>
                                    <ul class="guide-context-list">
                                        {screenArticles.value.map((article) => (
                                            <li key={article.id}>
                                                <button
                                                    type="button"
                                                    class="guide-link-button"
                                                    onClick={() => go("AdminGuideArticle", { articleId: article.id })}
                                                >
                                                    {article.title}
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            ) : null}
                        </>
                    )}
                </div>
                <div class="guide-context-drawer__footer">
                    <button type="button" class="guide-primary-button" onClick={() => go("AdminGuide")}>
                        Open the whole guide
                    </button>
                    <small>Opening help never closes or resets this form.</small>
                </div>
            </VNavigationDrawer>
        );
    },
});

export default ContextHelpDrawer;
