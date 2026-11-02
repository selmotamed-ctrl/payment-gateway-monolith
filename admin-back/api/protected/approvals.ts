import express, { type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../../lib/env";
import { parseOrThrow } from "../../lib/error";
import { callCoreResponse } from "../../lib/mtlsClient";
import { parseCidrList, resolveClientIp } from "../../lib/net";
import { resolveRequestId } from "../../lib/requestLogger";
import { zIdentifier, zPaginationQuery, zReason } from "../../lib/zReady";
import { toCoreApprovalApprove, toCoreApprovalReject } from "../contract";
import { coreForward } from "../forward";

const router = express.Router();

const idParamsSchema = z.object({ id: zIdentifier });

export const decisionSchema = z
  .object({
    reason: zReason,
    checkerUserId: zIdentifier.optional(),
    baseVersion: z.number().int().min(1).optional(),
    comment: z.string().max(2000).optional(),
    /** The checker's decision on a chargeback: core executes the adjustment with it. */
    outcome: z.enum(["WON", "LOST"]).optional(),
    riskAcceptanceNote: z.string().max(2000).optional(),
    checklist: z
      .array(
        z.enum([
          "DIFF_REVIEWED",
          "SUBJECT_CONTEXT_REVIEWED",
          "MAKER_CHECKER_SEPARATION_VERIFIED",
          "RISK_ASSESSED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

router.get(
  "/",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/approvals",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/approvals/export",
    querySchema: zPaginationQuery,
  }),
);

router.get(
  "/summary",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/approvals/summary",
  }),
);

export const bulkRejectSchema = z
  .object({
    approvalIds: z.array(zIdentifier).min(1).max(50),
    reason: zReason,
    checklist: z
      .array(
        z.enum([
          "SELECTION_REVIEWED",
          "REASONS_DOCUMENTED",
          "MAKER_NOTIFICATION_PLANNED",
          "CHECKER_AUTHORITY_CONFIRMED",
        ]),
      )
      .max(10)
      .optional(),
  })
  .strict();

router.post(
  "/bulk-reject",
  async (req: Request, res: Response): Promise<void> => {
    const body = parseOrThrow(bulkRejectSchema, req.body ?? {});
    const results: Array<Record<string, unknown>> = [];
    let rejected = 0;
    let failed = 0;
    for (const approvalId of body.approvalIds) {
      try {
        const response = await callCoreResponse({
          method: "POST",
          path: `/internal/admin/approvals/${encodeURIComponent(approvalId)}/reject`,
          body: toCoreApprovalReject({ reason: body.reason, checklist: body.checklist }),
          requestId: resolveRequestId(req),
          clientIp: resolveClientIp(req, parseCidrList(env.TRUSTED_PROXY_CIDRS)),
          userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
          authorization: req.headers.authorization,
        });
        const payload = (response.body ?? {}) as Record<string, unknown>;
        if (response.status >= 200 && response.status < 300) {
          rejected += 1;
          results.push({ approvalId, status: "REJECTED", state: payload.state ?? "REJECTED" });
        } else {
          failed += 1;
          results.push({
            approvalId,
            status: "FAILED",
            httpStatus: response.status,
            code: payload.code ?? null,
            message: payload.message ?? null,
          });
        }
      } catch (error) {
        failed += 1;
        results.push({ approvalId, status: "FAILED", message: (error as Error).message });
      }
    }
    res.status(200).json({ requested: body.approvalIds.length, rejected, failed, results });
  },
);

router.get(
  "/summary/export",
  coreForward({
    method: "GET",
    path: () => "/internal/admin/approvals/summary/export",
  }),
);

router.get(
  "/:id",
  coreForward({
    method: "GET",
    path: (context) => `/internal/admin/approvals/${encodeURIComponent(context.params.id ?? "")}`,
    paramsSchema: idParamsSchema,
  }),
);

router.post(
  "/:id/approve",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/approvals/${encodeURIComponent(context.params.id ?? "")}/approve`,
    paramsSchema: idParamsSchema,
    schema: decisionSchema,
    bodyFrom: (_req, body) => toCoreApprovalApprove(body),
    // An adjustment approval is executed by a queued job (`202 Accepted`),
    // every other subject is executed inline (`200 OK`). The edge relays the
    // status that core answered.
    relayStatus: true,
  }),
);

router.post(
  "/:id/reject",
  coreForward({
    method: "POST",
    path: (context) => `/internal/admin/approvals/${encodeURIComponent(context.params.id ?? "")}/reject`,
    paramsSchema: idParamsSchema,
    schema: decisionSchema,
    bodyFrom: (_req, body) => toCoreApprovalReject(body),
  }),
);

export const approvalsRouter = router;
