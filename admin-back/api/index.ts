import express from "express";
import { protectedRouter } from "./protected";
import { adminAuthRouter } from "./public";

const router = express.Router();

router.use("/auth", adminAuthRouter);
router.use("/", protectedRouter);

export const apiRouter = router;
