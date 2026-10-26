import express from "express";
import { externalRouter } from "./external";
import { protectedRouter } from "./protected";
import { authRouter, onboardingRouter } from "./public";

const router = express.Router();

router.use("/merchant/auth", authRouter);
router.use("/merchant/onboarding", onboardingRouter);
router.use("/merchant", protectedRouter);
router.use("/external", externalRouter);

export const apiRouter = router;
