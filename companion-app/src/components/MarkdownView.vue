<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import AppIcon from "./AppIcon.vue";
import ToolWidget from "./ToolWidget.vue";
import { firstProseParagraph, renderMarkdown } from "@/lib/markdown";
import { useContent } from "@/content/store";
import type { Term } from "@/content/types";

interface PreviewItem {
    kind: "a" | "c" | "s";
    kindLabel: string;
    title: string;
    subtitle: string;
    body: string;
    href: string;
}

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
const selectedPreview = ref<PreviewItem | null>(null);

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
    return term.related
        .map((slug) => bySlug.get(slug))
        .filter((entry): entry is Term => Boolean(entry));
});

const openTerm = (slug: string): void => {
    selectedPreview.value = null;
    selectedTerm.value =
        bundle.value?.guide.glossary.find((term) => term.slug === slug) ?? null;
};

const openRefPreview = (kind: string, id: string, href: string): boolean => {
    const guide = bundle.value?.guide;
    if (!guide) return false;

    if (kind === "a") {
        const article = guide.articles.find((item) => item.id === id);
        if (!article) return false;
        const book = guide.books.find((item) => item.id === String(article.book));
        selectedTerm.value = null;
        selectedPreview.value = {
            kind: "a",
            kindLabel: book ? `Book ${book.id} · ${book.title}` : "Guide article",
            title: article.title,
            subtitle: `${article.minutes} min read`,
            body: firstProseParagraph(article.plainText || article.body),
            href,
        };
        return true;
    }

    if (kind === "c") {
        const card = guide.cards.find((item) => item.id === id);
        if (!card) return false;
        selectedTerm.value = null;
        selectedPreview.value = {
            kind: "c",
            kindLabel: `Screen card · ${card.screen}`,
            title: card.title,
            subtitle: `${card.risk} risk${card.irreversible ? " · irreversible" : ""}`,
            body: firstProseParagraph(card.body),
            href,
        };
        return true;
    }

    if (kind === "s") {
        const situation = guide.playbook.find((item) => item.id === id);
        if (!situation) return false;
        selectedTerm.value = null;
        selectedPreview.value = {
            kind: "s",
            kindLabel: "Incident playbook",
            title: situation.title,
            subtitle: `${situation.cases.length} linked case${situation.cases.length === 1 ? "" : "s"}`,
            body: firstProseParagraph(situation.body),
            href,
        };
        return true;
    }

    if (kind === "g") {
        openTerm(id);
        return true;
    }

    return false;
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
        const refKind = link.dataset.refKind ?? "";
        const refId = link.dataset.refId ?? "";
        if (refKind && refId && openRefPreview(refKind, refId, href)) {
            event.preventDefault();
            return;
        }
        if (href.startsWith("/")) {
            event.preventDefault();
            void router.push(href);
        }
    }
};

const openRelated = (slug: string): void => {
    selectedTerm.value = null;
    void router.push(`/guide/glossary/${slug}`);
};

const navigateToPreview = (): void => {
    const href = selectedPreview.value?.href;
    selectedPreview.value = null;
    selectedTerm.value = null;
    if (href && href.startsWith("/")) {
        void router.push(href);
    }
};

const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (selectedPreview.value) {
        selectedPreview.value = null;
    } else if (selectedTerm.value) {
        selectedTerm.value = null;
    }
};

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
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
                    <button
                        type="button"
                        class="icon-button"
                        aria-label="Close glossary definition"
                        @click="selectedTerm = null"
                    >
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

        <div
            v-if="selectedPreview"
            class="sheet-backdrop"
            role="presentation"
            @click.self="selectedPreview = null"
        >
            <section
                class="sheet ref-preview-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="preview-title"
            >
                <header class="sheet__header">
                    <div>
                        <p class="eyebrow">{{ selectedPreview.kindLabel }}</p>
                        <h2 id="preview-title" dir="auto">{{ selectedPreview.title }}</h2>
                    </div>
                    <button
                        type="button"
                        class="icon-button"
                        aria-label="Close reference preview"
                        @click="selectedPreview = null"
                    >
                        <AppIcon name="close" />
                    </button>
                </header>
                <p class="muted small" dir="auto">{{ selectedPreview.subtitle }}</p>
                <p class="sheet__body" dir="auto">{{ selectedPreview.body }}</p>
                <div class="sheet__actions">
                    <button type="button" class="btn btn--ghost" @click="selectedPreview = null">
                        Keep reading here
                    </button>
                    <button type="button" class="btn btn--primary" @click="navigateToPreview">
                        Open full page →
                    </button>
                </div>
            </section>
        </div>
    </Teleport>
</template>
