import { routesRoles } from "@/layouts/sections";
import { resolveRouteRequirement } from "@/utils/routeAuthorities";
import { hasOneOfAuthorities, isAuthenticated, user } from "@/state/user";
import { showSnackBar } from "@/utils/snackBar";
import { createRouter, createWebHistory } from "vue-router";
import { routeError, routeLoading } from "@/state/route";

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
                    path: "join-requests/new",
                    name: "JoinRequestNew",
                    component: () => import("@/pages/join-requests/new"),
                    meta: { parentName: "JoinRequests" },
                },
                {
                    path: "join-requests/:id",
                    name: "JoinRequestDetail",
                    component: () => import("@/pages/join-requests/[id]"),
                    meta: { parentName: "JoinRequests" },
                },
                {
                    path: "kyb",
                    name: "KybReview",
                    component: () => import("@/pages/kyb/index"),
                },
                {
                    path: "kyb/:id",
                    name: "KybReviewDetail",
                    component: () => import("@/pages/kyb/[id]"),
                    meta: { parentName: "KybReview" },
                },
                {
                    path: "merchants",
                    name: "Merchants",
                    component: () => import("@/pages/merchants/index"),
                },
                {
                    path: "merchants/:id",
                    name: "MerchantDetail",
                    component: () => import("@/pages/merchants/[id]"),
                    meta: { parentName: "Merchants" },
                },
                {
                    path: "wallets",
                    name: "Wallets",
                    component: () => import("@/pages/wallets/index"),
                },
                {
                    path: "wallets/:id",
                    name: "WalletDetail",
                    component: () => import("@/pages/wallets/[id]"),
                    meta: { parentName: "Wallets" },
                },
                {
                    path: "applications",
                    name: "Applications",
                    component: () => import("@/pages/applications/index"),
                },
                {
                    path: "transactions",
                    name: "Transactions",
                    component: () => import("@/pages/transactions/index"),
                },
                {
                    path: "approvals",
                    name: "Approvals",
                    component: () => import("@/pages/approvals/index"),
                },
                {
                    path: "users",
                    name: "AdminUsers",
                    component: () => import("@/pages/users/index"),
                },
                {
                    path: "users/:id",
                    name: "AdminUserDetail",
                    component: () => import("@/pages/users/[id]"),
                    meta: { parentName: "AdminUsers" },
                },
                {
                    path: "audit-logs",
                    name: "AuditLog",
                    component: () => import("@/pages/audit-logs/index"),
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
                    path: "operator-cases/inquiries",
                    name: "GatewayInquirySchedules",
                    component: () => import("@/pages/operator-cases/inquiries/index"),
                    meta: { parentName: "OperatorCases" },
                },
                {
                    path: "operator-cases/:id",
                    name: "OperatorCaseDetail",
                    component: () => import("@/pages/operator-cases/[id]"),
                    meta: { parentName: "OperatorCases" },
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
                    path: "finance/pricing",
                    name: "PricingControls",
                    component: () => import("@/pages/finance/pricing/index"),
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
                    path: "finance/journal-entries",
                    name: "JournalEntries",
                    component: () => import("@/pages/finance/journal-entries/index"),
                },
                {
                    path: "finance/invariant",
                    name: "Invariant",
                    component: () => import("@/pages/finance/invariant/index"),
                },
                {
                    path: "credential-sets",
                    name: "CredentialSets",
                    component: () => import("@/pages/credential-sets/index"),
                },
                {
                    path: "gateways",
                    name: "Gateways",
                    component: () => import("@/pages/gateways/index"),
                },
                {
                    path: "gateways/ai-import",
                    name: "GatewayAiImport",
                    component: () => import("@/pages/gateways/ai-import/index"),
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
                {
                    path: "guide",
                    name: "AdminGuide",
                    component: () => import("@/pages/guide/index"),
                },
                {
                    path: "guide/book/:bookId",
                    name: "AdminGuideBook",
                    component: () => import("@/pages/guide/book"),
                },
                {
                    path: "guide/a/:articleId",
                    name: "AdminGuideArticle",
                    component: () => import("@/pages/guide/article"),
                },
                {
                    path: "guide/glossary/:slug?",
                    name: "AdminGuideGlossary",
                    component: () => import("@/pages/guide/glossary"),
                },
                {
                    path: "guide/tools/:tool?",
                    name: "AdminGuideTools",
                    component: () => import("@/pages/guide/tools"),
                },
                {
                    path: "guide/playbook/:id?",
                    name: "AdminGuidePlaybook",
                    component: () => import("@/pages/guide/playbook"),
                },
                {
                    path: "guide/cards/:id?",
                    name: "AdminGuideCards",
                    component: () => import("@/pages/guide/cards"),
                },
                {
                    path: "guide/edge-cases",
                    name: "AdminGuideEdgeCases",
                    component: () => import("@/pages/guide/edge-cases"),
                },
                {
                    path: "academy",
                    name: "AdminAcademy",
                    component: () => import("@/pages/academy/index"),
                },
                {
                    path: "academy/tracks",
                    name: "AdminAcademyTracks",
                    component: () => import("@/pages/academy/tracks"),
                    meta: { parentName: "AdminAcademy" },
                },
                {
                    path: "academy/track/:trackId",
                    name: "AdminAcademyTrack",
                    component: () => import("@/pages/academy/track"),
                    meta: { parentName: "AdminAcademy" },
                },
                {
                    path: "academy/module/:moduleId",
                    name: "AdminAcademyModule",
                    component: () => import("@/pages/academy/module"),
                    meta: { parentName: "AdminAcademy" },
                },
                {
                    path: "academy/lesson/:lessonId",
                    name: "AdminAcademyLesson",
                    component: () => import("@/pages/academy/lesson"),
                    meta: { parentName: "AdminAcademy" },
                },
                {
                    path: "academy/lab/:labId",
                    name: "AdminAcademyLab",
                    component: () => import("@/pages/academy/lab"),
                    meta: { parentName: "AdminAcademy" },
                },
                {
                    path: "academy/exam/:examId",
                    name: "AdminAcademyExam",
                    component: () => import("@/pages/academy/exam"),
                    meta: { parentName: "AdminAcademy" },
                },
                {
                    path: "academy/certificate/:badgeId",
                    name: "AdminAcademyCertificate",
                    component: () => import("@/pages/academy/certificate"),
                    meta: { parentName: "AdminAcademy" },
                },
                {
                    path: "academy/team",
                    name: "AdminAcademyTeam",
                    component: () => import("@/pages/academy/team"),
                    meta: { parentName: "AdminAcademy" },
                },
                {
                    path: "academy/help",
                    name: "AdminAcademyHelp",
                    component: () => import("@/pages/academy/help"),
                    meta: { parentName: "AdminAcademy" },
                },
                {
                    path: "settings/platform",
                    name: "AdminPlatformSettings",
                    component: () => import("@/pages/settings/platform/index"),
                },
                {
                    path: "settings/checkout-help",
                    name: "AdminCheckoutHelp",
                    component: () => import("@/pages/settings/checkout-help/index"),
                },
                {
                    path: "system/backups",
                    name: "SystemBackups",
                    component: () => import("@/pages/system/backups/index"),
                },
                {
                    path: "system/jobs-outbox",
                    name: "JobsOutbox",
                    component: () => import("@/pages/system/jobs-outbox/index"),
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
            path: "/accept-invitation",
            name: "AcceptInvitation",
            component: () => import("@/pages/public/auth/accept-invitation"),
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
    if (to.fullPath !== from.fullPath) {
        routeLoading.value = true;
    }

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
        const redirect = to.fullPath && to.fullPath !== "/" ? to.fullPath : undefined;
        return {
            name: "Login",
            ...(redirect ? { query: { redirect } } : {}),
        };
    }

    if (to.matched.some((r) => r.meta?.requiresVisitor) && authenticated) {
        return forceRedirect(defaultRoute);
    }

    const routeName = String(to.name ?? "");
    // Public routes (Login/NotFound) have no matched requiresAuth record and are not gated here.
    const gated = to.matched.some((r) => r.meta?.requiresAuth);
    const requirement = resolveRouteRequirement(routeName);
    if (gated && routeName && (!requirement.allowed || !hasOneOfAuthorities(requirement.authorities))) {
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

router.afterEach(() => {
    routeLoading.value = false;
    routeError.value = null;
    sessionStorage.removeItem("vuetify:dynamic-import-attempts");
});

router.onError((err, to) => {
    routeLoading.value = false;
    const message = String(err?.message ?? "");
    if (message.includes("Failed to fetch dynamically imported module")) {
        const attempts = Number(sessionStorage.getItem("vuetify:dynamic-import-attempts") ?? "0");
        if (attempts < 1) {
            sessionStorage.setItem("vuetify:dynamic-import-attempts", String(attempts + 1));
            location.assign(to.fullPath);
            return;
        }
        sessionStorage.removeItem("vuetify:dynamic-import-attempts");
        routeError.value = {
            path: to.fullPath,
            message: "The page module failed to load. Check your connection and try again.",
        };
    } else {
        routeError.value = {
            path: to.fullPath,
            message: message || "The page could not be loaded.",
        };
    }
    console.error(err);
});

router.isReady().then(() => {
    sessionStorage.removeItem("vuetify:dynamic-import-attempts");
});

export default router;
