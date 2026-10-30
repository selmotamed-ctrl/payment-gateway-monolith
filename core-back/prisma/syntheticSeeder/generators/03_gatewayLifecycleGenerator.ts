import type { SeederContext } from "../context";
import { addDays, chance, sha256Like } from "../builders";

const FAKE_RAILS_BASE = process.env.FAKE_RAILS_PUBLIC_BASE_URL ?? "http://127.0.0.1:8444";
const FAKE_RAILS_HOSTS = (process.env.FAKE_RAILS_ALLOWED_HOSTS ?? "127.0.0.1")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

/**
 * Version history (SUPERSEDED / ROLLED_BACK / LIVE / PENDING_APPROVAL), go-live
 * evidence, and 30 days of hourly route health samples.
 */
export const generateGatewayLifecycle = (ctx: SeederContext): void => {
  const start = ctx.timeline.start;
  const end = ctx.timeline.end;
  const actor = ctx.refs.adminUsers.find((user) => user.role === "GATEWAY_ADMIN")?.id
    ?? ctx.refs.adminUsers[0]?.id
    ?? ctx.nextId("user");
  const maker = ctx.refs.adminUsers.find((user) => user.role === "GATEWAY_ADMIN")?.id ?? actor;

  let gatewayIndex = 0;
  for (const gateway of ctx.refs.gateways) {
    gatewayIndex += 1;
    const baseUrl = `${FAKE_RAILS_BASE.replace(/\/$/, "")}/rails/${gateway.code}`;
    const versionStates: Array<{ versionNumber: number; state: string; createdAt: Date; note: string }> = [
      { versionNumber: 2, state: "SUPERSEDED", createdAt: addDays(start, 120 + gatewayIndex), note: "Superseded after the 2024 blueprint revision." },
      { versionNumber: 3, state: "LIVE", createdAt: addDays(start, 400 + gatewayIndex), note: "Live production version with complete evidence." },
    ];
    if (gatewayIndex <= 2) {
      versionStates.push({
        versionNumber: 4,
        state: "PENDING_APPROVAL",
        createdAt: addDays(end, -ctx.rng.int(1, 15)),
        note: "Sandbox-verified revision waiting for a checker.",
      });
    }
    for (const version of versionStates) {
      const versionId = ctx.nextId("gateway-version");
      const contentHash = sha256Like(ctx, `version:${gateway.id}:${version.versionNumber}`);
      ctx.dataset.gatewayVersions.push({
        id: versionId,
        createdAt: version.createdAt,
        updatedAt: version.createdAt,
        gatewayId: gateway.id,
        versionNumber: version.versionNumber,
        snapshotCiphertext: JSON.stringify({ gateway: gateway.code, version: version.versionNumber }),
        contentHash,
        state: version.state,
        createdById: maker,
        approvalRequestId: null,
        changeNote: version.note,
        rollbackVersionId: null,
      });
      for (const env of ["SANDBOX", "LIVE"]) {
        ctx.dataset.gatewayEnvironments.push({
          id: ctx.nextId("gateway-env"),
          createdAt: version.createdAt,
          updatedAt: version.createdAt,
          gatewayVersionId: versionId,
          env,
          baseUrls: { api: baseUrl },
          allowedHosts: [...new Set([new URL(baseUrl).hostname, ...FAKE_RAILS_HOSTS])],
          inboundIpAllowlist: ["127.0.0.1/32"],
          outboundEgressIps: [],
          enabled: true,
        });
        ctx.dataset.gatewayAuths.push({
          id: ctx.nextId("gateway-auth"),
          createdAt: version.createdAt,
          updatedAt: version.createdAt,
          gatewayVersionId: versionId,
          env,
          method: "API_KEY",
          authApply: "HEADER",
          refreshConfigJson: null,
        });
      }
      ctx.dataset.gatewaySettings.push({
        id: ctx.nextId("gateway-setting"),
        createdAt: version.createdAt,
        updatedAt: version.createdAt,
        gatewayVersionId: versionId,
        amountScale: 100,
        amountPrecision: 2,
        amountRounding: "NEAREST",
        amountFormat: "STRING_DECIMAL",
        referenceFormat: { prefix: "PG", template: "{attempt.reference}" },
        sessionTtlSeconds: 1200,
        otpTtlSeconds: 300,
        otpResendCooldownSeconds: 60,
        maxOtpAttempts: 3,
        supportsStatusCheck: true,
        statusCheckMinAgeSeconds: 30,
        supportsIdempotencyKey: true,
        supportsCancel: true,
        rateLimitPerSecond: 50,
        concurrencyCap: 200,
        timeoutMs: 15000,
        maxResponseBytes: 2_097_152,
        gatewayTimezone: "Africa/Tripoli",
      });
      if (version.state === "LIVE") {
        ctx.dataset.gatewayVersionEvidence.push({
          id: ctx.nextId("gateway-evidence"),
          createdAt: version.createdAt,
          updatedAt: version.createdAt,
          gatewayVersionId: versionId,
          evidenceJson: {
            gates: Array.from({ length: 12 }, (_, index) => ({ gate: index + 1, passed: true })),
            sandboxSuite: { total: 15, passed: 15 },
          },
          ranAt: version.createdAt,
        });
      }
    }
  }

  // A statement source for every gateway that has none, so the reconciliation
  // generator has real T+N sources to work from.
  for (const gateway of ctx.refs.gateways) {
    if (ctx.refs.statementSources.some((source) => source.gatewayId === gateway.id)) continue;
    const sourceId = ctx.nextId("statement-source");
    ctx.dataset.statementSources.push({
      id: sourceId,
      createdAt: start,
      updatedAt: start,
      gatewayId: gateway.id,
      type: "API",
      scheduleCron: "0 6 * * *",
      parserConfig: { format: "CSV", columns: ["provider_reference", "amount", "fee", "currency", "status"] },
      settlementLagDays: 1,
      dedupeKeyTemplate: "{provider_reference}",
    });
    ctx.refs.statementSources.push({ id: sourceId, gatewayId: gateway.id, gatewayCode: gateway.code });
  }

  // 30 days of hourly health samples per route.
  const sampleStart = addDays(end, -30);
  for (const route of ctx.refs.routes) {
    const degraded = chance(ctx, 8);
    const openBreaker = chance(ctx, 3);
    for (let hour = 0; hour < 30 * 24; hour += 1) {
      const windowStart = new Date(sampleStart.getTime() + hour * 3_600_000);
      if (windowStart > end) break;
      const successes = openBreaker && hour > 30 * 24 - 2 ? 0 : ctx.rng.int(20, 400);
      ctx.dataset.gatewayHealthSamples.push({
        id: ctx.nextId("health"),
        createdAt: windowStart,
        updatedAt: windowStart,
        routeId: route.id,
        windowStart,
        definitiveFailures: openBreaker && hour > 30 * 24 - 2 ? ctx.rng.int(20, 80) : ctx.rng.int(0, 6),
        ambiguousUnknowns: degraded ? ctx.rng.int(2, 20) : ctx.rng.int(0, 2),
        rateLimits429: ctx.rng.chance(5) ? ctx.rng.int(1, 15) : 0,
        successes,
        p50Ms: ctx.rng.int(80, 300) + (degraded ? 400 : 0),
        p95Ms: ctx.rng.int(300, 900) + (degraded ? 1800 : 0),
        p99Ms: ctx.rng.int(900, 2000) + (degraded ? 4000 : 0),
      });
    }
  }
};
