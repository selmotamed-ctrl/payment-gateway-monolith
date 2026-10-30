/**
 * Suite 05.1 — mTLS channel binding matrix.
 *
 * The real `requireEdgeIdentity` middleware is driven with sockets that model
 * the internal CA decisions, every edge common name, and an unexpected CN.
 */
import { describe, expect, test } from "bun:test";
import type { NextFunction, Request, Response } from "express";
import type { TLSSocket } from "node:tls";
import {
  getPeerCommonName,
  requireEdgeIdentity,
  type AllowedEdgeCN,
} from "../../../api/middleware/mtlsGuard";
import { errorCode, errorStatus } from "../_harness";

const CHANNELS: AllowedEdgeCN[] = ["admin-back", "merchant-back", "checkout-back"];
const IDENTITIES = [
  "admin-back",
  "merchant-back",
  "checkout-back",
  "unknown-back",
] as const;

const fakeRequest = (options: {
  authorized: boolean;
  commonName?: string | string[];
  certificate?: boolean;
}): Request => {
  const socket = {
    authorized: options.authorized,
    getPeerCertificate: () => {
      if (options.certificate === false) {
        return {};
      }
      return { subject: { CN: options.commonName } };
    },
  } as unknown as TLSSocket;
  return { socket } as unknown as Request;
};

const run = (middleware: ReturnType<typeof requireEdgeIdentity>, request: Request) => {
  let nextCalled = false;
  try {
    middleware(request, {} as Response, (() => {
      nextCalled = true;
    }) as NextFunction);
    return { nextCalled, error: undefined as unknown };
  } catch (error) {
    return { nextCalled, error };
  }
};

describe("Suite 05 · mTLS channel binding", () => {
  for (const channel of CHANNELS) {
    for (const identity of IDENTITIES) {
      test(`${channel} channel with CN=${identity} ${identity === channel ? "passes" : "is refused"}`, () => {
        const request = fakeRequest({ authorized: true, commonName: identity });
        const outcome = run(requireEdgeIdentity(channel), request);
        if (identity === channel) {
          expect(outcome.nextCalled).toBe(true);
          expect(outcome.error).toBeUndefined();
        } else {
          expect(outcome.nextCalled).toBe(false);
          expect(errorCode(outcome.error)).toBe("FORBIDDEN_SERVICE_IDENTITY");
          expect(errorStatus(outcome.error)).toBe(403);
        }
      });
    }

    test(`${channel} channel refuses an unauthorized certificate`, () => {
      const outcome = run(
        requireEdgeIdentity(channel),
        fakeRequest({ authorized: false, commonName: channel }),
      );
      expect(errorCode(outcome.error)).toBe("MTLS_UNAUTHORIZED");
      expect(errorStatus(outcome.error)).toBe(401);
    });

    test(`${channel} channel refuses a missing certificate`, () => {
      const outcome = run(
        requireEdgeIdentity(channel),
        fakeRequest({ authorized: true, certificate: false }),
      );
      expect(errorCode(outcome.error)).toBe("MTLS_UNAUTHORIZED");
    });

    test(`${channel} channel refuses an empty CN`, () => {
      const outcome = run(
        requireEdgeIdentity(channel),
        fakeRequest({ authorized: true, commonName: "" }),
      );
      expect(errorCode(outcome.error)).toBe("MTLS_UNAUTHORIZED");
    });
  }

  test("getPeerCommonName reads a scalar CN", () => {
    expect(getPeerCommonName({ getPeerCertificate: () => ({ subject: { CN: "admin-back" } }) } as never)).toBe("admin-back");
  });

  test("getPeerCommonName reads the first CN of an array", () => {
    expect(
      getPeerCommonName({ getPeerCertificate: () => ({ subject: { CN: ["merchant-back", "other"] } }) } as never),
    ).toBe("merchant-back");
  });

  test("getPeerCommonName returns undefined when the socket cannot inspect the certificate", () => {
    expect(getPeerCommonName({} as never)).toBeUndefined();
  });
});
