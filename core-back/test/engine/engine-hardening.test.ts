import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Decimal } from "decimal.js";
import { Prisma } from "../../generated/prisma/client";
import {
  TransformPipeline,
  validateTransformPipes,
  validateTransformUsage,
  type TransformPipe,
} from "../../engine/transforms/TransformPipeline";
import { CryptoEngine } from "../../engine/crypto/CryptoEngine";
import {
  StepExecutor,
  type CryptoProfileConfig,
  type FlowStep,
} from "../../engine/flow/StepExecutor";
import { DynamicRailEngine, type DynamicAttempt } from "../../engine/flow/DynamicRailEngine";
import {
  assertValidGatewayFlowTransforms,
  saveGatewayVersionFlows,
  type GatewayFlowInput,
} from "../../api/internal/admin";
import { ApiError } from "../../lib/error";

const pipeline = new TransformPipeline();

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("task 1: decimal money values and the float ban on monetary outputs", () => {
  test("a Prisma.Decimal money value is processed without a float", async () => {
    const amount = new Prisma.Decimal("100.5000");
    expect(await pipeline.apply(amount, [{ op: "scale", args: [1000] }])).toBe("100500");
    expect(await pipeline.apply(amount, [{ op: "format_decimal", args: [4] }])).toBe("100.5000");
  });

  test("a decimal.js money value is processed without a float", async () => {
    const amount = new Decimal("12.3400");
    expect(await pipeline.apply(amount, [{ op: "round", args: ["NEAREST", 2] }])).toBe("12.34");
    expect(await pipeline.apply(amount, [{ op: "scale", args: [100] }])).toBe("1234");
  });

  test("any object whose toString yields a decimal literal is accepted", async () => {
    const wrapped = { toString: () => "7.2500" };
    expect(await pipeline.apply(wrapped, [{ op: "scale", args: [100] }])).toBe("725");
    expect(await pipeline.apply({ toString: () => "-3.5" }, [{ op: "round", args: ["NEAREST", 1] }])).toBe("-3.5");
  });

  test("a value that is not a decimal literal is refused", async () => {
    await expect(pipeline.apply({ toString: () => "not-a-number" }, [{ op: "scale", args: [100] }])).rejects.toThrow();
    await expect(pipeline.apply(new Date(), [{ op: "scale", args: [100] }])).rejects.toThrow();
  });

  test("to_number is refused on a monetary step output", () => {
    const result = validateTransformUsage([
      { path: "flows[0].steps[0].outputs[0].transforms", pipes: [{ op: "to_number" }], storeAs: "SETTLED_AMOUNT" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.op).toBe("to_number");
    expect(result.errors[0]?.message).toContain("decimal");
    expect(result.errors[0]?.path).toBe("flows[0].steps[0].outputs[0].transforms");
  });

  test("to_number stays allowed on a non monetary step output", () => {
    const result = validateTransformUsage([
      { path: "outputs[0]", pipes: [{ op: "to_number" }], storeAs: "STATE" },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a monetary step output never produces a native float at runtime", async () => {
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => jsonResponse({ amount: "100.0000" })) as unknown as typeof fetch,
    });
    const step: FlowStep = {
      id: "http-money",
      type: "HTTP",
      method: "POST",
      url_template: "https://gateway.example.com/pay",
      side_effect: "READ_ONLY",
      retry_policy: "NEVER",
      outputs: [
        {
          name: "settled",
          selector: "amount",
          transforms: [{ op: "to_number" }],
          store_as: "SETTLED_AMOUNT",
        },
      ],
    };
    const result = await executor.execute(step);
    expect(result.output.settledAmount).toBeUndefined();
    expect(result.status).toBe("FAILED");
  });
});

describe("task 2: a matched status rule wins on a money step", () => {
  const moneyStep = (rules: FlowStep["status_rules"]): FlowStep => ({
    id: "http-money",
    type: "HTTP",
    method: "POST",
    url_template: "https://gateway.example.com/pay",
    side_effect: "MOVES_MONEY",
    retry_policy: "NEVER",
    status_rules: rules,
  });

  test("a matched FAILED rule on a money step yields FAILED", async () => {
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => jsonResponse({ status: "DECLINED" })) as unknown as typeof fetch,
    });
    const result = await executor.execute(
      moneyStep([
        {
          selector: "status",
          op: "equals",
          value: "DECLINED",
          canonical_status: "FAILED",
          canonical_error: "DECLINED_BY_GATEWAY",
        },
      ]),
    );
    expect(result.status).toBe("FAILED");
    expect(result.canonicalError).toBe("DECLINED_BY_GATEWAY");
  });

  test("an unmatched money step still yields UNKNOWN", async () => {
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => jsonResponse({ status: "GATEWAY_ERROR" }, 500)) as unknown as typeof fetch,
    });
    const result = await executor.execute(moneyStep([]));
    expect(result.status).toBe("UNKNOWN");
  });

  test("a missing required output on a money step still yields UNKNOWN", async () => {
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => jsonResponse({ status: "PAID" })) as unknown as typeof fetch,
    });
    const step = moneyStep([
      { selector: "status", op: "equals", value: "PAID", canonical_status: "FAILED" },
    ]);
    step.outputs = [{ name: "reference", selector: "result.reference", store_as: "STATE", required: true }];
    const result = await executor.execute(step);
    expect(result.status).toBe("UNKNOWN");
  });
});

describe("task 3: a branch step decides where the phase continues", () => {
  const createAttempt = (): DynamicAttempt => ({
    id: "attempt-1",
    reference: "PA-1",
    status: "CREATED",
    env: "SANDBOX",
    currency: "LYD",
    requestedAmount: "100.0000",
    totalChargedAmount: "100.0000",
    context: {},
  });

  const createEngine = (steps: FlowStep[], executed: string[]) => {
    const attempts = new Map<string, DynamicAttempt>();
    const engine = new DynamicRailEngine({
      attempts: {
        getAttempt: async (id) => attempts.get(id) ?? null,
        updateAttempt: async (id, patch) => {
          const attempt = attempts.get(id);
          if (!attempt) {
            throw new Error("attempt not found");
          }
          Object.assign(attempt, patch);
          return attempt;
        },
      },
      slots: {
        reserveSlot: async () => ({ reservationId: "slot-1" }),
        releaseSlot: async () => undefined,
        commitSlot: async () => undefined,
      },
      flowProvider: {
        getSteps: async (phase) => (phase === "PRE_INITIATE" ? steps : []),
      },
      stepExecutor: {
        execute: async (step: FlowStep) => {
          executed.push(step.id);
          return {
            stepId: step.id,
            status: "SUCCEEDED",
            output: { state: {}, public: {} },
            branch: step.type === "BRANCH" ? "then" : undefined,
            logs: [],
          };
        },
      } as never,
    });
    return { engine, attempts };
  };

  test("the engine continues with the referenced step and skips the rest of the current stack", async () => {
    const executed: string[] = [];
    const steps: FlowStep[] = [
      {
        id: "branch",
        type: "BRANCH",
        branch: { selector: "status", op: "equals", value: "PAID", thenStepId: "target", elseStepId: "other" },
      },
      { id: "skipped", type: "COMPUTE" },
      { id: "target", type: "COMPUTE" },
      { id: "after-target", type: "COMPUTE" },
    ];
    const { engine, attempts } = createEngine(steps, executed);
    const attempt = createAttempt();
    attempts.set(attempt.id, attempt);
    await engine.preInitiate(attempt, {});
    expect(executed).toEqual(["branch", "target", "after-target"]);
  });

  test("the phase stops when the branch target is not in the remaining stack", async () => {
    const executed: string[] = [];
    const steps: FlowStep[] = [
      {
        id: "branch",
        type: "BRANCH",
        branch: { selector: "status", op: "equals", value: "PAID", thenStepId: "missing", elseStepId: "other" },
      },
      { id: "other", type: "COMPUTE" },
    ];
    const { engine, attempts } = createEngine(steps, executed);
    const attempt = createAttempt();
    attempts.set(attempt.id, attempt);
    await engine.preInitiate(attempt, {});
    expect(executed).toEqual(["branch"]);
  });
});

describe("task 4: the declarative idempotency configuration is applied", () => {
  const capture = async (
    step: FlowStep,
    context: Parameters<StepExecutor["execute"]>[1],
  ): Promise<{ headers: Record<string, string>; body: Record<string, unknown> }> => {
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await executor.execute(step, context);
    return { headers, body };
  };

  test("a HEADER mode injects the rendered key as a request header", async () => {
    const captured = await capture(
      {
        id: "http-idem",
        type: "HTTP",
        method: "POST",
        url_template: "https://gateway.example.com/pay",
        content_type: "application/json",
        side_effect: "READ_ONLY",
        retry_policy: "NEVER",
        idempotency_config: {
          mode: "HEADER",
          key_name: "Idempotency-Key",
          source_template: "{{attempt.reference}}",
        },
        parameters: [{ place: "BODY", key: "amount", source: "CONSTANT", constant_value: "10.00" }],
      },
      { attempt: { reference: "PA-1" } },
    );
    expect(captured.headers["Idempotency-Key"]).toBe("PA-1");
    expect(captured.body.amount).toBe("10.00");
  });

  test("a BODY_FIELD mode injects the rendered key into the JSON body", async () => {
    const captured = await capture(
      {
        id: "http-idem",
        type: "HTTP",
        method: "POST",
        url_template: "https://gateway.example.com/pay",
        content_type: "application/json",
        side_effect: "READ_ONLY",
        retry_policy: "NEVER",
        idempotency_config: {
          mode: "BODY_FIELD",
          key_name: "idempotency_key",
          source_template: "{{customer.order_id}}",
        },
        parameters: [{ place: "BODY", key: "amount", source: "CONSTANT", constant_value: "10.00" }],
      },
      { customerFields: { order_id: "ORD-9" } },
    );
    expect(captured.body.idempotency_key).toBe("ORD-9");
    expect(captured.headers["Idempotency-Key"]).toBeUndefined();
  });

  test("a NONE mode leaves the request untouched", async () => {
    const captured = await capture(
      {
        id: "http-idem",
        type: "HTTP",
        method: "POST",
        url_template: "https://gateway.example.com/pay",
        content_type: "application/json",
        side_effect: "READ_ONLY",
        retry_policy: "NEVER",
        idempotency_config: { mode: "NONE" },
        parameters: [{ place: "BODY", key: "amount", source: "CONSTANT", constant_value: "10.00" }],
      },
      { attempt: { reference: "PA-1" } },
    );
    expect(captured.body.idempotency_key).toBeUndefined();
    expect(captured.headers["Idempotency-Key"]).toBeUndefined();
  });
});

describe("task 5: the declarative crypto signature is signed", () => {
  const profile: CryptoProfileConfig = {
    algorithm: "HMAC_SHA256",
    canonicalizationMode: "SORTED_KEY_VALUE_AMP",
    secretKeyRef: "vault.signing.key",
    secretKeyEncoding: "UTF8",
    outputEncoding: "HEX_LOWER",
    includedFields: ["amount", "reference"],
    excludedFields: [],
  };

  const executeSignature = async (): Promise<string> => {
    let signature = "";
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      secretResolver: { resolveSecret: () => "signing-secret" },
      cryptoProfileResolver: async (id) => (id === "cp-1" ? profile : null),
      fetch: (async (_url: string, init: RequestInit) => {
        signature = (init.headers as Record<string, string>)["X-Signature"] ?? "";
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await executor.execute(
      {
        id: "http-sign",
        type: "HTTP",
        method: "POST",
        url_template: "https://gateway.example.com/pay",
        content_type: "application/json",
        side_effect: "READ_ONLY",
        retry_policy: "NEVER",
        parameters: [
          {
            place: "HEADERS",
            key: "X-Signature",
            source: "CRYPTO_SIGNATURE",
            crypto_profile_id: "cp-1",
            selector: "customer",
          },
        ],
      },
      {
        attempt: { reference: "PA-1" },
        customerFields: { amount: "100.00", reference: "PA-1", ignored: "value" },
      },
    );
    return signature;
  };

  test("a CRYPTO_SIGNATURE parameter produces a deterministic signature", async () => {
    const signature = await executeSignature();
    expect(signature).toBe(
      createHmac("sha256", "signing-secret").update("amount=100.00&reference=PA-1").digest("hex"),
    );
    expect(await executeSignature()).toBe(signature);
  });

  test("a CRYPTO_SIGNATURE parameter without a profile is refused", async () => {
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      secretResolver: { resolveSecret: () => "signing-secret" },
      cryptoProfileResolver: async () => null,
      fetch: (async () => jsonResponse({ ok: true })) as unknown as typeof fetch,
    });
    await expect(
      executor.execute({
        id: "http-sign",
        type: "HTTP",
        method: "POST",
        url_template: "https://gateway.example.com/pay",
        side_effect: "READ_ONLY",
        retry_policy: "NEVER",
        parameters: [
          {
            place: "HEADERS",
            key: "X-Signature",
            source: "CRYPTO_SIGNATURE",
            crypto_profile_id: "cp-missing",
          },
        ],
      }),
    ).rejects.toThrow();
  });

  test("SORTED_KEY_VALUE_AMP honours the included and excluded fields", () => {
    const canonical = CryptoEngine.canonicalize("SORTED_KEY_VALUE_AMP", {
      fields: { amount: "100.00", reference: "PA-1", secret: "x" },
      includedFields: ["amount", "reference"],
    });
    expect(canonical).toBe("amount=100.00&reference=PA-1");
    const excluded = CryptoEngine.canonicalize("SORTED_KEY_VALUE_AMP", {
      fields: { amount: "100.00", secret: "x" },
      excludedFields: ["secret"],
    });
    expect(excluded).toBe("amount=100.00");
  });

  test("TEMPLATE_STRING renders the configured template", () => {
    const canonical = CryptoEngine.canonicalize("TEMPLATE_STRING", {
      fields: { amount: "100.00", reference: "PA-1" },
      templateString: "{{reference}}:{{amount}}",
    });
    expect(canonical).toBe("PA-1:100.00");
  });

  test("JSON_CANONICAL produces a deterministic JSON document", () => {
    const canonical = CryptoEngine.canonicalize("JSON_CANONICAL", {
      fields: { b: "2", a: { d: "4", c: "3" } },
    });
    expect(canonical).toBe('{"a":{"c":"3","d":"4"},"b":"2"}');
  });
});

describe("task 6: the transform pipes are validated when the version is saved", () => {
  const flowInput = (parameterTransforms: TransformPipe[], outputTransforms: TransformPipe[] = []): GatewayFlowInput => ({
    phase: "INITIATE",
    steps: [
      {
        type: "HTTP",
        method: "POST",
        urlTemplate: "https://gateway.example.com/pay",
        sideEffect: "READ_ONLY",
        retryPolicy: "NEVER",
        pointOfNoReturn: false,
        idempotencyConfig: { mode: "NONE" },
        parameters: [
          {
            place: "BODY",
            key: "amount",
            source: "CONSTANT",
            constantValue: "10.00",
            transforms: parameterTransforms as Array<{ op: string; args?: unknown[] }>,
          },
        ],
        outputs: [
          {
            name: "settled",
            selector: "amount",
            storeAs: "SETTLED_AMOUNT",
            required: false,
            transforms: outputTransforms as Array<{ op: string; args?: unknown[] }>,
          },
        ],
      },
    ],
  });

  test("an invalid pipe is refused with a 400 and nothing is written", async () => {
    let deleted = false;
    const created: unknown[] = [];
    const store = {
      deleteMany: async () => {
        deleted = true;
        return { count: 0 };
      },
      create: async (args: unknown) => {
        created.push(args);
        return { id: "flow-1", phase: "INITIATE" };
      },
    };
    let thrown: unknown;
    try {
      await saveGatewayVersionFlows("version-1", [flowInput([{ op: "exec" as TransformPipe["op"] }])], store);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const error = thrown as ApiError;
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("INVALID_TRANSFORM_PIPE");
    expect(Array.isArray(error.details)).toBe(true);
    expect((error.details as Array<{ message: string }>)[0]?.message).toContain("closed library");
    expect(deleted).toBe(false);
    expect(created).toEqual([]);
  });

  test("a monetary output with to_number is refused with a 400", async () => {
    let thrown: unknown;
    try {
      await saveGatewayVersionFlows(
        "version-1",
        [flowInput([], [{ op: "to_number" }])],
        {
          deleteMany: async () => ({ count: 0 }),
          create: async () => ({ id: "flow-1", phase: "INITIATE" }),
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const error = thrown as ApiError;
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("INVALID_TRANSFORM_PIPE");
    expect((error.details as Array<{ path: string }>)[0]?.path).toContain("outputs[0]");
  });

  test("a valid pipe is accepted and persisted", async () => {
    const created: unknown[] = [];
    const store = {
      deleteMany: async () => ({ count: 0 }),
      create: async (args: unknown) => {
        created.push(args);
        return { id: "flow-1", phase: "INITIATE" };
      },
    };
    const flows = await saveGatewayVersionFlows("version-1", [flowInput([{ op: "scale", args: [1000] }])], store);
    expect(flows).toEqual([{ id: "flow-1", phase: "INITIATE" }]);
    expect(created).toHaveLength(1);
    const payload = JSON.stringify(created[0]);
    expect(payload).toContain("scale");
    expect(payload).toContain("SETTLED_AMOUNT");
  });

  test("the validation helper reports the offending usage path", () => {
    expect(() => assertValidGatewayFlowTransforms([flowInput([{ op: "scale", args: ["nope"] }])]))
      .toThrow(ApiError);
    expect(validateTransformPipes([{ op: "scale", args: [1000] }]).valid).toBe(true);
  });
});
