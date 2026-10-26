import type { NextFunction, Request, Response } from "express";
import type { TLSSocket } from "node:tls";
import { ApiError } from "../../lib/error";

export type AllowedEdgeCN = "admin-back" | "merchant-back" | "checkout-back";

export const getPeerCommonName = (socket: TLSSocket): string | undefined => {
  if (typeof socket.getPeerCertificate !== "function") {
    return undefined;
  }
  const certificate = socket.getPeerCertificate();
  const commonName = certificate?.subject?.CN;
  if (Array.isArray(commonName)) {
    return commonName[0];
  }
  return commonName;
};

export const requireEdgeIdentity = (expectedCn: AllowedEdgeCN) => {
  return (request: Request, _response: Response, next: NextFunction) => {
    const socket = request.socket as TLSSocket;
    if (!socket.authorized) {
      throw new ApiError(
        401,
        "MTLS_UNAUTHORIZED",
        "Client certificate not authorized by internal CA",
      );
    }

    const clientCn = getPeerCommonName(socket);
    if (!clientCn) {
      throw new ApiError(
        401,
        "MTLS_UNAUTHORIZED",
        "Client certificate could not be inspected",
      );
    }

    if (clientCn !== expectedCn) {
      throw new ApiError(
        403,
        "FORBIDDEN_SERVICE_IDENTITY",
        `Certificate CN '${clientCn}' is not permitted on ${expectedCn} channel`,
      );
    }

    next();
  };
};
