import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getBaseClient } from "../prisma/client/base";
import { materializeSpec } from "../engine/specImporter";
import { otpSpec } from "./fixtures/otpSpec";

const client = getBaseClient();
const RUN = randomUUID().replace(/-/g, "").slice(0, 8);
const gatewayCode = `acme-otp-${RUN}`;
const railCode = `acme-rail-${RUN}`;
let actorId = "";
let reachable = false;

const buildSpec = () => {
  const spec = otpSpec();
  spec.gateway.code = gatewayCode;
  spec.rail.code = railCode;
  spec.gateway.name = `Acme OTP ${RUN}`;
  spec.confirmation_channels[0]!.path_token = `acme-webhook-${RUN}`;
  return spec;
};

beforeAll(async () => {
  try {
    await client.$queryRawUnsafe("SELECT 1");
    reachable = true;
  } catch {
    reachable = false;
    return;
  }
  const user = await client.user.create({
    data: {
      email: `spec-import-${RUN}@example.test`,
      role: "GATEWAY_ADMIN",
      authoritiesMap: { gateway: ["read", "write"] },
      isMaker: true,
      isChecker: false,
      mfaRequired: false,
      status: "ACTIVE",
      passwordHash: null,
    },
  });
  actorId = user.id;
});

afterAll(async () => {
  if (!reachable) {
    return;
  }
  // Delete in reverse dependency order.
  const versions = await client.gatewayVersion.findMany({ where: { gateway: { code: gatewayCode } } });
  for (const version of versions) {
    const flows = await client.flow.findMany({ where: { gatewayVersionId: version.id }, select: { id: true } });
    for (const flow of flows) {
      const steps = await client.flowStep.findMany({ where: { flowId: flow.id }, select: { id: true } });
      const stepIds = steps.map((step) => step.id);
      await client.stepOutput.deleteMany({ where: { stepId: { in: stepIds } } });
      await client.stepParameter.deleteMany({ where: { stepId: { in: stepIds } } });
      await client.flowStep.deleteMany({ where: { flowId: flow.id } });
    }
    await client.flow.deleteMany({ where: { gatewayVersionId: version.id } });
    await client.statusRule.deleteMany({ where: { gatewayVersionId: version.id } });
    await client.errorMap.deleteMany({ where: { gatewayVersionId: version.id } });
    await client.confirmationChannel.deleteMany({ where: { gatewayVersionId: version.id } });
    await client.stepParameter.deleteMany({ where: { cryptoProfile: { gatewayVersionId: version.id } } });
    await client.cryptoProfile.deleteMany({ where: { gatewayVersionId: version.id } });
    await client.gatewaySetting.deleteMany({ where: { gatewayVersionId: version.id } });
    await client.gatewayAuth.deleteMany({ where: { gatewayVersionId: version.id } });
    await client.gatewayEnvironment.deleteMany({ where: { gatewayVersionId: version.id } });
  }
  const gateway = await client.gateway.findUnique({ where: { code: gatewayCode } });
  if (gateway) {
    await client.railRoute.deleteMany({ where: { gatewayId: gateway.id } });
    await client.credentialSet.deleteMany({ where: { gatewayId: gateway.id } });
    await client.gateway.update({ where: { id: gateway.id }, data: { activeVersionId: null } }).catch(() => undefined);
    await client.gatewayVersion.deleteMany({ where: { gatewayId: gateway.id } });
    await client.gateway.delete({ where: { id: gateway.id } });
  }
  const rail = await client.rail.findUnique({ where: { code: railCode } });
  if (rail) {
    await client.railField.deleteMany({ where: { railId: rail.id } });
    await client.rail.delete({ where: { id: rail.id } });
  }
  if (actorId) {
    await client.user.delete({ where: { id: actorId } }).catch(() => undefined);
  }
  await client.$disconnect();
});

describe("spec materializer", () => {
  test("imports a verified spec as a DRAFT version in one transaction", async () => {
    if (!reachable) {
      console.log("[spec-materializer] database not reachable, skipping");
      return;
    }
    const result = await materializeSpec(client as never, {
      spec: buildSpec(),
      credentialsValues: { MID: "merchant-1", MerchantSecretKey: "a".repeat(32) },
      mode: "CREATE_NEW",
      actorId,
    });

    expect(result.versionState).toBe("DRAFT");
    expect(result.gatewayCode).toBe(gatewayCode);
    expect(result.railCode).toBe(railCode);
    expect(result.counts.environments).toBe(2);
    expect(result.counts.auth).toBe(2);
    expect(result.counts.cryptoProfiles).toBe(1);
    expect(result.counts.flows).toBe(2);
    expect(result.counts.steps).toBe(2);
    expect(result.counts.channels).toBe(1);
    expect(result.counts.errorMaps).toBe(1);
    expect(result.counts.railFields).toBe(2);
    expect(result.verification.valid).toBe(true);

    const version = await client.gatewayVersion.findUnique({
      where: { id: result.gatewayVersionId },
      include: { environments: true, auth: true, setting: true, cryptoProfiles: true, confirmationChannels: true },
    });
    expect(version?.state).toBe("DRAFT");
    expect(version?.environments).toHaveLength(2);
    expect(version?.auth).toHaveLength(2);
    expect(version?.setting?.amountScale).toBe(1000);
    expect(version?.cryptoProfiles[0]?.name).toBe("acme-sign");
    expect(version?.confirmationChannels[0]?.mustInquire).toBe(false);

    // The flows, steps, parameters and outputs are stored.
    const flows = await client.flow.findMany({
      where: { gatewayVersionId: result.gatewayVersionId },
      include: { steps: { include: { parameters: true, outputs: true } } },
    });
    expect(flows.map((flow) => flow.phase).sort()).toEqual(["INITIATE", "SUBMIT"]);
    const submit = flows.find((flow) => flow.phase === "SUBMIT");
    const submitStep = submit?.steps[0];
    expect(submitStep?.sideEffect).toBe("MOVES_MONEY");
    expect(submitStep?.retryPolicy).toBe("NEVER");
    expect(submitStep?.pointOfNoReturn).toBe(true);
    expect(submitStep?.outputs.some((output) => output.storeAs === "PROVIDER_REF")).toBe(true);

    // The CRYPTO_SIGNATURE parameter is bound to the created profile.
    const initiate = flows.find((flow) => flow.phase === "INITIATE");
    const signatureParameter = initiate?.steps[0]?.parameters.find(
      (parameter) => parameter.source === "CRYPTO_SIGNATURE",
    );
    expect(signatureParameter?.cryptoProfileId).toBeTruthy();

    // The route is imported PAUSED and the credential set is UNTESTED, so the
    // new integration cannot take live traffic before the admin promotes it.
    const route = await client.railRoute.findFirst({ where: { railId: result.railId, gatewayId: result.gatewayId } });
    expect(route?.status).toBe("PAUSED");
    expect(result.credentialSetId).toBeTruthy();
    const credentialSet = await client.credentialSet.findUnique({ where: { id: result.credentialSetId! } });
    expect(credentialSet?.status).toBe("UNTESTED");
    const entries = credentialSet?.entriesCiphertext as Array<{ key: string; isSecret: boolean; value: string }>;
    expect(entries.some((entry) => entry.key === "MID")).toBe(true);
    // The secret is encrypted, never stored in clear.
    const secretEntry = entries.find((entry) => entry.key === "MerchantSecretKey");
    expect(secretEntry?.isSecret).toBe(true);
    expect(secretEntry?.value).not.toBe("a".repeat(32));
  });

  test("re-importing as NEW_VERSION adds a second DRAFT version", async () => {
    if (!reachable) {
      return;
    }
    const spec = buildSpec();
    // The gateway already exists from the first test; a NEW_VERSION import is
    // the way to add a configuration change.
    spec.confirmation_channels[0]!.path_token = `acme-webhook-v2-${RUN}`;
    const result = await materializeSpec(client as never, {
      spec,
      credentialsValues: { MID: "merchant-1", MerchantSecretKey: "b".repeat(32) },
      mode: "NEW_VERSION",
      actorId,
    });
    expect(result.versionNumber).toBeGreaterThanOrEqual(2);
    const versions = await client.gatewayVersion.findMany({ where: { gateway: { code: gatewayCode } } });
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions.every((version) => version.state === "DRAFT")).toBe(true);
  });

  test("a CREATE_NEW import of an existing gateway code is refused", async () => {
    if (!reachable) {
      return;
    }
    await expect(
      materializeSpec(client as never, {
        spec: buildSpec(),
        credentialsValues: { MID: "merchant-1", MerchantSecretKey: "c".repeat(32) },
        mode: "CREATE_NEW",
        actorId,
      }),
    ).rejects.toThrow(/already exists/);
  });

  test("an invalid spec is refused before anything is written", async () => {
    if (!reachable) {
      return;
    }
    const spec = buildSpec();
    spec.gateway.code = `invalid-${RUN}`;
    spec.test_vectors[0]!.expect.status = "FAILED";
    const before = await client.gateway.count({ where: { code: spec.gateway.code } });
    await expect(
      materializeSpec(client as never, { spec, actorId, mode: "CREATE_NEW" }),
    ).rejects.toThrow(/verification/i);
    const after = await client.gateway.count({ where: { code: spec.gateway.code } });
    expect(after).toBe(before);
  });
});
