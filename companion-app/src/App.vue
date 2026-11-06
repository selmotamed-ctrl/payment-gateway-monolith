<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { App as CapacitorApp } from "@capacitor/app";
import { LocalNotifications } from "@capacitor/local-notifications";
import AppIcon from "@/components/AppIcon.vue";
import { todayKey, useCompanionData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";
import { ensureContent } from "@/content/store";
import { maybeAutoCheck, updateState, applyAndReload } from "@/lib/updates";
import { snoozeReminder, syncReminders } from "@/lib/reminders";

const route = useRoute();
const router = useRouter();
const { data, settings, load } = useCompanionData();
const { L } = useI18n();

const ready = ref(false);
const loading = ref(true);
const error = ref("");

const reload = (): void => window.location.reload();

const navItems = computed(() => [
    { to: "/today", label: L("nav.today"), icon: "today", prefix: "/today" },
    { to: "/guide", label: L("nav.guide"), icon: "book", prefix: "/guide" },
    { to: "/academy", label: L("nav.academy"), icon: "academy", prefix: "/academy" },
    { to: "/saved", label: L("nav.saved"), icon: "saved", prefix: "/saved" },
    { to: "/search", label: L("nav.search"), icon: "search", prefix: "/search" },
]);

const isActive = (prefix: string): boolean => route.path === prefix || route.path.startsWith(`${prefix}/`);

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

const applyTheme = (): void => {
    const choice = data.value.settings.theme;
    const resolved = choice === "system" ? (media?.matches ? "dark" : "light") : choice;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.setProperty("--reader-scale", String(data.value.settings.fontScale));
    document.documentElement.classList.toggle("serif-reader", data.value.settings.serif);
    document.documentElement.lang = data.value.settings.language;
    document.documentElement.dir = data.value.settings.language === "ar" ? "rtl" : "ltr";
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute("content", resolved === "light" ? "#f5f7fb" : "#0b1220");
};

const onSystemThemeChange = (): void => {
    if (data.value.settings.theme === "system") applyTheme();
};

watch(
    () => data.value.settings,
    () => applyTheme(),
    { deep: true },
);

watch(
    () => data.value.readingDays.includes(todayKey()),
    (readToday, previous) => {
        if (readToday && !previous) void syncReminders();
    },
);

watch(
    () => route.meta.title,
    (title) => {
        document.title = title ? `${String(title)} · PG Companion` : "PG Companion";
    },
    { immediate: true },
);

let backHandle: { remove: () => Promise<void> } | null = null;
let stateHandle: { remove: () => Promise<void> } | null = null;
let actionHandle: { remove: () => Promise<void> } | null = null;
let urlHandle: { remove: () => Promise<void> } | null = null;

onMounted(async () => {
    try {
        await load();
        applyTheme();
        media?.addEventListener("change", onSystemThemeChange);
        await ensureContent();
        ready.value = true;
        loading.value = false;
        void syncReminders();
        window.setTimeout(() => void maybeAutoCheck(), 1800);
    } catch (cause) {
        loading.value = false;
        error.value = cause instanceof Error ? cause.message : String(cause);
    }

    try {
        backHandle = await CapacitorApp.addListener("backButton", () => {
            if (route.path !== "/today" && window.history.length > 1) router.back();
            else void CapacitorApp.exitApp();
        });
        stateHandle = await CapacitorApp.addListener("appStateChange", ({ isActive }) => {
            if (isActive) {
                void syncReminders();
                void maybeAutoCheck();
            }
        });
        actionHandle = await LocalNotifications.addListener(
            "localNotificationActionPerformed",
            (event) => {
                if (event.actionId === "snooze") {
                    void snoozeReminder();
                    return;
                }
                const notificationRoute = event.notification.extra?.route;
                if (typeof notificationRoute === "string" && notificationRoute.startsWith("/")) {
                    void router.push(notificationRoute);
                }
            },
        );
        urlHandle = await CapacitorApp.addListener("appUrlOpen", ({ url }) => {
            try {
                const parsed = new URL(url);
                if (parsed.pathname.startsWith("/")) void router.push(parsed.pathname);
            } catch {
                // Ignore malformed external links.
            }
        });
    } catch {
        // Native listeners are unavailable in a browser preview.
    }
});

onBeforeUnmount(() => {
    media?.removeEventListener("change", onSystemThemeChange);
    void backHandle?.remove();
    void stateHandle?.remove();
    void actionHandle?.remove();
    void urlHandle?.remove();
});
</script>

<template>
    <div class="app-shell">
        <header class="app-bar">
            <RouterLink to="/today" class="brand" aria-label="PG Companion home">
                <span class="brand-mark" aria-hidden="true">PG</span>
                <span class="brand-name">{{ L("app.name") }}</span>
            </RouterLink>
            <div class="app-bar-actions">
                <RouterLink to="/search" class="icon-button" :aria-label="L('nav.search')">
                    <AppIcon name="search" />
                </RouterLink>
                <RouterLink to="/settings" class="icon-button" :aria-label="L('settings.title')">
                    <AppIcon name="settings" />
                </RouterLink>
            </div>
        </header>

        <div v-if="loading" class="app-state">
            <div class="brand-mark brand-mark--large">PG</div>
            <p>{{ L("common.loading") }}</p>
        </div>
        <div v-else-if="error" class="app-state">
            <div class="state-icon state-icon--danger"><AppIcon name="alert" :size="26" /></div>
            <h1>{{ L("error.content") }}</h1>
            <p class="muted">{{ L("error.contentHint") }}</p>
            <p class="mono small">{{ error }}</p>
            <button class="btn btn--primary" type="button" @click="reload">
                {{ L("common.retry") }}
            </button>
        </div>

        <main v-else class="app-main">
            <div v-if="updateState.applied" class="update-banner" role="status">
                <AppIcon name="sparkle" :size="18" />
                <span>{{ L("settings.updateApplied") }}</span>
                <button class="btn btn--small btn--ghost" type="button" @click="applyAndReload">
                    {{ L("settings.restart") }}
                </button>
            </div>
            <RouterView v-slot="{ Component }">
                <component :is="Component" />
            </RouterView>
        </main>

        <nav v-if="!loading && !error" class="bottom-nav" :aria-label="L('app.name')">
            <RouterLink
                v-for="item in navItems"
                :key="item.to"
                :to="item.to"
                class="bottom-nav__item"
                :class="{ 'is-active': isActive(item.prefix) }"
                :aria-current="isActive(item.prefix) ? 'page' : undefined"
            >
                <AppIcon :name="item.icon" :size="21" />
                <span>{{ item.label }}</span>
            </RouterLink>
        </nav>
    </div>
</template>
