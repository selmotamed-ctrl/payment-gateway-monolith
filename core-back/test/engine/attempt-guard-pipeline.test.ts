import { describe, expect, test } from "bun:test";
import { AttemptGuardPipeline } from "../../engine/guards/AttemptGuardPipeline";
import {
  CachedScreeningProvider,
  InternalWatchlistProvider,
  type ScreeningSubject,
} from "../../engine/guards/ScreeningProvider";
import {
  amlRule,
  createGuardFixture,
  createPrismaGuardFixture,
  existingAttempt,
  merchantRow,
  velocityRule,
  type GuardFixture,
} from "../helpers/guardsFake";

const NOW = new Date("2026-03-01T12:00:00.000Z");

const buildPipeline = (
  fixture: GuardFixture,
  screening: CachedScreeningProvider = new CachedScreeningProvider(new InternalWatchlistProvider()),
) =>
  new AttemptGuardPipeline({
    db: fixture.db,
    repositories: fixture.repositories,
    screening,
    clock: () => NOW,
  });

const guardRequest = (overrides: Record<string, unknown> = {}) => ({
  linkKey: "link-key-1",
  railCode: "edfali",
  applicationId: "application-1",
  merchantId: "merchant-1",
  env: "SANDBOX" as const,
  channel: "WEB" as const,
  mode: "OTP_PULL",
  idempotencyKey: "idem-0001",
  ...overrides,
});

describe("the attempt-creation guard (design §9.1 rule 2)", () => {
  test("a velocity rule that exceeds its limit produces a terminal BLOCKED attempt", async () => {
    const fixture = createGuardFixture({
      velocityRules: [velocityRule({ maxCount: 2 })],
      attempts: [
        existingAttempt(),
        existingAttempt({ id: "attempt-existing-2" }),
      ],
    });
    const pipeline = buildPipeline(fixture);

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons[0]).toContain("VELOCITY_REJECT");
    expect(decision.customerMessageCode).toBe("PAYMENT_CANNOT_BE_PROCESSED");

    // The refusal is auditable: a terminal attempt carries the reason.
    const attempt = fixture.state.createdAttempts[0];
    expect(attempt?.status).toBe("BLOCKED");
    expect(attempt?.substatus).toContain("VELOCITY_REJECT");

    // No slot was taken by a refused payment.
    expect(fixture.state.slotDeltas).toEqual([]);
    expect(decision.slotReserved).toBe(false);
  });

  test("a velocity rule of another scope does not count the attempts of this merchant", async () => {
    const fixture = createGuardFixture({
      velocityRules: [velocityRule({ scopeType: "END_CLIENT_IP", scopeValue: "10.0.0.1", maxCount: 1 })],
      attempts: [existingAttempt()],
    });
    const pipeline = buildPipeline(fixture);

    const decision = await pipeline.guard(guardRequest({ clientIp: "10.0.0.9" }));

    expect(decision.outcome).toBe("ALLOW");
    expect(fixture.state.createdAttempts[0]?.status).toBe("CREATED");
    expect(fixture.state.slotDeltas).toEqual([1]);
  });

  test("an AML rule that matches produces the AML_HOLD escrow and an AML case", async () => {
    const fixture = createGuardFixture({ amlRules: [amlRule()] });
    const pipeline = buildPipeline(fixture);

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("HOLD");
    expect(decision.holdRequired).toBe(true);
    expect(decision.amlCaseId).toBeTruthy();
    expect(decision.customerMessageCode).toBe("PAYMENT_UNDER_REVIEW");

    // The case points at the escrow, so the checker releases or voids it.
    const attemptId = decision.attemptId ?? "";
    const amlCase = fixture.state.amlCases[0];
    expect(amlCase?.subjectId).toBe(attemptId);
    expect(amlCase?.holdJournalEntryId).toBeTruthy();

    // The escrow is `Dr GATEWAY_CLEARING` / `Cr AML_HOLD` (design §11.3
    // entry 7) and it balances.
    expect(fixture.state.journalEntries).toHaveLength(1);
    const entry = fixture.state.journalEntries[0];
    expect(entry?.refType).toBe("PAYMENT_ATTEMPT");
    expect(entry?.refId).toBe(attemptId);
    const lines = fixture.state.journalLines.filter((line) => line.entryId === entry?.id);
    expect(lines).toHaveLength(2);
    const debit = lines.find((line) => line.direction === "DEBIT");
    const credit = lines.find((line) => line.direction === "CREDIT");
    expect(debit?.glAccountId).toBe("gl-clearing");
    expect(credit?.glAccountId).toBe("gl-aml-hold");
    expect(debit?.amount).toBe("100.0000");
    expect(credit?.amount).toBe(debit?.amount);

    // The attempt waits for the case: it never settles and it is polled by
    // nobody.
    const attempt = fixture.state.createdAttempts[0];
    expect(attempt?.status).toBe("CREATED");
    expect(fixture.state.attemptPatches[0]?.patch).toMatchObject({
      substatus: "AML_HOLD",
      nextCheckAt: null,
    });
    // The slot of the link stays reserved while the money is held.
    expect(fixture.state.slotDeltas).toEqual([1]);
  });

  test("a merchant direct settlement turns the hold into a case without an escrow", async () => {
    const fixture = createGuardFixture({ amlRules: [amlRule()] });
    const pipeline = buildPipeline(fixture);

    const decision = await pipeline.guard(
      guardRequest({
        pinnedRoute: {
          railId: "rail-1",
          routeId: "route-1",
          credentialSetId: "credential-1",
          gatewayVersionId: "gateway-version-1",
          commissionProfileId: "commission-1",
          settlementTarget: "MERCHANT_DIRECT",
          gatewayId: "gateway-1",
          mode: "OTP_PULL",
        },
      }),
    );

    expect(decision.outcome).toBe("CASE_ONLY");
    expect(decision.holdRequired).toBe(false);
    expect(fixture.state.amlCases).toHaveLength(1);
    expect(fixture.state.journalEntries).toHaveLength(0);
  });

  test("a SUSPENDED merchant is blocked and leaves no slot behind", async () => {
    const fixture = createGuardFixture({ merchant: merchantRow({ status: "SUSPENDED" }) });
    const pipeline = buildPipeline(fixture);

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons[0]).toBe("MERCHANT_SUSPENDED");
    expect(fixture.state.createdAttempts[0]?.status).toBe("BLOCKED");
    expect(fixture.state.slotDeltas).toEqual([]);
    expect(fixture.state.createdAttempts[0]?.merchantId).toBe("merchant-1");
  });

  test("a confirmed sanctions match on the published watch list blocks the attempt", async () => {
    const fixture = createGuardFixture({
      platformSettings: {
        "screening.watchlist": {
          version: "internal-v1",
          entries: [
            {
              entryRef: "SAN-1",
              listType: "SANCTIONS",
              listName: "Test sanctions list",
              names: ["مؤسسة النور للتجارة"],
            },
          ],
        },
      },
    });
    const pipeline = buildPipeline(fixture);

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons[0]).toContain("SCREENING_CONFIRMED_MATCH");
    expect(fixture.state.createdAttempts[0]?.status).toBe("BLOCKED");
    expect(fixture.state.slotDeltas).toEqual([]);
  });

  test("the hot path screening is served from the cache of the provider", async () => {
    const delegate = new InternalWatchlistProvider();
    let localCalls = 0;
    const counting = {
      code: delegate.code,
      capabilities: () => delegate.capabilities(),
      listVersions: () => delegate.listVersions(),
      screenLocal: (subject: ScreeningSubject) => {
        localCalls += 1;
        return delegate.screenLocal!(subject);
      },
      screenSubject: (subject: ScreeningSubject, options?: never) =>
        delegate.screenSubject(subject, options),
      getResult: (providerRequestRef: string) => delegate.getResult(providerRequestRef),
    };
    const screening = new CachedScreeningProvider(counting);
    const fixture = createGuardFixture();
    const pipeline = buildPipeline(fixture, screening);

    await pipeline.guard(guardRequest());
    await pipeline.guard(guardRequest({ idempotencyKey: "idem-0002" }));

    expect(localCalls).toBe(1);
  });

  test("the guard joins the transaction of its caller", async () => {
    const fixture = createGuardFixture();
    const pipeline = buildPipeline(fixture);

    const decision = await pipeline.guard(
      guardRequest(),
      fixture.db as never,
    );

    expect(decision.outcome).toBe("ALLOW");
    expect(decision.attemptId).toBeTruthy();
    expect(fixture.state.createdAttempts).toHaveLength(1);
  });
});

describe("OD-10 sandbox access for a pending merchant", () => {
  test("allows the sandbox when OD-10 is absent (documented default true)", async () => {
    const fixture = createGuardFixture({
      merchant: merchantRow({ status: "PENDING" }),
    });
    const pipeline = buildPipeline(fixture);

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("ALLOW");
    expect(fixture.state.createdAttempts[0]?.status).toBe("CREATED");
  });

  test("reads sandboxBeforeApproval=false from the OD-10 register object", async () => {
    const fixture = createGuardFixture({
      merchant: merchantRow({ status: "PENDING" }),
      platformSettings: {
        "OD-10": { sandboxBeforeApproval: false },
      },
    });
    const pipeline = buildPipeline(fixture);

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons[0]).toBe("MERCHANT_NOT_ACTIVE");
    expect(fixture.state.slotDeltas).toEqual([]);
  });

  test("reads sandboxBeforeApproval=true from the OD-10 register object", async () => {
    const fixture = createGuardFixture({
      merchant: merchantRow({ status: "PENDING" }),
      platformSettings: {
        "OD-10": { sandboxBeforeApproval: true },
      },
    });
    const pipeline = buildPipeline(fixture);

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("ALLOW");
    expect(fixture.state.createdAttempts[0]?.status).toBe("CREATED");
  });
});

describe("the guard against the production repositories", () => {
  test("the velocity rules are read from the database through the repositories", async () => {
    const fixture = createPrismaGuardFixture({
      velocityRules: [velocityRule({ maxCount: 1 })],
      attempts: [existingAttempt()],
    });
    const pipeline = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => NOW,
    });

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("BLOCK");
    expect(decision.reasons[0]).toContain("VELOCITY_REJECT:velocity-1");
    expect(fixture.state.createdAttempts[0]?.status).toBe("BLOCKED");
    expect(fixture.state.slotDeltas).toEqual([]);
  });

  test("the AML rules are read from the database through the repositories", async () => {
    const fixture = createPrismaGuardFixture({ amlRules: [amlRule()] });
    const pipeline = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => NOW,
    });

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("HOLD");
    expect(decision.holdRequired).toBe(true);
    expect(fixture.state.amlCases).toHaveLength(1);
    expect(fixture.state.journalEntries).toHaveLength(1);
    expect(fixture.state.slotDeltas).toEqual([1]);
  });

  test("the link slot is reserved by the repository inside the guard transaction", async () => {
    const fixture = createPrismaGuardFixture();
    const pipeline = new AttemptGuardPipeline({
      db: fixture.db,
      repositories: fixture.repositories,
      screening: new CachedScreeningProvider(new InternalWatchlistProvider()),
      clock: () => NOW,
    });

    const decision = await pipeline.guard(guardRequest());

    expect(decision.outcome).toBe("ALLOW");
    expect(decision.slotReserved).toBe(true);
    expect(fixture.state.slotDeltas).toEqual([1]);
    expect(fixture.state.createdAttempts[0]?.status).toBe("CREATED");
  });
});
