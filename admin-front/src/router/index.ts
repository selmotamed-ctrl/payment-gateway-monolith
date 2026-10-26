import { routesAuthorities, routesRoles } from "@/layouts/sections";
import { hasOneOfAuthorities, isAuthenticated, user } from "@/state/user";
import { showSnackBar } from "@/utils/snackBar";
import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes: [
        {
            path: "/",
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
                    path: "join-requests",
                    name: "JoinRequests",
                    component: () => import("@/pages/join-requests/index"),
                },
                {
                    path: "kyb",
                    name: "KybReview",
                    component: () => import("@/pages/kyb/index"),
                },
                {
                    path: "merchants",
                    name: "Merchants",
                    component: () => import("@/pages/merchants/index"),
                },
                {
                    path: "approvals",
                    name: "Approvals",
                    component: () => import("@/pages/approvals/index"),
                },
                {
                    path: "aml/cases",
                    name: "AmlCases",
                    component: () => import("@/pages/aml/cases/index"),
                },
                {
                    path: "aml/screenings",
                    name: "AmlScreenings",
                    component: () => import("@/pages/aml/screenings/index"),
                },
                {
                    path: "aml/rules",
                    name: "AmlRules",
                    component: () => import("@/pages/aml/rules/index"),
                },
                {
                    path: "aml/reports",
                    name: "AmlReports",
                    component: () => import("@/pages/aml/reports/index"),
                },
                {
                    path: "operator-cases",
                    name: "OperatorCases",
                    component: () => import("@/pages/operator-cases/index"),
                },
                {
                    path: "disputes",
                    name: "Disputes",
                    component: () => import("@/pages/disputes/index"),
                },
                {
                    path: "adjustments",
                    name: "Adjustments",
                    component: () => import("@/pages/adjustments/index"),
                },
                {
                    path: "cashouts",
                    name: "CashOuts",
                    component: () => import("@/pages/cashouts/index"),
                },
                {
                    path: "reconciliation",
                    name: "Reconciliation",
                    component: () => import("@/pages/reconciliation/index"),
                },
                {
                    path: "finance/profitability",
                    name: "Profitability",
                    component: () => import("@/pages/finance/profitability/index"),
                },
                {
                    path: "finance/liquidity",
                    name: "Liquidity",
                    component: () => import("@/pages/finance/liquidity/index"),
                },
                {
                    path: "finance/invariant",
                    name: "Invariant",
                    component: () => import("@/pages/finance/invariant/index"),
                },
                {
                    path: "gateways",
                    name: "Gateways",
                    component: () => import("@/pages/gateways/index"),
                },
                {
                    path: "gateways/wizard/:id",
                    name: "GatewayWizard",
                    component: () => import("@/pages/gateways/wizard/[id]"),
                },
                {
                    path: "rails",
                    name: "Rails",
                    component: () => import("@/pages/rails/index"),
                },
                {
                    path: "routes",
                    name: "GatewayRoutes",
                    component: () => import("@/pages/routes/index"),
                },
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

    const routeName = String(to.name ?? "");
    const requiredAuthorities = routesAuthorities[routeName];
    if (requiredAuthorities?.length && !hasOneOfAuthorities(requiredAuthorities)) {
        showSnackBar({
            message: "you are not allowed to access this resource",
            type: "error",
        });
        return forceRedirect(defaultRoute);
    }

    const allowedRoles = routesRoles[routeName];
    if (allowedRoles?.length) {
        const role = String(user.value?.userInfo?.role ?? "");
        if (!allowedRoles.includes(role)) {
            showSnackBar({
                message: "you are not allowed to access this resource",
                type: "error",
            });
            return forceRedirect(defaultRoute);
        }
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
