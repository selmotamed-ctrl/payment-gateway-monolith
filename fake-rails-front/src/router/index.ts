import { createRouter, createWebHistory } from "vue-router";
import { isAuthenticated } from "@/utils/api";

const routes = [
  { path: "/", redirect: "/dashboard" },
  { path: "/login", name: "login", component: () => import("@/pages/login/index") },
  { path: "/dashboard", name: "dashboard", component: () => import("@/pages/dashboard/index") },
  { path: "/transactions", name: "transactions", component: () => import("@/pages/transactions/index") },
  { path: "/chaos-matrix", name: "chaos-matrix", component: () => import("@/pages/chaos-matrix/index") },
  { path: "/statements", name: "statements", component: () => import("@/pages/statements/index") },
  { path: "/hosted/redirect/:sessionId", name: "hosted-redirect", component: () => import("@/pages/hosted/redirect/[sessionId]") },
  { path: "/hosted/widget-frame", name: "hosted-widget", component: () => import("@/pages/hosted/widget-frame") },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const publicRoute = to.path.startsWith("/hosted/") || to.path === "/login";
  if (!publicRoute && !isAuthenticated()) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  return true;
});

export default router;
