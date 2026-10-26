import express from "express";
import {
  adminInternalRouter,
  checkoutInternalRouter,
  merchantInternalRouter,
} from "./internal";
import { requireEdgeIdentity } from "./middleware/mtlsGuard";
import { publicRouter } from "./public";

const router = express.Router();
router.use("/public", publicRouter);

export const internalRouter = express.Router();
internalRouter.use("/admin", requireEdgeIdentity("admin-back"), adminInternalRouter);
internalRouter.use("/merchant", requireEdgeIdentity("merchant-back"), merchantInternalRouter);
internalRouter.use("/checkout", requireEdgeIdentity("checkout-back"), checkoutInternalRouter);

export const apiRouter = router;
