import {
    computed,
    defineComponent,
    nextTick,
    onBeforeUnmount,
    ref,
    watch,
    type PropType,
} from "vue";
import { useRouter, type RouteLocationRaw } from "vue-router";
import { VDialog, VIcon, VProgressLinear } from "vuetify/components";
import type { GuideSearchEntry } from "@/content/guide/types";
import {
    cancelPendingGlobalSearch,
    fetchGlobalSearchResults,
} from "./api";
import {
    clearRecentSearchQueries,
    getRecentSearchQueries,
    removeRecentSearchQuery,
    saveRecentSearchQuery,
} from "./recents";
import {
    filterAndNormalizeServerGroups,
    type FrontendAccessContext,
} from "./targets";
import {
    searchLocalGuides,
    searchLocalPages,
    type NavigationSectionItem,
} from "./localCommands";
import { SearchResultRow } from "./SearchResultRow";
import type {
    GlobalSearchResponse,
    SearchFilterTab,
} from "./types";

interface FlattenedPaletteOption {
    domId: string;
    groupKey: string;
    icon: string;
    title: string;
    subtitle?: string;
    reference?: string;
    status?: string;
    kindLabel: string;
    target: RouteLocationRaw;
    queryToStore?: string;
}

interface PaletteGroup {
    key: string;
    title: string;
    count: number;
    truncated?: boolean;
    options: FlattenedPaletteOption[];
}

const isAbortError = (error: unknown): boolean => {
    const candidate = error as {
        name?: string;
        code?: string;
    } | null;
    return (
        candidate?.name === "CanceledError" ||
        candidate?.name === "AbortError" ||
        candidate?.code === "ERR_CANCELED"
    );
};

export const GlobalSearchPalette = defineComponent({
    name: "GlobalSearchPalette",
    props: {
        modelValue: { type: Boolean, required: true },
        locale: { type: String as PropType<"en" | "ar">, default: "en" },
        accessContext: {
            type: Object as PropType<FrontendAccessContext>,
            required: true,
        },
        navigationItems: {
            type: Array as PropType<NavigationSectionItem[]>,
            default: () => [],
        },
        searchGuideFn: {
            type: Function as PropType<(query: string) => GuideSearchEntry[]>,
            default: () => [],
        },
        triggerElement: {
            type: Object as PropType<HTMLElement | null>,
            default: null,
        },
        focusSignal: { type: Number, default: 0 },
        onUpdateModelValue: {
            type: Function as PropType<(value: boolean) => void>,
            default: undefined,
        },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
        const router = useRouter();
        const inputRef = ref<HTMLInputElement | null>(null);
        const listboxRef = ref<HTMLElement | null>(null);

        const query = ref("");
        const activeTab = ref<SearchFilterTab>("all");
        const activeIndex = ref(0);
        const loading = ref(false);
        const errorState = ref<string | null>(null);
        const serverResponse = ref<GlobalSearchResponse | null>(null);
        const recentQueries = ref<string[]>([]);

        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const isRtl = computed(() => props.locale === "ar");
        const trimmedQuery = computed(() => query.value.trim());

        const t = computed(() =>
            props.locale === "ar"
                ? {
                      placeholder:
                          "ابحث في كل شيء (التجار، العمليات، الحالات، الصفحات، الدليل)…",
                      all: "الكل",
                      records: "السجلات",
                      pages: "الصفحات",
                      guide: "الدليل",
                      recentSearches: "عمليات البحث الأخيرة",
                      clearAll: "مسح الكل",
                      quickLinks: "روابط سريعة للصفحات",
                      minCharsHint:
                          "اكتب حرفين على الأقل للبحث في سجلات النظام…",
                      noResultsTitle: (value: string) =>
                          `لا توجد نتائج مطابقة لـ «${value}»`,
                      noResultsSub:
                          "تحقق من الرقم المرجعي أو جرب تغيير فلتر البحث أعلاه.",
                      partialBanner:
                          "تعذر الوصول إلى بعض المجموعات. يتم عرض نتائج جزئية.",
                      errorBanner: "تعذر إتمام البحث في السجلات الآن.",
                      retry: "إعادة المحاولة",
                      navigateHint: "للتنقل",
                      selectHint: "للفتح",
                      closeHint: "للإغلاق",
                      clearQuery: "مسح البحث",
                      searchScope: "نطاق البحث",
                      removeRecent: (value: string) =>
                          `إزالة ${value} من عمليات البحث الأخيرة`,
                      resultsAvailable: (count: number) => `${count} نتيجة متاحة`,
                  }
                : {
                      placeholder:
                          "Search everything (merchants, attempts, cases, pages, guide)…",
                      all: "All",
                      records: "Records",
                      pages: "Pages",
                      guide: "Guide",
                      recentSearches: "Recent Searches",
                      clearAll: "Clear",
                      quickLinks: "Quick Page Links",
                      minCharsHint:
                          "Type at least 2 characters to search platform records…",
                      noResultsTitle: (value: string) =>
                          `No matching records, pages, or guides for “${value}”`,
                      noResultsSub:
                          "Double-check the reference code or switch filter tabs above.",
                      partialBanner:
                          "Some record groups could not be reached. Showing partial results.",
                      errorBanner: "Unable to search platform records right now.",
                      retry: "Retry",
                      navigateHint: "to navigate",
                      selectHint: "to open",
                      closeHint: "to close",
                      clearQuery: "Clear search query",
                      searchScope: "Search scope filters",
                      removeRecent: (value: string) =>
                          `Remove ${value} from recent searches`,
                      resultsAvailable: (count: number) => `${count} results available`,
                  },
        );

        const updateModelValue = (value: boolean) => {
            emit("update:modelValue", value);
            props.onUpdateModelValue?.(value);
        };

        const executeServerSearch = async (bypassCache = false) => {
            const requestedQuery = trimmedQuery.value;
            if (requestedQuery.length < 2) {
                serverResponse.value = null;
                errorState.value = null;
                loading.value = false;
                return;
            }

            loading.value = true;
            errorState.value = null;

            try {
                const { data, stale } = await fetchGlobalSearchResults(
                    { query: requestedQuery, limit: 5 },
                    { bypassCache },
                );
                if (stale || trimmedQuery.value !== requestedQuery) {
                    return;
                }
                serverResponse.value = data;
                errorState.value = null;
                loading.value = false;
            } catch (error) {
                if (isAbortError(error) || trimmedQuery.value !== requestedQuery) {
                    return;
                }
                loading.value = false;
                errorState.value =
                    (error as { message?: string } | null)?.message || "SEARCH_FAILED";
            }
        };

        const clearDebounce = () => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
        };

        watch(trimmedQuery, (newQuery) => {
            activeIndex.value = 0;
            clearDebounce();
            cancelPendingGlobalSearch();

            if (newQuery.length < 2) {
                serverResponse.value = null;
                errorState.value = null;
                loading.value = false;
                return;
            }

            errorState.value = null;
            loading.value = true;
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                void executeServerSearch(false);
            }, 250);
        });

        watch(
            () => props.focusSignal,
            async () => {
                if (!props.modelValue) {
                    return;
                }
                await nextTick();
                inputRef.value?.focus();
                inputRef.value?.select();
            },
        );

        watch(
            () => props.modelValue,
            async (isOpen) => {
                if (isOpen) {
                    recentQueries.value = getRecentSearchQueries();
                    activeIndex.value = 0;
                    if (
                        trimmedQuery.value.length >= 2 &&
                        (Boolean(errorState.value) ||
                            !serverResponse.value ||
                            serverResponse.value.query !== trimmedQuery.value)
                    ) {
                        void executeServerSearch(false);
                    }
                    await nextTick();
                    inputRef.value?.focus();
                    inputRef.value?.select();
                    return;
                }

                clearDebounce();
                cancelPendingGlobalSearch();
                loading.value = false;
                await nextTick();
                props.triggerElement?.focus?.();
            },
        );

        onBeforeUnmount(() => {
            clearDebounce();
            cancelPendingGlobalSearch();
        });

        const localPages = computed(() => {
            if (activeTab.value !== "all" && activeTab.value !== "pages") {
                return [];
            }
            return searchLocalPages(
                props.navigationItems,
                trimmedQuery.value,
                props.locale,
                6,
            );
        });

        const localGuides = computed(() => {
            if (activeTab.value !== "all" && activeTab.value !== "guide") {
                return [];
            }
            if (!trimmedQuery.value) {
                return [];
            }
            return searchLocalGuides(
                props.searchGuideFn,
                trimmedQuery.value,
                props.locale,
                5,
            );
        });

        const normalizedRecordGroups = computed(() => {
            if (activeTab.value !== "all" && activeTab.value !== "records") {
                return [];
            }
            if (!serverResponse.value) {
                return [];
            }
            return filterAndNormalizeServerGroups(
                serverResponse.value.groups,
                trimmedQuery.value,
                props.accessContext,
            );
        });

        const visualGroups = computed<PaletteGroup[]>(() => {
            const groups: PaletteGroup[] = [];

            if (trimmedQuery.value.length === 0) {
                if (localPages.value.length > 0) {
                    groups.push({
                        key: "quick-pages",
                        title: t.value.quickLinks,
                        count: localPages.value.length,
                        options: localPages.value.map((page) => ({
                            domId: `pg-cmd-opt-${page.id}`,
                            groupKey: "quick-pages",
                            icon: page.icon,
                            title: page.title,
                            subtitle: page.subtitle,
                            kindLabel: page.kindLabel,
                            target: page.target,
                        })),
                    });
                }
                return groups;
            }

            if (localPages.value.length > 0) {
                groups.push({
                    key: "pages",
                    title: t.value.pages,
                    count: localPages.value.length,
                    options: localPages.value.map((page) => ({
                        domId: `pg-cmd-opt-${page.id}`,
                        groupKey: "pages",
                        icon: page.icon,
                        title: page.title,
                        subtitle: page.subtitle,
                        kindLabel: page.kindLabel,
                        target: page.target,
                        queryToStore: trimmedQuery.value,
                    })),
                });
            }

            for (const recordGroup of normalizedRecordGroups.value) {
                const groupTitle =
                    props.locale === "ar"
                        ? recordGroup.plugin.groupLabel.ar
                        : recordGroup.plugin.groupLabel.en;
                const kindLabel =
                    props.locale === "ar"
                        ? recordGroup.plugin.kindLabel.ar
                        : recordGroup.plugin.kindLabel.en;

                groups.push({
                    key: `record:${recordGroup.plugin.type}`,
                    title: groupTitle,
                    count: recordGroup.items.length,
                    truncated: recordGroup.truncated,
                    options: recordGroup.items.map(({ item, target }) => ({
                        domId: `pg-cmd-opt-${recordGroup.plugin.type}-${item.id}`,
                        groupKey: `record:${recordGroup.plugin.type}`,
                        icon: recordGroup.plugin.icon,
                        title: item.title,
                        subtitle: item.subtitle,
                        reference: item.reference,
                        status: item.status,
                        kindLabel,
                        target,
                        queryToStore: trimmedQuery.value,
                    })),
                });
            }

            if (localGuides.value.length > 0) {
                groups.push({
                    key: "guide",
                    title: t.value.guide,
                    count: localGuides.value.length,
                    options: localGuides.value.map((entry) => ({
                        domId: `pg-cmd-opt-${entry.id}`,
                        groupKey: "guide",
                        icon: entry.icon,
                        title: entry.title,
                        subtitle: entry.subtitle,
                        kindLabel: entry.kindLabel,
                        target: entry.target,
                        queryToStore: trimmedQuery.value,
                    })),
                });
            }

            return groups;
        });

        const flatOptions = computed<FlattenedPaletteOption[]>(() =>
            visualGroups.value.flatMap((group) => group.options),
        );

        const flatIndexByDomId = computed(() => {
            const indexes = new Map<string, number>();
            flatOptions.value.forEach((option, index) => {
                indexes.set(option.domId, index);
            });
            return indexes;
        });

        const activeOption = computed<FlattenedPaletteOption | undefined>(
            () => flatOptions.value[activeIndex.value],
        );

        watch(
            () => flatOptions.value.length,
            (length) => {
                if (length === 0) {
                    activeIndex.value = 0;
                    return;
                }
                if (activeIndex.value >= length) {
                    activeIndex.value = length - 1;
                }
            },
        );

        const scrollActiveIntoView = () => {
            void nextTick(() => {
                const activeId = activeOption.value?.domId;
                const listbox = listboxRef.value;
                if (!activeId || !listbox) {
                    return;
                }
                const element = document.getElementById(activeId);
                if (
                    element &&
                    listbox.contains(element) &&
                    typeof element.scrollIntoView === "function"
                ) {
                    element.scrollIntoView({ block: "nearest" });
                }
            });
        };

        const selectOption = (option: FlattenedPaletteOption) => {
            if (option.queryToStore && option.queryToStore.length >= 2) {
                recentQueries.value = saveRecentSearchQuery(option.queryToStore);
            }
            updateModelValue(false);
            void router.push(option.target).catch(() => undefined);
        };

        const handleKeydown = (event: KeyboardEvent) => {
            const totalOptions = flatOptions.value.length;

            if (event.key === "ArrowDown") {
                event.preventDefault();
                if (totalOptions > 0) {
                    activeIndex.value = (activeIndex.value + 1) % totalOptions;
                    scrollActiveIntoView();
                }
                return;
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                if (totalOptions > 0) {
                    activeIndex.value =
                        (activeIndex.value - 1 + totalOptions) % totalOptions;
                    scrollActiveIntoView();
                }
                return;
            }

            if (event.key === "Home") {
                if (totalOptions > 0) {
                    event.preventDefault();
                    activeIndex.value = 0;
                    scrollActiveIntoView();
                }
                return;
            }

            if (event.key === "End") {
                if (totalOptions > 0) {
                    event.preventDefault();
                    activeIndex.value = totalOptions - 1;
                    scrollActiveIntoView();
                }
                return;
            }

            if (event.key === "Enter") {
                if (activeOption.value) {
                    event.preventDefault();
                    selectOption(activeOption.value);
                }
                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                updateModelValue(false);
            }
        };

        return () => (
            <VDialog
                modelValue={props.modelValue}
                onUpdate:modelValue={updateModelValue}
                maxWidth={780}
                contentClass="pg-command-dialog"
                scrollable
            >
                <div
                    class="pg-command-surface"
                    dir={isRtl.value ? "rtl" : "ltr"}
                    onKeydown={handleKeydown}
                >
                    <div class="pg-command-header">
                        <VIcon
                            icon="mdi-magnify"
                            size={20}
                            class="pg-command-header__icon"
                        />
                        <input
                            ref={inputRef}
                            type="text"
                            role="combobox"
                            aria-expanded={props.modelValue ? "true" : "false"}
                            aria-autocomplete="list"
                            aria-controls="pg-global-search-listbox"
                            aria-activedescendant={activeOption.value?.domId}
                            aria-label={t.value.placeholder}
                            class="pg-command-header__input"
                            placeholder={t.value.placeholder}
                            autocomplete="off"
                            spellcheck={false}
                            value={query.value}
                            onInput={(event) => {
                                query.value = (event.target as HTMLInputElement).value;
                            }}
                        />
                        {query.value.length > 0 && (
                            <button
                                type="button"
                                class="pg-command-header__clear"
                                aria-label={t.value.clearQuery}
                                onClick={() => {
                                    query.value = "";
                                    inputRef.value?.focus();
                                }}
                            >
                                <VIcon icon="mdi-close-circle" size={16} />
                            </button>
                        )}
                        <kbd class="pg-command-kbd">ESC</kbd>
                    </div>

                    <div
                        class="pg-command-tabs"
                        role="tablist"
                        aria-label={t.value.searchScope}
                    >
                        {(
                            [
                                { id: "all", label: t.value.all },
                                { id: "records", label: t.value.records },
                                { id: "pages", label: t.value.pages },
                                { id: "guide", label: t.value.guide },
                            ] as const
                        ).map((tab) => (
                            <button
                                key={tab.id}
                                type="button"
                                role="tab"
                                aria-selected={
                                    activeTab.value === tab.id ? "true" : "false"
                                }
                                class={[
                                    "pg-command-tab-chip",
                                    activeTab.value === tab.id
                                        ? "pg-command-tab-chip--active"
                                        : "",
                                ]}
                                onClick={() => {
                                    activeTab.value = tab.id;
                                    activeIndex.value = 0;
                                    inputRef.value?.focus();
                                }}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    <div class="pg-command-progress-slot">
                        {loading.value && (
                            <VProgressLinear indeterminate height={2} color="primary" />
                        )}
                    </div>

                    <div class="pg-sr-only" aria-live="polite" aria-atomic="true">
                        {t.value.resultsAvailable(flatOptions.value.length)}
                    </div>

                    <div
                        id="pg-global-search-listbox"
                        ref={listboxRef}
                        role="listbox"
                        class="pg-command-body"
                    >
                        {trimmedQuery.value.length === 0 &&
                            recentQueries.value.length > 0 && (
                                <div class="pg-command-group">
                                    <div class="pg-command-group__header">
                                        <span>{t.value.recentSearches}</span>
                                        <button
                                            type="button"
                                            class="pg-command-group__action"
                                            onClick={() => {
                                                clearRecentSearchQueries();
                                                recentQueries.value = [];
                                            }}
                                        >
                                            {t.value.clearAll}
                                        </button>
                                    </div>
                                    <div class="pg-command-recents">
                                        {recentQueries.value.map((recentQuery) => (
                                            <div
                                                key={recentQuery}
                                                class="pg-command-recent-pill"
                                            >
                                                <button
                                                    type="button"
                                                    class="pg-command-recent-pill__btn"
                                                    onClick={() => {
                                                        query.value = recentQuery;
                                                        inputRef.value?.focus();
                                                    }}
                                                >
                                                    <VIcon icon="mdi-history" size={14} />
                                                    <span>{recentQuery}</span>
                                                </button>
                                                <button
                                                    type="button"
                                                    class="pg-command-recent-pill__remove"
                                                    aria-label={t.value.removeRecent(
                                                        recentQuery,
                                                    )}
                                                    onClick={() => {
                                                        recentQueries.value =
                                                            removeRecentSearchQuery(
                                                                recentQuery,
                                                            );
                                                    }}
                                                >
                                                    <VIcon icon="mdi-close" size={12} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                        {trimmedQuery.value.length === 1 &&
                            (activeTab.value === "all" ||
                                activeTab.value === "records") && (
                                <div class="pg-command-hint-banner">
                                    {t.value.minCharsHint}
                                </div>
                            )}

                        {visualGroups.value.map((group) => (
                            <div key={group.key} class="pg-command-group">
                                <div class="pg-command-group__header">
                                    <span>{group.title}</span>
                                    <span class="pg-command-group__count">
                                        {group.count}
                                        {group.truncated ? "+" : ""}
                                    </span>
                                </div>
                                {group.options.map((option) => {
                                    const optionIndex =
                                        flatIndexByDomId.value.get(option.domId) ?? 0;
                                    return (
                                        <SearchResultRow
                                            key={option.domId}
                                            id={option.domId}
                                            icon={option.icon}
                                            title={option.title}
                                            subtitle={option.subtitle}
                                            reference={option.reference}
                                            status={option.status}
                                            kindLabel={option.kindLabel}
                                            query={trimmedQuery.value}
                                            active={activeIndex.value === optionIndex}
                                            onHover={() => {
                                                activeIndex.value = optionIndex;
                                            }}
                                            onSelect={() => selectOption(option)}
                                        />
                                    );
                                })}
                            </div>
                        ))}

                        {errorState.value &&
                            (activeTab.value === "all" ||
                                activeTab.value === "records") && (
                                <div class="pg-command-error-banner" role="alert">
                                    <span>{t.value.errorBanner}</span>
                                    <button
                                        type="button"
                                        class="pg-command-retry-btn"
                                        onClick={() => void executeServerSearch(true)}
                                    >
                                        <VIcon icon="mdi-refresh" size={14} />
                                        <span>{t.value.retry}</span>
                                    </button>
                                </div>
                            )}

                        {!errorState.value &&
                            serverResponse.value?.partial &&
                            (activeTab.value === "all" ||
                                activeTab.value === "records") && (
                                <div class="pg-command-partial-banner" role="status">
                                    <span>{t.value.partialBanner}</span>
                                    <button
                                        type="button"
                                        class="pg-command-retry-btn"
                                        onClick={() => void executeServerSearch(true)}
                                    >
                                        <VIcon icon="mdi-refresh" size={14} />
                                        <span>{t.value.retry}</span>
                                    </button>
                                </div>
                            )}

                        {trimmedQuery.value.length >= 2 &&
                            !loading.value &&
                            !errorState.value &&
                            flatOptions.value.length === 0 && (
                                <div class="pg-command-empty">
                                    <VIcon icon="mdi-file-search-outline" size={32} />
                                    <div class="pg-command-empty__title">
                                        {t.value.noResultsTitle(trimmedQuery.value)}
                                    </div>
                                    <div class="pg-command-empty__sub">
                                        {t.value.noResultsSub}
                                    </div>
                                </div>
                            )}
                    </div>

                    <div class="pg-command-footer">
                        <div class="pg-command-footer__shortcut">
                            <kbd class="pg-command-kbd">↑</kbd>
                            <kbd class="pg-command-kbd">↓</kbd>
                            <span>{t.value.navigateHint}</span>
                        </div>
                        <div class="pg-command-footer__shortcut">
                            <kbd class="pg-command-kbd">↵</kbd>
                            <span>{t.value.selectHint}</span>
                        </div>
                        <div class="pg-command-footer__shortcut">
                            <kbd class="pg-command-kbd">ESC</kbd>
                            <span>{t.value.closeHint}</span>
                        </div>
                    </div>
                </div>
            </VDialog>
        );
    },
});

export default GlobalSearchPalette;
