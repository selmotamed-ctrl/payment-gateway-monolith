import express from "express";
import { z } from "zod";
import { zListQuery, zUuid } from "../../lib/zReady";
import { coreForward } from "../forward";
import { encode } from "./mutationSchemas";

const transactionsRouter = express.Router();
const inboundEventsRouter = express.Router();

transactionsRouter.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/transactions",
    querySchema: zListQuery,
  }),
);

transactionsRouter.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/transactions/summary",
    querySchema: zListQuery,
  }),
);

inboundEventsRouter.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/inbound-events",
    querySchema: zListQuery,
  }),
);

inboundEventsRouter.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/inbound-events/${encode(context.params.id)}`,
    paramsSchema: z.object({ id: zUuid }).strict(),
  }),
);

export { transactionsRouter, inboundEventsRouter };
