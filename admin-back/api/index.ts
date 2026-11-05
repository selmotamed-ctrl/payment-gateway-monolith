import express from "express";
import { cookieSession } from "../lib/security/sessionCookie";
import { protectedRouter } from "./protected";
import { adminAuthRouter } from "./public";

const router = express.Router();

router.use(cookieSession);
router.use("/auth", adminAuthRouter);
router.use("/", protectedRouter);

export const apiRouter = router;
