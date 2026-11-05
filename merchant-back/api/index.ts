import express from "express";
import { cookieSession, requireMerchantAudience } from "../lib/security/sessionCookie";
import { externalRouter } from "./external";
import { protectedRouter } from "./protected";
import { authRouter, onboardingRouter } from "./public";

const router = express.Router();

router.use(cookieSession);
router.use(requireMerchantAudience);
router.use("/merchant/auth", authRouter);
router.use("/merchant/onboarding", onboardingRouter);
router.use("/merchant", protectedRouter);
router.use("/external", externalRouter);

export const apiRouter = router;
