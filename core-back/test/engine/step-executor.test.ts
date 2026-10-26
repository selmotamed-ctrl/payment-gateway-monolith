import { describe, expect, test } from "bun:test";
import { StepExecutor, type FlowStep } from "../../engine/flow/StepExecutor";
import { TransformPipeline } from "../../engine/transforms/TransformPipeline";
import { MockGatewayServer, MOCK_SCENARIOS } from "../../engine/mockGateway/MockGatewayServer";
import { NativeAdapterRegistry } from "../../engine/flow/NativeAdapterRegistry";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("StepExecutor step types", () => {
  test("executes a COMPUTE step through the registered compute registry", async () => {
    const executor = new StepExecutor({
      computeRegistry: {
        amountMinorUnits: (input) => `${Number(input) * 100}`,
      },
    });
    const step: FlowStep = {
      id: "compute-1",
      type: "COMPUTE",
      compute: { name: "amountMinorUnits", input: "10.5" },
    };
    const result = await executor.execute(step);
    expect(result.status).toBe("SUCCEEDED");
  });

  test("rejects an unregistered compute operation", async () => {
    const executor = new StepExecutor();
    const step: FlowStep = {
      id: "compute-1",
      type: "COMPUTE",
      compute: { name: "notRegistered" },
    };
    await expect(executor.execute(step)).rejects.toThrow();
  });

  test("executes a RENDER step and exposes the public payload", async () => {
    const executor = new StepExecutor();
    const step: FlowStep = {
      id: "render-1",
      type: "RENDER",
      render: {
        action: "SHOW_OTP_FORM",
        values: { otp_length: 4, max_attempts: 3 },
      },
    };
    const result = await executor.execute(step);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.output.public.otp_length).toBe(4);
  });

  test("executes a WAIT step through the injected wait implementation", async () => {
    let waited = false;
    const executor = new StepExecutor({
      wait: async () => {
        waited = true;
      },
    });
    const step: FlowStep = { id: "wait-1", type: "WAIT", wait: { durationMs: 1000 } };
    const result = await executor.execute(step);
    expect(waited).toBe(true);
    expect(result.status).toBe("SUCCEEDED");
  });

  test("executes an ASSERT step and fails on a broken assertion", async () => {
    const executor = new StepExecutor();
    const passing: FlowStep = {
      id: "assert-1",
      type: "ASSERT",
      assertions: [{ selector: "status", op: "equals", value: "PAID" }],
    };
    const result = await executor.execute(passing, { previousResponse: { status: "PAID" } });
    expect(result.status).toBe("SUCCEEDED");
    const failing: FlowStep = {
      id: "assert-2",
      type: "ASSERT",
      assertions: [{ selector: "status", op: "equals", value: "PAID" }],
    };
    await expect(executor.execute(failing, { previousResponse: { status: "FAILED" } })).rejects.toThrow();
  });

  test("executes a BRANCH step and reports the branch", async () => {
    const executor = new StepExecutor();
    const step: FlowStep = {
      id: "branch-1",
      type: "BRANCH",
      branch: { selector: "status", op: "equals", value: "PAID", thenStepId: "s1", elseStepId: "s2" },
    };
    const result = await executor.execute(step, { previousResponse: { status: "PAID" } });
    expect(result.branch).toBe("then");
  });

  test("executes an HTTP step and extracts outputs with transforms", async () => {
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => jsonResponse({ result: { code: "00", amount: "100" } })) as unknown as typeof fetch,
    });
    const step: FlowStep = {
      id: "http-1",
      type: "HTTP",
      method: "POST",
      url_template: "https://gateway.example.com/pay",
      side_effect: "READ_ONLY",
      retry_policy: "NEVER",
      outputs: [
        {
          name: "code",
          selector: "result.code",
          transforms: [{ op: "uppercase" }],
          store_as: "STATE",
          required: true,
        },
      ],
    };
    const result = await executor.execute(step);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.output.state.code).toBe("00");
  });

  test("an HTTP step without a match on a MOVES_MONEY step becomes UNKNOWN", async () => {
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch,
    });
    const step: FlowStep = {
      id: "http-2",
      type: "HTTP",
      method: "POST",
      url_template: "https://gateway.example.com/pay",
      side_effect: "MOVES_MONEY",
      retry_policy: "NEVER",
      outputs: [
        { name: "reference", selector: "result.reference", store_as: "STATE", required: true },
      ],
    };
    const result = await executor.execute(step);
    expect(result.status).toBe("UNKNOWN");
  });

  test("a MOVES_MONEY step is never retried", async () => {
    let calls = 0;
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => {
        calls += 1;
        return jsonResponse({ error: "boom" }, 500);
      }) as unknown as typeof fetch,
    });
    const step: FlowStep = {
      id: "http-3",
      type: "HTTP",
      method: "POST",
      url_template: "https://gateway.example.com/pay",
      side_effect: "MOVES_MONEY",
      retry_policy: "NEVER",
      max_attempts: 3,
    };
    const result = await executor.execute(step);
    expect(calls).toBe(1);
    expect(result.status).toBe("UNKNOWN");
  });

  test("a READ_ONLY step retries a 5xx within its retry policy", async () => {
    let calls = 0;
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => {
        calls += 1;
        return calls === 1 ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
      transformPipeline: new TransformPipeline(),
    });
    const step: FlowStep = {
      id: "http-4",
      type: "HTTP",
      method: "GET",
      url_template: "https://gateway.example.com/ping",
      side_effect: "READ_ONLY",
      retry_policy: "SAFE",
      max_attempts: 2,
      retry_delay_ms: 1,
    };
    const result = await executor.execute(step);
    expect(calls).toBe(2);
    expect(result.status).toBe("SUCCEEDED");
  });

  test("rejects a CRLF header injection attempt", async () => {
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    const step: FlowStep = {
      id: "http-5",
      type: "HTTP",
      method: "GET",
      url_template: "https://gateway.example.com/ping",
      parameters: [
        {
          place: "HEADERS",
          key: "X-Custom",
          source: "CONSTANT",
          constant_value: "safe\r\nX-Injected: 1",
        },
      ],
    };
    await expect(executor.execute(step)).rejects.toThrow();
  });

  test("blocks a private DNS resolution", async () => {
    const executor = new StepExecutor({
      dnsLookup: async () => ["192.168.1.10"],
      fetch: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    const step: FlowStep = {
      id: "http-6",
      type: "HTTP",
      method: "GET",
      url_template: "https://gateway.example.com/ping",
    };
    await expect(executor.execute(step)).rejects.toThrow();
  });

  test("wipes PAN customer fields from the context after the step", async () => {
    const executor = new StepExecutor({
      dnsLookup: async () => ["93.184.216.34"],
      fetch: (async () => jsonResponse({ ok: true })) as unknown as typeof fetch,
    });
    const customerFields: Record<string, unknown> = { card_number: "4111111111111111", phone: "0912345678" };
    const step: FlowStep = { id: "http-7", type: "HTTP", method: "GET", url_template: "https://gateway.example.com/ping" };
    await executor.execute(step, { customerFields, panFieldNames: ["card_number"] });
    expect(customerFields.card_number).toBeUndefined();
    expect(customerFields.phone).toBe("0912345678");
  });
});

describe("MockGatewayServer", () => {
  test("exposes the fifteen deterministic scenarios", () => {
    expect(MOCK_SCENARIOS).toHaveLength(15);
  });

  test("runs each scenario deterministically", () => {
    const server = new MockGatewayServer();
    const attempt = {
      id: "attempt-1",
      status: "CREATED" as const,
      env: "SANDBOX",
      currency: "LYD",
      requestedAmount: "100",
      totalChargedAmount: "100",
      context: {},
    };
    for (const scenario of MOCK_SCENARIOS) {
      const first = server.runScenario(scenario, attempt);
      const second = server.runScenario(scenario, attempt);
      expect(first).toEqual(second);
      expect(first.reference).toBe(second.reference);
    }
  });

  test("a wrong OTP is retryable and the next attempt succeeds", async () => {
    const server = new MockGatewayServer();
    const attempt = {
      id: "attempt-1",
      status: "CREATED" as const,
      env: "SANDBOX",
      currency: "LYD",
      requestedAmount: "100",
      totalChargedAmount: "100",
      maxOtpAttempts: 3,
      context: { scenario: "WRONG_OTP_RETRY_SUCCESS" },
    };
    const first = await server.confirm(attempt, { otp: "0000" });
    expect(first.status).toBe("AWAITING_CUSTOMER");
    const second = await server.confirm(attempt, { otp: "1111" });
    expect(second.status).toBe("SUCCEEDED");
  });

  test("a 5xx on confirm raises a money uncertain error", async () => {
    const server = new MockGatewayServer();
    const attempt = {
      id: "attempt-1",
      status: "CREATED" as const,
      env: "SANDBOX",
      currency: "LYD",
      requestedAmount: "100",
      totalChargedAmount: "100",
      context: { scenario: "CONFIRM_5XX" },
    };
    await expect(server.confirm(attempt, {})).rejects.toThrow();
  });

  test("a duplicate webhook is reported as a duplicate", async () => {
    const server = new MockGatewayServer();
    const request = { attemptId: "attempt-1", dedupeKey: "dk-1", status: "SUCCESS" };
    const first = await server.verifyCallback("webhook", request);
    const second = await server.verifyCallback("webhook", request);
    expect(first.outputs.duplicate).toBeUndefined();
    expect(second.outputs.duplicate).toBe(true);
  });
});

describe("NativeAdapterRegistry", () => {
  test("registers, resolves and unregisters an adapter", () => {
    const registry = new NativeAdapterRegistry();
    const adapter = {
      preInitiate: async () => ({ attempt: {} as never, status: "CREATED" as const, outputs: {} }),
      initiate: async () => ({ attempt: {} as never, status: "CREATED" as const, outputs: {} }),
      confirm: async () => ({ attempt: {} as never, status: "CREATED" as const, outputs: {} }),
      verifyCallback: async () => ({ attempt: {} as never, status: "CREATED" as const, outputs: {} }),
      inquire: async () => ({ attempt: {} as never, status: "CREATED" as const, outputs: {} }),
      refund: async () => ({ attempt: {} as never, status: "CREATED" as const, outputs: {} }),
    };
    const unregister = registry.register("neompay", adapter);
    expect(registry.has("neompay")).toBe(true);
    expect(registry.require("neompay")).toBe(adapter);
    expect(registry.list()).toEqual(["neompay"]);
    unregister();
    expect(registry.has("neompay")).toBe(false);
    expect(() => registry.require("neompay")).toThrow();
  });
});
