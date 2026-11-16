import type { PrismaLike } from "../db/ports";
import type { RouteHealthProbeMethod, RouteHealthProbeStatus } from "./types";

export interface CredentialCheckPort {
  verify(
    credentialSetId: string,
    options?: { gatewayVersionId?: string; persist?: boolean },
  ): Promise<{ status: string; method: "FLOW" | "PROBE"; reason?: string; httpStatus?: number }>;
}

export interface RouteHealthProbeResult {
  routeId: string;
  credentialSetId: string | null;
  gatewayVersionId: string | null;
  method: RouteHealthProbeMethod;
  status: RouteHealthProbeStatus;
  reason: string | null;
  httpStatus: number | null;
  latencyMs: number;
}

/**
 * A route-health probe is read-only and never records a credential-set
 * verdict. It reuses the declared CREDENTIAL_CHECK flow when present and
 * otherwise the authenticated base-URL probe. A route that requires a
 * merchant-owned credential has no platform probe and is left to a person.
 */
export class RouteHealthProbeService {
  constructor(
    private readonly db: PrismaLike,
    private readonly credentialCheck: CredentialCheckPort | null,
    private readonly env: "LIVE" | "SANDBOX" = "LIVE",
  ) {}

  async probe(routeId: string, now = new Date()): Promise<RouteHealthProbeResult> {
    const started = Date.now();
    const route = (await this.db.railRoute.findUnique({
      where: { id: routeId },
      select: { id: true, gatewayId: true, credentialPolicy: true },
    })) as { id: string; gatewayId: string; credentialPolicy: string } | null;
    if (!route) {
      return {
        routeId,
        credentialSetId: null,
        gatewayVersionId: null,
        method: "NONE",
        status: "SKIPPED",
        reason: "ROUTE_NOT_FOUND",
        httpStatus: null,
        latencyMs: Date.now() - started,
      };
    }
    if (!this.credentialCheck) {
      return this.result(routeId, null, null, "NONE", "SKIPPED", "PROBE_NOT_CONFIGURED", null, started);
    }
    if (route.credentialPolicy === "MERCHANT_REQUIRED") {
      return this.result(routeId, null, null, "NONE", "SKIPPED", "MERCHANT_CREDENTIAL_REQUIRED", null, started);
    }

    const credentialSet = (await this.db.credentialSet.findFirst({
      where: {
        gatewayId: route.gatewayId,
        env: this.env,
        status: "VERIFIED",
        ownerType: "PLATFORM",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ lastVerifiedAt: "desc" }, { updatedAt: "desc" }],
      select: { id: true, gatewayId: true },
    })) as { id: string } | null;

    if (!credentialSet) {
      return this.result(routeId, null, null, "NONE", "SKIPPED", "NO_VERIFIED_CREDENTIAL", null, started);
    }

    const gateway = (await this.db.gateway.findUnique({
      where: { id: route.gatewayId },
      select: { activeVersionId: true },
    })) as { activeVersionId: string | null } | null;

    try {
      const verdict = await this.credentialCheck.verify(String(credentialSet.id), {
        ...(gateway?.activeVersionId ? { gatewayVersionId: gateway.activeVersionId } : {}),
        persist: false,
      });
      return this.result(
        routeId,
        String(credentialSet.id),
        gateway?.activeVersionId ?? null,
        verdict.method === "FLOW" ? "CREDENTIAL_CHECK" : "BASE_URL",
        verdict.status === "VERIFIED" ? "PASSED" : "FAILED",
        verdict.reason ?? null,
        verdict.httpStatus ?? null,
        started,
      );
    } catch (error) {
      return this.result(
        routeId,
        String(credentialSet.id),
        gateway?.activeVersionId ?? null,
        "BASE_URL",
        "FAILED",
        error instanceof Error ? error.message : "PROBE_FAILED",
        null,
        started,
      );
    }
  }

  private result(
    routeId: string,
    credentialSetId: string | null,
    gatewayVersionId: string | null,
    method: RouteHealthProbeMethod,
    status: RouteHealthProbeStatus,
    reason: string | null,
    httpStatus: number | null,
    started: number,
  ): RouteHealthProbeResult {
    return {
      routeId,
      credentialSetId,
      gatewayVersionId,
      method,
      status,
      reason: reason && reason.length > 1000 ? `${reason.slice(0, 997)}...` : reason,
      httpStatus,
      latencyMs: Date.now() - started,
    };
  }
}
