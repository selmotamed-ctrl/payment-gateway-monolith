import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ApiError } from "../../lib/error";
import { Vault } from "../crypto/Vault";
import {
  CryptoEngine,
  type CanonicalizationMode,
  type CryptoAlgorithm,
  type CryptoSecretResolver,
  type HashOutputEncoding,
  type KeyEncoding,
} from "../crypto/CryptoEngine";
import { compileUrl, assertNoControlCharacters, encodeForDestination, validateFinalUrl, type QueryValue } from "../apiConsumer/compileUrl";
import { recursiveSelect } from "../apiConsumer/recursiveSelect";
import { recursiveSet } from "../apiConsumer/recursiveSet";
import { isPublicIpAddress, type ApiConsumer, type ConsumerRetryPolicy, type ConsumerSideEffect } from "../apiConsumer/ApiConsumer";
import { TransformPipeline, type TransformContext, type TransformPipe } from "../transforms/TransformPipeline";

export type StepType = "HTTP" | "COMPUTE" | "RENDER" | "WAIT" | "ASSERT" | "BRANCH";
type FetchBody = string | Uint8Array | ArrayBuffer | URLSearchParams | FormData | Blob;
export type StepParameterPlace = "HEADERS" | "QUERY" | "PATH" | "BODY" | "FORM" | "MULTIPART" | "XML";
export type StepParameterSource =
  | "GATEWAY_META"
  | "ROUTE_META"
  | "CREDENTIAL"
  | "ATTEMPT"
  | "CUSTOMER_FIELD"
  | "STATE"
  | "PREVIOUS_RESPONSE"
  | "URLS"
  | "CLIENT_CONTEXT"
  | "CONSTANT"
  | "NOW"
  | "RANDOM"
  | "COMPUTED"
  | "CRYPTO_SIGNATURE";
export type StepOutputStore = "STATE" | "PUBLIC" | "SETTLED_AMOUNT" | "PROVIDER_FEE" | "PROVIDER_REF" | "NETWORK_REF";
export type CanonicalStepStatus = "AWAITING_CUSTOMER" | "VERIFYING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

export interface StepParameter {
  place: StepParameterPlace;
  key: string;
  source: StepParameterSource;
  selector?: string;
  constant_value?: unknown;
  crypto_profile_id?: string;
  transforms?: readonly TransformPipe[];
}

export interface StepOutput {
  name: string;
  selector?: string;
  transforms?: readonly TransformPipe[];
  store_as: StepOutputStore;
  required?: boolean;
}

/**
 * The declarative idempotency recipe of a step. `HEADER` injects the rendered
 * key as a request header, `BODY_FIELD` injects it into the JSON body.
 */
export type StepIdempotencyMode = "NONE" | "HEADER" | "BODY_FIELD";

export interface StepIdempotencyConfig {
  mode: StepIdempotencyMode;
  key_name?: string;
  source_template?: string;
}

/**
 * The declarative signing recipe of a `CRYPTO_SIGNATURE` step parameter.
 */
export interface CryptoProfileConfig {
  algorithm: CryptoAlgorithm;
  canonicalizationMode: CanonicalizationMode;
  secretKeyRef?: string | null;
  secretKeyEncoding?: KeyEncoding;
  outputEncoding?: HashOutputEncoding;
  includedFields?: readonly string[];
  excludedFields?: readonly string[];
  templateString?: string | null;
}

export interface StepAssertion {
  selector: string;
  op: "equals" | "not_equals" | "in" | "exists" | "matches";
  value?: unknown;
}

export interface StatusRule {
  selector: string;
  op: "equals" | "not_equals" | "in" | "exists" | "matches";
  value?: unknown;
  canonical_status: CanonicalStepStatus;
  canonical_substatus?: string;
  canonical_error?: string;
}

export interface ComputeStepDefinition {
  name: string;
  input?: unknown;
  transforms?: readonly TransformPipe[];
}

export interface RenderStepDefinition {
  action: "SHOW_OTP_FORM" | "HTTP_REDIRECT" | "RENDER_EMBEDDED" | "SHOW_QR_OR_CODE" | "SHOW_PUSH_OR_TRANSFER";
  values?: Record<string, unknown>;
  transforms?: readonly TransformPipe[];
}

export interface WaitStepDefinition {
  durationMs?: number;
  event?: string;
  timeoutMs?: number;
}

export interface BranchStepDefinition {
  selector: string;
  op: "equals" | "not_equals" | "in" | "exists" | "matches";
  value?: unknown;
  thenStepId?: string;
  elseStepId?: string;
}

export interface FlowStep {
  id: string;
  type: StepType;
  order_index?: number;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url_template?: string;
  content_type?: string;
  xml_template?: string;
  timeout_ms?: number;
  side_effect?: ConsumerSideEffect;
  retry_policy?: ConsumerRetryPolicy;
  point_of_no_return?: boolean;
  idempotency_config?: StepIdempotencyConfig;
  parameters?: readonly StepParameter[];
  outputs?: readonly StepOutput[];
  success_check?: StepAssertion[];
  status_rules?: readonly StatusRule[];
  compute?: ComputeStepDefinition;
  render?: RenderStepDefinition;
  wait?: WaitStepDefinition;
  assertions?: readonly StepAssertion[];
  branch?: BranchStepDefinition;
  max_attempts?: number;
  retry_delay_ms?: number;
}

export interface StepExecutionContext {
  gatewayMeta?: Record<string, unknown>;
  routeMeta?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  attempt?: Record<string, unknown>;
  customerFields?: Record<string, unknown>;
  state?: Record<string, unknown>;
  previousResponse?: unknown;
  urls?: Record<string, unknown>;
  clientContext?: Record<string, unknown>;
  constants?: Record<string, unknown>;
  transformContext?: TransformContext;
  signal?: AbortSignal;
  panFieldNames?: readonly string[];
}

export interface StepOutputs {
  state: Record<string, unknown>;
  public: Record<string, unknown>;
  settledAmount?: unknown;
  providerFee?: unknown;
  providerReference?: unknown;
  networkReference?: unknown;
}

export interface StepLog {
  stepId: string;
  type: StepType;
  outcome: string;
  httpStatus?: number;
  durationMs: number;
  request?: unknown;
  response?: unknown;
}

export interface StepExecutionResult {
  stepId: string;
  status: CanonicalStepStatus;
  substatus?: string;
  canonicalError?: string;
  output: StepOutputs;
  response?: unknown;
  rawText?: string;
  branch?: "then" | "else";
  logs: readonly StepLog[];
}

export interface StepExecutorLogger {
  info(payload: Record<string, unknown>): void;
  warn(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

export interface StepExecutorOptions {
  apiConsumer?: ApiConsumer;
  /**
   * Resolves the outbound consumer for the attempt being executed. When
   * present it takes precedence over the static `apiConsumer`, which allows a
   * single executor to serve every gateway in the catalog.
   */
  apiConsumerResolver?: (context: StepExecutionContext) => Promise<ApiConsumer | undefined> | ApiConsumer | undefined;
  fetch?: typeof fetch;
  transformPipeline?: TransformPipeline;
  allowedHosts?: readonly string[];
  dnsLookup?: (hostname: string) => Promise<string[]>;
  dnsGuard?: (hostname: string) => Promise<void>;
  logger?: StepExecutorLogger;
  vault?: Vault;
  wait?: (definition: WaitStepDefinition, signal?: AbortSignal) => Promise<void>;
  computeRegistry?: Record<string, (input: unknown, context: StepExecutionContext) => Promise<unknown> | unknown>;
  literalSecrets?: readonly string[];
  maxResponseBytes?: number;
  maxJsonDepth?: number;
  panFieldNames?: readonly string[];
  /**
   * Resolves the crypto profile of a `CRYPTO_SIGNATURE` step parameter.
   */
  cryptoProfileResolver?: (id: string) => Promise<CryptoProfileConfig | null> | CryptoProfileConfig | null;
  /**
   * Resolves the secret material of a crypto profile. When it is absent the
   * resolver of the transform context is used instead.
   */
  secretResolver?: CryptoSecretResolver;
}

export class StepAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepAssertionError";
  }
}

export class StepValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StepValidationError";
    this.code = code;
  }
}

function executorError(code: string, message: string, statusCode = 400): ApiError {
  return new ApiError(statusCode, code, message);
}

function defaultLookup(hostname: string): Promise<string[]> {
  return lookup(hostname, { all: true, verbatim: true }).then((entries) => entries.map((entry) => entry.address));
}

function assertJsonDepth(value: unknown, maximum: number, depth = 0): void {
  if (depth > maximum) {
    throw executorError("JSON_DEPTH_EXCEEDED", `JSON response exceeds depth ${maximum}`);
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      assertJsonDepth(child, maximum, depth + 1);
    }
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      assertJsonDepth(child, maximum, depth + 1);
    }
  }
}

function selectParameter(parameter: StepParameter, context: StepExecutionContext): unknown {
  switch (parameter.source) {
    case "GATEWAY_META":
      return parameter.selector ? recursiveSelect(context.gatewayMeta ?? {}, parameter.selector) : context.gatewayMeta;
    case "ROUTE_META":
      return parameter.selector ? recursiveSelect(context.routeMeta ?? {}, parameter.selector) : context.routeMeta;
    case "CREDENTIAL":
      return parameter.selector ? recursiveSelect(context.credentials ?? {}, parameter.selector) : context.credentials;
    case "ATTEMPT":
      return parameter.selector ? recursiveSelect(context.attempt ?? {}, parameter.selector) : context.attempt;
    case "CUSTOMER_FIELD":
      return parameter.selector ? recursiveSelect(context.customerFields ?? {}, parameter.selector) : context.customerFields;
    case "STATE":
      return parameter.selector ? recursiveSelect(context.state ?? {}, parameter.selector) : context.state;
    case "PREVIOUS_RESPONSE":
      return parameter.selector ? recursiveSelect(context.previousResponse, parameter.selector) : context.previousResponse;
    case "URLS":
      return parameter.selector ? recursiveSelect(context.urls ?? {}, parameter.selector) : context.urls;
    case "CLIENT_CONTEXT":
      return parameter.selector ? recursiveSelect(context.clientContext ?? {}, parameter.selector) : context.clientContext;
    case "CONSTANT":
      return parameter.constant_value;
    case "NOW":
      return new Date();
    case "RANDOM":
      return crypto.randomUUID();
    case "COMPUTED":
    case "CRYPTO_SIGNATURE":
      return parameter.constant_value;
  }
}

function sourceMap(
  parameter: StepParameter,
  value: unknown,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const key = parameter.key;
  if (key.includes(".")) {
    recursiveSet(output, key, value);
  } else {
    output[key] = value;
  }
  return output;
}

function mergeMaps(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      mergeMaps(current, value);
    } else {
      target[key] = value;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * The context roots a `{{path.to.value}}` template can address.
 */
function contextTemplateRoots(context: StepExecutionContext): Record<string, unknown> {
  return {
    attempt: context.attempt ?? {},
    customer: context.customerFields ?? {},
    customerFields: context.customerFields ?? {},
    state: context.state ?? {},
    previousResponse: isPlainObject(context.previousResponse) ? context.previousResponse : {},
    gatewayMeta: context.gatewayMeta ?? {},
    routeMeta: context.routeMeta ?? {},
    credentials: context.credentials ?? {},
    urls: context.urls ?? {},
    clientContext: context.clientContext ?? {},
    constants: context.constants ?? {},
  };
}

function readObjectPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object") {
    const text = String(value);
    if (text !== "[object Object]") {
      return text;
    }
    return JSON.stringify(value) ?? "";
  }
  return String(value);
}

function resolveTemplatePath(path: string, context: StepExecutionContext): unknown {
  const roots = contextTemplateRoots(context);
  const composed = readObjectPath(roots, path);
  if (composed !== undefined) {
    return composed;
  }
  const directRoots: Array<Record<string, unknown> | undefined> = [
    context.attempt,
    context.customerFields,
    context.state,
    isPlainObject(context.previousResponse) ? context.previousResponse : undefined,
    context.gatewayMeta,
    context.routeMeta,
    context.constants,
  ];
  for (const root of directRoots) {
    if (!root) {
      continue;
    }
    if (Object.hasOwn(root, path)) {
      return root[path];
    }
    const nested = readObjectPath(root, path);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

/**
 * Renders a `{{path.to.value}}` template against the execution context.
 */
function renderContextTemplate(template: string, context: StepExecutionContext): string {
  return template.replace(
    /\{\{([A-Za-z0-9_.-]+)\}\}|\{([A-Za-z0-9_.-]+)\}/g,
    (_match, doubleKey: string | undefined, singleKey: string | undefined) => {
      const path = String(doubleKey ?? singleKey ?? "");
      return stringifyTemplateValue(resolveTemplatePath(path, context));
    },
  );
}

export class StepExecutor {
  private readonly options: StepExecutorOptions;
  private readonly pipeline: TransformPipeline;
  private readonly vault: Vault;
  private readonly fetchImpl: typeof fetch;
  private readonly dnsLookup: (hostname: string) => Promise<string[]>;
  private readonly cryptoEngine: CryptoEngine;

  constructor(options: StepExecutorOptions = {}) {
    this.options = options;
    this.pipeline = options.transformPipeline ?? new TransformPipeline();
    this.vault = options.vault ?? new Vault();
    this.fetchImpl = options.fetch ?? fetch;
    this.dnsLookup = options.dnsLookup ?? defaultLookup;
    this.cryptoEngine = new CryptoEngine();
  }

  async execute(step: FlowStep, context: StepExecutionContext = {}): Promise<StepExecutionResult> {
    const started = Date.now();
    try {
      switch (step.type) {
        case "HTTP":
          return await this.executeHttp(step, context, started);
        case "COMPUTE":
          return await this.executeCompute(step, context, started);
        case "RENDER":
          return await this.executeRender(step, context, started);
        case "WAIT":
          return await this.executeWait(step, context, started);
        case "ASSERT":
          return await this.executeAssert(step, context, started);
        case "BRANCH":
          return await this.executeBranch(step, context, started);
        default:
          throw executorError("UNKNOWN_STEP_TYPE", `Unsupported step type '${String(step.type)}'`);
      }
    } finally {
      this.wipePanValues(context.customerFields, context.panFieldNames ?? this.options.panFieldNames ?? []);
      this.wipePanValues(context.state, context.panFieldNames ?? this.options.panFieldNames ?? []);
    }
  }

  private async executeHttp(
    step: FlowStep,
    context: StepExecutionContext,
    started: number,
  ): Promise<StepExecutionResult> {
    const sideEffect = step.side_effect ?? "READ_ONLY";
    const retryPolicy = step.retry_policy ?? "NEVER";
    const maximumAttempts = sideEffect === "MOVES_MONEY"
      ? 1
      : Math.max(1, step.max_attempts ?? (retryPolicy === "NEVER" ? 1 : 2));
    let attempt = 0;
    while (attempt < maximumAttempts) {
      attempt += 1;
      let request: Awaited<ReturnType<StepExecutor["buildHttpRequest"]>>;
      try {
        request = await this.buildHttpRequest(step, context);
        await this.assertUrlAllowed(request.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Step request validation failed";
        const code = error instanceof ApiError ? error.code : "STEP_REQUEST_INVALID";
        throw new StepValidationError(code, message);
      }
      try {
        const response = await this.sendHttp(step, request, context);
        const retryableStatus = response.status >= 500;
        const canRetryStatus = !moneyUncertainStep(step, sideEffect)
          && retryPolicy !== "NEVER"
          && attempt < maximumAttempts
          && retryableStatus;
        if (canRetryStatus) {
          await this.delay(step.retry_delay_ms ?? 250);
          continue;
        }
        const outputs = await this.extractOutputs(step, response.data, response.rawText, context);
        const missingRequired = (step.outputs ?? []).some(
          (output) => output.required && outputs.state[output.name] === undefined && outputs.public[output.name] === undefined,
        );
        const mapped = this.mapStatus(step, response.data, response.status);
        let status = mapped.status;
        // A matched status rule always wins. Only an unmatched money step
        // falls back to UNKNOWN because the money movement is then unknown.
        if (sideEffect === "MOVES_MONEY" && !mapped.ruleMatched && status === "FAILED") {
          status = "UNKNOWN";
        }
        if (sideEffect === "MOVES_MONEY" && missingRequired) {
          status = "UNKNOWN";
        }
        const log = this.redactLog({
          stepId: step.id,
          type: step.type,
          outcome: status,
          httpStatus: response.status,
          durationMs: Date.now() - started,
          request: request.logRequest,
          response: response.data,
        });
        this.options.logger?.info(log as unknown as Record<string, unknown>);
        return {
          stepId: step.id,
          status,
          substatus: mapped.substatus,
          canonicalError: mapped.canonicalError,
          output: outputs,
          response: response.data,
          rawText: response.rawText,
          logs: [log],
        };
      } catch (error) {
        const moneyUncertain = sideEffect === "MOVES_MONEY" || step.point_of_no_return === true;
        const canRetry = !moneyUncertain
          && retryPolicy !== "NEVER"
          && attempt < maximumAttempts
          && isRetryableStepError(error);
        if (!canRetry) {
          const status: CanonicalStepStatus = moneyUncertain ? "UNKNOWN" : "FAILED";
          const log = this.redactLog({
            stepId: step.id,
            type: step.type,
            outcome: status,
            durationMs: Date.now() - started,
            response: error instanceof Error ? error.message : String(error),
          });
          this.options.logger?.error(log as unknown as Record<string, unknown>);
          return {
            stepId: step.id,
            status,
            canonicalError: error instanceof Error ? error.message : "Step execution failed",
            output: this.emptyOutputs(),
            logs: [log],
          };
        }
        await this.delay(step.retry_delay_ms ?? 250);
      }
    }
    throw new Error("Step retry loop terminated unexpectedly");
  }

  private async executeCompute(
    step: FlowStep,
    context: StepExecutionContext,
    started: number,
  ): Promise<StepExecutionResult> {
    if (!step.compute) {
      throw executorError("MISSING_COMPUTE_DEFINITION", "COMPUTE step requires a declarative compute definition");
    }
    const implementation = this.options.computeRegistry?.[step.compute.name];
    if (!implementation) {
      throw executorError("UNKNOWN_COMPUTE_OPERATION", `Compute operation '${step.compute.name}' is not registered`);
    }
    let value = await implementation(step.compute.input, context);
    if (step.compute.transforms) {
      value = await this.pipeline.apply(value, step.compute.transforms, context.transformContext);
    }
    const outputs = await this.extractOutputs(step, value, undefined, context);
    return {
      stepId: step.id,
      status: "SUCCEEDED",
      output: outputs,
      response: value,
      logs: [this.redactLog({
        stepId: step.id,
        type: step.type,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - started,
        response: value,
      })],
    };
  }

  private async executeRender(
    step: FlowStep,
    context: StepExecutionContext,
    started: number,
  ): Promise<StepExecutionResult> {
    if (!step.render) {
      throw executorError("MISSING_RENDER_DEFINITION", "RENDER step requires a declarative render definition");
    }
    let value: Record<string, unknown> = { ...step.render.values };
    if (step.render.transforms) {
      value = await this.pipeline.apply(value, step.render.transforms, context.transformContext) as Record<string, unknown>;
    }
    const output = this.emptyOutputs();
    output.public = value;
    return {
      stepId: step.id,
      status: "SUCCEEDED",
      output,
      response: value,
      logs: [this.redactLog({
        stepId: step.id,
        type: step.type,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - started,
        response: value,
      })],
    };
  }

  private async executeWait(
    step: FlowStep,
    context: StepExecutionContext,
    started: number,
  ): Promise<StepExecutionResult> {
    const definition = step.wait ?? {};
    if (this.options.wait) {
      await this.options.wait(definition, context.signal);
    } else if (definition.durationMs !== undefined) {
      if (definition.durationMs < 0 || definition.durationMs > 24 * 60 * 60 * 1000) {
        throw executorError("INVALID_WAIT_DURATION", "Wait duration is outside the allowed range");
      }
      await this.delay(definition.durationMs, context.signal);
    }
    return {
      stepId: step.id,
      status: "SUCCEEDED",
      output: this.emptyOutputs(),
      logs: [this.redactLog({
        stepId: step.id,
        type: step.type,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - started,
      })],
    };
  }

  private async executeAssert(
    step: FlowStep,
    context: StepExecutionContext,
    started: number,
  ): Promise<StepExecutionResult> {
    const source = context.previousResponse ?? context.state;
    const assertions = step.assertions ?? step.success_check ?? [];
    for (const assertion of assertions) {
      if (!evaluateAssertion(assertion, source)) {
        throw new StepAssertionError(`Assertion failed at '${assertion.selector}'`);
      }
    }
    return {
      stepId: step.id,
      status: "SUCCEEDED",
      output: this.emptyOutputs(),
      logs: [this.redactLog({
        stepId: step.id,
        type: step.type,
        outcome: "SUCCEEDED",
        durationMs: Date.now() - started,
      })],
    };
  }

  private async executeBranch(
    step: FlowStep,
    context: StepExecutionContext,
    started: number,
  ): Promise<StepExecutionResult> {
    if (!step.branch) {
      throw executorError("MISSING_BRANCH_DEFINITION", "BRANCH step requires a declarative branch definition");
    }
    const matched = evaluateAssertion(step.branch, context.previousResponse ?? context.state);
    return {
      stepId: step.id,
      status: "SUCCEEDED",
      output: this.emptyOutputs(),
      branch: matched ? "then" : "else",
      logs: [this.redactLog({
        stepId: step.id,
        type: step.type,
        outcome: matched ? "then" : "else",
        durationMs: Date.now() - started,
      })],
    };
  }

  private async buildHttpRequest(
    step: FlowStep,
    context: StepExecutionContext,
  ): Promise<{
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers: Record<string, string>;
    body?: FetchBody;
    logRequest: Record<string, unknown>;
  }> {
    if (!step.url_template) {
      throw executorError("MISSING_STEP_URL", "HTTP step requires a URL template");
    }
    const headers: Record<string, string> = {};
    const query: Record<string, QueryValue> = {};
    const pathParameters: Record<string, unknown> = {};
    let body: unknown;
    let form: Record<string, unknown> = {};
    let multipart = new FormData();
    let xml = step.xml_template ?? "";

    for (const parameter of step.parameters ?? []) {
      let value = parameter.source === "CRYPTO_SIGNATURE" && parameter.crypto_profile_id
        ? await this.resolveCryptoSignature(parameter, context)
        : selectParameter(parameter, context);
      if (parameter.transforms) {
        value = await this.pipeline.apply(value, parameter.transforms, context.transformContext);
      }
      if (value === undefined || value === null) {
        continue;
      }
      if (parameter.place === "HEADERS") {
        const text = String(value);
        assertNoControlCharacters(text, "header");
        headers[parameter.key] = text;
      } else if (parameter.place === "QUERY") {
        mergeMaps(query, sourceMap(parameter, value) as Record<string, QueryValue>);
      } else if (parameter.place === "PATH") {
        pathParameters[parameter.key] = value;
      } else if (parameter.place === "BODY") {
        body = mergeBody(body, sourceMap(parameter, value));
      } else if (parameter.place === "FORM") {
        form[parameter.key] = value;
      } else if (parameter.place === "MULTIPART") {
        multipart.append(parameter.key, value instanceof Blob ? value : String(value));
      } else if (parameter.place === "XML") {
        xml = xml.replaceAll(`{{${parameter.key}}}`, encodeForDestination(value, "XML"));
      }
    }

    const idempotency = this.resolveIdempotency(step, context);
    if (idempotency) {
      if (idempotency.mode === "HEADER") {
        assertNoControlCharacters(idempotency.value, "header");
        headers[idempotency.keyName] = idempotency.value;
      } else if (idempotency.mode === "BODY_FIELD") {
        body = mergeBody(body, { [idempotency.keyName]: idempotency.value });
        if (step.content_type?.includes("x-www-form-urlencoded")) {
          form[idempotency.keyName] = idempotency.value;
        }
      }
    }

    let requestBody: FetchBody | undefined;
    if (step.content_type?.includes("json")) {
      requestBody = JSON.stringify(body ?? {});
      headers["content-type"] = step.content_type;
    } else if (step.content_type?.includes("x-www-form-urlencoded")) {
      requestBody = new URLSearchParams(Object.fromEntries(Object.entries(form).map(([key, value]) => [key, String(value)])));
      headers["content-type"] = step.content_type;
    } else if (step.content_type?.includes("multipart")) {
      requestBody = multipart;
    } else if (step.content_type?.includes("xml")) {
      requestBody = xml;
      headers["content-type"] = step.content_type;
    } else if (body !== undefined) {
      requestBody = JSON.stringify(body);
      headers["content-type"] = headers["content-type"] ?? "application/json";
    }

    const url = compileUrl(step.url_template, query, {
      allowedHosts: this.options.allowedHosts,
      requireHttps: true,
      parameters: pathParameters,
      destination: "URL",
    });
    return {
      url,
      method: step.method ?? "POST",
      headers,
      body: requestBody,
      logRequest: {
        method: step.method ?? "POST",
        url,
        headers,
      },
    };
  }

  /**
   * Renders the declarative idempotency recipe of a step. The source template
   * is resolved against the execution context.
   */
  private resolveIdempotency(
    step: FlowStep,
    context: StepExecutionContext,
  ): { mode: "HEADER" | "BODY_FIELD"; keyName: string; value: string } | undefined {
    const config = step.idempotency_config;
    if (!config || config.mode === "NONE") {
      return undefined;
    }
    const keyName = config.key_name?.trim();
    if (!keyName) {
      throw executorError("IDEMPOTENCY_KEY_NAME_MISSING", "An idempotency configuration requires a key name");
    }
    const template = config.source_template;
    if (!template) {
      throw executorError(
        "IDEMPOTENCY_SOURCE_TEMPLATE_MISSING",
        "An idempotency configuration requires a source template",
      );
    }
    return {
      mode: config.mode,
      keyName,
      value: renderContextTemplate(template, context),
    };
  }

  /**
   * Signs the declarative payload of a `CRYPTO_SIGNATURE` step parameter with
   * the recipe of its crypto profile.
   */
  private async resolveCryptoSignature(
    parameter: StepParameter,
    context: StepExecutionContext,
  ): Promise<string> {
    const profileId = parameter.crypto_profile_id;
    if (!profileId) {
      throw executorError("CRYPTO_PROFILE_REQUIRED", "A CRYPTO_SIGNATURE parameter requires a crypto profile");
    }
    const resolver = this.options.cryptoProfileResolver;
    if (!resolver) {
      throw executorError("CRYPTO_PROFILE_RESOLVER_MISSING", "No crypto profile resolver is configured");
    }
    const profile = await resolver(profileId);
    if (!profile) {
      throw executorError("CRYPTO_PROFILE_NOT_FOUND", `Crypto profile '${profileId}' does not exist`);
    }
    const payload = this.cryptoSigningPayload(parameter, context);
    const canonical = CryptoEngine.canonicalize(profile.canonicalizationMode, {
      fields: payload.fields,
      rawBody: payload.rawBody,
      timestamp: payload.timestamp,
      includedFields: profile.includedFields,
      excludedFields: profile.excludedFields,
      templateString: profile.templateString ?? undefined,
    });
    const secretResolver = this.options.secretResolver ?? context.transformContext?.secretResolver;
    const engine = secretResolver ? new CryptoEngine({ secretResolver }) : this.cryptoEngine;
    return engine.signCanonicalPayload(profile.algorithm, canonical, {
      keyReference: profile.secretKeyRef,
      keyEncoding: profile.secretKeyEncoding,
      outputEncoding: profile.outputEncoding,
    });
  }

  /**
   * The payload a crypto profile signs: the execution context, narrowed by the
   * selector of the parameter.
   */
  private cryptoSigningPayload(
    parameter: StepParameter,
    context: StepExecutionContext,
  ): { fields: Record<string, unknown>; rawBody?: string; timestamp?: string | number } {
    const root = contextTemplateRoots(context);
    const selected = parameter.selector ? recursiveSelect(root, parameter.selector) : root;
    const candidateTimestamp = root.timestamp ?? context.attempt?.timestamp;
    const timestamp = typeof candidateTimestamp === "string" || typeof candidateTimestamp === "number"
      ? candidateTimestamp
      : undefined;
    if (typeof selected === "string") {
      return { fields: {}, rawBody: selected, timestamp };
    }
    if (isPlainObject(selected)) {
      return { fields: selected, timestamp };
    }
    return { fields: selected === undefined ? {} : { value: selected }, timestamp };
  }

  private async sendHttp(
    step: FlowStep,
    request: { url: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; headers: Record<string, string>; body?: FetchBody },
    context: StepExecutionContext,
  ): Promise<{ status: number; data: unknown; rawText: string }> {
    const consumer = this.options.apiConsumerResolver
      ? await this.options.apiConsumerResolver(context)
      : this.options.apiConsumer;
    if (consumer) {
      const response = await consumer.request({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
        timeoutMs: step.timeout_ms,
        sideEffect: step.side_effect,
        retryPolicy: step.retry_policy,
        pointOfNoReturn: step.point_of_no_return,
        signal: context.signal,
      });
      return { status: response.status, data: response.data, rawText: response.rawText };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), step.timeout_ms ?? 15000);
    const external = context.signal;
    const abort = (): void => controller.abort(external?.reason);
    external?.addEventListener("abort", abort, { once: true });
    try {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
        signal: controller.signal,
      };
      if (request.method !== "GET" && request.method !== "DELETE" && request.body !== undefined) {
        init.body = request.body;
      }
      const response = await this.fetchImpl(request.url, init);
      if (response.status >= 300 && response.status < 400) {
        throw executorError("GATEWAY_REDIRECT_BLOCKED", "Outbound redirects are forbidden");
      }
      const rawText = await this.readRawText(response);
      const contentType = response.headers.get("content-type");
      let data: unknown = rawText;
      if (rawText && contentType?.includes("json")) {
        try {
          data = JSON.parse(rawText) as unknown;
          assertJsonDepth(data, this.options.maxJsonDepth ?? 64);
        } catch (error) {
          throw executorError("INVALID_GATEWAY_JSON", error instanceof Error ? error.message : "Invalid JSON response");
        }
      }
      if (contentType?.includes("xml") && /<!DOCTYPE|<!ENTITY/i.test(rawText)) {
        throw executorError("XML_ENTITY_BLOCKED", "XML DTD and external entities are forbidden");
      }
      return { status: response.status, data, rawText };
    } finally {
      clearTimeout(timeout);
      external?.removeEventListener("abort", abort);
    }
  }

  private async extractOutputs(
    step: FlowStep,
    response: unknown,
    rawText: string | undefined,
    context: StepExecutionContext,
  ): Promise<StepOutputs> {
    const output = this.emptyOutputs();
    for (const definition of step.outputs ?? []) {
      if (definition.store_as === "SETTLED_AMOUNT" || definition.store_as === "PROVIDER_FEE") {
        assertNoFloatMoneyTransform(definition.transforms, definition.name);
      }
      let value = definition.selector
        ? recursiveSelect(response, definition.selector)
        : response;
      if (definition.transforms) {
        value = await this.pipeline.apply(value, definition.transforms, context.transformContext);
      }
      if (definition.store_as === "STATE") {
        output.state[definition.name] = value;
      } else if (definition.store_as === "PUBLIC") {
        output.public[definition.name] = value;
      } else if (definition.store_as === "SETTLED_AMOUNT") {
        output.settledAmount = value;
      } else if (definition.store_as === "PROVIDER_FEE") {
        output.providerFee = value;
      } else if (definition.store_as === "PROVIDER_REF") {
        output.providerReference = value;
      } else {
        output.networkReference = value;
      }
    }
    if (rawText !== undefined && output.state.raw_response === undefined) {
      output.state.raw_response = rawText;
    }
    return output;
  }

  private mapStatus(
    step: FlowStep,
    response: unknown,
    httpStatus: number,
  ): { status: CanonicalStepStatus; substatus?: string; canonicalError?: string; ruleMatched: boolean } {
    for (const rule of step.status_rules ?? []) {
      if (evaluateAssertion(rule, response)) {
        return {
          status: rule.canonical_status,
          substatus: rule.canonical_substatus,
          canonicalError: rule.canonical_error,
          ruleMatched: true,
        };
      }
    }
    if (httpStatus >= 200 && httpStatus < 300) {
      return { status: "SUCCEEDED", ruleMatched: false };
    }
    return {
      status: step.side_effect === "MOVES_MONEY" ? "UNKNOWN" : "FAILED",
      canonicalError: `HTTP ${httpStatus}`,
      ruleMatched: false,
    };
  }

  private async assertUrlAllowed(url: string): Promise<void> {
    const parsed = validateFinalUrl(url, {
      allowedHosts: this.options.allowedHosts,
      requireHttps: true,
    });
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      throw executorError("SSRF_PRIVATE_ADDRESS_BLOCKED", `Hostname '${hostname}' is not allowed`);
    }
    if (isIP(hostname) && !isPublicIpAddress(hostname)) {
      throw executorError("SSRF_PRIVATE_ADDRESS_BLOCKED", `IP address '${hostname}' is not public`);
    }
    if (this.options.dnsGuard) {
      await this.options.dnsGuard(hostname);
      return;
    }
    const addresses = await this.dnsLookup(hostname);
    if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
      throw executorError("SSRF_PRIVATE_ADDRESS_BLOCKED", `Hostname '${hostname}' resolved to a forbidden address`);
    }
  }

  private async readRawText(response: Response): Promise<string> {
    const maximum = this.options.maxResponseBytes ?? 2 * 1024 * 1024;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maximum) {
      throw executorError("RESPONSE_TOO_LARGE", `Gateway response exceeds ${maximum} bytes`);
    }
    if (!response.body) {
      return "";
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw executorError("RESPONSE_TOO_LARGE", `Gateway response exceeds ${maximum} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private emptyOutputs(): StepOutputs {
    return { state: {}, public: {} };
  }

  private redactLog(log: StepLog): StepLog {
    return this.vault.redactPayload(log, this.options.literalSecrets ?? []);
  }

  private wipePanValues(values: Record<string, unknown> | undefined, names: readonly string[]): void {
    if (!values) {
      return;
    }
    const normalized = new Set(names.map((name) => name.toLowerCase()));
    const visit = (value: unknown, key?: string): void => {
      if (key && normalized.has(key.toLowerCase())) {
        if (Buffer.isBuffer(value)) {
          value.fill(0);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item, key);
        }
        return;
      }
      if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) {
          visit(child, childKey);
        }
      }
    };
    for (const [key, value] of Object.entries(values)) {
      if (normalized.has(key.toLowerCase())) {
        if (Buffer.isBuffer(value)) {
          value.fill(0);
        }
        delete values[key];
      } else {
        visit(value, key);
      }
    }
  }

  private delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, milliseconds);
      const abort = (): void => {
        clearTimeout(timeout);
        reject(signal?.reason ?? new Error("Step aborted"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function mergeBody(current: unknown, addition: Record<string, unknown>): unknown {
  if (!isPlainObject(current)) {
    return addition;
  }
  const output = { ...current };
  mergeMaps(output, addition);
  return output;
}

function evaluateAssertion(
  assertion: Pick<StepAssertion, "selector" | "op" | "value">,
  source: unknown,
): boolean {
  const actual = recursiveSelect(source, assertion.selector);
  switch (assertion.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "equals":
      return actual === assertion.value || String(actual) === String(assertion.value);
    case "not_equals":
      return actual !== assertion.value && String(actual) !== String(assertion.value);
    case "in":
      return Array.isArray(assertion.value) && assertion.value.some((value) => value === actual || String(value) === String(actual));
    case "matches":
      return typeof actual === "string" && typeof assertion.value === "string" && new RegExp(assertion.value, "u").test(actual);
  }
}

function moneyUncertainStep(step: FlowStep, sideEffect: ConsumerSideEffect): boolean {
  return sideEffect === "MOVES_MONEY" || step.point_of_no_return === true;
}

/**
 * Money is never a native float. A monetary step output that runs the
 * `to_number` transform is refused at runtime as well as at save time.
 */
function assertNoFloatMoneyTransform(
  pipes: readonly TransformPipe[] | undefined,
  name: string,
): void {
  if (!Array.isArray(pipes)) {
    return;
  }
  const offender = pipes.find((pipe) => pipe && typeof pipe === "object" && pipe.op === "to_number");
  if (offender) {
    throw executorError(
      "MONEY_OUTPUT_FLOAT_FORBIDDEN",
      `Output '${name}' stores money and must not use the to_number transform`,
    );
  }
}

function isRetryableStepError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { retryable?: boolean; status?: number; name?: string };
  return candidate.retryable === true
    || candidate.name === "AbortError"
    || candidate.name === "TimeoutError"
    || (candidate.status !== undefined && candidate.status >= 500);
}
