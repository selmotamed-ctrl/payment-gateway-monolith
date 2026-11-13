import express from "express";
import {
  adminInternalRouter,
  checkoutInternalRouter,
  merchantInternalRouter,
  sandboxInternalRouter,
} from "./internal";
import { requireEdgeIdentity } from "./middleware/mtlsGuard";
import { publicRouter } from "./public";

const router = express.Router();
router.use("/public", publicRouter);

export const internalRouter = express.Router();
internalRouter.use("/admin", requireEdgeIdentity("admin-back"), adminInternalRouter);
internalRouter.use("/merchant", requireEdgeIdentity("merchant-back"), merchantInternalRouter);
internalRouter.use("/checkout", requireEdgeIdentity("checkout-back"), checkoutInternalRouter);
// v38: the Sandbox Studio control plane is reachable from the merchant and
// admin edges only. The process-level SANDBOX guard is inside the router.
internalRouter.use("/sandbox", requireEdgeIdentity(["merchant-back", "admin-back"]), sandboxInternalRouter);

export const apiRouter = router;
