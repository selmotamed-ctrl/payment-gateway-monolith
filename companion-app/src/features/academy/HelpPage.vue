<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import MarkdownView from "@/components/MarkdownView.vue";
import PageHeader from "@/components/PageHeader.vue";
import { useI18n } from "@/lib/i18n";
import { useContent } from "@/content/store";

const route = useRoute();
const router = useRouter();
const { L } = useI18n();
const { bundle } = useContent();

const pages = computed(() => bundle.value?.academy.pages ?? []);
const drills = computed(() => bundle.value?.academy.drills ?? []);
const pageId = computed(() => String(route.query.page ?? "page-how-it-works"));
const selected = computed(() => pages.value.find((page) => page.id === pageId.value) ?? pages.value[0]);
const open = (id: string): void => {
    void router.replace({ query: { ...route.query, page: id } });
};
</script>

<template>
    <div class="page">
        <PageHeader
            :title="L('academy.help')"
            subtitle="How the Academy works, how scoring works and the optional live drills."
            back-to="/academy"
            tone="academy"
        />
        <div class="tool-picker">
            <button
                v-for="page in pages"
                :key="page.id"
                type="button"
                class="tool-pill"
                :class="{ 'is-active': selected?.id === page.id }"
                @click="open(page.id)"
            >
                {{ page.title }}
            </button>
        </div>
        <article v-if="selected" class="reader-sheet">
            <h2>{{ selected.title }}</h2>
            <MarkdownView :source="selected.markdown" />
        </article>

        <section v-if="drills.length" class="section">
            <div class="section-head">
                <h2>Optional live drills</h2>
                <span class="muted">{{ drills.length }}</span>
            </div>
            <p class="muted">Trainer-led material. The app can read them, but the live staging drills need the deployed system.</p>
            <details v-for="drill in drills" :key="drill.id" class="faq-card">
                <summary>{{ drill.title }} · {{ drill.minutes }} min</summary>
                <MarkdownView :source="drill.markdown" />
            </details>
        </section>
    </div>
</template>
