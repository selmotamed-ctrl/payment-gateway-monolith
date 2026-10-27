import { isIP } from "node:net";
import { isPublicIpAddress } from "../apiConsumer/ApiConsumer";
import { validateTransformUsage, type TransformUsage } from "../transforms/TransformPipeline";
import type { IntegrationSpec } from "./specSchema";

/**
 * One diagnostic of the verification pipeline.
 *
 * `aiFixHint` is deliberately part of the contract: the admin pastes the
 * serialised diagnostics straight back into the external AI, so the model sees
 * what is wrong AND what to do about it, in one turn.
 */
export interface SpecDiagnostic {
  /** The JSON path of the offending value, e.g. `flows[0].steps[1].url_template`. */
  path: string;
  /** A stable, machine-readable code (the AI repairs against it). */
  code: string;
  message: string;
  aiFixHint: string;
}

export interface SpecSemanticResult {
  valid: boolean;
  errors: SpecDiagnostic[];
  warnings: SpecDiagnostic[];
}

const MONETARY_STORES = new Set(["SETTLED_AMOUNT", "PROVIDER_FEE"]);

const PLACEHOLDER_PATTERN = /\{\{?\s*([A-Za-z0-9_.-]+)\s*\}?\}/g;

const urlPlaceholders = (template: string): string[] => {
  const names: string[] = [];
  let match = PLACEHOLDER_PATTERN.exec(template);
  while (match) {
    if (match[1]) {
      names.push(match[1]);
    }
    match = PLACEHOLDER_PATTERN.exec(template);
  }
  PLACEHOLDER_PATTERN.lastIndex = 0;
  return [...new Set(names)];
};

const isPrivateHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) {
    return true;
  }
  if (normalized === "localhost" || normalized.endsWith(".local") || normalized.endsWith(".internal")) {
    return true;
  }
  if (isIP(normalized) !== 0) {
    return !isPublicIpAddress(normalized);
  }
  return false;
};

/**
 * Layer 2 of the verification pipeline: the cross-field rules that a JSON
 * Schema cannot express.
 *
 * Everything here is checked OFFLINE against the spec (no network, no
 * database), because the whole point of the kit is that the admin verifies the
 * AI's work before any credential is bound or any host is contacted.
 */
export const validateSpecSemantics = (spec: IntegrationSpec): SpecSemanticResult => {
  const errors: SpecDiagnostic[] = [];
  const warnings: SpecDiagnostic[] = [];

  const fail = (path: string, code: string, message: string, aiFixHint: string): void => {
    errors.push({ path, code, message, aiFixHint });
  };
  const warn = (path: string, code: string, message: string, aiFixHint: string): void => {
    warnings.push({ path, code, message, aiFixHint });
  };

  // ---- identity / environment -------------------------------------------------
  const environmentNames = spec.environments.map((entry) => entry.env);
  if (!environmentNames.includes("LIVE")) {
    warn(
      "environments",
      "MISSING_LIVE_ENVIRONMENT",
      "No LIVE environment is declared.",
      "Add an environments entry with env = \"LIVE\", its https base_urls and allowed_hosts.",
    );
  }
  for (const environment of spec.environments) {
    const index = spec.environments.indexOf(environment);
    const path = `environments[${index}]`;
    if (Object.keys(environment.base_urls).length === 0) {
      fail(
        `${path}.base_urls`,
        "EMPTY_BASE_URLS",
        "The environment declares no base URL.",
        "Add at least one named base URL, e.g. { \"api\": \"https://sandbox.provider.ly\" }.",
      );
    }
    if (environment.allowed_hosts.length === 0) {
      fail(
        `${path}.allowed_hosts`,
        "EMPTY_ALLOWED_HOSTS",
        "The environment declares no allowed host, so no outbound host can be pinned.",
        "Add every host used by base_urls to allowed_hosts (the engine refuses an unpinned host).",
      );
    }
    const allowed = new Set(environment.allowed_hosts.map((host) => host.toLowerCase()));
    for (const [name, url] of Object.entries(environment.base_urls)) {
      const host = new URL(url).hostname.toLowerCase();
      if (!allowed.has(host)) {
        fail(
          `${path}.base_urls.${name}`,
          "HOST_NOT_ALLOWED",
          `The host '${host}' of base_urls.${name} is not in allowed_hosts.`,
          `Add "${host}" to allowed_hosts, or change base_urls.${name} to a host you list there.`,
        );
      }
      if (isPrivateHost(host)) {
        fail(
          `${path}.base_urls.${name}`,
          "PRIVATE_HOST_BLOCKED",
          `The host '${host}' is private, loopback or internal and is blocked by the SSRF guard.`,
          "Use the provider's public https host; private, loopback and .internal hosts are never allowed.",
        );
      }
    }
    for (const [indexHost, host] of environment.allowed_hosts.entries()) {
      if (isPrivateHost(host)) {
        fail(
          `${path}.allowed_hosts[${indexHost}]`,
          "PRIVATE_HOST_BLOCKED",
          `The allowed host '${host}' is private, loopback or internal.`,
          "Remove it and list only the provider's public https hosts.",
        );
      }
    }
  }

  // ---- auth covers every environment -----------------------------------------
  for (const environment of spec.environments) {
    if (!spec.auth.some((entry) => entry.env === environment.env)) {
      fail(
        "auth",
        "MISSING_AUTH_FOR_ENVIRONMENT",
        `No auth entry is declared for the ${environment.env} environment.`,
        `Add an auth entry with env = "${environment.env}".`,
      );
    }
  }
  for (const auth of spec.auth) {
    const index = spec.auth.indexOf(auth);
    const path = `auth[${index}]`;
    if (auth.method === "TOKEN_ENDPOINT" && !auth.token_endpoint) {
      fail(
        `${path}.token_endpoint`,
        "TOKEN_ENDPOINT_MISSING",
        "The TOKEN_ENDPOINT auth method needs a token_endpoint.",
        "Add token_endpoint as an absolute https:// URL.",
      );
    }
    if (auth.method === "TOKEN_ENDPOINT" && auth.token_endpoint) {
      const host = new URL(auth.token_endpoint).hostname;
      if (isPrivateHost(host)) {
        fail(
          `${path}.token_endpoint`,
          "PRIVATE_HOST_BLOCKED",
          `The token endpoint host '${host}' is private or loopback.`,
          "Use the provider's public https token endpoint.",
        );
      }
    }
    if (auth.method === "REQUEST_SIGNATURE" && !auth.signature_header) {
      warn(
        `${path}.signature_header`,
        "SIGNATURE_HEADER_MISSING",
        "REQUEST_SIGNATURE usually declares the header that carries the signature.",
        "Add signature_header (e.g. \"X-Signature\") and timestamp_header (e.g. \"X-Timestamp\").",
      );
    }
  }

  // ---- required credentials ---------------------------------------------------
  const credentialKeys = new Set<string>();
  for (const [index, credential] of spec.required_credentials.entries()) {
    if (credentialKeys.has(credential.key)) {
      fail(
        `required_credentials[${index}].key`,
        "DUPLICATE_CREDENTIAL_KEY",
        `The credential key '${credential.key}' is declared twice.`,
        "Give every credential a unique key.",
      );
    }
    credentialKeys.add(credential.key);
    if (credential.is_secret && credential.encoding && credential.encoding !== "UTF8" && !credential.description) {
      warn(
        `required_credentials[${index}].description`,
        "CREDENTIAL_DESCRIPTION_MISSING",
        `The secret '${credential.key}' declares a ${credential.encoding} encoding but no description.`,
        "Add a short description so the admin knows which real value to paste.",
      );
    }
  }

  // ---- crypto profiles --------------------------------------------------------
  const profileNames = new Set<string>();
  for (const [index, profile] of spec.crypto_profiles.entries()) {
    const path = `crypto_profiles[${index}]`;
    if (profileNames.has(profile.name)) {
      fail(
        `${path}.name`,
        "DUPLICATE_CRYPTO_PROFILE",
        `The crypto profile '${profile.name}' is declared twice.`,
        "Give every crypto profile a unique name.",
      );
    }
    profileNames.add(profile.name);
    if (profile.secret_key_ref && !credentialKeys.has(profile.secret_key_ref)) {
      warn(
        `${path}.secret_key_ref`,
        "SECRET_REF_NOT_DECLARED",
        `The secret '${profile.secret_key_ref}' is not declared in required_credentials.`,
        `Add { "key": "${profile.secret_key_ref}", "is_secret": true } to required_credentials so the portal renders an input for it.`,
      );
    }
    if (profile.canonicalization_mode === "TEMPLATE_STRING" && !profile.template_string) {
      fail(
        `${path}.template_string`,
        "TEMPLATE_STRING_MISSING",
        "The TEMPLATE_STRING canonicalization mode needs a template_string.",
        "Add template_string, e.g. \"{{MerchantId}}|{{Amount}}|{{TrxDateTime}}\".",
      );
    }
    if (profile.algorithm === "RSA_SHA256" && profile.secret_key_encoding === "HEX") {
      warn(
        `${path}.secret_key_encoding`,
        "RSA_KEY_ENCODING",
        "An RSA key is usually PEM, not HEX.",
        "Set secret_key_encoding to \"UTF8\" (PEM) for RSA_SHA256.",
      );
    }
  }

  // ---- flows ------------------------------------------------------------------
  const stepIds = new Set<string>();
  for (const [flowIndex, flow] of spec.flows.entries()) {
    const flowPath = `flows[${flowIndex}]`;
    const subMode = flow.sub_mode;
    if (subMode && spec.rail.sub_modes && !spec.rail.sub_modes.includes(subMode)) {
      fail(
        `${flowPath}.sub_mode`,
        "UNKNOWN_SUB_MODE",
        `The sub_mode '${subMode}' is not listed in rail.sub_modes.`,
        `Use one of: ${spec.rail.sub_modes.join(", ")}, or add '${subMode}' to rail.sub_modes.`,
      );
    }
    const ordered = [...flow.steps].sort((left, right) => left.order_index - right.order_index);
    let sawMoney = false;
    for (const [index, step] of ordered.entries()) {
      const path = `${flowPath}.steps[${index}]`;
      const stepKey = `${flow.phase}:${step.id}`;
      if (stepIds.has(stepKey)) {
        fail(
          `${path}.id`,
          "DUPLICATE_STEP_ID",
          `The step id '${step.id}' is used twice in the ${flow.phase} phase.`,
          "Give every step of a phase a unique id.",
        );
      }
      stepIds.add(stepKey);

      // The AI import writes the flows directly; the runtime projection of
      // `PrismaFlowProvider` carries HTTP, COMPUTE and RENDER. A WAIT / ASSERT /
      // BRANCH step is still expressible in the interactive wizard, but not in
      // an imported spec, so it is refused here instead of silently breaking.
      if (!["HTTP", "COMPUTE", "RENDER"].includes(step.type)) {
        fail(
          `${path}.type`,
          "STEP_TYPE_NOT_IMPORTABLE",
          `The ${step.type} step type cannot be imported from a spec yet.`,
          "Use an HTTP step (with an `assertions` list for ASSERT-like checks), a COMPUTE step, or a RENDER step. Add a WAIT / ASSERT / BRANCH step afterwards in the wizard's flow editor.",
        );
      }
      if (step.type === "COMPUTE" && step.compute?.transforms && step.compute.transforms.length > 0) {
        warn(
          `${path}.compute.transforms`,
          "COMPUTE_TRANSFORMS_NOT_PROJECTED",
          "A COMPUTE step's transforms are not projected onto the stored flow yet.",
          "Put the transforms on the step outputs instead, or add the COMPUTE transforms in the wizard afterwards.",
        );
      }
      if (step.type === "RENDER" && step.render?.values && Object.keys(step.render.values).length > 0) {
        warn(
          `${path}.render.values`,
          "RENDER_VALUES_NOT_PROJECTED",
          "A RENDER step's custom values are not projected onto the stored flow yet.",
          "The render action is stored; set its values in the wizard afterwards if the defaults are not enough.",
        );
      }

      // PREVIOUS_RESPONSE cannot be read before the first request has run.
      for (const parameter of step.parameters) {
        if (parameter.source === "PREVIOUS_RESPONSE" && index === 0) {
          fail(
            `${path}.parameters`,
            "PREVIOUS_RESPONSE_ON_FIRST_STEP",
            "The first step of a phase cannot read PREVIOUS_RESPONSE: there is no previous response yet.",
            "Remove the PREVIOUS_RESPONSE parameter from the first step, or move that step after the request that produces the value.",
          );
        }
        if (parameter.source === "CRYPTO_SIGNATURE") {
          if (!parameter.crypto_profile) {
            fail(
              `${path}.parameters`,
              "CRYPTO_PROFILE_MISSING",
              "A CRYPTO_SIGNATURE parameter must name the crypto profile it uses.",
              "Set crypto_profile to the `name` of one of the crypto_profiles.",
            );
          } else if (!profileNames.has(parameter.crypto_profile)) {
            fail(
              `${path}.parameters`,
              "UNKNOWN_CRYPTO_PROFILE",
              `The crypto profile '${parameter.crypto_profile}' does not exist.`,
              `Use one of: ${[...profileNames].join(", ") || "(none declared)"}.`,
            );
          }
        }
        if (parameter.source !== "CONSTANT" && parameter.source !== "NOW" && parameter.source !== "RANDOM"
          && parameter.source !== "COMPUTED" && parameter.source !== "CRYPTO_SIGNATURE"
          && !parameter.selector) {
          warn(
            `${path}.parameters`,
            "SELECTOR_MISSING",
            `The parameter '${parameter.key}' of source ${parameter.source} has no selector.`,
            "Add a selector (e.g. \"amount\", \"customer.phone\", \"process_id\").",
          );
        }
      }

      // Money-moving steps: retry policy and idempotency.
      if (step.side_effect === "MOVES_MONEY") {
        sawMoney = true;
        const idempotent = step.idempotency_config.mode !== "NONE" && spec.settings.supports_idempotency_key;
        if (step.retry_policy !== "NEVER" && !idempotent) {
          fail(
            `${path}.retry_policy`,
            "MOVES_MONEY_RETRY_NOT_NEVER",
            "A MOVES_MONEY step must use retry_policy = \"NEVER\" unless the gateway proves an idempotency key.",
            "Set retry_policy to \"NEVER\". If the gateway supports an idempotency key, set idempotency_config.mode to \"HEADER\" and settings.supports_idempotency_key to true.",
          );
        }
        if (!step.point_of_no_return) {
          warnings.push({
            path: `${path}.point_of_no_return`,
            code: "MOVES_MONEY_PONR_MISSING",
            message: "A MOVES_MONEY step usually declares point_of_no_return = true.",
            aiFixHint: "Set point_of_no_return to true so a timeout is treated as UNKNOWN and never retried.",
          });
        }
      }

      // URL template: https, pinned host, known placeholders.
      if (step.type === "HTTP") {
        if (!step.url_template) {
          fail(
            `${path}.url_template`,
            "URL_TEMPLATE_MISSING",
            "An HTTP step needs a url_template.",
            "Add url_template, e.g. \"{api}/verify\" (the {api} placeholder is resolved from environments.base_urls).",
          );
        } else {
          const placeholders = urlPlaceholders(step.url_template);
          const baseUrlNames = new Set(
            spec.environments.flatMap((environment) => Object.keys(environment.base_urls)),
          );
          const pathParameters = new Set(
            step.parameters.filter((parameter) => parameter.place === "PATH").map((parameter) => parameter.key),
          );
          for (const placeholder of placeholders) {
            if (!baseUrlNames.has(placeholder) && !pathParameters.has(placeholder)) {
              fail(
                `${path}.url_template`,
                "UNKNOWN_URL_PLACEHOLDER",
                `The placeholder {${placeholder}} is neither a base URL name nor a PATH parameter.`,
                `Use one of the base URL names (${[...baseUrlNames].join(", ") || "none"}) or declare a PATH parameter with key "${placeholder}".`,
              );
            }
          }
          // A literal absolute URL must be https and public.
          if (/^https?:\/\//i.test(step.url_template)) {
            try {
              const parsed = new URL(step.url_template);
              if (parsed.protocol !== "https:") {
                fail(
                  `${path}.url_template`,
                  "INSECURE_URL_BLOCKED",
                  "Only https:// URLs are allowed.",
                  "Change the URL to https://.",
                );
              }
              if (isPrivateHost(parsed.hostname)) {
                fail(
                  `${path}.url_template`,
                  "PRIVATE_HOST_BLOCKED",
                  `The host '${parsed.hostname}' is private or loopback.`,
                  "Use the provider's public https host.",
                );
              }
            } catch {
              fail(
                `${path}.url_template`,
                "INVALID_URL",
                "The url_template is not a valid URL.",
                "Use a base-URL placeholder (e.g. {api}/path) instead of a hand-written URL.",
              );
            }
          }
        }
      }

      if (step.type === "COMPUTE" && !step.compute?.name) {
        fail(
          `${path}.compute.name`,
          "COMPUTE_NAME_MISSING",
          "A COMPUTE step needs a registered compute operation name.",
          "Set compute.name to one of the engine's registered compute operations.",
        );
      }
      if (step.type === "RENDER" && !step.render?.action) {
        fail(
          `${path}.render.action`,
          "RENDER_ACTION_MISSING",
          "A RENDER step needs a render action.",
          "Set render.action to one of the five ClientAction kinds.",
        );
      }

      // Transforms are validated against the closed library, with the monetary rule.
      const usages: TransformUsage[] = [
        ...step.parameters.map((parameter, parameterIndex) => ({
          path: `${path}.parameters[${parameterIndex}].transforms`,
          storeAs: "STATE" as const,
          pipes: parameter.transforms ?? [],
        })),
        ...step.outputs.map((output, outputIndex) => ({
          path: `${path}.outputs[${outputIndex}].transforms`,
          storeAs: output.store_as,
          pipes: output.transforms ?? [],
        })),
      ];
      const transformResult = validateTransformUsage(usages);
      for (const error of transformResult.errors) {
        fail(
          error.path ?? path,
          "INVALID_TRANSFORM",
          `${error.op}: ${error.message}`,
          "Use only an operation from the closed transform library, with the documented arguments.",
        );
      }
      for (const output of step.outputs) {
        if (MONETARY_STORES.has(output.store_as)) {
          const hasToNumber = (output.transforms ?? []).some((pipe) => pipe.op === "to_number");
          if (hasToNumber) {
            fail(
              `${path}.outputs`,
              "FLOAT_MONEY_FORBIDDEN",
              "A monetary output cannot use to_number: money must stay an exact decimal.",
              "Use scale / round / format_decimal instead of to_number for a settled amount or a fee.",
            );
          }
        }
      }
    }

    if (flow.phase === "SUBMIT" && sawMoney === false) {
      warn(
        `${flowPath}.steps`,
        "SUBMIT_WITHOUT_MONEY_STEP",
        "The SUBMIT flow has no MOVES_MONEY step, so the confirmation moves no money.",
        "Mark the step that captures / confirms the payment as side_effect = \"MOVES_MONEY\".",
      );
    }
  }

  for (const requiredPhase of ["INITIATE"] as const) {
    if (!spec.flows.some((flow) => flow.phase === requiredPhase)) {
      fail(
        "flows",
        "REQUIRED_PHASE_MISSING",
        `The ${requiredPhase} flow is required for every rail.`,
        `Add a flows entry with phase = "${requiredPhase}" and at least one step.`,
      );
    }
  }
  if (["OTP_PULL", "HYBRID"].includes(spec.rail.collection_mode) && !spec.flows.some((flow) => flow.phase === "SUBMIT")) {
    fail(
      "flows",
      "SUBMIT_PHASE_MISSING",
      `The ${spec.rail.collection_mode} collection mode needs a SUBMIT flow.`,
      "Add a flows entry with phase = \"SUBMIT\" that confirms the OTP / payment.",
    );
  }

  // ---- confirmation channels --------------------------------------------------
  const pathTokens = new Set<string>();
  for (const [index, channel] of spec.confirmation_channels.entries()) {
    const path = `confirmation_channels[${index}]`;
    if (pathTokens.has(channel.path_token)) {
      fail(
        `${path}.path_token`,
        "DUPLICATE_PATH_TOKEN",
        `The path token '${channel.path_token}' is used twice.`,
        "Every inbound channel needs a unique path_token.",
      );
    }
    pathTokens.add(channel.path_token);
    if (channel.crypto_profile && !profileNames.has(channel.crypto_profile)) {
      fail(
        `${path}.crypto_profile`,
        "UNKNOWN_CRYPTO_PROFILE",
        `The crypto profile '${channel.crypto_profile}' does not exist.`,
        `Use one of: ${[...profileNames].join(", ") || "(none declared)"}.`,
      );
    }
    if (["SHARED_TOKEN", "IP_ONLY"].includes(channel.verify_method) && !channel.must_inquire) {
      fail(
        `${path}.must_inquire`,
        "WEAK_VERIFICATION_REQUIRES_INQUIRY",
        "A SHARED_TOKEN or IP_ONLY channel must confirm through an inquiry (must_inquire = true).",
        "Set must_inquire to true so the platform asks the gateway instead of trusting the callback.",
      );
    }
    if (channel.verify_method === "IP_ONLY" && channel.ip_allowlist.length === 0) {
      fail(
        `${path}.ip_allowlist`,
        "IP_ALLOWLIST_MISSING",
        "An IP_ONLY channel declares no ip_allowlist.",
        "Add the gateway's published callback CIDRs.",
      );
    }
  }

  // ---- test vectors -----------------------------------------------------------
  if (spec.test_vectors.length === 0) {
    fail(
      "test_vectors",
      "TEST_VECTORS_MISSING",
      "No test vector is supplied, so the spec cannot be proven offline.",
      "Add at least one test vector with a request, the gateway response from the docs, and the expected status / extractions.",
    );
  }
  for (const [index, vector] of spec.test_vectors.entries()) {
    const path = `test_vectors[${index}]`;
    if (!spec.flows.some((flow) => flow.phase === vector.phase)) {
      fail(
        `${path}.phase`,
        "VECTOR_PHASE_WITHOUT_FLOW",
        `The vector targets the ${vector.phase} phase but no ${vector.phase} flow exists.`,
        `Use a phase that has a flow, or add the ${vector.phase} flow.`,
      );
    }
    const hasExpectation = vector.expect.status !== undefined
      || vector.expect.extractions !== undefined
      || vector.expect.signature !== undefined
      || vector.expect.wire_amount !== undefined;
    if (!hasExpectation) {
      fail(
        `${path}.expect`,
        "VECTOR_EXPECTATION_MISSING",
        "The vector expects nothing, so it proves nothing.",
        "Add expect.status and/or expect.extractions (and expect.signature for a signed request).",
      );
    }
    if (vector.expect.signature && vector.expect.signature.profile
      && !profileNames.has(vector.expect.signature.profile)) {
      fail(
        `${path}.expect.signature.profile`,
        "UNKNOWN_CRYPTO_PROFILE",
        `The signature profile '${vector.expect.signature.profile}' does not exist.`,
        `Use one of: ${[...profileNames].join(", ") || "(none declared)"}.`,
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
};
