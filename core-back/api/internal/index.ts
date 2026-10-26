import express from "express";
import { adminInternalRouter } from "./admin";
import { checkoutInternalRouter } from "./checkout";
import { merchantInternalRouter } from "./merchant";

const createInternalRouter = (channel: "admin" | "merchant" | "checkout") => {
  const router = express.Router();
  router.get("/health", (_request, response) => {
    response.json({ status: "ok", channel });
  });
  return router;
};

export { adminInternalRouter, checkoutInternalRouter, merchantInternalRouter };
export const internalRouter = express.Router();
