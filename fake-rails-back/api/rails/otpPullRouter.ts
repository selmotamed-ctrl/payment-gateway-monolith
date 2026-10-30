import { inquiry, otpConfirm, otpInitiate, asyncInitiate } from "./handlers";
import type { RailRouteDefinition } from "./types";

/** Edfali, Sadad and MobiCash: pull-OTP collection rails. */
export const otpPullRoutes: RailRouteDefinition[] = [
  { gatewayCodes: ["edfali"], method: "POST", path: "/verify", phase: "INITIATE", handler: otpInitiate },
  { gatewayCodes: ["edfali"], method: "POST", path: "/confirm", phase: "SUBMIT", handler: otpConfirm },
  { gatewayCodes: ["edfali"], method: "GET", path: "/status/:ref", phase: "VERIFY", handler: inquiry },

  { gatewayCodes: ["sadad"], method: "POST", path: "/verify", phase: "INITIATE", handler: otpInitiate },
  { gatewayCodes: ["sadad"], method: "POST", path: "/confirm", phase: "SUBMIT", handler: otpConfirm },
  { gatewayCodes: ["sadad"], method: "GET", path: "/status/:ref", phase: "VERIFY", handler: inquiry },

  { gatewayCodes: ["mobicash"], method: "POST", path: "/open", phase: "INITIATE", handler: otpInitiate },
  { gatewayCodes: ["mobicash"], method: "POST", path: "/confirm", phase: "SUBMIT", handler: otpConfirm },
  { gatewayCodes: ["mobicash"], method: "POST", path: "/qr", phase: "INITIATE", handler: asyncInitiate },
  { gatewayCodes: ["mobicash"], method: "GET", path: "/status/:ref", phase: "VERIFY", handler: inquiry },
];
