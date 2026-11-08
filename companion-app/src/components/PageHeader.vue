<script setup lang="ts">
import { useRouter } from "vue-router";
import AppIcon from "./AppIcon.vue";

const props = withDefaults(
    defineProps<{
        title: string;
        subtitle?: string;
        backTo?: string | null;
        showBack?: boolean;
        tone?: "default" | "academy";
    }>(),
    { subtitle: "", backTo: null, showBack: true, tone: "default" },
);

const router = useRouter();

const goBack = (): void => {
    if (props.backTo) {
        void router.push(props.backTo);
        return;
    }
    if (window.history.length > 1) router.back();
    else void router.push("/today");
};
</script>

<template>
    <header class="page-header" :class="{ 'page-header--academy': tone === 'academy' }">
        <div class="page-header__top">
            <button
                v-if="showBack"
                type="button"
                class="icon-button icon-button--back"
                aria-label="Back"
                @click="goBack"
            >
                <AppIcon name="arrow-left" :size="22" />
            </button>
            <div class="page-header__titles">
                <h1 dir="auto">{{ title }}</h1>
                <p v-if="subtitle" dir="auto">{{ subtitle }}</p>
            </div>
            <div class="page-header__actions">
                <slot name="actions" />
            </div>
        </div>
        <slot />
    </header>
</template>
