import { Router, type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
import { createAccountsRouter } from "../portal/accounts";
import { createScenariosRouter } from "../portal/scenarios";
import { createStatementsRouter } from "../portal/statements";
import { createTransactionsRouter } from "../portal/transactions";
import { createWebhooksRouter } from "../portal/webhooks";

const constantTimeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const controlGuard = (request: Request, _response: Response, next: NextFunction): void => {
  const expected = String(process.env.FAKE_RAILS_CONTROL_TOKEN ?? "").trim();
  if (expected.length === 0) {
    if (env.NODE_ENV === "production") {
      next(
        new ApiError(
          503,
          "FAKE_RAILS_CONTROL_DISABLED",
          "The Fake Rails control plane requires FAKE_RAILS_CONTROL_TOKEN in production",
        ),
      );
      return;
    }
    next();
    return;
  }
  const supplied = String(request.header("x-fake-rails-control-token") ?? "").trim();
  if (supplied.length === 0 || !constantTimeEquals(supplied, expected)) {
    next(new ApiError(401, "FAKE_RAILS_CONTROL_UNAUTHORIZED", "A valid control token is required"));
    return;
  }
  next();
};

/**
 * The control plane used by `pg-core-sandbox` for the Sandbox Studio and the
 * checkout inspector. It deliberately shares the account routes with the
 * tester portal but is NOT behind the portal JWT: the caller is another
 * service. A shared token (when configured) is required.
 */
export const createControlRouter = (): Router => {
  const router = Router();
  router.use(controlGuard);
  // The control plane is a service-to-service surface for pg-core-sandbox. It
  // exposes the same tester features without requiring a second interactive
  // login; the caller identity is the control token.
  router.use((request, _response, next) => {
    if (!request.tester) {
      request.tester = { sub: "sandbox-control", role: "FAKE_RAILS_TESTER", channel: null, exp: null, iat: null } as never;
    }
    next();
  });
  router.use(createAccountsRouter());
  router.use("/transactions", createTransactionsRouter());
  router.use("/scenarios", createScenariosRouter());
  router.use("/webhooks", createWebhooksRouter());
  router.use("/statements", createStatementsRouter());
  return router;
};
