import {
    computed,
    defineComponent,
    nextTick,
    onBeforeUnmount,
    ref,
    watch,
    type PropType,
} from "vue";
import { useRouter } from "vue-router";
import { VDialog, VIcon } from "vuetify/components";
import {
    getGoldenRuleArticles,
    getGuideSearchDocument,
    searchGuideGroups,
    type GuideSearchDocument,
    type GuideSearchGroup,
    type GuideSearchHit,
} from "./GuideSearch";

const RECENT_KEY = "pg.guide.recent";
const MAX_RECENT = 8;

const readRecent = (): string[] => {
    try {
        const raw = window.localStorage.getItem(RECENT_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_RECENT)
            : [];
    } catch {
        return [];
    }
};

const writeRecent = (ids: string[]): void => {
    try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)));
    } catch {
        // Recent search is a convenience only.
    }
};

export const GuideSearchPalette = defineComponent({
    name: "GuideSearchPalette",
    props: {
        modelValue: { type: Boolean, required: true },
        locale: { type: String as PropType<"en" | "ar">, default: "en" },
        triggerElement: { type: Object as PropType<HTMLElement | null>, default: null },
        onUpdateModelValue: {
            type: Function as PropType<(value: boolean) => void>,
            default: undefined,
        },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const router = useRouter();
        const input = ref<HTMLInputElement | null>(null);
        const query = ref("");
        const loading = ref(false);
        const groups = ref<GuideSearchGroup[]>([]);
        const emptyDocuments = ref<GuideSearchDocument[]>([]);
        const activeIndex = ref(0);
        let timer: ReturnType<typeof setTimeout> | null = null;

        const isArabic = computed(() => props.locale === "ar");
        const labels = computed(() =>
            isArabic.value
                ? {
                      placeholder: "ابحث في الدليل: المقالات والقاموس والقوائم والسيناريوهات…",
                      empty: "اكتب للبحث في كل الدليل",
                      recent: "آخر ما فتحته",
                      golden: "القواعد الذهبية",
                      noResults: "لا نتائج. جرّب UNKNOWN أو LIMIT_EXCEEDED أو maker checker.",
                      loading: "جارٍ بناء الفهرس…",
                  }
                : {
                      placeholder: "Search the guide: articles, glossary, checklists, playbook…",
                      empty: "Type to search the whole guide",
                      recent: "Recent",
                      golden: "Golden Rules",
                      noResults: "No results. Try UNKNOWN, LIMIT_EXCEEDED, or maker checker.",
                      loading: "Building the index…",
                  },
        );

        const updateOpen = (value: boolean) => {
            emit("update:modelValue", value);
            props.onUpdateModelValue?.(value);
        };

        const flatHits = computed<GuideSearchHit[]>(() =>
            groups.value.flatMap((group) => group.hits),
        );
        const activeHit = computed(() => flatHits.value[activeIndex.value]);

        const resetActive = () => {
            activeIndex.value = 0;
        };

        const loadEmptyState = async () => {
            const [golden] = await Promise.all([getGoldenRuleArticles()]);
            const recentIds = readRecent();
            const recent = recentIds
                .map((id) => getGuideSearchDocument(id))
                .filter((document): document is GuideSearchDocument => Boolean(document));
            const seen = new Set<string>();
            const documents: GuideSearchDocument[] = [];
            for (const document of [...recent, ...golden]) {
                if (seen.has(document.id)) continue;
                seen.add(document.id);
                documents.push(document);
            }
            emptyDocuments.value = documents;
        };

        const runSearch = async () => {
            const value = query.value.trim();
            if (!value) {
                groups.value = [];
                await loadEmptyState();
                resetActive();
                return;
            }
            loading.value = true;
            try {
                groups.value = await searchGuideGroups(value);
                resetActive();
            } finally {
                loading.value = false;
            }
        };

        watch(query, () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void runSearch(), 80);
        });

        watch(
            () => props.modelValue,
            async (open) => {
                if (open) {
                    query.value = "";
                    groups.value = [];
                    await loadEmptyState();
                    await nextTick();
                    input.value?.focus();
                    input.value?.select();
                    return;
                }
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            },
            { immediate: true },
        );

        onBeforeUnmount(() => {
            if (timer) clearTimeout(timer);
        });

        const choose = (document: GuideSearchDocument) => {
            const recent = [document.id, ...readRecent().filter((id) => id !== document.id)];
            writeRecent(recent);
            updateOpen(false);
            void router.push(document.route).catch(() => undefined);
        };

        const move = (delta: number) => {
            const total = flatHits.value.length;
            if (total === 0) return;
            activeIndex.value = (activeIndex.value + delta + total) % total;
            void nextTick(() => {
                document.getElementById(`pg-guide-search-${activeIndex.value}`)?.scrollIntoView({
                    block: "nearest",
                });
            });
        };

        const tabGroup = (direction: 1 | -1) => {
            const total = flatHits.value.length;
            if (total === 0) return;
            const current = flatHits.value[activeIndex.value];
            if (!current) return;
            const groupIndex = groups.value.findIndex((group) => group.type === current.type);
            let nextGroupIndex = groupIndex + direction;
            if (nextGroupIndex < 0) nextGroupIndex = groups.value.length - 1;
            if (nextGroupIndex >= groups.value.length) nextGroupIndex = 0;
            const nextGroup = groups.value[nextGroupIndex];
            const nextHit = nextGroup?.hits[0];
            if (!nextHit) return;
            const nextIndex = flatHits.value.findIndex((hit) => hit.id === nextHit.id);
            if (nextIndex >= 0) activeIndex.value = nextIndex;
        };

        const onKeydown = (event: KeyboardEvent) => {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
            } else if (event.key === "Tab") {
                event.preventDefault();
                tabGroup(event.shiftKey ? -1 : 1);
            } else if (event.key === "Enter") {
                event.preventDefault();
                if (activeHit.value) choose(activeHit.value);
            } else if (event.key === "Escape") {
                event.preventDefault();
                updateOpen(false);
            }
        };

        const renderDocument = (document: GuideSearchDocument, index: number, keyPrefix: string) => (
            <button
                key={`${keyPrefix}-${document.id}`}
                id={`pg-guide-search-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex.value ? "true" : "false"}
                class={[
                    "guide-search-option",
                    index === activeIndex.value ? "guide-search-option--active" : "",
                ]}
                onMouseover={() => (activeIndex.value = index)}
                onClick={() => choose(document)}
            >
                <span class="guide-search-option__title">{document.title}</span>
                <span class="guide-search-option__subtitle">{document.subtitle}</span>
            </button>
        );

        return () => {
            let runningIndex = 0;
            return (
                <VDialog
                    modelValue={props.modelValue}
                    onUpdate:modelValue={updateOpen}
                    maxWidth={760}
                    contentClass="guide-search-dialog"
                    scrollable
                    onAfterLeave={() => props.triggerElement?.focus?.()}
                >
                    <div class="guide-search-surface" dir={isArabic.value ? "rtl" : "ltr"} onKeydown={onKeydown}>
                        <div class="guide-search-header">
                            <VIcon icon="mdi-book-search-outline" size={20} />
                            <input
                                ref={input}
                                class="guide-search-input"
                                type="text"
                                role="combobox"
                                aria-expanded={props.modelValue ? "true" : "false"}
                                aria-controls="pg-guide-search-listbox"
                                aria-activedescendant={
                                    activeHit.value ? `pg-guide-search-${activeIndex.value}` : undefined
                                }
                                aria-autocomplete="list"
                                aria-label={labels.value.placeholder}
                                placeholder={labels.value.placeholder}
                                autocomplete="off"
                                spellcheck={false}
                                value={query.value}
                                onInput={(event) =>
                                    (query.value = (event.target as HTMLInputElement).value)
                                }
                            />
                            <kbd class="pg-command-kbd">ESC</kbd>
                        </div>
                        <div id="pg-guide-search-listbox" role="listbox" class="guide-search-results">
                            {loading.value ? (
                                <p class="guide-search-note">{labels.value.loading}</p>
                            ) : query.value.trim() === "" ? (
                                <>
                                    {emptyDocuments.value.length > 0 ? (
                                        <>
                                            <p class="guide-search-group-label">{labels.value.recent}</p>
                                            {emptyDocuments.value.slice(0, MAX_RECENT).map((document) =>
                                                renderDocument(document, runningIndex++, "empty"),
                                            )}
                                            <p class="guide-search-group-label">{labels.value.golden}</p>
                                        </>
                                    ) : (
                                        <p class="guide-search-note">{labels.value.empty}</p>
                                    )}
                                </>
                            ) : groups.value.length === 0 ? (
                                <p class="guide-search-note">{labels.value.noResults}</p>
                            ) : (
                                groups.value.map((group) => (
                                    <section key={group.type} class="guide-search-group">
                                        <p class="guide-search-group-label">{group.label}</p>
                                        {group.hits.map((hit) =>
                                            renderDocument(hit, runningIndex++, group.type),
                                        )}
                                    </section>
                                ))
                            )}
                        </div>
                    </div>
                </VDialog>
            );
        };
    },
});

export default GuideSearchPalette;
