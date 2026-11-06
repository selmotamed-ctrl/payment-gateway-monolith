<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import AppIcon from "./AppIcon.vue";
import ToolWidget from "./ToolWidget.vue";
import { renderMarkdown } from "@/lib/markdown";
import { useContent } from "@/content/store";
import type { Term } from "@/content/types";

const props = withDefaults(
    defineProps<{
        source: string;
        articleId?: string;
        disableGlossaryLinks?: boolean;
        glossaryPageSlug?: string;
    }>(),
    { articleId: "", disableGlossaryLinks: false, glossaryPageSlug: "" },
);

const router = useRouter();
const { bundle } = useContent();
const selectedTerm = ref<Term | null>(null);

const segments = computed(() => {
    const guide = bundle.value?.guide;
    return renderMarkdown(props.source, {
        articleId: props.articleId,
        glossary: guide?.glossary ?? [],
        articles: guide?.articles ?? [],
        cards: guide?.cards ?? [],
        situations: guide?.playbook ?? [],
        disableGlossaryLinks: props.disableGlossaryLinks,
        glossaryPageSlug: props.glossaryPageSlug,
    });
});

const relatedTerms = computed(() => {
    const term = selectedTerm.value;
    if (!term) return [];
    const terms = bundle.value?.guide.glossary ?? [];
    const bySlug = new Map(terms.map((entry) => [entry.slug, entry]));
    return term.related.map((slug) => bySlug.get(slug)).filter((entry): entry is Term => Boolean(entry));
});

const openTerm = (slug: string): void => {
    selectedTerm.value = bundle.value?.guide.glossary.find((term) => term.slug === slug) ?? null;
};

const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const glossary = target?.closest<HTMLElement>(".glossary-term");
    if (glossary) {
        event.preventDefault();
        openTerm(glossary.dataset.slug ?? "");
        return;
    }
    const link = target?.closest<HTMLAnchorElement>("a[data-guide-link]");
    if (link) {
        const href = link.getAttribute("href") ?? "";
        event.preventDefault();
        if (href.startsWith("/")) void router.push(href);
    }
};

const openRelated = (slug: string): void => {
    selectedTerm.value = null;
    void router.push(`/guide/glossary/${slug}`);
};
</script>

<template>
    <div class="prose" @click="onClick">
        <template v-for="(segment, index) in segments" :key="index">
            <div v-if="segment.type === 'widget' && segment.widgetId" class="widget-embed">
                <ToolWidget :tool="segment.widgetId" />
            </div>
            <div v-else v-html="segment.html" />
        </template>
    </div>

    <Teleport to="body">
        <div
            v-if="selectedTerm"
            class="sheet-backdrop"
            role="presentation"
            @click.self="selectedTerm = null"
        >
            <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="term-title">
                <header class="sheet__header">
                    <div>
                        <p class="eyebrow">Glossary</p>
                        <h2 id="term-title" dir="auto">{{ selectedTerm.term }}</h2>
                    </div>
                    <button type="button" class="icon-button" @click="selectedTerm = null">
                        <AppIcon name="close" />
                    </button>
                </header>
                <p v-if="selectedTerm.ar" class="arabic-term" dir="rtl" lang="ar">
                    {{ selectedTerm.ar }}
                </p>
                <p class="sheet__body" dir="auto">{{ selectedTerm.short }}</p>
                <p v-if="selectedTerm.aliases.length" class="muted small" dir="auto">
                    Also: {{ selectedTerm.aliases.join(", ") }}
                </p>
                <div v-if="relatedTerms.length" class="related-terms">
                    <p class="eyebrow">Related</p>
                    <button
                        v-for="term in relatedTerms"
                        :key="term.slug"
                        type="button"
                        class="chip"
                        @click="openRelated(term.slug)"
                    >
                        {{ term.term }}
                    </button>
                </div>
            </section>
        </div>
    </Teleport>
</template>
