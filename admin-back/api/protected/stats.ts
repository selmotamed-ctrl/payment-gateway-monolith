import express from "express";
import { coreForward } from "../forward";

const router = express.Router();

router.get(
  "/overview",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/stats/overview",
  }),
);

export const statsRouter = router;
