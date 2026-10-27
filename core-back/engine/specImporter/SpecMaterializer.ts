import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { PrismaLike } from "../db/ports";
import { ApiError } from "../../lib/error";
import { Vault } from "../crypto/Vault";
import {
  IntegrationSpecSchema,
  type ConfirmationChannelSpecType,
  type CryptoProfileSpecType,
  type ErrorMapSpecType,
  type FlowSpecType,
  type IntegrationSpec,
  type RailFieldSpecType,
} from "./specSchema";
import { simulateSpec, type SimulateOptions, type VerificationReport } from "./SpecSimulator";

export type ImportMode = "CREATE_NEW" | "NEW_VERSION";

export interface MaterializeInput {
  spec: unknown;
  /** The real secret values the admin typed in the portal. Never logged. */
  credentialsValues?: Record<string, string>;
  mode?: ImportMode;
  /** The admin user id (the gateway version creator). */
  actorId: string;
  /** Environment used to pick the base URL for the credential check. */
  checkEnvironment?: "SANDBOX" | "LIVE";
}

export interface MaterializeResult {
  gatewayId: string;
  gatewayCode: string;
  gatewayVersionId: string;
  versionNumber: number;
  versionState: string;
  railId: string;
  railCode: string;
  railRouteId: string;
  credentialSetId: string | null;
  counts: {
    environments: number;
    auth: number;
    cryptoProfiles: number;
    flows: number;
    steps: number;
    channels: number;
    statusRules: number;
    errorMaps: number;
    railFields: number;
  };
  verification: VerificationReport;
}

const CONTENT_TYPE_VALUES: Record<string, string> = {
  "application/json": "APPLICATION_JSON",
  "application/x-www-form-urlencoded": "APPLICATION_FORM_URLENCODED",
  "multipart/form-data": "MULTIPART_FORM_DATA",
  "application/xml": "APPLICATION_XML",
  "text/xml": "TEXT_XML",
  "text/plain": "TEXT_PLAIN",
};

const contentTypeEnum = (value: string | undefined): string | undefined =>
  value ? CONTENT_TYPE_VALUES[value.trim().toLowerCase()] : undefined;

const json = (value: unknown): Prisma.InputJsonValue => value as unknown as Prisma.InputJsonValue;

interface FlowCreateInput {
  phase: string;
  subMode: string | null;
  steps: Array<Record<string, unknown>>;
}

/**
 * Projects a spec flow onto the `flows` / `flow_steps` / `step_parameters` /
 * `step_outputs` rows.
 *
 * It writes the rows directly (rather than through the admin flow-save route)
 * because the import path must persist `xml_template` and `success_check`,
 * which the interactive save does not carry.
 */
const toFlowInput = (flow: FlowSpecType): FlowCreateInput => ({
  phase: flow.phase,
  subMode: flow.sub_mode ?? null,
  steps: [...flow.steps]
    .sort((left, right) => left.order_index - right.order_index)
    .map((step) => ({
      type: step.type,
      // COMPUTE carries its operation name, RENDER its action, in `method`
      // (the projection in `PrismaFlowProvider` reads it from there).
      method: step.type === "COMPUTE" ? step.compute?.name : step.type === "RENDER" ? step.render?.action : step.method,
      urlTemplate: step.url_template,
      contentType: contentTypeEnum(step.content_type),
      xmlTemplate: step.xml_template,
      timeoutMs: step.timeout_ms,
      // The HTTP assertions are stored in `success_check`.
      successCheck: step.assertions && step.assertions.length > 0 ? json(step.assertions) : Prisma.JsonNull,
      sideEffect: step.side_effect,
      retryPolicy: step.retry_policy,
      pointOfNoReturn: step.point_of_no_return,
      idempotencyConfig: json(step.idempotency_config),
      parameters: step.parameters.map((parameter) => ({
        place: parameter.place,
        key: parameter.key,
        source: parameter.source,
        selector: parameter.selector ?? null,
        constantValue: parameter.constant_value === undefined ? null : String(parameter.constant_value),
        cryptoProfileName: parameter.crypto_profile,
        transforms: json(parameter.transforms ?? []),
      })),
      outputs: step.outputs.map((output) => ({
        name: output.name,
        selector: output.selector ?? null,
        transforms: json(output.transforms ?? []),
        storeAs: output.store_as,
        required: output.required,
      })),
    })),
});

const toCryptoRow = (profile: CryptoProfileSpecType, gatewayVersionId: string): Record<string, unknown> => ({
  gatewayVersionId,
  name: profile.name,
  purpose: profile.purpose,
  algorithm: profile.algorithm,
  secretKeyRef: profile.secret_key_ref ?? null,
  secretKeyEncoding: profile.secret_key_encoding,
  canonicalizationMode: profile.canonicalization_mode,
  templateString: profile.template_string ?? null,
  includedFields: json(profile.included_fields),
  excludedFields: json(profile.excluded_fields),
  outputEncoding: profile.output_encoding,
});

const toChannelRow = (
  channel: ConfirmationChannelSpecType,
  gatewayVersionId: string,
  cryptoProfileIdByName: Map<string, string>,
): Record<string, unknown> => ({
  gatewayVersionId,
  type: channel.type,
  pathToken: channel.path_token,
  cryptoProfileId: channel.crypto_profile ? cryptoProfileIdByName.get(channel.crypto_profile) ?? null : null,
  verifyMethod: channel.verify_method,
  signatureHeader: channel.signature_header ?? null,
  timestampSelector: channel.timestamp_selector ?? null,
  timestampToleranceSec: channel.timestamp_tolerance_sec,
  ipAllowlist: json(channel.ip_allowlist),
  bodyFormat: channel.body_format,
  correlationSelector: channel.correlation_selector ?? null,
  dedupeKeySelector: channel.dedupe_key_selector ?? null,
  eventMap: json(channel.event_map),
  mustInquire: channel.must_inquire,
  ackStatus: channel.ack_status,
  ackBodyTemplate: channel.ack_body_template ?? null,
});

const toErrorMapRow = (errorMap: ErrorMapSpecType, gatewayVersionId: string): Record<string, unknown> => ({
  gatewayVersionId,
  gatewayCode: errorMap.gateway_code,
  canonicalError: errorMap.canonical_error,
  classification: errorMap.classification,
  retryable: errorMap.retryable,
  countsTowardLockout: errorMap.counts_toward_lockout,
  countsTowardBreaker: errorMap.counts_toward_breaker,
  customerMessageAr: errorMap.customer_message_ar ?? null,
  customerMessageEn: errorMap.customer_message_en ?? null,
  operatorHint: errorMap.operator_hint ?? null,
});

const toRailFieldRow = (field: RailFieldSpecType, railId: string): Record<string, unknown> => ({
  railId,
  key: field.key,
  type: field.type,
  labelAr: field.label_ar,
  labelEn: field.label_en,
  placeholderAr: field.placeholder_ar ?? null,
  placeholderEn: field.placeholder_en ?? null,
  required: field.required,
  regex: field.regex ?? null,
  minLength: field.min_length ?? null,
  maxLength: field.max_length ?? null,
  sensitivity: field.sensitivity,
  optionsJson: field.options ? json(field.options) : Prisma.JsonNull,
  orderIndex: field.order_index,
});

/**
 * Imports a verified spec as a DRAFT gateway version.
 *
 * The whole write is ONE transaction (design §14 "always import into DRAFT", so
 * the admin binds the real secrets and promotes it later through the go-live
 * gates). The verification is re-run inside the materializer (the Double-Check
 * Rule): the edge is never trusted.
 */
export const materializeSpec = async (
  db: PrismaLike,
  input: MaterializeInput,
  simulateOptions: Omit<SimulateOptions, "collisionChecker"> = {},
  vault: Vault = new Vault(),
): Promise<MaterializeResult> => {
  // ---- 1. Double-check the spec inside core -------------------------------
  const verification = await simulateSpec(input.spec, simulateOptions);
  if (!verification.valid || !verification.normalizedSpec) {
    throw new ApiError(
      400,
      "SPEC_VERIFICATION_FAILED",
      "The integration spec did not pass the verification pipeline",
      {
        layers: verification.layers,
        errors: verification.errors,
        aiRepairPrompt: verification.aiRepairPrompt,
      },
    );
  }
  const spec: IntegrationSpec = verification.normalizedSpec;
  const mode: ImportMode = input.mode ?? "CREATE_NEW";

  // ---- 2. Bind the secrets with the Vault --------------------------------
  const entries: Array<{
    key: string;
    type: string;
    value: string;
    isSecret: boolean;
    secretVersion: number;
  }> = [];
  for (const credential of spec.required_credentials) {
    const supplied = input.credentialsValues?.[credential.key];
    if (credential.is_secret && (supplied === undefined || supplied === "")) {
      // A missing secret does not fail the import: the DRAFT is created and the
      // admin binds it later from the portal. It is recorded as absent.
      continue;
    }
    const value = supplied ?? "";
    entries.push({
      key: credential.key,
      type: credential.type,
      value: credential.is_secret ? await vault.encryptSecret(value, "credential-set") : value,
      isSecret: credential.is_secret,
      secretVersion: 1,
    });
  }

  // ---- 3. One atomic transaction ----------------------------------------
  const result = await db.$transaction(async (tx: PrismaLike) => {
    // Gateway: create, or reuse for a new draft version.
    let gateway = await tx.gateway.findUnique({ where: { code: spec.gateway.code } });
    if (!gateway) {
      gateway = await tx.gateway.create({
        data: {
          code: spec.gateway.code,
          name: spec.gateway.name,
          operator: spec.gateway.operator,
          country: spec.gateway.country.toUpperCase(),
          aliases: json(spec.gateway.aliases),
          kind: spec.gateway.kind,
          verificationState: "UNVERIFIED",
          riskClass: spec.gateway.risk_class,
        },
      });
    } else if (mode === "CREATE_NEW") {
      throw new ApiError(
        409,
        "GATEWAY_CODE_TAKEN",
        `The gateway code '${spec.gateway.code}' already exists; import it as a new version instead`,
        { gatewayId: gateway.id },
      );
    }

    const latestVersion = await tx.gatewayVersion.findFirst({
      where: { gatewayId: gateway.id },
      orderBy: { versionNumber: "desc" },
    });
    const snapshot = JSON.stringify(spec);
    const version = await tx.gatewayVersion.create({
      data: {
        gatewayId: gateway.id,
        versionNumber: (latestVersion?.versionNumber ?? 0) + 1,
        snapshotCiphertext: snapshot,
        contentHash: createHash("sha256").update(snapshot).digest("hex"),
        state: "DRAFT",
        createdById: input.actorId,
        changeNote: `Smart AI import (${mode}) for rail '${spec.rail.code}'`,
      },
    });

    // Environments.
    for (const environment of spec.environments) {
      await tx.gatewayEnvironment.create({
        data: {
          gatewayVersionId: version.id,
          env: environment.env,
          baseUrls: json(environment.base_urls),
          allowedHosts: json(environment.allowed_hosts),
          inboundIpAllowlist: json(environment.inbound_ip_allowlist),
          outboundEgressIps: json([]),
          enabled: environment.enabled,
        },
      });
    }

    // Auth.
    for (const auth of spec.auth) {
      await tx.gatewayAuth.create({
        data: {
          gatewayVersionId: version.id,
          env: auth.env,
          method: auth.method,
          authApply: auth.apply,
          refreshConfigJson: json({
            ...(auth.header_name ? { header_name: auth.header_name } : {}),
            ...(auth.query_name ? { query_name: auth.query_name } : {}),
            ...(auth.body_name ? { body_name: auth.body_name } : {}),
            ...(auth.token_endpoint ? { token_endpoint: auth.token_endpoint } : {}),
            ...(auth.refresh_url ? { refresh_url: auth.refresh_url } : {}),
            ...(auth.refresh_period_ms ? { refresh_period_ms: auth.refresh_period_ms } : {}),
            ...(auth.signature_header ? { signature_header: auth.signature_header } : {}),
            ...(auth.timestamp_header ? { timestamp_header: auth.timestamp_header } : {}),
            ...(auth.signature_algorithm ? { signature_algorithm: auth.signature_algorithm } : {}),
            ...auth.refresh_config,
          }),
        },
      });
    }

    // Settings.
    await tx.gatewaySetting.create({
      data: {
        gatewayVersionId: version.id,
        amountScale: spec.settings.amount_scale,
        amountPrecision: spec.settings.amount_precision,
        amountRounding: spec.settings.amount_rounding,
        amountFormat: spec.settings.amount_format,
        referenceFormat: json(spec.settings.reference_format),
        sessionTtlSeconds: spec.settings.session_ttl_seconds,
        otpTtlSeconds: spec.settings.otp_ttl_seconds,
        otpResendCooldownSeconds: spec.settings.otp_resend_cooldown_seconds,
        maxOtpAttempts: spec.settings.max_otp_attempts,
        supportsStatusCheck: spec.settings.supports_status_check,
        statusCheckMinAgeSeconds: spec.settings.status_check_min_age_seconds ?? null,
        supportsIdempotencyKey: spec.settings.supports_idempotency_key,
        supportsCancel: spec.settings.supports_cancel,
        rateLimitPerSecond: spec.settings.rate_limit_per_second ?? null,
        concurrencyCap: spec.settings.concurrency_cap ?? null,
        timeoutMs: spec.settings.timeout_ms,
        maxResponseBytes: spec.settings.max_response_bytes,
        gatewayTimezone: spec.settings.gateway_timezone,
      },
    });

    // Crypto profiles: create first so the channel and step parameters can reference them.
    const cryptoProfileIdByName = new Map<string, string>();
    for (const profile of spec.crypto_profiles) {
      const created = await tx.cryptoProfile.create({ data: toCryptoRow(profile, version.id) as never });
      cryptoProfileIdByName.set(profile.name, created.id);
    }

    // Rail.
    const rail = await tx.rail.upsert({
      where: { code: spec.rail.code },
      update: {
        nameAr: spec.rail.name_ar,
        nameEn: spec.rail.name_en,
        collectionMode: spec.rail.collection_mode,
        subModes: spec.rail.sub_modes ? json(spec.rail.sub_modes) : Prisma.JsonNull,
        currency: spec.rail.currency,
        capabilities: json(spec.rail.capabilities),
        instructionsAr: spec.rail.instructions_ar ?? null,
        instructionsEn: spec.rail.instructions_en ?? null,
      },
      create: {
        code: spec.rail.code,
        nameAr: spec.rail.name_ar,
        nameEn: spec.rail.name_en,
        collectionMode: spec.rail.collection_mode,
        subModes: spec.rail.sub_modes ? json(spec.rail.sub_modes) : Prisma.JsonNull,
        currency: spec.rail.currency,
        capabilities: json(spec.rail.capabilities),
        instructionsAr: spec.rail.instructions_ar ?? null,
        instructionsEn: spec.rail.instructions_en ?? null,
      },
    });

    // Rail fields: replace the rail's fields with the spec's.
    await tx.railField.deleteMany({ where: { railId: rail.id } });
    for (const field of spec.rail_fields) {
      await tx.railField.create({ data: toRailFieldRow(field, rail.id) as never });
    }

    // Flows, steps, parameters, outputs. The transform pipes are validated by
    // the semantic layer before the transaction is opened.
    for (const flow of spec.flows.map(toFlowInput)) {
      await tx.flow.create({
        data: {
          gatewayVersionId: version.id,
          railId: rail.id,
          subMode: flow.subMode,
          phase: flow.phase as never,
          steps: {
            create: flow.steps.map((step, index) => ({
              orderIndex: index,
              type: step.type as never,
              method: (step.method as string | undefined) ?? null,
              urlTemplate: (step.urlTemplate as string | undefined) ?? null,
              contentType: (step.contentType as never) ?? null,
              xmlTemplate: (step.xmlTemplate as string | undefined) ?? null,
              timeoutMs: (step.timeoutMs as number | undefined) ?? null,
              successCheck: step.successCheck as never,
              sideEffect: step.sideEffect as never,
              retryPolicy: step.retryPolicy as never,
              pointOfNoReturn: Boolean(step.pointOfNoReturn),
              idempotencyConfig: step.idempotencyConfig as never,
              parameters: {
                create: (step.parameters as Array<Record<string, unknown>>).map((parameter) => {
                  const profileName = (parameter.cryptoProfileName as string | undefined) ?? undefined;
                  return {
                    place: parameter.place as never,
                    key: parameter.key as string,
                    source: parameter.source as never,
                    selector: (parameter.selector as string | null) ?? null,
                    constantValue: (parameter.constantValue as string | null) ?? null,
                    cryptoProfileId: profileName ? cryptoProfileIdByName.get(profileName) ?? null : null,
                    transforms: parameter.transforms as never,
                  };
                }),
              },
              outputs: {
                create: (step.outputs as Array<Record<string, unknown>>).map((output) => ({
                  name: output.name as string,
                  selector: (output.selector as string | null) ?? null,
                  transforms: output.transforms as never,
                  storeAs: output.storeAs as never,
                  required: Boolean(output.required),
                })),
              },
            })),
          },
        },
      });
    }

    // Step-level status rules are stored on the step (already handled by the
    // flow input); the flow-level ones live in the status_rules table.
    let statusRuleCount = 0;
    for (const rule of spec.status_rules) {
      await tx.statusRule.create({
        data: {
          gatewayVersionId: version.id,
          phase: rule.phase,
          orderIndex: statusRuleCount,
          selector: rule.selector,
          op: rule.op.toUpperCase() as never,
          valueJson: json(rule.value ?? null),
          canonicalStatus: rule.canonical_status,
          canonicalSubstatus: rule.canonical_substatus ?? null,
          canonicalError: rule.canonical_error ?? null,
        },
      });
      statusRuleCount += 1;
    }

    // Error maps.
    for (const errorMap of spec.error_maps) {
      await tx.errorMap.create({ data: toErrorMapRow(errorMap, version.id) as never });
    }

    // Confirmation channels (the crypto profile of the channel is bound).
    for (const channel of spec.confirmation_channels) {
      await tx.confirmationChannel.create({ data: toChannelRow(channel, version.id, cryptoProfileIdByName) as never });
    }

    // Rail route: PAUSED on import (design: never live until the admin promotes it).
    const existingRoute = await tx.railRoute.findFirst({
      where: { railId: rail.id, gatewayId: gateway.id },
    });
    const routeData = {
      railId: rail.id,
      gatewayId: gateway.id,
      credentialPolicy: spec.rail_route.credential_policy,
      priority: spec.rail_route.priority,
      routingStrategy: spec.rail_route.routing_strategy,
      weight: spec.rail_route.weight,
      costModel: json(spec.rail_route.cost_model),
      mismatchPolicy: json(spec.rail_route.mismatch_policy),
      minAmount: new Prisma.Decimal(spec.rail_route.min_amount),
      maxAmount: spec.rail_route.max_amount ? new Prisma.Decimal(spec.rail_route.max_amount) : null,
      dailyCapAmount: spec.rail_route.daily_cap_amount ? new Prisma.Decimal(spec.rail_route.daily_cap_amount) : null,
      status: "PAUSED" as const,
      healthState: "HEALTHY" as const,
      scope: json(spec.rail_route.scope),
    };
    const railRoute = existingRoute
      ? await tx.railRoute.update({ where: { id: existingRoute.id }, data: routeData })
      : await tx.railRoute.create({ data: routeData });

    // Credential set: PLATFORM owned, UNTESTED until the live probe runs.
    let credentialSetId: string | null = null;
    if (spec.required_credentials.length > 0) {
      const environment = spec.environments.find((entry) => entry.env === (input.checkEnvironment ?? "SANDBOX"))
        ?? spec.environments[0];
      const existingCredentialSet = await tx.credentialSet.findFirst({
        where: {
          gatewayId: gateway.id,
          env: environment?.env ?? "SANDBOX",
          ownerType: "PLATFORM",
        },
      });
      const credentialSet = existingCredentialSet
        ? await tx.credentialSet.update({
            where: { id: existingCredentialSet.id },
            data: { entriesCiphertext: json(entries), settlementTarget: "PLATFORM_CLEARING", status: "UNTESTED" },
          })
        : await tx.credentialSet.create({
            data: {
              gatewayId: gateway.id,
              env: environment?.env ?? "SANDBOX",
              ownerType: "PLATFORM",
              externalMerchantId: null,
              settlementTarget: "PLATFORM_CLEARING",
              entriesCiphertext: json(entries),
              status: "UNTESTED",
            },
          });
      credentialSetId = credentialSet.id;
    }

    return {
      gatewayId: gateway.id,
      gatewayVersionId: version.id,
      versionNumber: version.versionNumber,
      railId: rail.id,
      railRouteId: railRoute.id,
      credentialSetId,
      counts: {
        environments: spec.environments.length,
        auth: spec.auth.length,
        cryptoProfiles: spec.crypto_profiles.length,
        flows: spec.flows.length,
        steps: spec.flows.reduce((total, flow) => total + flow.steps.length, 0),
        channels: spec.confirmation_channels.length,
        statusRules: statusRuleCount,
        errorMaps: spec.error_maps.length,
        railFields: spec.rail_fields.length,
      },
    };
  });

  return {
    gatewayId: result.gatewayId,
    gatewayCode: spec.gateway.code,
    gatewayVersionId: result.gatewayVersionId,
    versionNumber: result.versionNumber,
    versionState: "DRAFT",
    railId: result.railId,
    railCode: spec.rail.code,
    railRouteId: result.railRouteId,
    credentialSetId: result.credentialSetId,
    counts: result.counts,
    verification,
  };
};

/** Re-exported so the route can validate the payload shape before simulating. */
export const parseImportRequest = (body: unknown): {
  spec: unknown;
  credentialsValues: Record<string, string>;
  mode: ImportMode;
} => {
  const record = (body ?? {}) as Record<string, unknown>;
  const mode = record.mode === "NEW_VERSION" ? "NEW_VERSION" : "CREATE_NEW";
  const rawCredentials = record.credentialsValues ?? record.credentials_values ?? {};
  const credentialsValues: Record<string, string> = {};
  if (rawCredentials && typeof rawCredentials === "object" && !Array.isArray(rawCredentials)) {
    for (const [key, value] of Object.entries(rawCredentials as Record<string, unknown>)) {
      if (typeof value === "string") {
        credentialsValues[key] = value;
      }
    }
  }
  return { spec: record.spec, credentialsValues, mode };
};

export { IntegrationSpecSchema };
