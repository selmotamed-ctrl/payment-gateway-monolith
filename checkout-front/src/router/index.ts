import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes: [
        {
            path: "/",
            name: "Home",
            redirect: { name: "NotFound" },
        },
        {
            path: "/pay/:linkKey",
            name: "Pay",
            component: () => import("@/pages/pay/[linkKey]/index"),
        },
        {
            path: "/:pathMatch(.*)*",
            name: "NotFound",
            component: () => import("@/pages/public/not-found/index"),
        },
    ],
});

router.onError((err, to) => {
    if (err?.message?.includes?.("Failed to fetch dynamically imported module")) {
        if (!localStorage.getItem("vuetify:dynamic-reload")) {
            localStorage.setItem("vuetify:dynamic-reload", "true");
            location.assign(to.fullPath);
        } else {
            console.error("Dynamic import error, reloading page did not fix it", err);
        }
    } else {
        console.error(err);
    }
});

router.isReady().then(() => {
    localStorage.removeItem("vuetify:dynamic-reload");
});

export default router;
