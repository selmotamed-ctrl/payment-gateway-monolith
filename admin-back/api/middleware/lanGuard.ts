import type { NextFunction, Request, Response } from "express";
import { env } from "../../lib/env";
import { ApiError } from "../../lib/error";
import { isInCidrList, normalizeIp, parseCidrList, remoteAddressOf } from "../../lib/net";

const LOOPBACK_CIDRS = ["127.0.0.1/32", "::1/128"];

export const resolveLanClientIp = (req: Request): string => {
  const remote = remoteAddressOf(req);
  if (isInCidrList(LOOPBACK_CIDRS, remote)) {
    const forwarded = req.headers["x-real-client-ip"];
    if (typeof forwarded === "string" && forwarded.trim().length > 0) {
      return normalizeIp(forwarded);
    }
  }
  return remote;
};

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
