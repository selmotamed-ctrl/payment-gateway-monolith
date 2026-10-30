import { inquiry, otpConfirm, otpInitiate, redirectInitiate, refund, tokenEndpoint } from "./handlers";
import type { RailRouteDefinition } from "./types";

/** Hosted redirect rails: T-LYNC, MyPay, DPay and Plutu. */
export const redirectRoutes: RailRouteDefinition[] = [
  { gatewayCodes: ["tlync"], method: "POST", path: "/payment/create", phase: "INITIATE", handler: redirectInitiate },
  { gatewayCodes: ["tlync"], method: "POST", path: "/receipt/transaction", phase: "VERIFY", handler: inquiry },
  { gatewayCodes: ["tlync"], method: "POST", path: "/refund", phase: "REFUND", handler: refund },

  { gatewayCodes: ["mypay"], method: "POST", path: "/auth/token", phase: "INITIATE", handler: tokenEndpoint },
  { gatewayCodes: ["mypay"], method: "POST", path: "/payment/create", phase: "INITIATE", handler: redirectInitiate },

  { gatewayCodes: ["dpay"], method: "POST", path: "/sessions/open", phase: "INITIATE", handler: redirectInitiate },
  { gatewayCodes: ["dpay"], method: "POST", path: "/sessions/:id/verify", phase: "SUBMIT", handler: otpConfirm },
  { gatewayCodes: ["dpay"], method: "GET", path: "/sessions/:id", phase: "VERIFY", handler: inquiry },
  { gatewayCodes: ["dpay"], method: "POST", path: "/refund", phase: "REFUND", handler: refund },

  { gatewayCodes: ["plutu"], method: "POST", path: "/edfali/verify", phase: "INITIATE", handler: otpInitiate },
  { gatewayCodes: ["plutu"], method: "POST", path: "/edfali/confirm", phase: "SUBMIT", handler: otpConfirm },
  { gatewayCodes: ["plutu"], method: "POST", path: "/sadad/verify", phase: "INITIATE", handler: otpInitiate },
  { gatewayCodes: ["plutu"], method: "POST", path: "/sadad/confirm", phase: "SUBMIT", handler: otpConfirm },
  { gatewayCodes: ["plutu"], method: "POST", path: "/tlync/create", phase: "INITIATE", handler: redirectInitiate },
];
