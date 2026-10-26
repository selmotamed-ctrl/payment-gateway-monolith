import { describe, expect, test } from "bun:test";
import {
  BLUEPRINT_CATALOG,
  RAIL_CAPABILITIES,
  seedBlueprints,
  type BlueprintCatalogEntry,
  type BlueprintGateway,
  type BlueprintRail,
  type BlueprintStep,
} from "../prisma/seedBlueprints";
import {
  createFakePrisma,
  fakeTable,
  fakeTableNames,
  resetFakeDatabase,
} from "./helpers/fakePrisma";
import { PrismaFlowProvider } from "../engine/runtime/flowProvider";
import type { DynamicAttempt } from "../engine/flow/DynamicRailEngine";

/**
 * The blueprint catalogue is pure data, so every assertion of this suite runs
 * without a database connection.
 */

const blueprints = (): BlueprintCatalogEntry[] => BLUEPRINT_CATALOG;

const allSteps = (blueprint: BlueprintCatalogEntry): BlueprintStep[] =>
  blueprint.gateways.flatMap((gateway) =>
    gateway.flows.flatMap((flow) => flow.steps),
  );

const allGateways = (blueprint: BlueprintCatalogEntry): BlueprintGateway[] => blueprint.gateways;

const allRails = (blueprint: BlueprintCatalogEntry): BlueprintRail[] => blueprint.rails;

describe("blueprint catalogue", () => {
  test("exposes the seven production blueprints", () => {
    expect(blueprints().length).toBe(7);
    expect(blueprints().map((blueprint) => blueprint.key)).toEqual([
      "edfali-sadad-otp",
      "moamalat-lightbox",
      "cbl-lypay",
      "mypay-tlync-redirect",
      "hybrid-wallet-rails",
      "mpgs-evo-pay",
      "neompay-internal",
    ]);
  });

  test("every blueprint seeds gateways, rails and a live flow definition", () => {
    for (const blueprint of blueprints()) {
      expect(blueprint.gateways.length).toBeGreaterThan(0);
      expect(blueprint.rails.length).toBeGreaterThan(0);
      expect(blueprint.gatewayKinds).toBeDefined();

      for (const gateway of allGateways(blueprint)) {
        expect(gateway.flows.length).toBeGreaterThan(0);
        expect(gateway.environments.map((environment) => environment.env)).toEqual([
          "SANDBOX",
          "LIVE",
        ]);
        expect(gateway.channels.length).toBeGreaterThan(0);
        expect(gateway.settings.sessionTtlSeconds).toBeGreaterThan(0);
        expect(gateway.auth.method).toBeTruthy();

        for (const flow of gateway.flows) {
          expect(flow.steps.length).toBeGreaterThan(0);
          for (const entry of flow.steps) {
            expect(entry.sideEffect).toMatch(/^(READ_ONLY|SENDS_NOTIFICATION|MOVES_MONEY)$/);
            expect(entry.retryPolicy).toMatch(/^(SAFE|SAFE_WITH_COOLDOWN|NEVER)$/);
            expect(typeof entry.pointOfNoReturn).toBe("boolean");
            expect(entry.idempotencyConfig).toEqual({
              mode: expect.any(String),
              key_name: expect.any(String),
              source_template: expect.any(String),
            });
          }
        }
      }
    }
  });

  test("every money moving rail has an INITIATE, a SUBMIT and a VERIFY phase", () => {
    for (const blueprint of blueprints()) {
      for (const gateway of allGateways(blueprint)) {
        const phases = new Set(gateway.flows.map((flow) => flow.phase));
        expect(phases.has("INITIATE")).toBe(true);
        expect(phases.has("SUBMIT")).toBe(true);
        expect(phases.has("VERIFY")).toBe(true);
      }
    }
  });

  test("a money moving step never retries and is a point of no return", () => {
    for (const blueprint of blueprints()) {
      for (const entry of allSteps(blueprint).filter(
        (candidate) => candidate.sideEffect === "MOVES_MONEY",
      )) {
        expect(entry.retryPolicy).toBe("NEVER");
        expect(entry.pointOfNoReturn).toBe(true);
      }
    }
  });

  test("the rails that settle on the platform move the money exactly once", () => {
    const platformSettled = ["edfali-sadad-otp", "cbl-lypay", "hybrid-wallet-rails", "neompay-internal"];
    for (const key of platformSettled) {
      const blueprint = blueprints().find((entry) => entry.key === key);
      const moneySteps = allSteps(blueprint ?? ({} as BlueprintCatalogEntry)).filter(
        (entry) => entry.sideEffect === "MOVES_MONEY",
      );
      expect(moneySteps.length).toBeGreaterThan(0);
      for (const entry of moneySteps) {
        expect(entry.retryPolicy).toBe("NEVER");
        expect(entry.pointOfNoReturn).toBe(true);
      }
    }
  });

  test("the hosted rails confirm by inquiry instead of moving the money themselves", () => {
    const hosted = ["moamalat-lightbox", "mypay-tlync-redirect", "mpgs-evo-pay"];
    for (const key of hosted) {
      const blueprint = blueprints().find((entry) => entry.key === key);
      for (const gateway of allGateways(blueprint ?? ({} as BlueprintCatalogEntry))) {
        const submit = gateway.flows.find((flow) => flow.phase === "SUBMIT");
        expect(submit).toBeDefined();
        for (const entry of submit?.steps ?? []) {
          expect(entry.sideEffect).not.toBe("MOVES_MONEY");
          expect(entry.sideEffect).toBe("READ_ONLY");
        }
      }
    }
  });

  test("a notification step may be retried but never moves money", () => {
    for (const blueprint of blueprints()) {
      for (const entry of allSteps(blueprint).filter(
        (candidate) => candidate.sideEffect === "SENDS_NOTIFICATION",
      )) {
        expect(entry.pointOfNoReturn).toBe(false);
        expect(entry.retryPolicy).not.toBe("NEVER");
      }
    }
  });

  test("the edfali and sadad blueprint follows the two step otp contract", () => {
    const blueprint = blueprints().find((entry) => entry.key === "edfali-sadad-otp");
    expect(blueprint).toBeDefined();
    for (const gateway of allGateways(blueprint ?? ({} as BlueprintCatalogEntry))) {
      const initiate = gateway.flows.find((flow) => flow.phase === "INITIATE");
      const submit = gateway.flows.find((flow) => flow.phase === "SUBMIT");
      const initiateStep = initiate?.steps.find((entry) => entry.urlTemplate?.includes("/verify"));
      const submitStep = submit?.steps.find((entry) => entry.urlTemplate?.includes("/confirm"));
      expect(initiateStep?.sideEffect).toBe("SENDS_NOTIFICATION");
      expect(initiateStep?.retryPolicy).toBe("SAFE_WITH_COOLDOWN");
      expect(submitStep?.sideEffect).toBe("MOVES_MONEY");
      expect(submitStep?.retryPolicy).toBe("NEVER");
      expect(submitStep?.pointOfNoReturn).toBe(true);
      expect(
        initiateStep?.outputs?.some((output) => output.name === "process_id" && output.storeAs === "STATE"),
      ).toBe(true);
    }
  });

  test("the moamalat blueprint computes the lightbox payload and inquires the transaction", () => {
    const blueprint = blueprints().find((entry) => entry.key === "moamalat-lightbox");
    const gateway = blueprint?.gateways.find((entry) => entry.code === "moamalat");
    expect(gateway).toBeDefined();

    const initiate = gateway?.flows.find((flow) => flow.phase === "INITIATE");
    const compute = initiate?.steps.find((entry) => entry.type === "COMPUTE");
    expect(compute?.method).toBe("MOAMALAT_LIGHTBOX_PAYLOAD");
    expect(
      compute?.outputs?.map((output) => output.name),
    ).toEqual(expect.arrayContaining(["AmountTrxn", "MerchantReference", "TrxDateTime", "SecureHash"]));

    const verify = gateway?.flows.find((flow) => flow.phase === "VERIFY");
    const inquiry = verify?.steps.find((entry) => entry.urlTemplate?.includes("FilterTransactions"));
    expect(inquiry?.urlTemplate).toBe("{inquiry}/FilterTransactions");
    expect(inquiry?.sideEffect).toBe("READ_ONLY");
    const assertion = verify?.steps.find((entry) => entry.type === "ASSERT");
    expect(assertion?.successCheck).toEqual(
      expect.arrayContaining([
        { selector: "Approved", op: "equals", value: true },
        { selector: "ActionCode", op: "equals", value: "00" },
      ]),
    );

    const profile = gateway?.cryptoProfiles.find(
      (entry) => entry.name === "MOAMALAT_SECURE_HASH",
    );
    expect(profile?.algorithm).toBe("HMAC_SHA256");
    expect(profile?.secretKeyEncoding).toBe("HEX");
    expect(profile?.canonicalizationMode).toBe("SORTED_KEY_VALUE_AMP");
    expect(profile?.outputEncoding).toBe("HEX_UPPER");
  });

  test("the lypay blueprint confirms inside the five second window and polls afterwards", () => {
    const blueprint = blueprints().find((entry) => entry.key === "cbl-lypay");
    const gateway = blueprint?.gateways.find((entry) => entry.code === "cbl_lypay");
    expect(gateway?.auth.method).toBe("TOKEN_ENDPOINT");
    const submit = gateway?.flows.find((flow) => flow.phase === "SUBMIT");
    const confirm = submit?.steps[0];
    expect(confirm?.sideEffect).toBe("MOVES_MONEY");
    expect(confirm?.retryPolicy).toBe("NEVER");
    expect(confirm?.pointOfNoReturn).toBe(true);
    expect(confirm?.urlTemplate).toContain("funds-transfers");
    const rules = gateway?.statusRules ?? [];
    expect(
      rules.some(
        (rule) =>
          rule.canonicalStatus === "VERIFYING" &&
          rule.value === "Processing" &&
          rule.phase === "SUBMIT",
      ),
    ).toBe(true);
  });

  test("the redirect blueprint signs the callback and inquires the receipt", () => {
    const blueprint = blueprints().find((entry) => entry.key === "mypay-tlync-redirect");
    const mypay = blueprint?.gateways.find((entry) => entry.code === "mypay");
    const tlync = blueprint?.gateways.find((entry) => entry.code === "tlync");

    const webhook = mypay?.channels.find((channel) => channel.type === "WEBHOOK");
    expect(webhook?.verifyMethod).toBe("HMAC_BODY");
    expect(webhook?.signatureHeader).toBe("X-MYPAY-SIGNATURE");
    const profile = mypay?.cryptoProfiles.find((entry) => entry.name === "MYPAY_SIGNATURE");
    expect(profile?.canonicalizationMode).toBe("RAW_BODY");

    const receipt = tlync?.flows
      .find((flow) => flow.phase === "VERIFY")
      ?.steps.find((entry) => entry.urlTemplate?.includes("/receipt/transaction"));
    expect(receipt?.urlTemplate).toBe("{api}/receipt/transaction");
    expect(receipt?.sideEffect).toBe("READ_ONLY");

    const redirect = blueprint?.rails
      .flatMap((rail) => rail.routes)
      .find((route) => route.gatewayCode === "mypay");
    expect(redirect?.redirect?.method).toBe("GET");
    expect(redirect?.redirect?.urlSourceOutput).toBe("redirect_url");
  });

  test("the hybrid rails mark the card identifiers as PAN", () => {
    const blueprint = blueprints().find((entry) => entry.key === "hybrid-wallet-rails");
    for (const rail of allRails(blueprint ?? ({} as BlueprintCatalogEntry))) {
      const card = rail.fields.find((field) => field.key === "card_number");
      expect(card).toBeDefined();
      expect(card?.type).toBe("PAN");
      expect(card?.sensitivity).toBe("PAN");
      expect(card?.regex).toMatch(/^\^\[0-9\]\{[0-9]+\}\$$/);
    }
  });

  test("the mpgs blueprint runs the mandatory order inquiry", () => {
    const blueprint = blueprints().find((entry) => entry.key === "mpgs-evo-pay");
    const mpgs = blueprint?.gateways.find((entry) => entry.code === "mpgs");
    expect(mpgs?.auth.method).toBe("BASIC");
    const inquiry = mpgs?.flows
      .find((flow) => flow.phase === "VERIFY")
      ?.steps.find((entry) => entry.urlTemplate?.includes("/order/"));
    expect(inquiry?.urlTemplate).toBe("{api}/order/{order_id}");
    expect(inquiry?.sideEffect).toBe("READ_ONLY");

    const evo = blueprint?.gateways.find((entry) => entry.code === "evo_pay");
    const profile = evo?.cryptoProfiles.find((entry) => entry.name === "EVO_PAY_SIGNATURE");
    expect(profile?.algorithm).toBe("RSA_SHA256");
    const nested = evo?.flows
      .find((flow) => flow.phase === "INITIATE")
      ?.steps.find((entry) => entry.urlTemplate?.includes("/Payment"))
      ?.parameters?.some((parameter) => parameter.key === "transAmount.amount");
    expect(nested).toBe(true);
  });

  test("the neompay blueprint is an internal wallet rail", () => {
    const blueprint = blueprints().find((entry) => entry.key === "neompay-internal");
    expect(blueprint?.kind).toBe("INTERNAL");
    const gateway = blueprint?.gateways.find((entry) => entry.code === "neompay");
    expect(gateway?.kind).toBe("INTERNAL");
    expect(gateway?.auth.method).toBe("MUTUAL_TLS");
    expect(gateway?.settings.amountScale).toBe(1);
    expect(gateway?.settings.amountPrecision).toBe(3);
    expect(gateway?.settings.amountRounding).toBe("NONE");
    expect(gateway?.settings.supportsIdempotencyKey).toBe(true);

    const rail = blueprint?.rails.find((entry) => entry.code === "neompay_wallet");
    expect(rail?.collectionMode).toBe("HYBRID");
    expect(rail?.subModes).toEqual(["PUSH_APPROVAL", "OTP_PULL", "QR_DISPLAY"]);

    const wallet = rail?.fields.find((field) => field.key === "wallet_id");
    expect(wallet?.type).toBe("WALLET_ID");
    expect(wallet?.regex).toBe("^NP-[0-9]{12}$");
    expect(wallet?.sensitivity).toBe("SENSITIVE");
    expect(wallet?.checksum).toBe("LUHN");

    const subModes = (gateway?.flows ?? [])
      .filter((flow) => flow.phase === "INITIATE")
      .map((flow) => flow.subMode);
    expect(subModes).toEqual(["PUSH_APPROVAL", "OTP_PULL", "QR_DISPLAY"]);
  });

  test("every pan or wallet field carries a regular expression", () => {
    for (const blueprint of blueprints()) {
      for (const rail of allRails(blueprint)) {
        for (const field of rail.fields) {
          if (field.type === "PAN" || field.type === "WALLET_ID" || field.type === "CARD_NUMBER") {
            expect(field.regex).toBeTruthy();
          }
          expect(field.labelAr.length).toBeGreaterThan(0);
          expect(field.labelEn.length).toBeGreaterThan(0);
          expect(field.sensitivity).toMatch(/^(NORMAL|SENSITIVE|PAN)$/);
        }
      }
    }
  });

  test("every route binds a rail to a gateway with a cost and a mismatch policy", () => {
    for (const blueprint of blueprints()) {
      for (const rail of allRails(blueprint)) {
        expect(rail.routes.length).toBeGreaterThan(0);
        for (const route of rail.routes) {
          expect(blueprint.gatewayCodes).toContain(route.gatewayCode);
          expect(route.costModel).toEqual({
            calc_type: expect.any(String),
            flat: expect.any(String),
            percent: expect.any(String),
            min: expect.any(String),
            max: expect.any(String),
            bearer: expect.any(String),
            accrue_fee_at_confirm: expect.any(Boolean),
          });
          expect(route.mismatchPolicy).toEqual({
            tolerance_amount: expect.any(String),
            underpay_action: expect.any(String),
            overpay_action: expect.any(String),
          });
          expect(route.status).toMatch(/^(ACTIVE|PAUSED|DRAINING)$/);
          expect(route.healthState).toMatch(/^(HEALTHY|DEGRADED|OPEN_BREAKER)$/);
          expect(route.scope).toBeDefined();
        }
      }
    }
  });

  test("the confirmation channel tokens are unique and the weak ones inquire", () => {
    const tokens = blueprints().flatMap((blueprint) =>
      allGateways(blueprint).flatMap((gateway) => gateway.channels.map((channel) => channel.pathToken)),
    );
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const blueprint of blueprints()) {
      for (const gateway of allGateways(blueprint)) {
        for (const channel of gateway.channels) {
          expect(channel.pathToken.length).toBeGreaterThanOrEqual(8);
          expect(channel.timestampToleranceSec).toBeGreaterThan(0);
          if (["IP_ONLY", "NONE_PLUS_INQUIRY", "SHARED_TOKEN"].includes(channel.verifyMethod)) {
            expect(channel.mustInquire).toBe(true);
          }
        }
      }
    }
  });

  test("the rail capabilities use the snake_case key of the design", () => {
    expect(RAIL_CAPABILITIES.partial_refund).toBe(true);
    expect(Object.keys(RAIL_CAPABILITIES)).toContain("partial_refund");
    expect(Object.keys(RAIL_CAPABILITIES)).not.toContain("partialRefund");
  });

  test("the crypto profiles cover the signing shapes of the design", () => {
    const profiles = blueprints().flatMap((blueprint) =>
      allGateways(blueprint).flatMap((gateway) =>
        gateway.cryptoProfiles.map((profile) => profile.name),
      ),
    );
    expect(profiles).toContain("MOAMALAT_SECURE_HASH");
    expect(profiles).toContain("DPAY_WEBHOOK_VERIFY");
    expect(profiles).toContain("PLUTU_CALLBACK_HASH");
    expect(profiles).toContain("MYPAY_SIGNATURE");
    expect(profiles).toContain("EVO_PAY_SIGNATURE");

    const moamalat = blueprints()
      .flatMap((blueprint) => allGateways(blueprint))
      .flatMap((gateway) => gateway.cryptoProfiles)
      .find((profile) => profile.name === "MOAMALAT_SECURE_HASH");
    expect(moamalat?.secretKeyEncoding).toBe("HEX");
    expect(moamalat?.canonicalizationMode).toBe("SORTED_KEY_VALUE_AMP");

    const dpay = blueprints()
      .flatMap((blueprint) => allGateways(blueprint))
      .flatMap((gateway) => gateway.cryptoProfiles)
      .find((profile) => profile.name === "DPAY_WEBHOOK_VERIFY");
    expect(dpay?.canonicalizationMode).toBe("TIMESTAMP_DOT_RAW_BODY");

    const plutu = blueprints()
      .flatMap((blueprint) => allGateways(blueprint))
      .flatMap((gateway) => gateway.cryptoProfiles)
      .find((profile) => profile.name === "PLUTU_CALLBACK_HASH");
    expect(plutu?.canonicalizationMode).toBe("SORTED_VALUES_HASH");

    const mypay = blueprints()
      .flatMap((blueprint) => allGateways(blueprint))
      .flatMap((gateway) => gateway.cryptoProfiles)
      .find((profile) => profile.name === "MYPAY_SIGNATURE");
    expect(mypay?.canonicalizationMode).toBe("RAW_BODY");

    const evo = blueprints()
      .flatMap((blueprint) => allGateways(blueprint))
      .flatMap((gateway) => gateway.cryptoProfiles)
      .find((profile) => profile.name === "EVO_PAY_SIGNATURE");
    expect(evo?.algorithm).toBe("RSA_SHA256");
  });

  test("the kind of a gateway is decided per gateway code", () => {
    const redirect = blueprints().find((entry) => entry.key === "mypay-tlync-redirect");
    expect(redirect?.gatewayKinds.mypay).toBe("AGGREGATOR");
    expect(redirect?.gatewayKinds.tlync).toBe("DIRECT");
    for (const blueprint of blueprints()) {
      for (const gateway of allGateways(blueprint)) {
        expect(blueprint.gatewayKinds[gateway.code]).toBe(gateway.kind);
      }
    }
  });
});

/**
 * The seed itself is executed against an in-memory stand-in for the Prisma
 * client: no database is involved, and the second run proves that the seed is
 * idempotent.
 */
describe("blueprint seed execution", () => {
  const snapshot = (): Record<string, unknown[]> => {
    const result: Record<string, unknown[]> = {};
    for (const name of fakeTableNames()) {
      result[name] = fakeTable(name)
        .map((row) => {
          const copy = { ...row };
          for (const volatile of ["id", "createdAt", "updatedAt", "stepId", "flowId"]) {
            delete copy[volatile];
          }
          return copy;
        })
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return result;
  };

  const runSeed = async () => {
    resetFakeDatabase();
    fakeTable("user").push({
      id: "user-seed-actor",
      email: "gateway-admin@payment-gateway.internal",
    });
    const prisma = createFakePrisma();
    await seedBlueprints(prisma);
    return prisma;
  };

  test("seeds every declarative table of the runtime configuration", async () => {
    await runSeed();
    const expected = [
      "confirmationChannel",
      "cryptoProfile",
      "flow",
      "flowStep",
      "gateway",
      "gatewayAuth",
      "gatewayEnvironment",
      "gatewaySetting",
      "gatewayVersion",
      "pollPolicy",
      "rail",
      "railField",
      "railRoute",
      "redirectDefinition",
      "statusRule",
      "stepOutput",
      "stepParameter",
      "widgetDefinition",
    ];
    for (const table of expected) {
      expect(fakeTable(table).length).toBeGreaterThan(0);
    }
  });

  test("creates one live version per gateway and activates it", async () => {
    await runSeed();
    const gateways = fakeTable("gateway");
    const versions = fakeTable("gatewayVersion");
    expect(versions.length).toBe(gateways.length);
    for (const version of versions) {
      expect(version.state).toBe("LIVE");
      expect(String(version.contentHash)).toHaveLength(64);
    }
    for (const gateway of gateways) {
      expect(gateway.status).toBe("LIVE");
      expect(gateway.activeVersionId).toBeTruthy();
      const version = versions.find((entry) => entry.id === gateway.activeVersionId);
      expect(version).toBeDefined();
      expect(version?.gatewayId).toBe(gateway.id);
    }
  });

  test("seeds the two environments, the auth and the settings of every version", async () => {
    await runSeed();
    const versions = fakeTable("gatewayVersion");
    for (const version of versions) {
      const environments = fakeTable("gatewayEnvironment").filter(
        (entry) => entry.gatewayVersionId === version.id,
      );
      expect(environments.map((entry) => entry.env).sort()).toEqual(["LIVE", "SANDBOX"]);
      for (const environment of environments) {
        const auth = fakeTable("gatewayAuth").find(
          (entry) => entry.gatewayVersionId === version.id && entry.env === environment.env,
        );
        expect(auth).toBeDefined();
        expect(auth?.method).toBeTruthy();
        expect(auth?.authApply).toMatch(/^(HEADER|QUERY|BODY)$/);
        const hosts = environment.allowedHosts as string[];
        expect(Array.isArray(hosts)).toBe(true);
        expect(hosts.length).toBeGreaterThan(0);
        const baseUrls = environment.baseUrls as Record<string, string>;
        expect(Object.keys(baseUrls)).toContain("api");
      }
      const setting = fakeTable("gatewaySetting").find(
        (entry) => entry.gatewayVersionId === version.id,
      );
      expect(setting).toBeDefined();
      expect(setting?.amountScale).toBeGreaterThan(0);
      expect(setting?.maxOtpAttempts).toBeGreaterThan(0);
      expect(setting?.gatewayTimezone).toBe("Africa/Tripoli");
    }
  });

  test("binds every rail to a gateway with a route and its channels", async () => {
    await runSeed();
    const routes = fakeTable("railRoute");
    expect(routes.length).toBe(fakeTable("rail").length);
    for (const route of routes) {
      expect(route.status).toBe("ACTIVE");
      expect(route.healthState).toBe("HEALTHY");
      const costModel = route.costModel as Record<string, unknown>;
      expect(Object.keys(costModel)).toEqual(
        expect.arrayContaining([
          "calc_type",
          "flat",
          "percent",
          "min",
          "max",
          "bearer",
          "accrue_fee_at_confirm",
        ]),
      );
      const mismatchPolicy = route.mismatchPolicy as Record<string, unknown>;
      expect(Object.keys(mismatchPolicy)).toEqual(
        expect.arrayContaining(["tolerance_amount", "underpay_action", "overpay_action"]),
      );
    }
    for (const channel of fakeTable("confirmationChannel")) {
      expect(String(channel.pathToken).length).toBeGreaterThanOrEqual(8);
      expect(channel.routeId).toBeTruthy();
      expect(channel.gatewayVersionId).toBeTruthy();
    }
  });

  test("is idempotent: a second run neither duplicates nor fails", async () => {
    await runSeed();
    const first = snapshot();
    const firstCounts = Object.fromEntries(
      Object.entries(first).map(([name, rows]) => [name, rows.length]),
    );

    const prisma = createFakePrisma();
    await seedBlueprints(prisma);
    const second = snapshot();
    const secondCounts = Object.fromEntries(
      Object.entries(second).map(([name, rows]) => [name, rows.length]),
    );

    expect(secondCounts).toEqual(firstCounts);
    expect(second).toEqual(first);
  });
});


/**
 * The seeded rows are projected into the shape the step executor consumes.
 * The projection is exercised against the in-memory database of the seed, so
 * the declarative configuration is proven to be executable.
 */
describe("blueprint flow projection", () => {
  const seed = async () => {
    resetFakeDatabase();
    fakeTable("user").push({
      id: "user-seed-actor",
      email: "gateway-admin@payment-gateway.internal",
    });
    const prisma = createFakePrisma();
    await seedBlueprints(prisma);
    return prisma;
  };

  const RAIL_OF: Record<string, string> = {
    edfali: "edfali",
    sadad: "sadad",
    moamalat: "moamalat_card",
    cbl_lypay: "lypay",
    mypay: "mypay",
    tlync: "tlync",
    mobicash: "mobicash",
    onepay: "onepay",
    yussor: "yussor",
    sahara: "sahara",
    mpgs: "mpgs",
    evo_pay: "evo_pay",
    neompay: "neompay_wallet",
  };

  const attemptFor = (gatewayCode: string, overrides: Partial<DynamicAttempt> = {}): DynamicAttempt => {
    const gateway = fakeTable("gateway").find((row) => row.code === gatewayCode);
    const rail = fakeTable("rail").find((row) => row.code === RAIL_OF[gatewayCode]);
    return {
      id: "attempt-1",
      reference: "PA-TEST-1",
      status: "CREATED",
      env: "SANDBOX",
      currency: "LYD",
      requestedAmount: "100.0000",
      totalChargedAmount: "100.0000",
      platformCommissionAmount: "3.0000",
      netMerchantAmount: "97.0000",
      maxOtpAttempts: 3,
      otpAttempts: 0,
      ownershipMode: "PLATFORM_CLEARING",
      context: {},
      gatewayId: String(gateway?.id ?? ""),
      gatewayVersionId: String(gateway?.activeVersionId ?? ""),
      railId: String(rail?.id ?? ""),
      ...overrides,
    } as DynamicAttempt;
  };

  test("resolves the named base url of the environment of the attempt", async () => {
    const prisma = await seed();
    const provider = new PrismaFlowProvider(prisma);

    const sandbox = await provider.getSteps("INITIATE", attemptFor("edfali"));
    expect(sandbox[0]?.url_template).toBe("https://sandbox.edfali.example.ly/verify");
    expect(sandbox[0]?.side_effect).toBe("SENDS_NOTIFICATION");
    expect(sandbox[0]?.retry_policy).toBe("SAFE_WITH_COOLDOWN");

    const live = await provider.getSteps(
      "INITIATE",
      attemptFor("edfali", { env: "LIVE" as never }),
    );
    expect(live[0]?.url_template).toBe("https://api.edfali.example.ly/verify");
  });

  test("projects the money moving step with its closed retry policy", async () => {
    const prisma = await seed();
    const provider = new PrismaFlowProvider(prisma);
    const steps = await provider.getSteps("SUBMIT", attemptFor("edfali"));
    const confirm = steps.find((step) => step.url_template?.includes("/confirm"));
    expect(confirm?.side_effect).toBe("MOVES_MONEY");
    expect(confirm?.retry_policy).toBe("NEVER");
    expect(confirm?.point_of_no_return).toBe(true);
    expect(confirm?.idempotency_config?.mode).toBe("NONE");
  });

  test("projects the moamalat compute, render and inquiry steps", async () => {
    const prisma = await seed();
    const provider = new PrismaFlowProvider(prisma);
    const initiate = await provider.getSteps("INITIATE", attemptFor("moamalat"));
    const compute = initiate.find((step) => step.type === "COMPUTE");
    expect(compute?.compute?.name).toBe("MOAMALAT_LIGHTBOX_PAYLOAD");
    const render = initiate.find((step) => step.type === "RENDER");
    expect(render?.render?.action).toBe("RENDER_EMBEDDED");

    const verify = await provider.getSteps("VERIFY", attemptFor("moamalat"));
    const inquiry = verify.find((step) => step.url_template?.includes("FilterTransactions"));
    expect(inquiry?.url_template).toBe(
      "https://sandbox.moamalat.example.ly/inquiry/FilterTransactions",
    );
    const assertion = verify.find((step) => step.type === "ASSERT");
    expect(assertion?.success_check).toEqual(
      expect.arrayContaining([
        { selector: "Approved", op: "equals", value: true },
        { selector: "ActionCode", op: "equals", value: "00" },
      ]),
    );
  });

  test("projects the status rules with the operations of the executor", async () => {
    const prisma = await seed();
    const provider = new PrismaFlowProvider(prisma);
    const steps = await provider.getSteps("SUBMIT", attemptFor("cbl_lypay"));
    const rules = steps[0]?.status_rules ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(["equals", "not_equals", "in", "exists", "matches"]).toContain(rule.op);
    }
    expect(
      rules.some(
        (rule) => rule.canonical_status === "VERIFYING" && rule.value === "Processing",
      ),
    ).toBe(true);
  });

  test("selects the flow of the sub mode of the attempt", async () => {
    const prisma = await seed();
    const provider = new PrismaFlowProvider(prisma);
    const attempt = attemptFor("neompay");
    const push = await provider.getSteps("INITIATE", { ...attempt, subMode: "PUSH_APPROVAL" });
    expect(push.find((step) => step.type === "HTTP")?.url_template).toBe(
      "https://sandbox.neompay.example.ly/payments/requests",
    );
    const qr = await provider.getSteps("INITIATE", { ...attempt, subMode: "QR_DISPLAY" });
    expect(qr.find((step) => step.type === "COMPUTE")?.compute?.name).toBe("NEOMPAY_QR_PAYLOAD");
  });
});
