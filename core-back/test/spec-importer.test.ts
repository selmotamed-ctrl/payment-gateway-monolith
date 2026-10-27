import { describe, expect, test } from "bun:test";
import {
  IntegrationSpecSchema,
  SPEC_TRANSFORM_OPERATIONS,
  SPEC_VERSION,
  buildTranscriptKit,
  simulateSpec,
  validateSpecSemantics,
  type IntegrationSpec,
} from "../engine/specImporter";
import { TRANSFORM_OPERATIONS } from "../engine/transforms/TransformPipeline";
import { otpSpec, brokenSpec } from "./fixtures/otpSpec";

describe("integration spec schema", () => {
  test("accepts the documented OTP spec and applies the defaults", () => {
    const parsed = IntegrationSpecSchema.safeParse(otpSpec());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.spec_version).toBe(SPEC_VERSION);
    expect(parsed.data.rail_route.cost_model.calc_type).toBe("PERCENTAGE");
    expect(parsed.data.settings.amount_scale).toBe(1000);
    expect(parsed.data.flows[0]?.steps[0]?.idempotency_config.mode).toBe("NONE");
  });

  test("rejects an unknown auth method with a path-bearing diagnostic", async () => {
    const spec = { ...otpSpec(), auth: [{ env: "SANDBOX", method: "MAGIC", apply: "HEADER" }] };
    const report = await simulateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.layers[0]?.passed).toBe(false);
    const error = report.errors.find((entry) => entry.path.includes("auth"));
    expect(error?.code).toBe("SCHEMA_INVALID");
    expect(report.aiRepairPrompt).toContain("integration-spec.json");
  });

  test("rejects a wrong spec_version", async () => {
    const report = await simulateSpec({ ...otpSpec(), spec_version: "9.9" });
    expect(report.valid).toBe(false);
    expect(report.errors[0]?.path).toBe("spec_version");
  });

  test("the advertised transform list matches the engine's closed library", () => {
    expect([...SPEC_TRANSFORM_OPERATIONS]).toEqual([...TRANSFORM_OPERATIONS]);
  });
});

describe("integration spec semantic validator", () => {
  const codes = (spec: IntegrationSpec): string[] =>
    validateSpecSemantics(IntegrationSpecSchema.parse(spec)).errors.map((entry) => entry.code);

  test("the golden spec has no semantic error", () => {
    const result = validateSpecSemantics(IntegrationSpecSchema.parse(otpSpec()));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("blocks a private / loopback host", () => {
    const spec = otpSpec();
    spec.environments = [
      { ...spec.environments[0]!, base_urls: { api: "https://127.0.0.1" }, allowed_hosts: ["127.0.0.1"] },
    ];
    expect(codes(spec)).toContain("PRIVATE_HOST_BLOCKED");
  });

  test("blocks a base URL whose host is not in allowed_hosts", () => {
    const spec = otpSpec();
    spec.environments = [
      { ...spec.environments[0]!, base_urls: { api: "https://other.acme.ly" }, allowed_hosts: ["sandbox.acme.ly"] },
    ];
    expect(codes(spec)).toContain("HOST_NOT_ALLOWED");
  });

  test("blocks PREVIOUS_RESPONSE on the first step", () => {
    const spec = otpSpec();
    spec.flows[0]!.steps[0]!.parameters = [
      { place: "BODY", key: "prev", source: "PREVIOUS_RESPONSE", selector: "x" },
    ];
    expect(codes(spec)).toContain("PREVIOUS_RESPONSE_ON_FIRST_STEP");
  });

  test("blocks a MOVES_MONEY step that retries unless it is idempotent", () => {
    const spec = otpSpec();
    const step = spec.flows[1]!.steps[0]!;
    step.retry_policy = "SAFE_WITH_COOLDOWN";
    expect(codes(spec)).toContain("MOVES_MONEY_RETRY_NOT_NEVER");

    // The same step is legal when the gateway proves an idempotency key.
    const idempotent = otpSpec();
    idempotent.settings.supports_idempotency_key = true;
    idempotent.flows[1]!.steps[0]!.retry_policy = "SAFE_WITH_COOLDOWN";
    idempotent.flows[1]!.steps[0]!.idempotency_config = {
      mode: "HEADER",
      key_name: "Idempotency-Key",
      source_template: "{{reference}}",
    };
    expect(codes(idempotent)).not.toContain("MOVES_MONEY_RETRY_NOT_NEVER");
  });

  test("blocks an unknown crypto profile reference", () => {
    const spec = otpSpec();
    spec.flows[0]!.steps[0]!.parameters = [
      { place: "FORM", key: "SecureHash", source: "CRYPTO_SIGNATURE", crypto_profile: "nope" },
    ];
    expect(codes(spec)).toContain("UNKNOWN_CRYPTO_PROFILE");
  });

  test("blocks an unknown url placeholder", () => {
    const spec = otpSpec();
    spec.flows[0]!.steps[0]!.url_template = "{unknown}/verify";
    expect(codes(spec)).toContain("UNKNOWN_URL_PLACEHOLDER");
  });

  test("blocks a weak inbound channel that does not inquire", () => {
    const spec = otpSpec();
    spec.confirmation_channels[0]!.verify_method = "IP_ONLY";
    spec.confirmation_channels[0]!.must_inquire = false;
    expect(codes(spec)).toContain("WEAK_VERIFICATION_REQUIRES_INQUIRY");
  });

  test("blocks a spec without test vectors", () => {
    const spec = otpSpec();
    spec.test_vectors = [];
    expect(codes(spec)).toContain("TEST_VECTORS_MISSING");
  });

  test("blocks an unimportable step type but explains the workaround", () => {
    const spec = otpSpec();
    (spec.flows[0]!.steps[0] as { type: string }).type = "WAIT";
    const result = validateSpecSemantics(IntegrationSpecSchema.parse(spec));
    const error = result.errors.find((entry) => entry.code === "STEP_TYPE_NOT_IMPORTABLE");
    expect(error).toBeDefined();
    expect(error?.aiFixHint).toContain("wizard");
  });

  test("reports all the defects of a broken spec at once", () => {
    const result = validateSpecSemantics(IntegrationSpecSchema.parse(brokenSpec()));
    const found = result.errors.map((entry) => entry.code);
    expect(found).toContain("PRIVATE_HOST_BLOCKED");
    expect(found).toContain("PREVIOUS_RESPONSE_ON_FIRST_STEP");
    expect(found).toContain("MOVES_MONEY_RETRY_NOT_NEVER");
    expect(found).toContain("TEST_VECTORS_MISSING");
  });
});

describe("offline vector simulator", () => {
  test("the golden OTP spec passes all four layers", async () => {
    const report = await simulateSpec(otpSpec());
    expect(report.valid).toBe(true);
    expect(report.layers.map((layer) => layer.passed)).toEqual([true, true, true, true]);
    expect(report.vectorResults).toHaveLength(2);
    expect(report.vectorResults.every((vector) => vector.passed)).toBe(true);
    expect(report.summary.passedVectors).toBe(2);
    expect(report.requiredCredentials.map((credential) => credential.key)).toEqual([
      "MID",
      "MerchantSecretKey",
    ]);
    expect(report.aiRepairPrompt).toBeUndefined();
  });

  test("the initiate vector reaches AWAITING_CUSTOMER and sends the wire amount", async () => {
    const report = await simulateSpec(otpSpec());
    const vector = report.vectorResults.find((entry) => entry.phase === "INITIATE");
    expect(vector?.status).toBe("AWAITING_CUSTOMER");
    expect(vector?.extractions.process_id).toBe("PROC-1");
    expect(vector?.requests.some((request) => `${request.body}`.includes("100000"))).toBe(true);
  });

  test("a wrong expected extraction is a Layer 3 failure", async () => {
    const spec = otpSpec();
    spec.test_vectors[0]!.expect.extractions = { process_id: "WRONG" };
    const report = await simulateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.layers[2]?.passed).toBe(false);
    expect(report.errors.some((entry) => entry.code === "VECTOR_EXTRACTION_MISMATCH")).toBe(true);
    expect(report.aiRepairPrompt).toContain("VECTOR_EXTRACTION_MISMATCH");
  });

  test("a wrong expected status is a Layer 3 failure", async () => {
    const spec = otpSpec();
    spec.test_vectors[1]!.expect.status = "FAILED";
    const report = await simulateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((entry) => entry.code === "VECTOR_STATUS_MISMATCH")).toBe(true);
  });

  test("a wrong wire amount is a Layer 3 failure", async () => {
    const spec = otpSpec();
    spec.test_vectors[0]!.expect.wire_amount = "999999";
    const report = await simulateSpec(spec);
    expect(report.valid).toBe(false);
    expect(report.errors.some((entry) => entry.code === "VECTOR_WIRE_AMOUNT_MISMATCH")).toBe(true);
  });

  test("the signature vector proves the crypto recipe (and fails when it is wrong)", async () => {
    // The signature is a FORM field of the INITIATE request. Run once without
    // an expectation, read the value the engine actually produced, then prove
    // the check accepts it and rejects a tampered value.
    const baseline = await simulateSpec(otpSpec());
    const initiate = baseline.vectorResults.find((entry) => entry.phase === "INITIATE");
    const body = initiate?.requests[0]?.body ?? "";
    const match = /(?:^|&)SecureHash=([0-9A-Fa-f]+)/.exec(body);
    expect(match?.[1]).toBeDefined();
    const signature = match?.[1] as string;

    const good = otpSpec();
    good.test_vectors[0]!.expect.signature = { expected: signature };
    const goodReport = await simulateSpec(good);
    expect(goodReport.valid).toBe(true);

    const bad = otpSpec();
    bad.test_vectors[0]!.expect.signature = { expected: "DEADBEEF" };
    const badReport = await simulateSpec(bad);
    expect(badReport.valid).toBe(false);
    expect(badReport.errors.some((entry) => entry.code === "VECTOR_SIGNATURE_MISMATCH")).toBe(true);
  });

  test("Layer 4 returns the collision result", async () => {
    let called = false;
    const report = await simulateSpec(otpSpec(), {
      collisionChecker: async () => {
        called = true;
        return { gatewayExists: true, railCodeExists: true, versionCount: 2 };
      },
    });
    expect(called).toBe(true);
    expect(report.collision).toEqual({ gatewayExists: true, railCodeExists: true, versionCount: 2 });
    // Layers 2 and 3 still run even when the code exists: the admin decides
    // between "Create New" and "New Version".
    expect(report.valid).toBe(true);
  });
});

describe("AI transcript", () => {
  test("is self-contained: version, closed lists, schema and examples", () => {
    const kit = buildTranscriptKit({ generatedAt: new Date("2026-01-01T00:00:00.000Z") });
    expect(kit.specVersion).toBe(SPEC_VERSION);
    expect(kit.contentType).toBe("text/markdown");
    expect(kit.markdown).toContain(`spec_version: \`${SPEC_VERSION}\``);
    expect(kit.markdown).toContain('"$schema"');
    expect(kit.markdown).toContain("MUTUAL_TLS");
    expect(kit.markdown).toContain("hmac_sha256");
    expect(kit.markdown).toContain("<<< PASTE THE PROVIDER'S API DOCUMENTATION HERE >>>");
    // Two gold-standard examples (an OTP rail and a Redirect rail).
    expect(kit.markdown).toContain("acme-otp");
    expect(kit.markdown).toContain("acme-redirect");
    // The vocabulary is returned structurally as well.
    expect(kit.vocabulary.auth_methods).toContain("MUTUAL_TLS");
    expect(kit.vocabulary.flow_phases).toContain("SETTLEMENT_FETCH");
  });

  test("tailors the example to the requested rail kind", () => {
    const otp = buildTranscriptKit({ railKind: "OTP_PULL" });
    expect(otp.filename).toContain("otp_pull");
    expect(otp.markdown).toContain("acme-otp");
    expect(otp.markdown).not.toContain("acme-redirect");

    const redirect = buildTranscriptKit({ railKind: "REDIRECT" });
    expect(redirect.markdown).toContain("acme-redirect");
    expect(redirect.markdown).not.toContain("acme-otp");
  });

  test("warns the AI never to be given a live secret", () => {
    const kit = buildTranscriptKit();
    expect(kit.markdown.toLowerCase()).toContain("never");
    expect(kit.markdown).toContain("required_credentials");
    expect(kit.markdown).toContain("never real secrets");
  });
});
