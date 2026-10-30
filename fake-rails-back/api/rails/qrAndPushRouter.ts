import { asyncConfirm, asyncInitiate, cancel, inquiry, otpConfirm, otpInitiate, tokenEndpoint } from "./handlers";
import type { RailRouteDefinition } from "./types";

const hybridCodes = ["yussor", "sahara", "masrefy"];
const pushCodes = ["hawelli", "gpay_libya", "numo_pay", "libyana"];

/** QR display, push approval, pay-code and deep-link rails. */
export const qrAndPushRoutes: RailRouteDefinition[] = [
  { gatewayCodes: ["ly_pay"], method: "POST", path: "/api/v1/auth/token", phase: "INITIATE", handler: tokenEndpoint },
  { gatewayCodes: ["ly_pay"], method: "POST", path: "/api/v1/payments/funds-transfers", phase: "INITIATE", handler: asyncInitiate },
  { gatewayCodes: ["ly_pay"], method: "POST", path: "/api/v1/payments/funds-transfers/:uuid/confirm", phase: "SUBMIT", handler: asyncConfirm },
  { gatewayCodes: ["ly_pay"], method: "GET", path: "/api/v1/payments/funds-transfers/enquiry", phase: "VERIFY", handler: inquiry },

  { gatewayCodes: ["onepay"], method: "POST", path: "/qr", phase: "INITIATE", handler: asyncInitiate },
  { gatewayCodes: ["onepay"], method: "POST", path: "/paycode", phase: "INITIATE", handler: asyncInitiate },
  { gatewayCodes: ["onepay"], method: "POST", path: "/verify", phase: "INITIATE", handler: otpInitiate },
  { gatewayCodes: ["onepay"], method: "POST", path: "/confirm", phase: "SUBMIT", handler: otpConfirm },
  { gatewayCodes: ["onepay"], method: "GET", path: "/status/:ref", phase: "VERIFY", handler: inquiry },

  ...hybridCodes.flatMap((code): RailRouteDefinition[] => [
    { gatewayCodes: [code], method: "POST", path: "/initiate", phase: "INITIATE", handler: asyncInitiate },
    { gatewayCodes: [code], method: "POST", path: "/confirm", phase: "SUBMIT", handler: asyncConfirm },
    { gatewayCodes: [code], method: "GET", path: "/status/:ref", phase: "VERIFY", handler: inquiry },
  ]),

  ...pushCodes.flatMap((code): RailRouteDefinition[] => [
    { gatewayCodes: [code], method: "POST", path: "/request", phase: "INITIATE", handler: asyncInitiate },
    { gatewayCodes: [code], method: "POST", path: "/confirm", phase: "SUBMIT", handler: asyncConfirm },
    { gatewayCodes: [code], method: "POST", path: "/cancel", phase: "INITIATE", handler: cancel },
    { gatewayCodes: [code], method: "GET", path: "/status/:ref", phase: "VERIFY", handler: inquiry },
  ]),

  { gatewayCodes: ["evopay"], method: "POST", path: "/Payment", phase: "INITIATE", handler: asyncInitiate },
  { gatewayCodes: ["evopay"], method: "GET", path: "/Payment/:id", phase: "VERIFY", handler: inquiry },
];
