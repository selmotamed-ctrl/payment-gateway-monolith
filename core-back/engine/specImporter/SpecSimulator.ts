import { createHash } from "node:crypto";
import type { ZodError } from "zod";
import {
  IntegrationSpecSchema,
  SPEC_VERSION,
  type CryptoProfileSpecType,
  type IntegrationSpec,
  type TestVectorSpecType,
} from "./specSchema";
import { validateSpecSemantics, type SpecDiagnostic } from "./specValidator";
import {
  StepExecutor,
  type FlowStep,
  type StepExecutionContext,
  type StepExecutionResult,
} from "../flow/StepExecutor";
import type { CryptoProfileConfig } from "../flow/StepExecutor";

export interface CollisionResult {
  gatewayExists: boolean;
  railCodeExists: boolean;
  versionCount: number;
}

export interface VectorOutcome {
  name: string;
  phase: string;
  passed: boolean;
  /** The canonical status the flow reached. */
  status?: string;
  extractions: Record<string, unknown>;
  requests: Array<{ method: string; url: string; headers: Record<string, string>; body: string }>;
  errors: SpecDiagnostic[];
}

export interface VerificationLayer {
  layer: number;
  name: string;
  passed: boolean;
  errorCount: number;
  warningCount: number;
}

export interface VerificationReport {
  valid: boolean;
  specVersion: string | null;
  layers: VerificationLayer[];
  summary: {
    gatewayCode: string | null;
    railCode: string | null;
    collectionMode: string | null;
    vectorCount: number;
    passedVectors: number;
    flowPhases: string[];
    errorCount: number;
    warningCount: number;
  };
  requiredCredentials: Array<{ key: string; is_secret: boolean; encoding?: string; description?: string; type: string }>;
  vectorResults: VectorOutcome[];
  errors: SpecDiagnostic[];
  warnings: SpecDiagnostic[];
  collision?: CollisionResult;
  /** A ready-to-paste message for the external AI when the spec is invalid. */
  aiRepairPrompt?: string;
  /** The spec normalised by the schema (defaults applied), when Layer 1 passed. */
  normalizedSpec?: IntegrationSpec;
}

export interface SimulateOptions {
  /** Layer 4: is the gateway / rail code already taken? */
  collisionChecker?: (spec: IntegrationSpec) => Promise<CollisionResult>;
  /**
   * Dummy (or sandbox) secret values used only to compute signatures offline.
   * Live secrets must NEVER be passed here: the whole point of the kit is that
   * the secret never leaves the admin's machine before the import.
   */
  secrets?: Record<string, string>;
  /** The real compute operations (the core route supplies the production registry). */
  computeRegistry?: Record<string, (input: unknown, context: StepExecutionContext) => Promise<unknown> | unknown>;
  clock?: () => Date;
}

const zodToDiagnostics = (error: ZodError): SpecDiagnostic[] =>
  error.issues.map((issue) => {
    const path = issue.path
      .map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`))
      .join("")
      .replace(/^\./, "");
    return {
      path,
      code: "SCHEMA_INVALID",
      message: issue.message,
      aiFixHint: `Fix the value at '${path || "(root)"}' so it matches the transcript's JSON schema: ${issue.message}.`,
    };
  });

/**
 * A stable, obviously-fake secret for the offline simulation.
 *
 * It must satisfy the credential's declared encoding (a HEX profile cannot
 * sign with an arbitrary UTF8 string), it is deterministic so a vector's
 * expected signature is reproducible, and it is clearly marked as a
 * simulation value so it can never be mistaken for a live secret.
 */
export const simulationSecretFor = (
  key: string,
  encoding?: "UTF8" | "HEX" | "BASE64",
): string => {
  const digest = createHash("sha256").update(`sim:${key}`).digest();
  switch (encoding) {
    case "HEX":
      return digest.toString("hex");
    case "BASE64":
      return digest.toString("base64");
    default:
      return `sim-${key}`.padEnd(16, "0");
  }
};

const resolveTemplate = (
  template: string,
  baseUrls: Record<string, string>,
  pathParameters: Record<string, string>,
): string =>
  template.replace(/\{\{?\s*([A-Za-z0-9_.-]+)\s*\}?\}/g, (match, rawKey: string) => {
    const key = String(rawKey);
    if (pathParameters[key] !== undefined) {
      return encodeURIComponent(pathParameters[key] as string);
    }
    const base = baseUrls[key];
    return base ?? match;
  });

const toFlowStep = (
  step: IntegrationSpec["flows"][number]["steps"][number],
  baseUrls: Record<string, string>,
  cryptoProfileIdByName: Map<string, string>,
  pathParameters: Record<string, string>,
): FlowStep => ({
  id: step.id,
  type: step.type,
  order_index: step.order_index,
  method: step.method,
  url_template: step.url_template ? resolveTemplate(step.url_template, baseUrls, pathParameters) : undefined,
  content_type: step.content_type,
  xml_template: step.xml_template,
  timeout_ms: step.timeout_ms,
  side_effect: step.side_effect,
  retry_policy: step.retry_policy,
  point_of_no_return: step.point_of_no_return,
  idempotency_config: step.idempotency_config as FlowStep["idempotency_config"],
  compute: step.compute
    ? { name: step.compute.name, transforms: step.compute.transforms as never }
    : undefined,
  render: step.render
    ? { action: step.render.action, values: step.render.values }
    : undefined,
  wait: step.wait
    ? { durationMs: step.wait.duration_ms, timeoutMs: step.wait.timeout_ms }
    : undefined,
  assertions: step.assertions as never,
  branch: step.branch
    ? {
        selector: step.branch.selector,
        op: step.branch.op,
        value: step.branch.value,
        thenStepId: step.branch.then_step_id,
        elseStepId: step.branch.else_step_id,
      }
    : undefined,
  parameters: step.parameters.map((parameter) => ({
    place: parameter.place,
    key: parameter.key,
    source: parameter.source,
    selector: parameter.selector,
    constant_value: parameter.constant_value,
    crypto_profile_id: parameter.crypto_profile
      ? cryptoProfileIdByName.get(parameter.crypto_profile)
      : undefined,
    transforms: parameter.transforms as never,
  })),
  outputs: step.outputs.map((output) => ({
    name: output.name,
    selector: output.selector,
    transforms: output.transforms as never,
    store_as: output.store_as,
    required: output.required,
  })),
  status_rules: step.status_rules.map((rule) => ({
    selector: rule.selector,
    op: rule.op,
    value: rule.value,
    canonical_status: rule.canonical_status,
    canonical_substatus: rule.canonical_substatus,
    canonical_error: rule.canonical_error,
  })),
});

const toCryptoProfileConfig = (profile: CryptoProfileSpecType): CryptoProfileConfig => ({
  algorithm: profile.algorithm,
  canonicalizationMode: profile.canonicalization_mode,
  secretKeyRef: profile.secret_key_ref ?? null,
  secretKeyEncoding: profile.secret_key_encoding,
  outputEncoding: profile.output_encoding,
  includedFields: profile.included_fields,
  excludedFields: profile.excluded_fields,
  templateString: profile.template_string ?? null,
});

const outputValue = (
  output: StepExecutionResult["output"],
  declared: { name: string; store_as: string },
): unknown => {
  switch (declared.store_as) {
    case "STATE":
      return output.state[declared.name];
    case "PUBLIC":
      return output.public[declared.name];
    case "SETTLED_AMOUNT":
      return output.settledAmount;
    case "PROVIDER_FEE":
      return output.providerFee;
    case "PROVIDER_REF":
      return output.providerReference;
    case "NETWORK_REF":
      return output.networkReference;
    default:
      return output.state[declared.name] ?? output.public[declared.name];
  }
};

const captureValue = (headers: Record<string, string>, body: string, expected: string): boolean =>
  Object.values(headers).some((value) => value === expected)
  || body.includes(expected);

const simulateVector = async (
  spec: IntegrationSpec,
  vector: TestVectorSpecType,
  options: SimulateOptions,
): Promise<VectorOutcome> => {
  const errors: SpecDiagnostic[] = [];
  const index = spec.test_vectors.indexOf(vector);
  const baseUrls: Record<string, string> = {};
  for (const environment of spec.environments) {
    for (const [name, url] of Object.entries(environment.base_urls)) {
      baseUrls[name] = url;
    }
  }

  const cryptoProfileIdByName = new Map<string, string>();
  spec.crypto_profiles.forEach((profile, profileIndex) => {
    cryptoProfileIdByName.set(profile.name, `sim-profile-${profileIndex}:${profile.name}`);
  });
  const cryptoProfileByName = new Map(spec.crypto_profiles.map((profile) => [profile.name, profile]));

  const secrets: Record<string, string> = {};
  for (const credential of spec.required_credentials) {
    secrets[credential.key] = options.secrets?.[credential.key]
      ?? simulationSecretFor(credential.key, credential.encoding);
  }

  const requests: VectorOutcome["requests"] = [];
  const responseBody = typeof vector.response === "string"
    ? vector.response
    : JSON.stringify(vector.response ?? {});
  const contentType = "application/json";

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? {});
    requests.push({
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "",
    });
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": contentType },
    });
  }) as unknown as typeof fetch;

  const executor = new StepExecutor({
    fetch: fetchImpl,
    allowedHosts: spec.environments.flatMap((environment) => environment.allowed_hosts),
    cryptoProfileResolver: async (id) => {
      const name = id.includes(":") ? id.split(":").slice(1).join(":") : id;
      const profile = cryptoProfileByName.get(name);
      return profile ? toCryptoProfileConfig(profile) : null;
    },
    secretResolver: { resolveSecret: (reference: string) => secrets[reference] ?? simulationSecretFor(reference) },
    computeRegistry: options.computeRegistry,
    literalSecrets: Object.values(secrets),
    maxJsonDepth: 64,
    maxResponseBytes: 2097152,
  });

  const flow = spec.flows.find(
    (candidate) => candidate.phase === vector.phase,
  );
  if (!flow) {
    errors.push({
      path: `test_vectors[${index}]`,
      code: "VECTOR_PHASE_WITHOUT_FLOW",
      message: `No ${vector.phase} flow exists for the vector '${vector.name}'.`,
      aiFixHint: `Add a flows entry with phase = "${vector.phase}".`,
    });
    return { name: vector.name, phase: vector.phase, passed: false, extractions: {}, requests, errors };
  }

  const amount = typeof vector.request.amount === "string" ? vector.request.amount : "100.0000";
  const currency = typeof vector.request.currency === "string" ? vector.request.currency : "LYD";
  const attempt: Record<string, unknown> = {
    id: `sim-attempt-${index}`,
    reference: `SIM-${index + 1}`,
    totalChargedAmount: amount,
    requestedAmount: amount,
    currency,
    env: "SANDBOX",
    ...vector.request,
  };

  // The vector's `request` is what the flow sees: it seeds the customer fields
  // AND the state, so a later-phase vector (e.g. SUBMIT) can resolve the
  // process id an earlier phase stored.
  const state: Record<string, unknown> = { ...vector.request };
  const publicOutputs: Record<string, unknown> = {};
  const derived: Record<string, unknown> = {};
  let previousResponse: unknown;
  let finalStatus = "SUCCEEDED";

  const steps = [...flow.steps].sort((left, right) => left.order_index - right.order_index);
  const pathParameters: Record<string, string> = {};
  for (const step of steps) {
    for (const parameter of step.parameters) {
      if (parameter.place === "PATH" && typeof parameter.selector === "string") {
        const value = attempt[parameter.selector] ?? vector.request[parameter.selector];
        if (value !== undefined) {
          pathParameters[parameter.key] = String(value);
        }
      }
    }
  }

  for (const step of steps) {
    const flowStep = toFlowStep(step, baseUrls, cryptoProfileIdByName, pathParameters);
    const context: StepExecutionContext = {
      attempt,
      customerFields: vector.request,
      credentials: secrets,
      state,
      previousResponse,
      gatewayMeta: { code: spec.gateway.code, name: spec.gateway.name },
      routeMeta: {},
      urls: baseUrls,
      transformContext: { templateValues: vector.request },
      panFieldNames: spec.rail_fields
        .filter((field) => field.sensitivity === "PAN")
        .map((field) => field.key),
    };
    let result: StepExecutionResult;
    try {
      result = await executor.execute(flowStep, context);
    } catch (error) {
      errors.push({
        path: `test_vectors[${index}]`,
        code: "VECTOR_STEP_FAILED",
        message: `The step '${step.id}' failed: ${(error as Error).message}`,
        aiFixHint: `Fix the step '${step.id}' so it can build its request from the vector: ${(error as Error).message}.`,
      });
      return { name: vector.name, phase: vector.phase, passed: false, extractions: state, requests, errors };
    }
    Object.assign(state, result.output.state);
    Object.assign(publicOutputs, result.output.public);
    // Record the value under the DECLARED output name, whatever its store:
    // a vector asserts `settled_amount`, not `settledAmount`.
    for (const declared of flowStep.outputs ?? []) {
      const value = outputValue(result.output, declared);
      if (value !== undefined) {
        derived[declared.name] = value;
      }
    }
    if (result.output.settledAmount !== undefined) derived.settledAmount = result.output.settledAmount;
    if (result.output.providerFee !== undefined) derived.providerFee = result.output.providerFee;
    if (result.output.providerReference !== undefined) derived.providerReference = result.output.providerReference;
    if (result.output.networkReference !== undefined) derived.networkReference = result.output.networkReference;
    previousResponse = result.response;
    if (["UNKNOWN", "FAILED", "VERIFYING", "AWAITING_CUSTOMER"].includes(result.status)) {
      finalStatus = result.status;
      break;
    }
  }

  // ---- expectations ----------------------------------------------------------
  if (vector.expect.status && vector.expect.status !== finalStatus) {
    errors.push({
      path: `test_vectors[${index}].expect.status`,
      code: "VECTOR_STATUS_MISMATCH",
      message: `The flow reached ${finalStatus} but the vector expects ${vector.expect.status}.`,
      aiFixHint: `The status_rules of the ${vector.phase} flow do not map the documented response to ${vector.expect.status}. Check the selector and the value of the status_rules.`,
    });
  }
  for (const [key, expected] of Object.entries(vector.expect.extractions ?? {})) {
    const actual = key in state ? state[key] : key in publicOutputs ? publicOutputs[key] : derived[key];
    const equal = typeof expected === "object" && expected !== null
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : String(actual) === String(expected);
    if (!equal) {
      errors.push({
        path: `test_vectors[${index}].expect.extractions.${key}`,
        code: "VECTOR_EXTRACTION_MISMATCH",
        message: `The extraction '${key}' is ${JSON.stringify(actual)} but the vector expects ${JSON.stringify(expected)}.`,
        aiFixHint: `The selector for '${key}' does not point at the documented field. Fix the step output selector (the documented response is ${responseBody.slice(0, 200)}).`,
      });
    }
  }
  if (vector.expect.signature) {
    const { header, expected } = vector.expect.signature;
    const found = header
      ? requests.some((request) => (request.headers[header.toLowerCase()] ?? request.headers[header]) === expected)
      : requests.some((request) => captureValue(request.headers, request.body, expected));
    if (!found) {
      errors.push({
        path: `test_vectors[${index}].expect.signature`,
        code: "VECTOR_SIGNATURE_MISMATCH",
        message: `No outbound request carried the expected signature ${expected}.`,
        aiFixHint: `The crypto profile recipe does not reproduce the provider's documented signature. Check the canonicalization_mode, the included_fields / excluded_fields and the output_encoding. The captured requests were: ${JSON.stringify(requests.map((request) => ({ headers: request.headers, body: request.body }))).slice(0, 600)}.`,
      });
    }
  }
  if (vector.expect.wire_amount) {
    const found = requests.some((request) => captureValue(request.headers, `${request.url} ${request.body}`, vector.expect.wire_amount as string));
    if (!found) {
      errors.push({
        path: `test_vectors[${index}].expect.wire_amount`,
        code: "VECTOR_WIRE_AMOUNT_MISMATCH",
        message: `No outbound request carried the expected wire amount ${vector.expect.wire_amount}.`,
        aiFixHint: `The amount pipeline does not produce ${vector.expect.wire_amount}. Check settings.amount_scale and the scale / round / format_decimal transforms on the amount parameter.`,
      });
    }
  }
  return {
    name: vector.name,
    phase: vector.phase,
    passed: errors.length === 0,
    status: finalStatus,
    extractions: { ...derived, ...publicOutputs, ...state },
    requests,
    errors,
  };
};

/**
 * Formats the diagnostics into a message the admin can paste back into the
 * external AI. This is what turns "the spec is invalid" into a one-turn fix.
 */
export const buildRepairPrompt = (
  errors: readonly SpecDiagnostic[],
  vectorErrors: readonly SpecDiagnostic[],
): string => {
  const all = [...errors, ...vectorErrors];
  if (all.length === 0) {
    return "";
  }
  const lines = [
    "The integration-spec.json you produced failed the platform's verification.",
    "Fix ONLY the problems below and return the complete corrected integration-spec.json.",
    "",
    ...all.map((error, index) =>
      `${index + 1}. [${error.code}] at ${error.path || "(root)"}\n   Problem: ${error.message}\n   Fix: ${error.aiFixHint}`,
    ),
    "",
    `spec_version must stay "${SPEC_VERSION}". Do not invent new fields, auth methods, transform operations or parameter sources: the transcript lists the closed sets.`,
  ];
  return lines.join("\n");
};

/**
 * Runs the four verification layers and returns a report. Nothing is written to
 * the database and no gateway host is contacted: Layer 3 drives the real step
 * executor against the spec's own test vectors with a captured, in-memory
 * transport.
 */
export const simulateSpec = async (
  input: unknown,
  options: SimulateOptions = {},
): Promise<VerificationReport> => {
  // ---- Layer 1: schema & version -------------------------------------------
  const parsed = IntegrationSpecSchema.safeParse(input);
  if (!parsed.success) {
    const errors = zodToDiagnostics(parsed.error);
    return {
      valid: false,
      specVersion: null,
      layers: [
        { layer: 1, name: "Schema & version", passed: false, errorCount: errors.length, warningCount: 0 },
        { layer: 2, name: "Semantic & security guard", passed: false, errorCount: 0, warningCount: 0 },
        { layer: 3, name: "Offline vector simulation", passed: false, errorCount: 0, warningCount: 0 },
        { layer: 4, name: "Collision check", passed: false, errorCount: 0, warningCount: 0 },
      ],
      summary: {
        gatewayCode: null,
        railCode: null,
        collectionMode: null,
        vectorCount: 0,
        passedVectors: 0,
        flowPhases: [],
        errorCount: errors.length,
        warningCount: 0,
      },
      requiredCredentials: [],
      vectorResults: [],
      errors,
      warnings: [],
      aiRepairPrompt: buildRepairPrompt(errors, []),
    };
  }
  const spec = parsed.data;

  // ---- Layer 2: semantics & security --------------------------------------
  const semantics = validateSpecSemantics(spec);

  // ---- Layer 3: offline vectors -------------------------------------------
  const vectorResults: VectorOutcome[] = [];
  if (semantics.valid) {
    for (const vector of spec.test_vectors) {
      vectorResults.push(await simulateVector(spec, vector, options));
    }
  }
  const vectorErrors = vectorResults.flatMap((result) => result.errors);

  // ---- Layer 4: collision --------------------------------------------------
  let collision: CollisionResult | undefined;
  let collisionPassed = true;
  if (semantics.valid && options.collisionChecker) {
    collision = await options.collisionChecker(spec);
    collisionPassed = true;
  }

  const errors = [...semantics.errors, ...vectorErrors];
  const valid = semantics.valid && vectorErrors.length === 0;
  const passedVectors = vectorResults.filter((result) => result.passed).length;

  return {
    valid,
    specVersion: spec.spec_version,
    layers: [
      { layer: 1, name: "Schema & version", passed: true, errorCount: 0, warningCount: 0 },
      {
        layer: 2,
        name: "Semantic & security guard",
        passed: semantics.valid,
        errorCount: semantics.errors.length,
        warningCount: semantics.warnings.length,
      },
      {
        layer: 3,
        name: "Offline vector simulation",
        passed: semantics.valid && vectorErrors.length === 0,
        errorCount: vectorErrors.length,
        warningCount: 0,
      },
      {
        layer: 4,
        name: "Collision check",
        passed: collisionPassed,
        errorCount: 0,
        warningCount: 0,
      },
    ],
    summary: {
      gatewayCode: spec.gateway.code,
      railCode: spec.rail.code,
      collectionMode: spec.rail.collection_mode,
      vectorCount: spec.test_vectors.length,
      passedVectors,
      flowPhases: [...new Set(spec.flows.map((flow) => flow.phase))],
      errorCount: errors.length,
      warningCount: semantics.warnings.length,
    },
    requiredCredentials: spec.required_credentials.map((credential) => ({
      key: credential.key,
      is_secret: credential.is_secret,
      encoding: credential.encoding,
      description: credential.description,
      type: credential.type,
    })),
    vectorResults,
    errors,
    warnings: semantics.warnings,
    collision,
    aiRepairPrompt: valid ? undefined : buildRepairPrompt(semantics.errors, vectorErrors),
    normalizedSpec: spec,
  };
};
