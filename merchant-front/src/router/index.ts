import { routesAuthorities } from "@/layouts/sections";
import { hasOneOfAuthorities, isAuthenticated } from "@/state/user";
import { showSnackBar } from "@/utils/snackBar";
import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes: [
        {
            path: "/",
            name: "Landing",
            component: () => import("@/pages/public/landing/index"),
        },
        {
            path: "/login",
            name: "Login",
            component: () => import("@/pages/public/auth/login/index"),
            meta: {
                requiresVisitor: true,
            },
        },
        {
            path: "/register",
            name: "Register",
            component: () => import("@/pages/public/auth/register/index"),
            meta: {
                requiresVisitor: true,
            },
        },
        {
            path: "/portal",
            component: () => import("@/layouts/default"),
            children: [
                {
                    path: "",
                    redirect: { name: "Dashboard" },
                },
                {
                    path: "dashboard",
                    name: "Dashboard",
                    component: () => import("@/pages/dashboard/index"),
                },
                {
                    path: "onboarding",
                    name: "Onboarding",
                    component: () => import("@/pages/onboarding/index"),
                },
                {
                    path: "guide",
                    name: "MerchantGuide",
                    component: () => import("@/pages/guide/index"),
                },
                {
                    path: "wallets",
                    name: "Wallets",
                    component: () => import("@/pages/wallets/index"),
                },
                {
                    path: "statements",
                    name: "Statements",
                    component: () => import("@/pages/statements/index"),
                },
                {
                    path: "applications",
                    name: "Applications",
                    component: () => import("@/pages/applications/index"),
                },
                {
                    path: "links",
                    name: "Links",
                    component: () => import("@/pages/links/index"),
                },
                {
                    path: "pos",
                    name: "PosTerminals",
                    component: () => import("@/pages/pos/index"),
                },
                {
                    path: "pos/screen/:code",
                    name: "PosScreen",
                    component: () => import("@/pages/pos/screen/[code]"),
                },
                {
                    path: "payments",
                    name: "Payments",
                    component: () => import("@/pages/payments/index"),
                },
                {
                    path: "disputes",
                    name: "Disputes",
                    component: () => import("@/pages/disputes/index"),
                },
                {
                    path: "cashouts",
                    name: "Cashouts",
                    component: () => import("@/pages/cashouts/index"),
                },
                {
                    path: "developers/tokens",
                    name: "DeveloperTokens",
                    component: () => import("@/pages/developers/tokens/index"),
                },
                {
                    path: "credentials",
                    name: "Credentials",
                    component: () => import("@/pages/credentials/index"),
                },
                {
                    path: "team",
                    name: "Team",
                    component: () => import("@/pages/team/index"),
                },
            ],
            meta: {
                requiresAuth: true,
            },
        },
        {
            path: "/:pathMatch(.*)*",
            name: "NotFound",
            component: () => import("@/pages/public/not-found/index"),
        },
    ],
});

export const defaultRoute = {
    name: "Dashboard",
};

router.beforeEach((to, from) => {
    const authenticated = isAuthenticated();

    const forceRedirect = (props: { path?: string; name: string }) => {
        if (from.name == props.name) {
            return false;
        }
        if (props.path) {
            return { path: props.path };
        }
        return { name: props.name };
    };

    if (!authenticated && to.matched.some((r) => r.meta?.requiresAuth)) {
        return forceRedirect({ name: "Login" });
    }

    if (to.matched.some((r) => r.meta?.requiresVisitor) && authenticated) {
        return forceRedirect(defaultRoute);
    }

    if (to.name === "Landing" && authenticated) {
        return forceRedirect(defaultRoute);
    }

    const routeName = String(to.name ?? "");
    const requiredAuthorities = routesAuthorities[routeName];
    if (requiredAuthorities?.length && !hasOneOfAuthorities(requiredAuthorities)) {
        showSnackBar({
            message: "you are not allowed to access this resource",
            type: "error",
        });
        return forceRedirect(defaultRoute);
    }

    return true;
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
