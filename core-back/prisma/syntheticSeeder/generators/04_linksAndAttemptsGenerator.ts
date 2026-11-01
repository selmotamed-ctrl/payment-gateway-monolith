import type { SeederContext } from "../context";
import { addDays, addMinutes, amount, sha256Like } from "../builders";
import { businessHour, iterateDays } from "../timelineClock";

const ATTEMPT_STATUS_WEIGHTS = {
  SUCCEEDED: 6800,
  FAILED: 1150,
  EXPIRED: 700,
  CANCELLED: 350,
  BLOCKED: 250,
  REFUNDED: 150,
  PARTIALLY_REFUNDED: 100,
  DISPUTED: 150,
  CREATED: 80,
  INITIATING: 80,
  AWAITING_CUSTOMER: 120,
  AUTHORIZING: 40,
  VERIFYING: 50,
  UNKNOWN: 80,
} as const;

const FEE_BEARERS = { MERCHANT_ABSORBS: 70, PAYER_SURCHARGE: 20, SPLIT: 10 } as const;
const SETTLEMENT_TARGETS = { PLATFORM_CLEARING: 70, MERCHANT_DIRECT: 15, PROVIDER_HELD: 15 } as const;
const FAILURE_CODES = [
  "INSUFFICIENT_FUNDS", "LIMIT_EXCEEDED", "WRONG_OTP", "GATEWAY_FAULT",
  "TIMEOUT", "MALFORMED_RESPONSE", "RATE_LIMITED", "CARD_DECLINED",
];

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "BLOCKED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"]);
const IN_FLIGHT = new Set(["CREATED", "INITIATING", "AWAITING_CUSTOMER", "AUTHORIZING", "VERIFYING", "UNKNOWN"]);

export const generateLinksAndAttempts = (ctx: SeederContext): void => {
  const days = iterateDays(ctx.timeline);
  const cumulative: number[] = [];
  let running = 0;
  for (const day of days) {
    running += day.multiplier;
    cumulative.push(running);
  }
  const sampleDay = (): (typeof days)[number] => {
    const roll = ctx.rng.next() * running;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (cumulative[mid]! < roll) low = mid + 1;
      else high = mid;
    }
    return days[low]!;
  };

  const applications = ctx.dataset.applications.filter((application) => application.status !== "CLOSED");
  if (applications.length === 0) return;
  const walletsById = new Map(ctx.dataset.wallets.map((wallet) => [wallet.id, wallet]));
  const commissionsByMerchant = new Map(ctx.dataset.commissionProfiles.map((profile) => [profile.merchantId, profile.id]));
  const routes = ctx.refs.routes;
  const credentials = ctx.refs.credentials.filter((credential) => credential.ownerType === "PLATFORM");
  if (routes.length === 0 || credentials.length === 0) return;
  const channelsByVersion = new Map<string, any>();
  for (const channel of ctx.dataset.confirmationChannels) {
    if (!channelsByVersion.has(channel.gatewayVersionId)) {
      channelsByVersion.set(channel.gatewayVersionId, channel);
    }
  }
  const channelFor = (versionId: string, _env: string): any | undefined =>
    channelsByVersion.get(versionId);

  // ---------------------------------------------------------------- links
  for (let index = 0; index < ctx.config.volumes.paymentLinks; index += 1) {
    const day = sampleDay();
    const hour = businessHour(ctx.rng);
    const createdAt = new Date(day.date);
    createdAt.setUTCHours(hour, ctx.rng.int(0, 59), ctx.rng.int(0, 59), 0);
    const application = ctx.rng.pick(applications);
    const wallet = walletsById.get(application.assignedWalletId);
    if (!wallet) continue;
    const expiresAt = addMinutes(createdAt, ctx.rng.int(30, 60 * 48));
    const linkId = ctx.nextId("link");
    ctx.dataset.paymentLinks.push({
      id: linkId,
      createdAt,
      updatedAt: createdAt,
      key: `PL-${ctx.config.namespace}-${index.toString(36).padStart(6, "0")}`,
      applicationId: application.id,
      walletId: wallet.id,
      amount: amount(ctx, 5, 2500),
      currency: "LYD",
      feeBearer: ctx.rng.weighted(FEE_BEARERS),
      splitRatioJson: null,
      infiniteUse: ctx.rng.chance(8),
      useCount: ctx.rng.int(1, 3),
      confirmedCount: 0,
      activeLockedCount: 0,
      redirectUrl: ctx.rng.chance(50) ? `https://merchant.${ctx.config.namespace}.ly/thanks` : null,
      railWhitelist: null,
      state: "PENDING",
      expiresAt,
    });
  }

  const links = ctx.dataset.paymentLinks;
  const linkState = new Map<string, { confirmed: number; active: number; expired: boolean; cancelled: boolean }>();

  // -------------------------------------------------------------- attempts
  for (let index = 0; index < ctx.config.volumes.paymentAttempts; index += 1) {
    const link = ctx.rng.pick(links);
    if (!link) break;
    const application = applications.find((candidate) => candidate.id === link.applicationId);
    if (!application) continue;
    const wallet = walletsById.get(link.walletId);
    if (!wallet) continue;

    const day = sampleDay();
    const hour = businessHour(ctx.rng);
    const createdAt = new Date(day.date);
    createdAt.setUTCHours(hour, ctx.rng.int(0, 59), ctx.rng.int(0, 59), 0);
    if (createdAt < link.createdAt) {
      createdAt.setTime(link.createdAt.getTime() + ctx.rng.int(60_000, 86_400_000));
    }
    if (createdAt > ctx.timeline.end) {
      createdAt.setTime(ctx.timeline.end.getTime() - ctx.rng.int(60_000, 3_600_000));
    }

    const status = ctx.rng.weighted(ATTEMPT_STATUS_WEIGHTS);
    const inFlight = IN_FLIGHT.has(status);
    const route = ctx.rng.pick(routes);
    const version = ctx.refs.versions.find((candidate) => candidate.gatewayId === route.gatewayId);
    if (!version) continue;
    const env = ctx.rng.chance(82) ? "LIVE" : "SANDBOX";
    const credential = credentials.find((candidate) => candidate.gatewayId === route.gatewayId && candidate.env === env)
      ?? credentials.find((candidate) => candidate.gatewayId === route.gatewayId)
      ?? credentials[0]!;
    const commissionProfileId = commissionsByMerchant.get(application.merchantId);
    if (!commissionProfileId) continue;

    const requested = Number(link.amount);
    const totalCharged = requested;
    const gatewayFee = Number((totalCharged * (ctx.rng.int(20, 90) / 10_000)).toFixed(4));
    const commission = Number((totalCharged * (ctx.rng.int(50, 250) / 10_000)).toFixed(4));
    const net = Number((totalCharged - gatewayFee - commission).toFixed(4));
    const expiresAt = addMinutes(createdAt, ctx.rng.int(10, 60));
    const graceExpiresAt = addMinutes(expiresAt, ctx.rng.int(5, 120));
    const rawTerminalAt = TERMINAL.has(status) ? addMinutes(createdAt, ctx.rng.int(1, 120)) : null;
    const terminalAt = rawTerminalAt && rawTerminalAt > ctx.timeline.end ? ctx.timeline.end : rawTerminalAt;
    const attemptId = ctx.nextId("attempt");
    const reference = `PG-${ctx.config.namespace.toUpperCase()}-${index.toString(36).padStart(8, "0")}`;
    const groupId = ctx.nextId("attempt-group");
    ctx.dataset.attemptGroups.push({
      id: groupId,
      createdAt,
      updatedAt: createdAt,
      linkId: link.id,
      customerFingerprint: sha256Like(ctx, `fingerprint:${link.id}:${attemptId}`),
      successCount: status === "SUCCEEDED" ? 1 : 0,
    });

    const conflictCandidate = status === "UNKNOWN" && ctx.rng.chance(25);
    const lateSuccessCandidate = status === "EXPIRED" && ctx.rng.chance(20);
    const manualReviewCandidate = status === "VERIFYING" && ctx.rng.chance(18);
    const substatus = conflictCandidate
      ? "CONFLICTING_TRUSTED_SIGNALS"
      : lateSuccessCandidate
        ? "LATE_SUCCESS_PENDING"
        : manualReviewCandidate
          ? "MANUAL_REVIEW"
          : status === "AWAITING_CUSTOMER"
            ? ctx.rng.pick(["OTP_REQUIRED", "REDIRECT_PENDING", "WIDGET_OPEN", "QR_PENDING", "PUSH_PENDING", "CODE_PENDING", "TRANSFER_PENDING"])
            : status === "AUTHORIZING" || status === "VERIFYING"
              ? "AML_HOLD"
              : null;
    const providerReference = ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED", "AUTHORIZING", "VERIFYING", "UNKNOWN", "AWAITING_CUSTOMER", "EXPIRED"].includes(status)
      ? `FK-${route.gatewayCode.toUpperCase()}-${ctx.config.namespace}-${index.toString(36)}`
      : null;
    const otpAttempts = status === "FAILED" && ctx.rng.chance(20) ? 3 : ctx.rng.int(0, 2);

    ctx.dataset.paymentAttempts.push({
      id: attemptId,
      createdAt,
      updatedAt: terminalAt ?? ctx.timeline.end,
      reference,
      idempotencyKey: null,
      linkId: link.id,
      attemptGroupId: groupId,
      applicationId: application.id,
      merchantId: application.merchantId,
      railId: route.railId,
      routeId: route.id,
      credentialSetId: credential.id,
      gatewayVersionId: version.id,
      commissionProfileId,
      env,
      mode: route.railCode,
      subMode: null,
      status,
      substatus,
      gatewayReference: providerReference,
      providerReference,
      networkReference: ["moamalat", "ly_pay", "onepay", "mpgs"].includes(route.railCode)
        ? `NET-${sha256Like(ctx, attemptId).slice(0, 12).toUpperCase()}`
        : null,
      requestedAmount: requested.toFixed(4),
      surchargeAmount: "0.0000",
      totalChargedAmount: totalCharged.toFixed(4),
      gatewayAmountWire: totalCharged.toFixed(2),
      settledAmount: ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED"].includes(status)
        ? totalCharged.toFixed(4)
        : null,
      gatewayFeeAmount: gatewayFee.toFixed(4),
      platformCommissionAmount: commission.toFixed(4),
      netMerchantAmount: net.toFixed(4),
      feeBearer: link.feeBearer,
      settlementTarget: ctx.rng.weighted(SETTLEMENT_TARGETS),
      currency: "LYD",
      customerFieldsMasked: {
        phone: `*******${ctx.rng.int(1000, 9999)}`,
        ip: `203.0.113.${ctx.rng.int(1, 250)}`,
      },
      publicOutputs: { reference },
      contextCiphertext: Buffer.from(`synthetic-context:${attemptId}`).toString("base64"),
      pointOfNoReturn: ["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED", "UNKNOWN"].includes(status),
      otpAttempts,
      lastOtpSentAt: status === "AWAITING_CUSTOMER" ? addMinutes(createdAt, 1) : null,
      clientIp: `203.0.113.${ctx.rng.int(1, 250)}`,
      userAgent: ctx.rng.pick([
        "Mozilla/5.0 (Linux; Android 14) Chrome/126",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Safari/605",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125",
      ]),
      expiresAt: inFlight ? addMinutes(ctx.timeline.end, ctx.rng.int(3, 18)) : expiresAt,
      graceExpiresAt: inFlight ? addMinutes(ctx.timeline.end, ctx.rng.int(20, 120)) : graceExpiresAt,
      nextCheckAt: status === "AUTHORIZING" || status === "VERIFYING" ? addMinutes(ctx.timeline.end, ctx.rng.int(1, 5)) : null,
      ledgerEntryId: null,
      terminalAt,
    });

    // Step logs: the money-moving phases every attempt goes through.
    const stepLogStart = ctx.dataset.attemptStepLogs.length;
    const phases = status === "BLOCKED"
      ? ["INITIATE"]
      : status === "CREATED" ? [] : ["INITIATE", ...(status === "INITIATING" ? [] : ["SUBMIT", ...(status === "AWAITING_CUSTOMER" ? [] : ["VERIFY"])])];
    phases.forEach((phase, stepOrder) => {
      const at = addMinutes(createdAt, stepOrder + 1);
      ctx.dataset.attemptStepLogs.push({
        id: ctx.nextId("step-log"),
        createdAt: at,
        updatedAt: at,
        attemptId,
        gatewayVersionId: version.id,
        phase,
        stepId: null,
        stepOrder,
        redactedRequestJson: {
          reference,
          amount: totalCharged.toFixed(2),
          phone: "*******",
        },
        redactedResponseText: JSON.stringify({
          status: phase === "INITIATE" ? "AWAITING_CUSTOMER" : status,
          provider_reference: providerReference,
        }),
        httpStatus: status === "FAILED" && ctx.rng.chance(35) ? ctx.rng.pick([500, 502, 504]) : 200,
        durationMs: ctx.rng.int(80, 3500),
        outcome: phase === "INITIATE" ? "AWAITING_CUSTOMER" : status,
      });
    });

    // Link counters.
    const counters = linkState.get(link.id) ?? { confirmed: 0, active: 0, expired: false, cancelled: false };
    if (status === "SUCCEEDED") counters.confirmed += 1;
    if (inFlight) counters.active += 1;
    if (status === "EXPIRED") counters.expired = true;
    if (status === "CANCELLED") counters.cancelled = true;
    linkState.set(link.id, counters);

    // Failure and ambiguity evidence on the last step log, for the case detail.
    const logsForAttempt = ctx.dataset.attemptStepLogs.slice(stepLogStart);
    const lastLog = logsForAttempt[logsForAttempt.length - 1];
    if (lastLog && status === "FAILED") {
      lastLog.outcome = ctx.rng.pick(FAILURE_CODES);
      lastLog.httpStatus = ctx.rng.chance(40) ? ctx.rng.pick([400, 402, 422]) : 200;
    }
    if (lastLog && status === "UNKNOWN" && !conflictCandidate) {
      lastLog.outcome = ctx.rng.pick(["TIMEOUT", "GATEWAY_FAULT", "MALFORMED_RESPONSE"]);
      lastLog.httpStatus = ctx.rng.chance(75) ? ctx.rng.pick([500, 502, 504]) : null;
      lastLog.durationMs = ctx.rng.pick([15_000, 20_000, 30_000]);
      lastLog.redactedResponseText = JSON.stringify({ error: "gateway did not return a definitive status" });
    }
    if (lastLog && conflictCandidate) {
      lastLog.outcome = "FAILED";
      lastLog.httpStatus = 200;
      lastLog.redactedResponseText = JSON.stringify({
        status: "FAILED",
        canonicalError: "DECLINED",
        provider_reference: providerReference,
      });
    }

    // Inbound evidence. A CONFLICT is the combination of a verified paid
    // webhook and the failed inquiry above; a LATE_SUCCESS is a verified paid
    // webhook that arrived after the attempt had already expired.
    const channel = channelFor(version.id, env);
    const pushInbound = (input: {
      at: Date;
      verified: boolean;
      processingResult: string;
      status: string;
      amount: string;
      verificationError?: string | null;
    }) => {
      if (!channel) return;
      const eventId = ctx.nextId("inbound-event");
      const body = {
        event_id: eventId,
        our_reference: reference,
        provider_reference: providerReference ?? `FK-LATE-${index.toString(36)}`,
        status: input.status,
        amount: input.amount,
        currency: "LYD",
        environment: env,
        timestamp: input.at.toISOString(),
      };
      ctx.dataset.inboundEvents.push({
        id: eventId,
        createdAt: input.at,
        updatedAt: input.at,
        channelId: channel.id,
        gatewayId: route.gatewayId,
        env,
        rawBodyBytes: Buffer.from(JSON.stringify(body)),
        redactedHeadersJson: {
          "content-type": "application/json",
          "x-fake-rails-signature": "******",
          "x-forwarded-for": `127.0.0.${ctx.rng.int(1, 20)}`,
        },
        sourceIp: `127.0.0.${ctx.rng.int(1, 20)}`,
        verified: input.verified,
        verificationError: input.verificationError ?? null,
        dedupeKey: sha256Like(ctx, `inbound:${eventId}:${reference}`),
        attemptId,
        receivedAt: input.at,
        processedAt: addMinutes(input.at, ctx.rng.int(0, 2)),
        processingResult: input.processingResult,
      });
    };
    if (conflictCandidate) {
      pushInbound({
        at: new Date(Math.min(ctx.timeline.end.getTime(), addMinutes(lastLog?.createdAt ?? createdAt, ctx.rng.int(1, 8)).getTime())),
        verified: true,
        processingResult: "CONFLICTING_TRUSTED_SIGNALS",
        status: "PAID",
        amount: totalCharged.toFixed(4),
      });
    } else if (lateSuccessCandidate) {
      pushInbound({
        at: new Date(Math.min(ctx.timeline.end.getTime(), addMinutes(terminalAt ?? expiresAt, ctx.rng.int(5, 90)).getTime())),
        verified: true,
        processingResult: "LATE_SUCCESS",
        status: "PAID",
        amount: totalCharged.toFixed(4),
      });
    } else if (status === "SUCCEEDED" && ctx.rng.chance(55)) {
      pushInbound({
        at: new Date(Math.min(ctx.timeline.end.getTime(), addMinutes(terminalAt ?? createdAt, ctx.rng.int(0, 3)).getTime())),
        verified: true,
        processingResult: "PAID",
        status: "PAID",
        amount: totalCharged.toFixed(4),
      });
    } else if (status === "FAILED" && ctx.rng.chance(8)) {
      pushInbound({
        at: new Date(Math.min(ctx.timeline.end.getTime(), addMinutes(terminalAt ?? createdAt, ctx.rng.int(0, 3)).getTime())),
        verified: false,
        verificationError: "SIGNATURE_MISMATCH",
        processingResult: "REJECTED_UNVERIFIED",
        status: "PAID",
        amount: totalCharged.toFixed(4),
      });
    }
    void addDays;
  }

  for (const link of links) {
    const counters = linkState.get(link.id);
    if (!counters) {
      link.state = "EXPIRED";
      continue;
    }
    link.confirmedCount = counters.confirmed;
    link.activeLockedCount = counters.active;
    // The database enforces `confirmed_count + active_locked_count <= use_count`
    // (unless the link is infinite-use). A link that attracted several attempts
    // is a multi-use link, so widen its use count instead of violating the
    // slot-reservation invariant.
    link.useCount = Math.max(Number(link.useCount), counters.confirmed + counters.active);
    if (counters.confirmed > 0) link.state = "COMPLETED";
    else if (counters.cancelled) link.state = "CANCELLED";
    else if (counters.expired) link.state = "EXPIRED";
    else link.state = "PENDING";
  }
};
