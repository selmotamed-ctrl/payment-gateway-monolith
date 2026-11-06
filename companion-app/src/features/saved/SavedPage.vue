<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import {
    removeBookmark,
    removeHighlight,
    updateHighlight,
    useCompanionData,
    type Bookmark,
} from "@/lib/data";
import { useI18n } from "@/lib/i18n";

const { data } = useCompanionData();
const { L } = useI18n();
const tab = ref<"bookmarks" | "highlights">("bookmarks");

const bookmarks = computed(() => data.value.bookmarks);
const highlights = computed(() => data.value.highlights);

const editing = ref<string | null>(null);
const noteDraft = ref("");

const editNote = (id: string, current: string | undefined): void => {
    editing.value = id;
    noteDraft.value = current ?? "";
};

const saveNote = (): void => {
    if (!editing.value) return;
    updateHighlight(editing.value, { note: noteDraft.value.trim() });
    editing.value = null;
    noteDraft.value = "";
};

const routeFor = (bookmark: Bookmark): string => {
    const base =
        bookmark.kind === "article"
            ? `/guide/article/${bookmark.targetId}`
            : bookmark.kind === "lesson"
              ? `/academy/lesson/${bookmark.targetId}`
              : bookmark.kind === "term"
                ? `/guide/glossary/${bookmark.targetId}`
                : `/guide/cards/${bookmark.targetId}`;
    return bookmark.headingId ? `${base}#${bookmark.headingId}` : base;
};
</script>

<template>
    <div class="page">
        <PageHeader :title="L('saved.title')" :show-back="false" />
        <div class="segmented">
            <button type="button" class="segmented__item" :class="{ 'is-active': tab === 'bookmarks' }" @click="tab = 'bookmarks'">
                {{ L("saved.bookmarks") }} <span class="count">{{ bookmarks.length }}</span>
            </button>
            <button type="button" class="segmented__item" :class="{ 'is-active': tab === 'highlights' }" @click="tab = 'highlights'">
                {{ L("saved.highlights") }} <span class="count">{{ highlights.length }}</span>
            </button>
        </div>

        <template v-if="tab === 'bookmarks'">
            <ul v-if="bookmarks.length" class="simple-list">
                <li v-for="bookmark in bookmarks" :key="bookmark.id">
                    <div class="saved-row">
                        <RouterLink :to="routeFor(bookmark)" class="saved-row__main">
                            <span class="quick-icon"><AppIcon name="bookmark" :size="18" /></span>
                            <span>
                                <strong dir="auto">{{ bookmark.label || bookmark.title }}</strong>
                                <small>{{ bookmark.kind }} · {{ bookmark.title }}</small>
                            </span>
                        </RouterLink>
                        <button type="button" class="icon-button icon-button--tiny" :aria-label="L('common.delete')" @click="removeBookmark(bookmark.id)">
                            <AppIcon name="trash" :size="17" />
                        </button>
                    </div>
                </li>
            </ul>
            <div v-else class="empty-state empty-state--small">
                <AppIcon name="bookmark" :size="28" />
                <h2>{{ L("saved.bookmarks") }}</h2>
                <p class="muted">{{ L("saved.noBookmarks") }}</p>
                <RouterLink to="/guide" class="btn btn--primary">{{ L("nav.guide") }}</RouterLink>
            </div>
        </template>

        <template v-else>
            <ul v-if="highlights.length" class="simple-list">
                <li v-for="highlight in highlights" :key="highlight.id">
                    <article class="highlight-card" :class="`highlight-card--${highlight.color}`">
                        <div class="highlight-card__head">
                            <small>{{ highlight.title }}</small>
                            <button type="button" class="icon-button icon-button--tiny" :aria-label="L('common.delete')" @click="removeHighlight(highlight.id)">
                                <AppIcon name="trash" :size="17" />
                            </button>
                        </div>
                        <p dir="auto">{{ highlight.text }}</p>
                        <p v-if="highlight.note" class="muted" dir="auto">{{ highlight.note }}</p>
                        <button type="button" class="btn btn--tiny btn--ghost" @click="editNote(highlight.id, highlight.note)">
                            {{ highlight.note ? "Edit note" : "Add note" }}
                        </button>
                        <RouterLink
                            :to="highlight.kind === 'lesson' ? `/academy/lesson/${highlight.targetId}` : `/guide/article/${highlight.targetId}`"
                            class="text-link"
                        >
                            Open source →
                        </RouterLink>
                    </article>
                </li>
            </ul>
            <div v-else class="empty-state empty-state--small">
                <AppIcon name="highlight" :size="28" />
                <h2>{{ L("saved.highlights") }}</h2>
                <p class="muted">{{ L("saved.noHighlights") }}</p>
            </div>
        </template>

        <Teleport to="body">
            <div v-if="editing" class="sheet-backdrop" @click.self="editing = null">
                <section class="sheet" role="dialog" aria-modal="true" aria-label="Highlight note">
                    <header class="sheet__header">
                        <div><p class="eyebrow">Highlight</p><h2>Note</h2></div>
                        <button type="button" class="icon-button" @click="editing = null">
                            <AppIcon name="close" />
                        </button>
                    </header>
                    <textarea v-model="noteDraft" class="input textarea" rows="5" placeholder="What do you want to remember?" />
                    <div class="hero-actions">
                        <button type="button" class="btn btn--primary" @click="saveNote">Save note</button>
                        <button type="button" class="btn btn--ghost" @click="editing = null">Cancel</button>
                    </div>
                </section>
            </div>
        </Teleport>
    </div>
</template>
