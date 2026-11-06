<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppIcon from "@/components/AppIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import ToolWidget from "@/components/ToolWidget.vue";
import { useI18n } from "@/lib/i18n";

const route = useRoute();
const router = useRouter();
const { L } = useI18n();

const tools = computed(() => [
    { id: "transform-sandbox", icon: "tools", title: L("tool.transform"), note: "Amounts, masks, hashes and phone numbers." },
    { id: "crypto-lab", icon: "lock", title: L("tool.crypto"), note: "Build the canonical string and compare an HMAC." },
    { id: "ledger-explorer", icon: "book", title: L("tool.ledger"), note: "Read the two sides of every journal event." },
    { id: "visible-rails", icon: "alert", title: L("tool.rails"), note: "Find the first predicate that hides a rail." },
    { id: "attempt-states", icon: "refresh", title: L("tool.states"), note: "Walk the teaching transition table." },
]);
const selected = computed(() => String(route.params.tool ?? ""));
const current = computed(() => tools.value.find((tool) => tool.id === selected.value));
const choose = (id: string): void => {
    void router.push(`/guide/tools/${id}`);
};
</script>

<template>
    <div class="page">
        <PageHeader
            :title="L('guide.tools')"
            subtitle="Safe, client-only teaching tools. They are not connected to any real system."
            back-to="/guide"
        />
        <div class="tool-picker">
            <button
                v-for="tool in tools"
                :key="tool.id"
                type="button"
                class="tool-pill"
                :class="{ 'is-active': selected === tool.id }"
                @click="choose(tool.id)"
            >
                <AppIcon :name="tool.icon" :size="17" />
                <span>{{ tool.title }}</span>
            </button>
        </div>
        <ToolWidget v-if="current" :tool="current.id" />
        <section v-else class="empty-state">
            <AppIcon name="tools" :size="28" />
            <h2>Choose a simulator</h2>
            <p>Each tool opens with example data, a reset button and an explanation of the result.</p>
        </section>
    </div>
</template>
