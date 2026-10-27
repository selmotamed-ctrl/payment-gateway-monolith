import type { PrismaLike } from "../db/ports";
import type { DynamicAttempt, FlowPhase, FlowProvider } from "../flow/DynamicRailEngine";
import type {
  FlowStep,
  StatusRule,
  StepIdempotencyConfig,
  StepOutput,
  StepParameter,
} from "../flow/StepExecutor";

/**
 * The declarative flow engine is stored in the database:
 *
 *   flows        (gateway_version_id, rail_id, phase)
 *   flow_steps   (flow_id, order_index, type, side_effect, retry_policy, ...)
 *   step_parameters / step_outputs
 *   status_rules (gateway_version_id, phase)
 *
 * `PrismaFlowProvider` projects those rows into the `FlowStep` shape the
 * `StepExecutor` consumes. A gateway version without a flow for a phase simply
 * yields no steps, which the engine treats as a no-op phase.
 *
 * Two declarative conventions are honoured while projecting the rows:
 *
 *  - a URL template may address a named base URL of the environment
 *    (`{api}/verify`, `{inquiry}/FilterTransactions`). The placeholder is
 *    resolved against `gateway_environments.base_urls` of the environment the
 *    attempt runs in, so one flow definition serves SANDBOX and LIVE;
 *  - a `COMPUTE` or `RENDER` step carries its operation name in the `method`
 *    column, because the datamodel has no dedicated column for the compute
 *    and the render definition.
 */
export class PrismaFlowProvider implements FlowProvider {
  private readonly client: PrismaLike;

  constructor(client: PrismaLike) {
    this.client = client;
  }

  async getSteps(phase: FlowPhase, attempt: DynamicAttempt): Promise<readonly FlowStep[]> {
    const gatewayVersionId = attempt.gatewayVersionId;
    if (!gatewayVersionId) {
      return [];
    }
    const flowPhase = PHASE_TO_FLOW_PHASE[phase];
    if (!flowPhase) {
      return [];
    }
    return this.getStepsOfFlowPhase(flowPhase, attempt);
  }

  /**
   * The steps of the `CREDENTIAL_CHECK` phase of the pinned version.
   *
   * The credential check is not a lifecycle phase of an attempt, so it has no
   * entry in the engine phase union. The phase is nevertheless part of the
   * declarative datamodel (design v5 §7.4), and a gateway version may define
   * the steps that prove that its credentials work.
   */
  async getCredentialCheckSteps(attempt: DynamicAttempt): Promise<readonly FlowStep[]> {
    if (!attempt.gatewayVersionId) {
      return [];
    }
    return this.getStepsOfFlowPhase("CREDENTIAL_CHECK", attempt);
  }

  private async getStepsOfFlowPhase(
    flowPhase: string,
    attempt: DynamicAttempt,
  ): Promise<readonly FlowStep[]> {
    const gatewayVersionId = attempt.gatewayVersionId;
    if (!gatewayVersionId) {
      return [];
    }

    const flows = await this.client.flow.findMany({
      where: {
        gatewayVersionId,
        phase: flowPhase,
        OR: [{ railId: null }, ...(attempt.railId ? [{ railId: attempt.railId }] : [])],
      },
      orderBy: [{ railId: "asc" }],
      select: { id: true, railId: true, subMode: true },
    });
    const flow = selectFlow(
      flows as unknown as Array<{ id: string; railId: string | null; subMode: string | null }>,
      attempt.railId ?? null,
      attempt.subMode ?? null,
    );
    if (!flow) {
      return [];
    }

    const rows = await this.client.flowStep.findMany({
      where: { flowId: flow.id },
      orderBy: { orderIndex: "asc" },
      include: { parameters: true, outputs: true },
    });

    const statusRules = await this.client.statusRule.findMany({
      where: { gatewayVersionId, phase: flowPhase },
      orderBy: { orderIndex: "asc" },
    });

    const baseUrls = await this.resolveBaseUrls(gatewayVersionId, attempt.env);

    return rows.map((row: Record<string, unknown>) =>
      toFlowStep(row, statusRules as unknown as Array<Record<string, unknown>>, baseUrls),
    );
  }

  /**
   * The named base URLs of the environment the attempt runs in. The
   * environment that matches the attempt wins; the first environment is used
   * as a fallback so that a misconfigured environment never silently produces
   * an unresolvable URL template.
   */
  private async resolveBaseUrls(
    gatewayVersionId: string,
    env: string | undefined,
  ): Promise<Record<string, string>> {
    const environments = await this.client.gatewayEnvironment.findMany({
      where: { gatewayVersionId },
    });
    const rows = environments as Array<{ env?: string; baseUrls?: unknown }>;
    const selected =
      rows.find((row) => String(row.env ?? "").toUpperCase() === String(env ?? "").toUpperCase()) ??
      rows[0];
    const baseUrls = selected?.baseUrls;
    if (!baseUrls || typeof baseUrls !== "object") {
      return {};
    }
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseUrls as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        output[key] = value;
      }
    }
    return output;
  }
}

const PHASE_TO_FLOW_PHASE: Record<string, string> = {
  PRE_INITIATE: "PRE_INITIATE",
  INITIATE: "INITIATE",
  SUBMIT: "SUBMIT",
  VERIFY: "VERIFY",
  CANCEL: "CANCEL",
  REFUND: "REFUND",
  VOID: "VOID",
};

const BASE_URL_PATTERN = /\{\{([A-Za-z0-9_.-]+)\}\}|\{([A-Za-z0-9_.-]+)\}/g;

const CLIENT_ACTIONS = new Set([
  "SHOW_OTP_FORM",
  "HTTP_REDIRECT",
  "RENDER_EMBEDDED",
  "SHOW_QR_OR_CODE",
  "SHOW_PUSH_OR_TRANSFER",
]);

/**
 * Picks the flow that matches the rail and the sub mode of the attempt. A flow
 * that is bound to the rail wins over a generic flow, and a flow that is
 * bound to the sub mode wins over a flow that serves every sub mode.
 */
const selectFlow = (
  flows: Array<{ id: string; railId: string | null; subMode: string | null }>,
  railId: string | null,
  subMode: string | null,
): { id: string; railId: string | null; subMode: string | null } | undefined => {
  const candidates = flows.filter((flow) => flow.railId === railId || flow.railId === null);
  return (
    candidates.find((flow) => flow.railId === railId && flow.subMode === subMode) ??
    candidates.find((flow) => flow.railId === railId && flow.subMode === null) ??
    candidates.find((flow) => flow.railId === null && flow.subMode === subMode) ??
    candidates.find((flow) => flow.railId === null && flow.subMode === null)
  );
};

/**
 * Replaces the named base URL placeholders of a URL template. Placeholders
 * that are not a known base URL are left untouched: they are path parameters
 * that the step executor resolves from the step parameters.
 */
const resolveUrlTemplate = (
  template: string | undefined,
  baseUrls: Record<string, string>,
): string | undefined => {
  if (!template) {
    return template;
  }
  return template.replace(BASE_URL_PATTERN, (match, doubleKey: string, singleKey: string) => {
    const key = String(doubleKey ?? singleKey ?? "");
    const base = baseUrls[key];
    if (!base) {
      return match;
    }
    return base.endsWith("/") ? base.slice(0, -1) : base;
  });
};

const toFlowStep = (
  row: Record<string, unknown>,
  statusRules: Array<Record<string, unknown>>,
  baseUrls: Record<string, string>,
): FlowStep => {
  const parameters = (row.parameters as Array<Record<string, unknown>> | undefined) ?? [];
  const outputs = (row.outputs as Array<Record<string, unknown>> | undefined) ?? [];
  const type = String(row.type ?? "HTTP");
  const method = row.method === undefined || row.method === null ? undefined : String(row.method);
  const step: FlowStep = {
    id: String(row.id),
    type: type as FlowStep["type"],
    order_index: Number(row.orderIndex ?? 0),
    method: (method ?? undefined) as FlowStep["method"],
    url_template: resolveUrlTemplate(
      row.urlTemplate === undefined || row.urlTemplate === null ? undefined : String(row.urlTemplate),
      baseUrls,
    ),
    content_type: (row.contentType ?? undefined) as string | undefined,
    xml_template: (row.xmlTemplate ?? undefined) as string | undefined,
    timeout_ms: (row.timeoutMs ?? undefined) as number | undefined,
    side_effect: (row.sideEffect ?? "READ_ONLY") as FlowStep["side_effect"],
    retry_policy: (row.retryPolicy ?? "SAFE") as FlowStep["retry_policy"],
    point_of_no_return: Boolean(row.pointOfNoReturn),
    idempotency_config: toIdempotencyConfig(row.idempotencyConfig),
    parameters: parameters.map(toStepParameter),
    outputs: outputs.map(toStepOutput),
    success_check: (row.successCheck ?? undefined) as FlowStep["success_check"],
    status_rules: statusRules.map(toStatusRule),
  };
  if (type === "COMPUTE" && method) {
    step.compute = { name: method };
  }
  if (type === "RENDER" && method && CLIENT_ACTIONS.has(method)) {
    step.render = { action: method as never, values: { actionType: method } };
  }
  return step;
};

/**
 * The idempotency recipe of a step. The datamodel stores it as a free JSON
 * object, the executor expects the closed `{mode, key_name, source_template}`
 * shape.
 */
const toIdempotencyConfig = (value: unknown): StepIdempotencyConfig | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const raw = String(record.mode ?? "NONE").toUpperCase();
  const mode = raw === "HEADER" || raw === "BODY_FIELD" ? raw : "NONE";
  return {
    mode,
    key_name: typeof record.key_name === "string" ? record.key_name : undefined,
    source_template: typeof record.source_template === "string" ? record.source_template : undefined,
  };
};

const toStepParameter = (row: Record<string, unknown>): StepParameter => ({
  place: row.place as StepParameter["place"],
  key: String(row.key),
  source: row.source as StepParameter["source"],
  selector: (row.selector ?? undefined) as string | undefined,
  constant_value: row.constantValue ?? undefined,
  crypto_profile_id: (row.cryptoProfileId ?? undefined) as string | undefined,
  transforms: (row.transforms ?? undefined) as StepParameter["transforms"],
});

const toStepOutput = (row: Record<string, unknown>): StepOutput => ({
  name: String(row.name),
  selector: (row.selector ?? undefined) as string | undefined,
  transforms: (row.transforms ?? undefined) as StepOutput["transforms"],
  store_as: row.storeAs as StepOutput["store_as"],
  required: Boolean(row.required),
});

const toStatusRule = (row: Record<string, unknown>): StatusRule => ({
  selector: String(row.selector),
  op: String(row.op ?? "EXISTS").toLowerCase() as StatusRule["op"],
  value: row.valueJson ?? undefined,
  canonical_status: row.canonicalStatus as StatusRule["canonical_status"],
  canonical_substatus: (row.canonicalSubstatus ?? undefined) as string | undefined,
  canonical_error: (row.canonicalError ?? undefined) as string | undefined,
});
