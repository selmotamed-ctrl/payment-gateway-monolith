import { inquiry, redirectInitiate, refund, asyncConfirm } from "./handlers";
import type { RailRouteDefinition } from "./types";

/** Moamalat NPG lightbox and MPGS hosted-session (embedded / redirect). */
export const embeddedRoutes: RailRouteDefinition[] = [
  { gatewayCodes: ["moamalat"], method: "POST", path: "/FilterTransactions", phase: "VERIFY", handler: inquiry },
  { gatewayCodes: ["moamalat"], method: "POST", path: "/refund", phase: "REFUND", handler: refund },
  { gatewayCodes: ["moamalat"], method: "POST", path: "/confirm", phase: "SUBMIT", handler: asyncConfirm },

  { gatewayCodes: ["mpgs"], method: "POST", path: "/session", phase: "INITIATE", handler: redirectInitiate },
  { gatewayCodes: ["mpgs"], method: "GET", path: "/order/:id", phase: "VERIFY", handler: inquiry },
  { gatewayCodes: ["mpgs"], method: "POST", path: "/order/:id/refund", phase: "REFUND", handler: refund },
  { gatewayCodes: ["mpgs"], method: "POST", path: "/order/:id/confirm", phase: "SUBMIT", handler: asyncConfirm },
];
