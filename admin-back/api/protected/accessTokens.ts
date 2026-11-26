import express from "express";
import { zListQuery } from "../../lib/zReady";
import { coreForward } from "../forward";

const accessTokensRouter = express.Router();

/**
 * Platform-wide API-token oversight. Tokens belong to one application; the
 * admin can read every token (including its IP allowlist) and revoke one, but
 * only the merchant can create tokens or change their allowlist.
 */
accessTokensRouter.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/access-tokens",
    querySchema: zListQuery,
  }),
);

accessTokensRouter.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/access-tokens/summary",
    querySchema: zListQuery,
  }),
);

export { accessTokensRouter };
