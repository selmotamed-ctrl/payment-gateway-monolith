import type { Request } from "express";
import { sandboxCoreBackUrls } from "./env";
import { ApiError } from "./error";

/** The plane an edge call targets. `SANDBOX` never falls back to the Live pool. */
export type CorePlane = "LIVE" | "SANDBOX";

export const sandboxTokenPrefix = "pg_test_";
export const liveTokenPrefix = "pg_live_";

export const bearerOf = (request: Request): string => {
  const header = request.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : "";
};

export const requestPlane = (request: Request): CorePlane =>
  bearerOf(request).startsWith(sandboxTokenPrefix) ? "SANDBOX" : "LIVE";

export const requireSandboxCoreBackUrls = (): string[] => {
  const urls = sandboxCoreBackUrls();
  if (!urls || urls.length === 0) {
    throw new ApiError(
      503,
      "SANDBOX_NODE_UNAVAILABLE",
      "The Sandbox environment is not configured on this gateway",
    );
  }
  return urls;
};

/** The explicit pool of a request: Sandbox for a `pg_test_` token or the sandbox namespace, otherwise Live. */
export const targetUrlsForRequest = (request: Request): string[] | undefined =>
  requestPlane(request) === "SANDBOX" ? requireSandboxCoreBackUrls() : undefined;
