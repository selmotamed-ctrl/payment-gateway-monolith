import type { NextFunction, Request, Response } from "express";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
import { isInCidrList, parseCidrList, resolveClientIp } from "../../lib/net";

const LOOPBACK_CIDRS = ["127.0.0.1/32", "::1/128"];

/**
 * Peers whose forwarded headers are trusted.
 *
 * The shipped nginx (`design/deploy/nginx-lan-admin.conf`) proxies the back office from
 * the loopback interface and sets `X-Real-IP` (not `X-Real-Client-IP`), so both header
 * names have to be honoured. Forwarded headers are only accepted when the immediate peer
 * is a loopback address or an explicitly configured trusted proxy.
 */
const trustedProxyCidrs = (): string[] => [
  ...new Set([...LOOPBACK_CIDRS, ...parseCidrList(env.TRUSTED_PROXY_CIDRS)]),
];

export const resolveLanClientIp = (req: Request): string =>
  resolveClientIp(req, trustedProxyCidrs());

export const enforceLanAccess = (req: Request, _res: Response, next: NextFunction) => {
  const cidrs = parseCidrList(env.ADMIN_LAN_CIDRS);
  const ip = resolveLanClientIp(req);
  if (!isInCidrList(cidrs, ip)) {
    throw new ApiError(403, "ADMIN_LAN_ONLY", "The admin back office is reachable from the private LAN only", {
      clientIp: ip,
    });
  }
  next();
};
