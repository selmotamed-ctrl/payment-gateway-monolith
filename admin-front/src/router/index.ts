import { routesAuthorities } from "@/layouts/sections";
import { hasOneOfAuthorities } from "@/pages/user/core/users/roles/authorities";
import { operations } from "@/pages/user/ubs/operations";
import { allowedToAccessCore } from "@/state/app";
import { user } from "@/state/user";
import { showSnackBar } from "@/utils/snackBar";
import { createRouter, createWebHashHistory, createWebHistory } from "vue-router";
import { components } from "vuetify/dist/vuetify.js";

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes: [
        {
            path: "/",
            name: "",
            component: () => {
                return import("@/layouts/default");
            },
            children: [
                // example
                // {
                //     path: "",
                //     redirect: {
                //         name: "Dashboard",
                //     },
                // },
                // {
                //     path: "/dashboard",
                //     name: "Dashboard",
                //     component: () => {
                //         return import("@/pages/user/dashboard");
                //     },
                // },
            ],
            meta: {
                requiresAuth: true,
            },
        },
        {
            path: "/login",
            name: "Login",
            component: () => import("@/pages/public/auth/login"),
            meta: {
                requiresVisitor: true,
            },
        },
    ],
});

export const defaultRoute = {
    name: "Dashboard",
};

router.beforeEach((to, from) => {
    const isAuthenticated = !!user.value?.token && !!user.value?.userInfo;
    const forceRedirect = (props: { path?: string; name: string }) => {
        if (from.name == props.name) {
            return false;
        }
        if (props.path) {
            return {
                path: props.path,
            };
        }
        return {
            name: props.name,
        };
    };

    console.log("routing...", {
        isAuthenticated,
        from: {
            path: from.path,
            name: from.name,
        },
        to: {
            path: to.path,
            name: to.name,
        },
    });

    if (
        !isAuthenticated &&
        to.matched.some((r) => {
            return r.meta?.requiresAuth;
        })
    ) {
        console.log("[RA:unauthorized] Routing away from target", to.name, "because it requires authentication and the user is not", user.value);
        return forceRedirect({
            name: "Login",
        });
    }

    if (
        to.matched.some((r) => {
            return r.meta?.requiresVisitor;
        }) &&
        isAuthenticated
    ) {
        console.log("[RA:requires-visitor] Routing away from target", to.name, "because it requires visitor and the user is logged in", user.value);
        return forceRedirect(defaultRoute);
    }

    if (
        to.matched.some((r) => {
            return r.meta?.requiresCore;
        }) &&
        !allowedToAccessCore.value
    ) {
        console.log("[RA:requires-core-access] Routing away from target", to.name, "because it requires core access", allowedToAccessCore.value);
        showSnackBar({
            type: "error",
            message: "Not Allowed To Access Core",
        });
        return forceRedirect(defaultRoute);
    }

    const routeAuthorities = routesAuthorities[String(to.name)];
    if (routeAuthorities?.length) {
        if (!hasOneOfAuthorities(routeAuthorities)) {
            showSnackBar({
                message: "you are not allowed to access this resource",
                type: "error",
            });
            return forceRedirect(defaultRoute);
        }
    }

    return true;
});

// Workaround for https://github.com/vitejs/vite/issues/11804
router.onError((err, to) => {
    if (err?.message?.includes?.("Failed to fetch dynamically imported module")) {
        if (!localStorage.getItem("vuetify:dynamic-reload")) {
            console.log("Reloading page to fix dynamic import error");
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
