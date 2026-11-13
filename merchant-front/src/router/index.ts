import { routesAuthorities } from "@/layouts/sections";
import { isSandboxPath, SANDBOX_ROUTE_ALIASES, sandboxMode, setSandboxMode } from "@/state/sandbox";
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
                    path: "guide/developers",
                    name: "MerchantDeveloperGuide",
                    component: () => import("@/pages/guide/developers/index"),
                },
                {
                    path: "sandbox/overview",
                    name: "SandboxOverview",
                    component: () => import("@/pages/sandbox/overview/index"),
                },
                {
                    path: "sandbox/wallets",
                    name: "SandboxWallets",
                    component: () => import("@/pages/sandbox/wallets/index"),
                },
                {
                    path: "sandbox/wallets/:id",
                    name: "SandboxWalletDetail",
                    component: () => import("@/pages/sandbox/wallets/[id]"),
                },
                {
                    path: "sandbox/applications",
                    name: "SandboxApplications",
                    component: () => import("@/pages/sandbox/applications/index"),
                },
                {
                    path: "sandbox/applications/:id",
                    name: "SandboxApplicationDetail",
                    component: () => import("@/pages/sandbox/applications/[id]"),
                },
                {
                    path: "sandbox/links",
                    name: "SandboxLinks",
                    component: () => import("@/pages/sandbox/links/index"),
                },
                {
                    path: "sandbox/links/:id",
                    name: "SandboxLinkDetail",
                    component: () => import("@/pages/sandbox/links/[id]"),
                },
                {
                    path: "sandbox/payments",
                    name: "SandboxPayments",
                    component: () => import("@/pages/sandbox/payments/index"),
                },
                {
                    path: "sandbox/payments/:id",
                    name: "SandboxPaymentDetail",
                    component: () => import("@/pages/sandbox/payments/[id]"),
                },
                {
                    path: "sandbox/accounts",
                    name: "SandboxAccounts",
                    component: () => import("@/pages/sandbox/accounts/index"),
                },
                {
                    path: "sandbox/tokens",
                    name: "SandboxTokens",
                    component: () => import("@/pages/sandbox/tokens/index"),
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
                    path: "developers/webhooks",
                    name: "Webhooks",
                    component: () => import("@/pages/developers/webhooks/index"),
                },
                {
                    path: "reports",
                    name: "MerchantReports",
                    component: () => import("@/pages/reports/index"),
                },
                {
                    path: "reports/chrome",
                    name: "MerchantReportsChrome",
                    component: () => import("@/pages/reports/chrome/index"),
                },
                {
                    path: "reports/chrome/needs-migration",
                    name: "MerchantReportsChromeNeedsMigration",
                    component: () => import("@/pages/reports/chrome/needs-migration/index"),
                },
                {
                    path: "reports/needs-migration",
                    name: "MerchantReportsNeedsMigration",
                    component: () => import("@/pages/reports/needs-migration/index"),
                },
                {
                    path: "reports/studio",
                    name: "MerchantReportsStudio",
                    component: () => import("@/pages/reports/studio/index"),
                },
                {
                    path: "sandbox/mirror/cashouts",
                    name: "SandboxMirrorCashouts",
                    component: () => import("@/pages/cashouts/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/disputes",
                    name: "SandboxMirrorDisputes",
                    component: () => import("@/pages/disputes/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/pos",
                    name: "SandboxMirrorPos",
                    component: () => import("@/pages/pos/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/pos/screen/:code",
                    name: "SandboxMirrorPosScreen",
                    component: () => import("@/pages/pos/screen/[code]"),
                    meta: { sandboxMirror: true, parentName: "SandboxMirrorPos" },
                },
                {
                    path: "sandbox/mirror/credentials",
                    name: "SandboxMirrorCredentials",
                    component: () => import("@/pages/credentials/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/team",
                    name: "SandboxMirrorTeam",
                    component: () => import("@/pages/team/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/webhooks",
                    name: "SandboxMirrorWebhooks",
                    component: () => import("@/pages/developers/webhooks/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/tokens",
                    name: "SandboxMirrorTokens",
                    component: () => import("@/pages/developers/tokens/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/statements",
                    name: "SandboxMirrorStatements",
                    component: () => import("@/pages/statements/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/reports",
                    name: "SandboxMirrorReports",
                    component: () => import("@/pages/reports/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/reports/studio",
                    name: "SandboxMirrorReportsStudio",
                    component: () => import("@/pages/reports/studio/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/reports/chrome",
                    name: "SandboxMirrorReportsChrome",
                    component: () => import("@/pages/reports/chrome/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/reports/chrome/needs-migration",
                    name: "SandboxMirrorReportsChromeNeedsMigration",
                    component: () => import("@/pages/reports/chrome/needs-migration/index"),
                    meta: { sandboxMirror: true },
                },
                {
                    path: "sandbox/mirror/reports/needs-migration",
                    name: "SandboxMirrorReportsNeedsMigration",
                    component: () => import("@/pages/reports/needs-migration/index"),
                    meta: { sandboxMirror: true },
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
    const wasSandbox = sandboxMode.value;
    setSandboxMode(isSandboxPath(to.path));
    if (wasSandbox && !isSandboxPath(to.path) && to.name) {
        // An explicit Exit sandbox link always wins over the Live->mirror alias
        // map; otherwise Exit redirected straight back into the mirror.
        if (String(to.query.live ?? "") === "1") {
            const { live: _live, ...query } = to.query;
            return { path: to.path, query };
        }
        const alias = SANDBOX_ROUTE_ALIASES[String(to.name)];
        if (alias && alias !== to.name) {
            return { name: alias, params: to.params, query: to.query };
        }
        const publicRoute = ["Login", "AcceptInvitation", "NotFound", "Landing"].includes(String(to.name));
        if (!publicRoute) {
            showSnackBar({ type: "primary", message: "This screen is not available in Sandbox. Use Exit sandbox to return to Live." });
            return false;
        }
    }
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
