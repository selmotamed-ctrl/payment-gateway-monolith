import type { SeederContext } from "../context";
import { addDays, between, sha256Like } from "../builders";
import { IN_FLIGHT_STATUSES, SETTLED_STATUSES } from "../lifecycle";

const fakeRailsBase = (): string => process.env.FAKE_RAILS_PUBLIC_BASE_URL ?? "http://127.0.0.1:8444";
const fakeRailsHosts = (): string[] => (process.env.FAKE_RAILS_ALLOWED_HOSTS ?? "127.0.0.1")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

/** Gateway versions created by this generator that wait for a checker (bound to approvals in 08). */
export const pendingVersionIds = new WeakMap<SeederContext, string[]>();
/** Rolled-back versions: they went live through an executed approval before the rollback. */
export const rolledBackVersionIds = new WeakMap<SeederContext, string[]>();

/**
 * Gateway version history around the ACTIVE baseline version.
 *
 * The blueprint seed owns version 1 of every gateway, which is LIVE and is
 * `gateways.active_version_id`; every attempt pins it. The history therefore
 * only adds LATER versions that are not live: a rolled-back promotion
 * (`rollback_version_id` = the active version), a sandbox-verified or draft
 * revision and, for two gateways, a revision waiting for a checker. The old
 * generator added `SUPERSEDED` v2 and a second `LIVE` v3 next to the active
 * v1, which no lifecycle can produce, and duplicated the baseline webhook
 * channels of every version.
 */
export const generateGatewayLifecycle = (ctx: SeederContext): void => {
  const start = ctx.timeline.start;
  const end = ctx.timeline.end;
  const makers = ctx.dataset.users.filter((user) => user.merchantId === null && user.status === "ACTIVE" && user.role === "GATEWAY_ADMIN");
  const maker = makers[0]?.id ?? ctx.refs.adminUsers.find((user) => user.role === "GATEWAY_ADMIN")?.id;
  if (!maker) throw new Error("No GATEWAY_ADMIN available to author gateway versions");
  const pending: string[] = [];
  const rolledBack: string[] = [];

  let gatewayIndex = 0;
  for (const gateway of ctx.refs.gateways) {
    gatewayIndex += 1;
    const versions = ctx.refs.versions.filter((version) => version.gatewayId === gateway.id);
    const active = versions.find((version) => version.id === gateway.activeVersionId)
      ?? versions.find((version) => version.state === "LIVE")
      ?? versions[0];
    if (!active) continue;
    const highest = Math.max(0, ...versions.map((version) => version.versionNumber ?? 1));
    const baseUrl = `${fakeRailsBase().replace(/\/$/, "")}/rails/${gateway.code}`;
    const plan: Array<{ state: string; createdAt: Date; note: string }> = [];
    if (gatewayIndex % 3 !== 0) {
      plan.push({
        state: "ROLLED_BACK",
        createdAt: between(ctx, addDays(start, 120), addDays(end, -200)),
        note: "Promoted, then rolled back to the active version after a timeout spike.",
      });
    }
    plan.push({
      state: gatewayIndex % 2 === 0 ? "SANDBOX_VERIFIED" : "DRAFT",
      createdAt: between(ctx, addDays(end, -150), addDays(end, -20)),
      note: "Revision in sandbox verification.",
    });
    if (gatewayIndex <= 2) {
      plan.push({
        state: "PENDING_APPROVAL",
        createdAt: between(ctx, addDays(end, -12), addDays(end, -1)),
        note: "Sandbox-verified revision waiting for a checker.",
      });
    }
    plan.forEach((entry, offset) => {
      const versionNumber = highest + offset + 1;
      const versionId = ctx.nextId("gateway-version");
      ctx.dataset.gatewayVersions.push({
        id: versionId,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        gatewayId: gateway.id,
        versionNumber,
        snapshotCiphertext: JSON.stringify({ gateway: gateway.code, version: versionNumber, synthetic: true }),
        contentHash: sha256Like(ctx, `version:${gateway.id}:${versionNumber}`),
        state: entry.state,
        createdById: maker,
        approvalRequestId: null,
        changeNote: entry.note,
        rollbackVersionId: entry.state === "ROLLED_BACK" ? active.id : null,
      });
      if (entry.state === "PENDING_APPROVAL") pending.push(versionId);
      if (entry.state === "ROLLED_BACK") rolledBack.push(versionId);
      for (const env of ["SANDBOX", "LIVE"]) {
        ctx.dataset.gatewayEnvironments.push({
          id: ctx.nextId("gateway-env"),
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
          gatewayVersionId: versionId,
          env,
          baseUrls: { api: baseUrl },
          allowedHosts: [...new Set([new URL(baseUrl).hostname, ...fakeRailsHosts()])],
          inboundIpAllowlist: ["127.0.0.1/32"],
          outboundEgressIps: [],
          enabled: env === "SANDBOX" || entry.state !== "DRAFT",
        });
        ctx.dataset.gatewayAuths.push({
          id: ctx.nextId("gateway-auth"),
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
          gatewayVersionId: versionId,
          env,
          method: "API_KEY",
          authApply: "HEADER",
          refreshConfigJson: null,
        });
      }
      ctx.dataset.gatewaySettings.push({
        id: ctx.nextId("gateway-setting"),
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        gatewayVersionId: versionId,
        amountScale: gateway.code === "moamalat" || gateway.code === "ly_pay" || gateway.code === "neompay" ? 1000 : 100,
        amountPrecision: gateway.code === "moamalat" ? 0 : gateway.code === "ly_pay" || gateway.code === "neompay" ? 3 : 2,
        amountRounding: "NEAREST",
        amountFormat: gateway.code === "moamalat" ? "INTEGER_MINOR" : "STRING_DECIMAL",
        referenceFormat: { prefix: "PA", template: "{attempt.reference}" },
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
      if (entry.state === "ROLLED_BACK" || entry.state === "PENDING_APPROVAL" || entry.state === "SANDBOX_VERIFIED") {
        ctx.dataset.gatewayVersionEvidence.push({
          id: ctx.nextId("gateway-evidence"),
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
          gatewayVersionId: versionId,
          evidenceJson: {
            gates: Array.from({ length: 12 }, (_, index) => ({ gate: index + 1, passed: true })),
            sandboxSuite: { total: 15, passed: 15 },
          },
          ranAt: entry.createdAt,
        });
      }
    });
  }
  pendingVersionIds.set(ctx, pending);
  rolledBackVersionIds.set(ctx, rolledBack);

  // A webhook channel only for a baseline version that has none: inbound
  // evidence must FK-link to a channel, and the baseline `seedFakeRails` step
  // already owns `<gateway>-webhook` for most versions.
  const existingChannels = ctx.refs.confirmationChannels ?? [];
  for (const version of ctx.refs.versions) {
    if (existingChannels.some((channel) => channel.gatewayVersionId === version.id && channel.type === "WEBHOOK")) continue;
    const route = ctx.refs.routes.find((candidate) => candidate.gatewayId === version.gatewayId);
    const id = ctx.nextId("confirmation-channel");
    ctx.dataset.confirmationChannels.push({
      id,
      createdAt: start,
      updatedAt: start,
      gatewayVersionId: version.id,
      routeId: route?.id ?? null,
      type: "WEBHOOK",
      pathToken: `synth-${ctx.config.namespace}-${version.id}-webhook`,
      cryptoProfileId: null,
      verifyMethod: "HMAC_BODY",
      signatureHeader: "x-fake-rails-signature",
      timestampSelector: "timestamp",
      timestampToleranceSec: 300,
      ipAllowlist: ["127.0.0.1/32"],
      bodyFormat: "JSON",
      correlationSelector: "our_reference",
      dedupeKeySelector: "event_id",
      eventMap: { PAID: "SUCCEEDED", FAILED: "FAILED", EXPIRED: "EXPIRED", REFUNDED: "REFUNDED", DISPUTED: "DISPUTED" },
      mustInquire: false,
      ackStatus: 200,
      ackBodyTemplate: "{\"ok\":true}",
    });
  }

  // A T+1 statement source for every gateway that has none.
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
      parserConfig: { format: "CSV", columns: ["provider_reference", "our_reference", "amount", "fee", "currency", "status", "settled_at"], supports_batch_net: true },
      settlementLagDays: 1,
      dedupeKeyTemplate: "{provider_reference}",
    });
    ctx.refs.statementSources.push({ id: sourceId, gatewayId: gateway.id, gatewayCode: gateway.code, settlementLagDays: 1, parserConfig: { supports_batch_net: true } });
  }
};

/**
 * Route health samples for the last 30 days, DERIVED from the generated
 * attempts (successes, definitive failures, ambiguous unknowns per route and
 * hour). Runs after generator 04. The previous samples were independent
 * random numbers that contradicted the attempts on the same routes.
 */
export const generateRouteHealth = (ctx: SeederContext): void => {
  const end = ctx.timeline.end;
  const windowStart = new Date(end.getTime() - 30 * 86_400_000);
  windowStart.setUTCMinutes(0, 0, 0);
  const buckets = new Map<string, { successes: number; failures: number; unknowns: number; durations: number[] }>();
  const durations = new Map<string, number[]>();
  for (const log of ctx.dataset.attemptStepLogs) {
    const list = durations.get(String(log.attemptId)) ?? [];
    if (typeof log.durationMs === "number") list.push(log.durationMs);
    durations.set(String(log.attemptId), list);
  }
  for (const attempt of ctx.dataset.paymentAttempts) {
    const at = new Date(attempt.terminalAt ?? attempt.createdAt).getTime();
    if (at < windowStart.getTime()) continue;
    const hour = Math.floor((at - windowStart.getTime()) / 3_600_000);
    const key = `${attempt.routeId}:${hour}`;
    const bucket = buckets.get(key) ?? { successes: 0, failures: 0, unknowns: 0, durations: [] };
    const status = String(attempt.status);
    if (SETTLED_STATUSES.has(status)) bucket.successes += 1;
    else if (status === "FAILED") bucket.failures += 1;
    else if (status === "UNKNOWN") bucket.unknowns += 1;
    else if (IN_FLIGHT_STATUSES.has(status)) continue;
    bucket.durations.push(...(durations.get(String(attempt.id)) ?? []));
    buckets.set(key, bucket);
  }
  const percentile = (values: number[], p: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  };
  for (const route of ctx.refs.routes) {
    for (let hour = 0; hour < 30 * 24; hour += 1) {
      const sampleAt = new Date(windowStart.getTime() + hour * 3_600_000);
      if (sampleAt > end) break;
      const bucket = buckets.get(`${route.id}:${hour}`);
      if (!bucket) continue;
      ctx.dataset.gatewayHealthSamples.push({
        id: ctx.nextId("health"),
        createdAt: sampleAt,
        updatedAt: sampleAt,
        routeId: route.id,
        windowStart: sampleAt,
        definitiveFailures: bucket.failures,
        ambiguousUnknowns: bucket.unknowns,
        rateLimits429: 0,
        successes: bucket.successes,
        p50Ms: percentile(bucket.durations, 0.5),
        p95Ms: percentile(bucket.durations, 0.95),
        p99Ms: percentile(bucket.durations, 0.99),
      });
    }
  }
};
