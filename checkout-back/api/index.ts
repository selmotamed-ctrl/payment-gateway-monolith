import express from "express";
import { inboundRouter, payRouter, returnRouter } from "./public";

const router = express.Router();

router.use("/pay", payRouter);
router.use("/return", returnRouter);

export { inboundRouter };
export const apiRouter = router;
