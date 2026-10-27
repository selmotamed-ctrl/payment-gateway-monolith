import { z } from "zod";
import {
  IntegrationSpecSchema,
  SPEC_AMOUNT_FORMATS,
  SPEC_AMOUNT_ROUNDING,
  SPEC_AUTH_APPLY,
  SPEC_AUTH_METHODS,
  SPEC_BODY_FORMATS,
  SPEC_CANONICALIZATION_MODES,
  SPEC_CANONICAL_STATUSES,
  SPEC_CHANNEL_TYPES,
  SPEC_COLLECTION_MODES,
  SPEC_CONTENT_TYPES,
  SPEC_CREDENTIAL_POLICIES,
  SPEC_CRYPTO_ALGORITHMS,
  SPEC_CRYPTO_PURPOSES,
  SPEC_ENVIRONMENTS,
  SPEC_ERROR_CLASSIFICATIONS,
  SPEC_FLOW_PHASES,
  SPEC_GATEWAY_KINDS,
  SPEC_KEY_ENCODINGS,
  SPEC_OUTPUT_ENCODINGS,
  SPEC_OUTPUT_STORES,
  SPEC_PARAMETER_PLACES,
  SPEC_PARAMETER_SOURCES,
  SPEC_RAIL_FIELD_TYPES,
  SPEC_RETRY_POLICIES,
  SPEC_ROUTING_STRATEGIES,
  SPEC_SENSITIVITY,
  SPEC_SIDE_EFFECTS,
  SPEC_STATUS_OPS,
  SPEC_STEP_METHODS,
  SPEC_STEP_TYPES,
  SPEC_TRANSFORM_OPERATIONS,
  SPEC_VERIFY_METHODS,
  SPEC_VERSION,
} from "./specSchema";

export interface TranscriptOptions {
  /** Narrows the examples to a rail shape the admin is onboarding. */
  railKind?: "OTP_PULL" | "REDIRECT" | "EMBEDDED" | "QR_DISPLAY" | "PUSH_APPROVAL" | "HYBRID";
  generatedAt?: Date;
  /** The public base URL the inbound webhooks are mounted on, if known. */
  publicBaseUrl?: string;
}

export interface TranscriptKit {
  filename: string;
  contentType: "text/markdown";
  markdown: string;
  /** The closed lists, also returned structurally for the UI. */
  vocabulary: Record<string, readonly string[]>;
  specVersion: string;
}

const bullet = (values: readonly string[]): string => values.map((value) => `\`${value}\``).join(", ");

const otpExample = `\`\`\`json
{
  "spec_version": "${SPEC_VERSION}",
  "gateway": {
    "code": "acme-otp",
    "name": "Acme OTP",
    "operator": "Acme",
    "country": "LY",
    "aliases": ["acme"],
    "kind": "DIRECT"
  },
  "environments": [
    {
      "env": "SANDBOX",
      "base_urls": { "api": "https://sandbox.acme.ly" },
      "allowed_hosts": ["sandbox.acme.ly"]
    },
    {
      "env": "LIVE",
      "base_urls": { "api": "https://api.acme.ly" },
      "allowed_hosts": ["api.acme.ly"]
    }
  ],
  "auth": [
    { "env": "SANDBOX", "method": "REQUEST_SIGNATURE", "apply": "HEADER", "signature_header": "X-Signature", "timestamp_header": "X-Timestamp", "signature_algorithm": "HMAC_SHA256" },
    { "env": "LIVE", "method": "REQUEST_SIGNATURE", "apply": "HEADER", "signature_header": "X-Signature", "timestamp_header": "X-Timestamp", "signature_algorithm": "HMAC_SHA256" }
  ],
  "required_credentials": [
    { "key": "MID", "is_secret": false, "type": "HEADER", "description": "Merchant id issued by Acme" },
    { "key": "MerchantSecretKey", "is_secret": true, "encoding": "HEX", "type": "HEADER", "description": "HMAC key, hex encoded" }
  ],
  "settings": {
    "amount_scale": 1000,
    "amount_precision": 2,
    "amount_rounding": "NONE",
    "amount_format": "INTEGER_MINOR_UNITS",
    "session_ttl_seconds": 1200,
    "otp_ttl_seconds": 300,
    "otp_resend_cooldown_seconds": 60,
    "max_otp_attempts": 3,
    "supports_status_check": true,
    "supports_cancel": true
  },
  "rail": {
    "code": "acme-otp",
    "name_ar": "أكمي",
    "name_en": "Acme OTP",
    "collection_mode": "OTP_PULL",
    "capabilities": { "refund": true, "partial_refund": false, "void": false, "capture": false, "recurring": false }
  },
  "rail_fields": [
    { "key": "phone", "type": "PHONE", "label_ar": "رقم الهاتف", "label_en": "Phone", "required": true, "min_length": 9, "max_length": 15, "sensitivity": "SENSITIVE", "order_index": 0 },
    { "key": "otp", "type": "OTP", "label_ar": "رمز التحقق", "label_en": "OTP", "required": true, "min_length": 4, "max_length": 6, "sensitivity": "SENSITIVE", "order_index": 1 }
  ],
  "rail_route": {
    "credential_policy": "PLATFORM",
    "priority": 100,
    "cost_model": { "calc_type": "PERCENTAGE", "percent": "1.5" },
    "mismatch_policy": { "tolerance_amount": "0.0100" },
    "min_amount": "1.0000",
    "max_amount": "20000.0000"
  },
  "crypto_profiles": [
    {
      "name": "acme-sign",
      "purpose": "OUTBOUND_SIGN",
      "algorithm": "HMAC_SHA256",
      "secret_key_ref": "MerchantSecretKey",
      "secret_key_encoding": "HEX",
      "canonicalization_mode": "SORTED_KEY_VALUE_AMP",
      "excluded_fields": ["SecureHash"],
      "output_encoding": "HEX_UPPER"
    }
  ],
  "flows": [
    {
      "phase": "INITIATE",
      "steps": [
        {
          "id": "verify-phone",
          "order_index": 0,
          "type": "HTTP",
          "method": "POST",
          "url_template": "{api}/verify",
          "content_type": "application/x-www-form-urlencoded",
          "side_effect": "SENDS_NOTIFICATION",
          "retry_policy": "SAFE_WITH_COOLDOWN",
          "point_of_no_return": false,
          "parameters": [
            { "place": "FORM", "key": "MID", "source": "CREDENTIAL", "selector": "MID" },
            { "place": "FORM", "key": "Amount", "source": "ATTEMPT", "selector": "totalChargedAmount", "transforms": [{ "op": "scale", "args": [1000] }, { "op": "to_int" }] },
            { "place": "FORM", "key": "Phone", "source": "CUSTOMER_FIELD", "selector": "phone", "transforms": [{ "op": "phone_normalize", "args": ["LOCAL_09"] }] },
            { "place": "FORM", "key": "SecureHash", "source": "CRYPTO_SIGNATURE", "crypto_profile": "acme-sign" },
            { "place": "HEADERS", "key": "X-Timestamp", "source": "NOW" }
          ],
          "outputs": [
            { "name": "process_id", "selector": "process_id", "store_as": "STATE", "required": true }
          ],
          "status_rules": [
            { "selector": "status", "op": "equals", "value": "PENDING", "canonical_status": "AWAITING_CUSTOMER" }
          ]
        }
      ]
    },
    {
      "phase": "SUBMIT",
      "steps": [
        {
          "id": "confirm-otp",
          "order_index": 0,
          "type": "HTTP",
          "method": "POST",
          "url_template": "{api}/confirm",
          "content_type": "application/x-www-form-urlencoded",
          "side_effect": "MOVES_MONEY",
          "retry_policy": "NEVER",
          "point_of_no_return": true,
          "parameters": [
            { "place": "FORM", "key": "MID", "source": "CREDENTIAL", "selector": "MID" },
            { "place": "FORM", "key": "ProcessId", "source": "STATE", "selector": "process_id" },
            { "place": "FORM", "key": "Otp", "source": "CUSTOMER_FIELD", "selector": "otp" }
          ],
          "outputs": [
            { "name": "transaction_id", "selector": "transaction_id", "store_as": "PROVIDER_REF", "required": true },
            { "name": "settled_amount", "selector": "amount", "store_as": "SETTLED_AMOUNT", "transforms": [{ "op": "format_decimal", "args": [4] }] }
          ],
          "status_rules": [
            { "selector": "status", "op": "equals", "value": "PAID", "canonical_status": "SUCCEEDED" },
            { "selector": "status", "op": "equals", "value": "DECLINED", "canonical_status": "FAILED", "canonical_error": "TERMINAL_DECLINE" }
          ]
        }
      ]
    }
  ],
  "confirmation_channels": [],
  "error_maps": [
    { "gateway_code": "OTP_EXPIRED", "canonical_error": "RETRYABLE_OTP", "classification": "RETRYABLE_OTP", "retryable": true, "counts_toward_lockout": true }
  ],
  "status_rules": [],
  "test_vectors": [
    {
      "name": "verify phone returns a process id",
      "phase": "INITIATE",
      "request": { "amount": "100.0000", "currency": "LYD", "phone": "0912345678" },
      "response": { "status": "PENDING", "process_id": "PROC-1" },
      "expect": { "status": "AWAITING_CUSTOMER", "extractions": { "process_id": "PROC-1" }, "wire_amount": "100000" }
    },
    {
      "name": "confirm otp is paid",
      "phase": "SUBMIT",
      "request": { "amount": "100.0000", "currency": "LYD", "otp": "1234" },
      "response": { "status": "PAID", "transaction_id": "TX-9", "amount": "100.0000" },
      "expect": { "status": "SUCCEEDED", "extractions": { "settled_amount": "100.0000" } }
    }
  ]
}
\`\`\``;

const redirectExample = `\`\`\`json
{
  "spec_version": "${SPEC_VERSION}",
  "gateway": {
    "code": "acme-redirect",
    "name": "Acme Checkout",
    "operator": "Acme",
    "country": "LY",
    "aliases": [],
    "kind": "AGGREGATOR"
  },
  "environments": [
    { "env": "SANDBOX", "base_urls": { "api": "https://sandbox.acme.ly", "return": "https://merchant.example.ly/pay/return" }, "allowed_hosts": ["sandbox.acme.ly"] },
    { "env": "LIVE", "base_urls": { "api": "https://api.acme.ly" }, "allowed_hosts": ["api.acme.ly"] }
  ],
  "auth": [
    { "env": "SANDBOX", "method": "API_KEY", "apply": "HEADER", "header_name": "Authorization" },
    { "env": "LIVE", "method": "API_KEY", "apply": "HEADER", "header_name": "Authorization" }
  ],
  "required_credentials": [
    { "key": "api_key", "is_secret": true, "type": "HEADER", "description": "Bearer API key" },
    { "key": "webhook_secret", "is_secret": true, "type": "HEADER", "description": "HMAC key for the callback" }
  ],
  "settings": {
    "amount_scale": 100,
    "amount_precision": 2,
    "amount_rounding": "NEAREST",
    "amount_format": "INTEGER_MINOR_UNITS",
    "session_ttl_seconds": 1800,
    "supports_status_check": true,
    "supports_cancel": true
  },
  "rail": {
    "code": "acme-card",
    "name_ar": "أكمي كارد",
    "name_en": "Acme Card",
    "collection_mode": "REDIRECT",
    "capabilities": { "refund": true, "partial_refund": true, "void": true, "capture": true, "recurring": false }
  },
  "rail_fields": [],
  "rail_route": {
    "credential_policy": "PLATFORM",
    "priority": 50,
    "cost_model": { "calc_type": "FLAT", "flat": "0.8000", "accrue_fee_at_confirm": true },
    "mismatch_policy": { "tolerance_amount": "0.0100" },
    "min_amount": "1.0000"
  },
  "crypto_profiles": [
    {
      "name": "acme-webhook",
      "purpose": "INBOUND_VERIFY",
      "algorithm": "HMAC_SHA256",
      "secret_key_ref": "webhook_secret",
      "canonicalization_mode": "TIMESTAMP_DOT_RAW_BODY",
      "output_encoding": "HEX_LOWER"
    }
  ],
  "flows": [
    {
      "phase": "INITIATE",
      "steps": [
        {
          "id": "create-payment",
          "order_index": 0,
          "type": "HTTP",
          "method": "POST",
          "url_template": "{api}/payments",
          "content_type": "application/json",
          "side_effect": "READ_ONLY",
          "retry_policy": "SAFE",
          "parameters": [
            { "place": "BODY", "key": "amount", "source": "ATTEMPT", "selector": "totalChargedAmount", "transforms": [{ "op": "scale", "args": [100] }, { "op": "to_int" }] },
            { "place": "BODY", "key": "currency", "source": "ATTEMPT", "selector": "currency" },
            { "place": "BODY", "key": "reference", "source": "ATTEMPT", "selector": "reference" },
            { "place": "BODY", "key": "return_url", "source": "URLS", "selector": "return" }
          ],
          "outputs": [
            { "name": "redirect_url", "selector": "data.checkout_url", "store_as": "PUBLIC", "required": true }
          ],
          "status_rules": [
            { "selector": "status", "op": "equals", "value": "created", "canonical_status": "AWAITING_CUSTOMER" }
          ]
        },
        {
          "id": "render-redirect",
          "order_index": 1,
          "type": "RENDER",
          "render": { "action": "HTTP_REDIRECT", "values": { "url": "{{redirect_url}}" } }
        }
      ]
    },
    {
      "phase": "VERIFY",
      "steps": [
        {
          "id": "fetch-payment",
          "order_index": 0,
          "type": "HTTP",
          "method": "GET",
          "url_template": "{api}/payments/{reference}",
          "side_effect": "READ_ONLY",
          "retry_policy": "SAFE",
          "parameters": [
            { "place": "PATH", "key": "reference", "source": "ATTEMPT", "selector": "reference" }
          ],
          "outputs": [
            { "name": "settled_amount", "selector": "amount", "store_as": "SETTLED_AMOUNT", "transforms": [{ "op": "format_decimal", "args": [4] }] }
          ],
          "status_rules": [
            { "selector": "status", "op": "equals", "value": "paid", "canonical_status": "SUCCEEDED" },
            { "selector": "status", "op": "equals", "value": "failed", "canonical_status": "FAILED" },
            { "selector": "status", "op": "equals", "value": "pending", "canonical_status": "VERIFYING" }
          ]
        }
      ]
    }
  ],
  "confirmation_channels": [
    {
      "type": "WEBHOOK",
      "path_token": "acme-webhook-token",
      "crypto_profile": "acme-webhook",
      "verify_method": "HMAC_BODY",
      "signature_header": "X-Signature",
      "timestamp_selector": "timestamp",
      "timestamp_tolerance_sec": 300,
      "body_format": "JSON",
      "correlation_selector": "reference",
      "dedupe_key_selector": "event_id",
      "event_map": { "paid": "SUCCESS", "failed": "FAILED" },
      "must_inquire": false,
      "ack_status": 200
    }
  ],
  "error_maps": [
    { "gateway_code": "card_declined", "canonical_error": "TERMINAL_DECLINE", "classification": "TERMINAL_DECLINE" }
  ],
  "status_rules": [],
  "test_vectors": [
    {
      "name": "create payment returns a checkout url",
      "phase": "INITIATE",
      "request": { "amount": "100.0000", "currency": "LYD", "reference": "PA-1" },
      "response": { "status": "created", "data": { "checkout_url": "https://pay.acme.ly/abc" } },
      "expect": { "status": "AWAITING_CUSTOMER", "extractions": { "redirect_url": "https://pay.acme.ly/abc" }, "wire_amount": "10000" }
    },
    {
      "name": "the inquiry says paid",
      "phase": "VERIFY",
      "request": { "amount": "100.0000", "currency": "LYD", "reference": "PA-1" },
      "response": { "status": "paid", "amount": "100.00" },
      "expect": { "status": "SUCCEEDED", "extractions": { "settled_amount": "100.0000" } }
    }
  ]
}
\`\`\``;

const pickExamples = (railKind: TranscriptOptions["railKind"]): string => {
  switch (railKind) {
    case "REDIRECT":
    case "EMBEDDED":
      return redirectExample;
    case "OTP_PULL":
    case "HYBRID":
      return otpExample;
    default:
      return `${otpExample}\n\n---\n\n${redirectExample}`;
  }
};

/**
 * Builds the self-contained "AI Onboarding Kit" the admin hands to an external
 * AI.
 *
 * It is generated from the LIVE schema (via `z.toJSONSchema`) and the LIVE
 * closed lists, so the AI can never be told to emit a field, an auth method, a
 * transform or a parameter source that the engine does not have.
 */
export const buildTranscriptKit = (options: TranscriptOptions = {}): TranscriptKit => {
  const generatedAt = options.generatedAt ?? new Date();
  const jsonSchema = z.toJSONSchema(IntegrationSpecSchema, { io: "input", target: "draft-2020-12" });

  const vocabulary = {
    auth_methods: SPEC_AUTH_METHODS,
    auth_apply: SPEC_AUTH_APPLY,
    gateway_kinds: SPEC_GATEWAY_KINDS,
    environments: SPEC_ENVIRONMENTS,
    flow_phases: SPEC_FLOW_PHASES,
    step_types: SPEC_STEP_TYPES,
    step_methods: SPEC_STEP_METHODS,
    side_effects: SPEC_SIDE_EFFECTS,
    retry_policies: SPEC_RETRY_POLICIES,
    content_types: SPEC_CONTENT_TYPES,
    parameter_places: SPEC_PARAMETER_PLACES,
    parameter_sources: SPEC_PARAMETER_SOURCES,
    output_stores: SPEC_OUTPUT_STORES,
    status_ops: SPEC_STATUS_OPS,
    canonical_statuses: SPEC_CANONICAL_STATUSES,
    collection_modes: SPEC_COLLECTION_MODES,
    rail_field_types: SPEC_RAIL_FIELD_TYPES,
    sensitivity: SPEC_SENSITIVITY,
    credential_policies: SPEC_CREDENTIAL_POLICIES,
    routing_strategies: SPEC_ROUTING_STRATEGIES,
    crypto_algorithms: SPEC_CRYPTO_ALGORITHMS,
    crypto_purposes: SPEC_CRYPTO_PURPOSES,
    key_encodings: SPEC_KEY_ENCODINGS,
    output_encodings: SPEC_OUTPUT_ENCODINGS,
    canonicalization_modes: SPEC_CANONICALIZATION_MODES,
    channel_types: SPEC_CHANNEL_TYPES,
    verify_methods: SPEC_VERIFY_METHODS,
    body_formats: SPEC_BODY_FORMATS,
    error_classifications: SPEC_ERROR_CLASSIFICATIONS,
    amount_rounding: SPEC_AMOUNT_ROUNDING,
    amount_formats: SPEC_AMOUNT_FORMATS,
    transform_operations: SPEC_TRANSFORM_OPERATIONS,
  };

  const markdown = `# AI Integration Transcript — Payment Gateway Rail Onboarding

> Generated by the platform on ${generatedAt.toISOString()}.
> **spec_version: \`${SPEC_VERSION}\`**
> This file is self-contained. Hand it to the AI together with the provider's
> documentation. You do NOT need to give the AI any live secret.

---

## 1. Your role

You are a meticulous integration engineer. You will be given a payment
provider's API documentation. You must produce **one** JSON document that
implements the provider as a rail of this platform, conforming EXACTLY to the
JSON Schema in section 3.

Rules that must not be broken:

1. Output **only** the JSON document, inside a single fenced \`\`\`json block.
   No prose before or after it.
2. Use **only** the closed sets in section 2. Never invent a field, an auth
   method, a parameter source, a transform operation, a status, or a channel
   type. The platform rejects anything outside them.
3. Static configuration only. Never reference or embed a live secret: the
   \`required_credentials\` manifest declares the credential *names* and
   *types*, and the admin enters the real values later in the portal.
4. Extract 2–3 **real request / response examples from the documentation** and
   put them in \`test_vectors\`, together with what the platform must extract
   from them. The platform runs these offline before any network call; they
   are how you prove your selectors and your signing recipe are correct.
5. Money is never a float. Amounts are decimal strings; the wire amount is
   produced by \`scale\` + \`to_int\` (or \`format_decimal\`) transforms from
   \`settings.amount_scale\`.
6. A step that moves money (\`side_effect: "MOVES_MONEY"\`) must use
   \`retry_policy: "NEVER"\` and \`point_of_no_return: true\`, unless the
   provider documents an idempotency key (then set
   \`idempotency_config.mode\` and \`settings.supports_idempotency_key: true\`).
7. Every outbound URL must be \`https://\` and must be reachable through a host
   listed in that environment's \`allowed_hosts\`. Use the \`{base_name}\`
   placeholder for the host (e.g. \`{api}/verify\`), never a hand-written
   private or loopback address.

---

## 2. The closed sets (the complete vocabulary)

| Concept | Allowed values |
| :--- | :--- |
| \`auth.method\` | ${bullet(SPEC_AUTH_METHODS)} |
| \`auth.apply\` | ${bullet(SPEC_AUTH_APPLY)} |
| \`gateway.kind\` | ${bullet(SPEC_GATEWAY_KINDS)} |
| \`environments[].env\` | ${bullet(SPEC_ENVIRONMENTS)} |
| \`flows[].phase\` | ${bullet(SPEC_FLOW_PHASES)} |
| \`step.type\` | ${bullet(SPEC_STEP_TYPES)} |
| \`step.method\` | ${bullet(SPEC_STEP_METHODS)} |
| \`step.side_effect\` | ${bullet(SPEC_SIDE_EFFECTS)} |
| \`step.retry_policy\` | ${bullet(SPEC_RETRY_POLICIES)} |
| \`step.content_type\` | ${bullet(SPEC_CONTENT_TYPES)} |
| \`parameter.place\` | ${bullet(SPEC_PARAMETER_PLACES)} |
| \`parameter.source\` | ${bullet(SPEC_PARAMETER_SOURCES)} |
| \`output.store_as\` | ${bullet(SPEC_OUTPUT_STORES)} |
| \`status_rule.op\` | ${bullet(SPEC_STATUS_OPS)} |
| \`canonical_status\` | ${bullet(SPEC_CANONICAL_STATUSES)} |
| \`rail.collection_mode\` | ${bullet(SPEC_COLLECTION_MODES)} |
| \`rail_field.type\` | ${bullet(SPEC_RAIL_FIELD_TYPES)} |
| \`rail_field.sensitivity\` | ${bullet(SPEC_SENSITIVITY)} |
| \`rail_route.credential_policy\` | ${bullet(SPEC_CREDENTIAL_POLICIES)} |
| \`rail_route.routing_strategy\` | ${bullet(SPEC_ROUTING_STRATEGIES)} |
| \`crypto.algorithm\` | ${bullet(SPEC_CRYPTO_ALGORITHMS)} |
| \`crypto.purpose\` | ${bullet(SPEC_CRYPTO_PURPOSES)} |
| \`crypto.secret_key_encoding\` | ${bullet(SPEC_KEY_ENCODINGS)} |
| \`crypto.output_encoding\` | ${bullet(SPEC_OUTPUT_ENCODINGS)} |
| \`crypto.canonicalization_mode\` | ${bullet(SPEC_CANONICALIZATION_MODES)} |
| \`confirmation_channel.type\` | ${bullet(SPEC_CHANNEL_TYPES)} |
| \`confirmation_channel.verify_method\` | ${bullet(SPEC_VERIFY_METHODS)} |
| \`confirmation_channel.body_format\` | ${bullet(SPEC_BODY_FORMATS)} |
| \`error_map.classification\` | ${bullet(SPEC_ERROR_CLASSIFICATIONS)} |
| \`settings.amount_rounding\` | ${bullet(SPEC_AMOUNT_ROUNDING)} |
| \`settings.amount_format\` | ${bullet(SPEC_AMOUNT_FORMATS)} |
| \`transform.op\` | ${bullet(SPEC_TRANSFORM_OPERATIONS)} |

### 2.1 Parameter sources, explained

| Source | What it resolves to |
| :--- | :--- |
| \`GATEWAY_META\` | A field of the gateway (\`code\`, \`name\`, \`operator\`, \`country\`). |
| \`ROUTE_META\` | A field of the pinned route. |
| \`CREDENTIAL\` | A value from \`required_credentials\`; \`selector\` is the credential key. |
| \`ATTEMPT\` | The attempt: \`reference\`, \`totalChargedAmount\`, \`requestedAmount\`, \`currency\`, \`env\`, \`subMode\`. |
| \`CUSTOMER_FIELD\` | A customer form input; \`selector\` is the \`rail_fields[].key\`. |
| \`STATE\` | A value stored by an earlier step's \`STATE\` output. |
| \`PREVIOUS_RESPONSE\` | A value from the previous HTTP response (never step 0). |
| \`URLS\` | A named base URL of the environment (\`selector\` = the name, e.g. \`return\`). |
| \`CLIENT_CONTEXT\` | \`ip\`, \`userAgent\` of the payer. |
| \`CONSTANT\` | \`constant_value\`. |
| \`NOW\` | The current time (use with a \`format_date\` / \`epoch_seconds\` transform). |
| \`RANDOM\` | A random value (use with \`uuid\` / \`numeric_random\`). |
| \`COMPUTED\` | A registered compute operation (advanced). |
| \`CRYPTO_SIGNATURE\` | The signature produced by \`crypto_profile\`. |

### 2.2 Transform operations, explained

The library is closed. The most used ones:

| Operation | Args | Purpose |
| :--- | :--- | :--- |
| \`scale\` | \`[factor]\` | Multiply by the amount scale (e.g. \`scale 1000\` turns 100.0000 into 100.000). |
| \`to_int\` | — | Drop the fraction (after \`scale\`), producing the integer minor units. |
| \`format_decimal\` | \`[places]\` | Render a decimal with exactly N places (for a canonical \`settled_amount\`). |
| \`round\` | \`[mode, places?]\` | \`NONE\\|NEAREST\\|UP\\|DOWN\`, optional places. |
| \`phone_normalize\` | — | Normalise a Libyan / international phone number. |
| \`arabic_digits_to_ascii\` | — | Convert ٠١٢ … to 012 … |
| \`template\` | \`[template]\` | Interpolate \`{{path}}\` values. |
| \`format_date\` | \`[format, timezone?]\` | \`YYYYMMDDHHmm\` etc. |
| \`epoch_seconds\` / \`epoch_millis\` | — | Timestamps. |
| \`sort_keys\` / \`values_only\` / \`join_pairs\` | — | Canonical strings for signatures. |
| \`hmac_sha256\` / \`hmac_sha512\` / \`sha256\` / \`sha512\` / \`rsa_sha256_sign\` | — | Cryptographic recipes. |

A monetary output (\`SETTLED_AMOUNT\`, \`PROVIDER_FEE\`) must never use
\`to_number\`.

---

## 3. The JSON Schema (authoritative)

\`\`\`json
${JSON.stringify(jsonSchema, null, 2)}
\`\`\`

---

## 4. Gold-standard examples

${railKindHint(options.railKind)}

${pickExamples(options.railKind)}

---

## 5. Your task

Paste the provider's documentation below (PDF text, Markdown, a Postman
collection, or a cURL dump), and answer the two questions.

### 5.1 Provider documentation

\`\`\`text
<<< PASTE THE PROVIDER'S API DOCUMENTATION HERE >>>
\`\`\`

### 5.2 Credential field names (names and types ONLY — never real secrets)

\`\`\`text
<<< PASTE THE CREDENTIAL *NAMES* AND *TYPES* HERE, e.g.
MID (public), MerchantSecretKey (secret, HEX), webhook_secret (secret, UTF8) >>>
\`\`\`

### 5.3 What kind of rail is this?

\`\`\`text
<<< OTP_PULL | REDIRECT | EMBEDDED | QR_DISPLAY | PUSH_APPROVAL | HYBRID >>>
\`\`\`

### 5.4 The 2–3 documented request/response examples (for test_vectors)

\`\`\`text
<<< PASTE THE DOCUMENTED REQUEST/RESPONSE PAIRS HERE >>>
\`\`\`

---

## 6. Self-check before you answer

- [ ] \`spec_version\` is exactly \`"${SPEC_VERSION}"\`.
- [ ] Every \`auth.env\` matches an \`environments[].env\`.
- [ ] Every \`base_urls\` host is listed in that environment's \`allowed_hosts\`.
- [ ] Every \`rail_field.key\` is snake_case and every \`CUSTOMER_FIELD\`
      parameter points at one of them.
- [ ] Every \`CRYPTO_SIGNATURE\` parameter names an existing \`crypto_profiles[].name\`.
- [ ] Every \`MOVES_MONEY\` step has \`retry_policy: "NEVER"\` and
      \`point_of_no_return: true\`.
- [ ] \`test_vectors\` has at least two vectors, each with a request, the
      documented response, and the expected \`status\` / \`extractions\`.
- [ ] You used only the values from section 2.

Return the single \`\`\`json document now.
`;

  return {
    filename: `ai-integration-transcript-${options.railKind ? options.railKind.toLowerCase() : "generic"}.md`,
    contentType: "text/markdown",
    markdown,
    vocabulary,
    specVersion: SPEC_VERSION,
  };
};

const railKindHint = (railKind: TranscriptOptions["railKind"]): string =>
  railKind
    ? `The admin selected the **${railKind}** shape, so this transcript focuses on it (the full schema in section 3 still applies).`
    : "The admin did not select a shape, so both examples below are included (an OTP rail and a Redirect rail).";
