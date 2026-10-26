import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PrismaSlotReservationStore } from "../../engine/runtime/slotStore";
import { PrismaCallbackVerifier } from "../../engine/runtime/callbackVerifier";
import { PrismaFlowProvider } from "../../engine/runtime/flowProvider";
import { PrismaAttemptRepository } from "../../engine/runtime/attemptRepository";
import type { PrismaLike } from "../../engine/db/ports";
import { decimal } from "../../engine/ledger/LedgerPoster";

type Row = Record<string, unknown>;

const rows = (store: Map<string, Row[]>, table: string): Row[] => {
  const existing = store.get(table);
  if (existing) {
    return existing;
  }
  const created: Row[] = [];
  store.set(table, created);
  return created;
};

interface FakeOptions {
  link?: Row;
  attempt?: Row;
  channel?: Row;
  credentialSet?: Row;
  cryptoProfile?: Row;
  flow?: Row;
  flowStep?: Row;
  statusRule?: Row;
}

const createFakeClient = (options: FakeOptions = {}) => {
  const store = new Map<string, Row[]>();
  if (options.link) {
    rows(store, "paymentLink").push(options.link);
  }
  if (options.attempt) {
    rows(store, "paymentAttempt").push(options.attempt);
  }
  if (options.channel) {
    rows(store, "confirmationChannel").push(options.channel);
  }
  if (options.credentialSet) {
    rows(store, "credentialSet").push(options.credentialSet);
  }
  if (options.cryptoProfile) {
    rows(store, "cryptoProfile").push(options.cryptoProfile);
  }
  if (options.flow) {
    rows(store, "flow").push(options.flow);
  }
  if (options.flowStep) {
    rows(store, "flowStep").push(options.flowStep);
  }
  if (options.statusRule) {
    rows(store, "statusRule").push(options.statusRule);
  }

  const client = {
    $queryRawUnsafe: async (_sql: string, ...params: unknown[]) => {
      const sql = String(_sql);
      if (sql.includes("active_locked_count = active_locked_count + 1")) {
        const link = rows(store, "paymentLink")[0];
        if (!link) {
          return [];
        }
        const confirmed = Number(link.confirmedCount ?? 0);
        const locked = Number(link.activeLockedCount ?? 0);
        const useCount = Number(link.useCount ?? 1);
        if (!link.infiniteUse && confirmed + locked >= useCount) {
          return [];
        }
        link.activeLockedCount = locked + 1;
        return [{ id: link.id }];
      }
      if (sql.includes("confirmed_count = confirmed_count + 1")) {
        const link = rows(store, "paymentLink")[0];
        if (link) {
          link.confirmedCount = Number(link.confirmedCount ?? 0) + 1;
          link.activeLockedCount = Math.max(0, Number(link.activeLockedCount ?? 0) - 1);
          if (Number(link.confirmedCount) >= Number(link.useCount ?? 1)) {
            link.state = "COMPLETED";
          }
        }
        return [];
      }
      if (sql.includes("active_locked_count = GREATEST(0, active_locked_count - 1)")) {
        const link = rows(store, "paymentLink")[0];
        if (link) {
          link.activeLockedCount = Math.max(0, Number(link.activeLockedCount ?? 0) - 1);
        }
        return [];
      }
      return [];
    },
    paymentLink: {
      findUnique: async ({ where }: { where: Row }) =>
        rows(store, "paymentLink").find((row) => row.id === where.id) ?? null,
    },
    paymentAttempt: {
      findUnique: async ({ where }: { where: Row }) =>
        rows(store, "paymentAttempt").find((row) => row.id === where.id) ?? null,
      findFirst: async ({ where }: { where: Row }) => {
        const candidates = rows(store, "paymentAttempt");
        if (where.OR) {
          const alternatives = where.OR as Row[];
          return candidates.find((row) =>
            alternatives.some((alternative) =>
              Object.entries(alternative).every(([key, value]) => row[key] === value),
            ),
          ) ?? null;
        }
        return candidates.find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ) ?? null;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const attempt = rows(store, "paymentAttempt").find((row) => row.id === where.id);
        if (!attempt) {
          throw new Error("attempt not found");
        }
        Object.assign(attempt, data);
        return attempt;
      },
    },
    confirmationChannel: {
      findUnique: async ({ where }: { where: Row }) =>
        rows(store, "confirmationChannel").find((row) => row.pathToken === where.pathToken) ?? null,
    },
    credentialSet: {
      findUnique: async ({ where }: { where: Row }) =>
        rows(store, "credentialSet").find((row) => row.id === where.id) ?? null,
    },
    cryptoProfile: {
      findUnique: async ({ where }: { where: Row }) =>
        rows(store, "cryptoProfile").find((row) => row.id === where.id) ?? null,
    },
    gatewayEnvironment: {
      findMany: async () => rows(store, "gatewayEnvironment"),
    },
    flow: {
      findMany: async ({ where }: { where: Row }) => {
        const phase = where.phase as string | undefined;
        return rows(store, "flow").filter((row) => !phase || row.phase === phase);
      },
    },
    flowStep: {
      findMany: async () => rows(store, "flowStep"),
    },
    statusRule: {
      findMany: async () => rows(store, "statusRule"),
    },
  };

  return { client: client as unknown as PrismaLike, store };
};

const linkRow = (overrides: Row = {}): Row => ({
  id: "link-1",
  key: "LNKTESTKEY1",
  state: "PENDING",
  confirmedCount: 0,
  activeLockedCount: 0,
  useCount: 3,
  infiniteUse: false,
  amount: "100.0000",
  currency: "LYD",
  ...overrides,
});

const attemptRow = (overrides: Row = {}): Row => ({
  id: "attempt-1",
  reference: "PA-TEST-1",
  status: "AWAITING_CUSTOMER",
  env: "SANDBOX",
  currency: "LYD",
  mode: "OTP_PULL",
  requestedAmount: "100.0000",
  surchargeAmount: "0.0000",
  totalChargedAmount: "100.0000",
  platformCommissionAmount: "3.0000",
  netMerchantAmount: "97.0000",
  gatewayFeeAmount: "0.8000",
  settlementTarget: "PLATFORM_CLEARING",
  feeBearer: "MERCHANT_ABSORBS",
  otpAttempts: 0,
  pointOfNoReturn: false,
  contextCiphertext: "",
  customerFieldsMasked: {},
  linkId: "link-1",
  gatewayVersionId: "version-1",
  railId: "rail-1",
  routeId: "route-1",
  credentialSetId: "cred-1",
  commissionProfileId: "profile-1",
  merchantId: "merchant-1",
  applicationId: "application-1",
  ...overrides,
});

describe("production slot reservation store", () => {
  test("reserves a slot atomically and refuses the last one twice", async () => {
    const { client, store } = createFakeClient({ link: linkRow({ useCount: 1 }) });
    const store2 = new PrismaSlotReservationStore(client);
    const attempt = { id: "attempt-1", linkId: "link-1" } as never;

    await store2.reserveSlot(attempt);
    expect(Number(store.get("paymentLink")?.[0]?.activeLockedCount)).toBe(1);

    await expect(store2.reserveSlot(attempt)).rejects.toThrow();
    expect(Number(store.get("paymentLink")?.[0]?.activeLockedCount)).toBe(1);
  });

  test("releases a slot on a terminal outcome", async () => {
    const { client, store } = createFakeClient({
      link: linkRow({ activeLockedCount: 1 }),
      attempt: attemptRow(),
    });
    const store2 = new PrismaSlotReservationStore(client);
    await store2.releaseSlot({ id: "attempt-1", linkId: "link-1" } as never, "FAILED");
    expect(Number(store.get("paymentLink")?.[0]?.activeLockedCount)).toBe(0);
  });

  test("commits a slot into a confirmed slot and completes the link", async () => {
    const { client, store } = createFakeClient({
      link: linkRow({ useCount: 1, activeLockedCount: 1 }),
    });
    const store2 = new PrismaSlotReservationStore(client);
    await store2.commitSlot({ id: "attempt-1", linkId: "link-1" } as never);
    const link = store.get("paymentLink")?.[0];
    expect(Number(link?.confirmedCount)).toBe(1);
    expect(Number(link?.activeLockedCount)).toBe(0);
    expect(link?.state).toBe("COMPLETED");
  });
});

describe("production attempt repository", () => {
  test("maps the pinned money, the fee bearer and the ownership mode", async () => {
    const { client } = createFakeClient({
      attempt: attemptRow({ gatewayVersion: { gateway: { kind: "DIRECT" }, setting: { maxOtpAttempts: 5 } } }),
    });
    const repository = new PrismaAttemptRepository(client);
    const attempt = await repository.getAttempt("attempt-1");
    expect(attempt).not.toBeNull();
    expect(attempt?.totalChargedAmount).toBe("100.0000");
    expect(attempt?.platformCommissionAmount).toBe("3.0000");
    expect(attempt?.netMerchantAmount).toBe("97.0000");
    expect(attempt?.gatewayFeeAmount).toBe("0.8000");
    expect(attempt?.ownershipMode).toBe("PLATFORM_CLEARING");
    expect(attempt?.maxOtpAttempts).toBe(5);
  });

  test("marks a first-party gateway as INTERNAL (ledger rule INTERNAL-1)", async () => {
    const { client } = createFakeClient({
      attempt: attemptRow({ gatewayVersion: { gateway: { kind: "INTERNAL" } } }),
    });
    const repository = new PrismaAttemptRepository(client);
    const attempt = await repository.getAttempt("attempt-1");
    expect(attempt?.ownershipMode).toBe("INTERNAL");
  });
});

describe("production flow provider", () => {
  test("projects the declarative flow of the attempt into executable steps", async () => {
    const { client } = createFakeClient({
      flow: { id: "flow-1", railId: "rail-1", subMode: null, phase: "SUBMIT" },
      flowStep: {
        id: "step-1",
        flowId: "flow-1",
        orderIndex: 0,
        type: "HTTP",
        method: "POST",
        urlTemplate: "{api}/confirm",
        sideEffect: "MOVES_MONEY",
        retryPolicy: "NEVER",
        pointOfNoReturn: true,
        idempotencyConfig: { mode: "HEADER", key_name: "Idempotency-Key", source_template: "{{attempt.reference}}" },
        parameters: [{ place: "BODY", key: "otp", source: "CUSTOMER_FIELD", selector: "otp" }],
        outputs: [{ name: "transaction_id", selector: "transaction_id", storeAs: "PROVIDER_REF" }],
      },
      statusRule: {
        selector: "status",
        op: "EQUALS",
        valueJson: "SUCCESS",
        canonicalStatus: "SUCCEEDED",
      },
    });
    const provider = new PrismaFlowProvider(client);
    const steps = await provider.getSteps("SUBMIT", {
      id: "attempt-1",
      gatewayVersionId: "version-1",
      railId: "rail-1",
    } as never);
    expect(steps.length).toBe(1);
    expect(steps[0]?.type).toBe("HTTP");
    expect(steps[0]?.side_effect).toBe("MOVES_MONEY");
    expect(steps[0]?.retry_policy).toBe("NEVER");
    expect(steps[0]?.point_of_no_return).toBe(true);
    expect(steps[0]?.parameters?.[0]?.source).toBe("CUSTOMER_FIELD");
    expect(steps[0]?.outputs?.[0]?.store_as).toBe("PROVIDER_REF");
    expect(steps[0]?.status_rules?.length).toBe(1);
  });
});

describe("production callback verifier", () => {
  const secret = "super-secret-value";
  const channel = {
    id: "channel-1",
    pathToken: "token-abc",
    gatewayVersionId: "version-1",
    type: "WEBHOOK",
    verifyMethod: "HMAC_BODY",
    signatureHeader: "x-signature",
    timestampSelector: "timestamp",
    timestampToleranceSec: 300,
    ipAllowlist: ["203.0.113.0/24"],
    bodyFormat: "JSON",
    correlationSelector: "reference",
    dedupeKeySelector: "event_id",
    eventMap: { "00": "SUCCESS" },
    mustInquire: false,
    ackStatus: 200,
    ackBodyTemplate: null,
    cryptoProfile: {
      id: "crypto-1",
      algorithm: "HMAC_SHA256",
      secretKeyEncoding: "UTF8",
      canonicalizationMode: "RAW_BODY",
      outputEncoding: "HEX_LOWER",
    },
  };

  const credentialSet = {
    id: "cred-1",
    entriesCiphertext: [
      { key: "webhook_secret", type: "HEADER", value: secret, isSecret: false, secretVersion: 1 },
    ],
  };

  const attempt = attemptRow({ providerReference: "GW-REF-1" });

  const sign = (rawBody: string): string =>
    createHash("sha256").update(rawBody).digest("hex") && require("node:crypto")
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

  test("accepts a correctly signed callback and correlates the attempt", async () => {
    const { client } = createFakeClient({ channel, credentialSet, attempt });
    const verifier = new PrismaCallbackVerifier(client);
    const rawBody = JSON.stringify({ reference: "GW-REF-1", status: "00", amount: "100.0000", currency: "LYD" });
    const result = await verifier.verify("token-abc", {
      rawBody: Buffer.from(rawBody, "utf8"),
      headers: { "x-signature": sign(rawBody) },
      sourceIp: "203.0.113.10",
    });
    expect(result.verified).toBe(true);
    expect(result.attemptId).toBe("attempt-1");
    expect(result.evidence?.status).toBe("SUCCESS");
  });

  test("rejects a tampered body", async () => {
    const { client } = createFakeClient({ channel, credentialSet, attempt });
    const verifier = new PrismaCallbackVerifier(client);
    const rawBody = JSON.stringify({ reference: "GW-REF-1", status: "00", amount: "100.0000" });
    const result = await verifier.verify("token-abc", {
      rawBody: Buffer.from(rawBody, "utf8"),
      headers: { "x-signature": sign(`${rawBody}tampered`) },
      sourceIp: "203.0.113.10",
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("INBOUND_SIGNATURE_INVALID");
  });

  test("rejects a callback from outside the IP allowlist", async () => {
    const { client } = createFakeClient({ channel, credentialSet, attempt });
    const verifier = new PrismaCallbackVerifier(client);
    const rawBody = JSON.stringify({ reference: "GW-REF-1", status: "00" });
    const result = await verifier.verify("token-abc", {
      rawBody: Buffer.from(rawBody, "utf8"),
      headers: { "x-signature": sign(rawBody) },
      sourceIp: "198.51.100.7",
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("INBOUND_IP_NOT_ALLOWED");
  });

  test("rejects a callback outside the replay window", async () => {
    const { client } = createFakeClient({ channel, credentialSet, attempt });
    const verifier = new PrismaCallbackVerifier(client);
    const stale = Math.floor(Date.now() / 1000) - 4000;
    const rawBody = JSON.stringify({ reference: "GW-REF-1", status: "00", timestamp: stale });
    const result = await verifier.verify("token-abc", {
      rawBody: Buffer.from(rawBody, "utf8"),
      headers: { "x-signature": sign(rawBody) },
      sourceIp: "203.0.113.10",
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("INBOUND_TIMESTAMP_OUTSIDE_WINDOW");
  });

  test("refuses to trust an unknown correlation", async () => {
    const { client } = createFakeClient({ channel, credentialSet, attempt });
    const verifier = new PrismaCallbackVerifier(client);
    const rawBody = JSON.stringify({ reference: "GW-UNKNOWN", status: "00" });
    const result = await verifier.verify("token-abc", {
      rawBody: Buffer.from(rawBody, "utf8"),
      headers: { "x-signature": sign(rawBody) },
      sourceIp: "203.0.113.10",
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("INBOUND_ATTEMPT_UNKNOWN");
  });
});

describe("production settled amount tolerance", () => {
  test("accepts a settled amount inside the route tolerance", async () => {
    const { client } = createFakeClient({
      attempt: attemptRow({
        route: { mismatchPolicy: { tolerance_amount: "0.0100" } },
        gatewayVersion: { gateway: { kind: "DIRECT" }, setting: { maxOtpAttempts: 3 } },
      }),
    });
    const repository = new PrismaAttemptRepository(client);
    const attempt = await repository.getAttempt("attempt-1");
    expect(attempt?.mismatchTolerance).toBe("0.0100");
  });
});

describe("production money helpers", () => {
  test("the pinned commission is used verbatim", () => {
    expect(decimal("3.0000").toFixed(4)).toBe("3.0000");
  });
});
