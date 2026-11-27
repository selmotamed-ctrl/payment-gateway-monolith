import { computed, onMounted, ref, type PropType } from "vue";
import { defineComponent } from "@/utils/dc";
import { useRoute, useRouter } from "vue-router";
import {PgAlert, PgButton, PgNavigationDrawer, PgStatusBadge} from "@pg/ui";
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
import { resolveGuideScreenForPath } from "./resolveGuideScreen";

export const ContextHelpDrawer = defineComponent({
    name: "ContextHelpDrawer",
    props: {
        /**
         * Optional controlled visibility. When omitted the drawer follows the
         * shared `useContextHelp()` store (the layout instance). `default: null`
         * keeps an absent Boolean prop `null` instead of Vue's `false` cast, so
         * the uncontrolled mode stays distinguishable.
         */
        modelValue: { type: Boolean, default: null as unknown as boolean },
        /** Optional explicit screen lookup name (defaults to the current route). */
        routeName: { type: String, default: "" },
        onOpenFullGuide: {
            type: Function as PropType<() => void>,
            default: undefined,
        },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const route = useRoute();
        const router = useRouter();
        const { open, routeName, closeContextHelp } = useContextHelp();
        const contextMap = ref<ContextMap | null>(null);
        const cards = ref<Card[]>([]);
        const situations = ref<Situation[]>([]);
        const articles = ref<Article[]>([]);
        const loading = ref(true);

        const isControlled = computed(
            () => props.modelValue !== null && props.modelValue !== undefined,
        );
        const visible = computed(() =>
            isControlled.value ? Boolean(props.modelValue) : open.value,
        );
        const currentRouteName = computed(
            () =>
                props.routeName ||
                routeName.value ||
                (route.name ? String(route.name) : ""),
        );

        const close = () => {
            if (!isControlled.value) closeContextHelp();
            emit("update:modelValue", false);
        };

        const screen = computed<ContextScreen | null>(() => {
            const map = contextMap.value;
            if (!map) return null;
            return resolveGuideScreenForPath(map, {
                path: route.path,
                routeName: currentRouteName.value,
                routes: router.getRoutes().map((record) => ({
                    path: record.path,
                    name: record.name,
                })),
            });
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

        const riskStatus = (risk: Card["risk"]): string =>
            risk === "HIGH" ? "HIGH_RISK" : risk;

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
            close();
            void router.push({ name, params });
        };

        const openFullGuide = () => {
            close();
            if (props.onOpenFullGuide) {
                props.onOpenFullGuide();
                return;
            }
            void router.push({ name: "AdminGuide" });
        };

        return () => (
            <PgNavigationDrawer
                modelValue={visible.value}
                onUpdate:modelValue={(value: boolean) => {
                    if (!value) close();
                }}
                onKeydown={(event: KeyboardEvent) => {
                    if (event.key !== "Escape" || event.defaultPrevented) return;
                    event.preventDefault();
                    close();
                }}
                location="end"
                temporary
                width={420}
                scrim={false}
                class="guide-context-drawer"
                aria-label="How this page works"
            >
                <div class="guide-context-drawer__header">
                    <div class="guide-context-drawer__heading">
                        <p class="guide-context-drawer__eyebrow">Help for this screen</p>
                        <h2>{screen.value?.screenId ?? "General"}</h2>
                    </div>
                    <PgButton
                        class="guide-context-drawer__close"
                        icon="mdi-close"
                        variant="text"
                        size="sm"
                        ariaLabel="Close help"
                        onClick={close}
                    />
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
                                            <details key={card.id} class="guide-context-card">
                                                <summary>
                                                    <span>{card.title}</span>
                                                    <PgStatusBadge
                                                        status={riskStatus(card.risk)}
                                                        label={card.risk}
                                                        showDot={false}
                                                    />
                                                </summary>
                                                <div class="guide-context-card__body">
                                                    <MarkdownView source={card.body} compact disableGlossaryLinks />
                                                    {card.irreversible ? (
                                                        <PgAlert tone="danger" density="compact">
                                                            This action cannot be undone.
                                                        </PgAlert>
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
                    <button type="button" class="guide-primary-button" onClick={openFullGuide}>
                        Open the whole guide
                    </button>
                    <small>Opening help never closes or resets this form.</small>
                </div>
            </PgNavigationDrawer>
        );
    },
});

export default ContextHelpDrawer;
