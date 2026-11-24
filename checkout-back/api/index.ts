import express from "express";
import { certificateRouter, inboundRouter, payRouter, returnRouter } from "./public";

const router = express.Router();

router.use("/pay", payRouter);
router.use("/return", returnRouter);
router.use("/verify", certificateRouter);

export { inboundRouter };
export const apiRouter = router;
