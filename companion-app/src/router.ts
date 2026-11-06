import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
    { path: "/", redirect: "/today" },
    {
        path: "/today",
        name: "today",
        component: () => import("@/features/today/TodayPage.vue"),
        meta: { title: "Today" },
    },
    {
        path: "/guide",
        name: "guide",
        component: () => import("@/features/guide/GuideHomePage.vue"),
        meta: { title: "Guide" },
    },
    {
        path: "/guide/book/:bookId",
        name: "guide-book",
        component: () => import("@/features/guide/BookPage.vue"),
        meta: { title: "Book" },
    },
    {
        path: "/guide/article/:articleId",
        name: "guide-article",
        component: () => import("@/features/guide/ArticlePage.vue"),
        meta: { title: "Article" },
    },
    {
        path: "/guide/glossary/:slug?",
        name: "guide-glossary",
        component: () => import("@/features/guide/GlossaryPage.vue"),
        meta: { title: "Glossary" },
    },
    {
        path: "/guide/cards/:id?",
        name: "guide-cards",
        component: () => import("@/features/guide/CardsPage.vue"),
        meta: { title: "Safeguard cards" },
    },
    {
        path: "/guide/playbook/:id?",
        name: "guide-playbook",
        component: () => import("@/features/guide/PlaybookPage.vue"),
        meta: { title: "Playbook" },
    },
    {
        path: "/guide/edge-cases",
        name: "guide-edge-cases",
        component: () => import("@/features/guide/EdgeCasesPage.vue"),
        meta: { title: "Edge cases" },
    },
    {
        path: "/guide/reference",
        name: "guide-reference",
        component: () => import("@/features/guide/ReferencePage.vue"),
        meta: { title: "Reference" },
    },
    {
        path: "/guide/tools/:tool?",
        name: "guide-tools",
        component: () => import("@/features/tools/ToolsPage.vue"),
        meta: { title: "Tools" },
    },
    {
        path: "/academy",
        name: "academy",
        component: () => import("@/features/academy/AcademyHomePage.vue"),
        meta: { title: "Academy" },
    },
    {
        path: "/academy/track/:trackId",
        name: "academy-track",
        component: () => import("@/features/academy/TrackPage.vue"),
        meta: { title: "Track" },
    },
    {
        path: "/academy/module/:moduleId",
        name: "academy-module",
        component: () => import("@/features/academy/ModulePage.vue"),
        meta: { title: "Module" },
    },
    {
        path: "/academy/lesson/:lessonId",
        name: "academy-lesson",
        component: () => import("@/features/academy/LessonPage.vue"),
        meta: { title: "Lesson" },
    },
    {
        path: "/academy/lab/:labId",
        name: "academy-lab",
        component: () => import("@/features/academy/LabPage.vue"),
        meta: { title: "Lab" },
    },
    {
        path: "/academy/help",
        name: "academy-help",
        component: () => import("@/features/academy/HelpPage.vue"),
        meta: { title: "Academy help" },
    },
    {
        path: "/academy/practice-exam",
        name: "academy-practice-exam",
        component: () => import("@/features/academy/PracticeExamPage.vue"),
        meta: { title: "Practice exam" },
    },
    {
        path: "/saved",
        name: "saved",
        component: () => import("@/features/saved/SavedPage.vue"),
        meta: { title: "Saved" },
    },
    {
        path: "/search",
        name: "search",
        component: () => import("@/features/search/SearchPage.vue"),
        meta: { title: "Search" },
    },
    {
        path: "/settings",
        name: "settings",
        component: () => import("@/features/settings/SettingsPage.vue"),
        meta: { title: "Settings" },
    },
    { path: "/:pathMatch(.*)*", name: "not-found", redirect: "/today" },
];

export const router = createRouter({
    history: createWebHashHistory(),
    routes,
    scrollBehavior(to, _from, savedPosition) {
        if (savedPosition) return savedPosition;
        if (to.hash) return { el: to.hash, behavior: "smooth" };
        return { top: 0 };
    },
});
