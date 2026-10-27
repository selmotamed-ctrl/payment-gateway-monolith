import type { IntegrationSpec } from "../../engine/specImporter/specSchema";

/**
 * A complete, valid OTP-pull spec.
 *
 * It is the fixture the schema / validator / simulator / materializer tests
 * share, and it doubles as the "does the documented example actually verify?"
 * regression. Its two `test_vectors` are the contract: the simulator must
 * reach AWAITING_CUSTOMER for the initiate vector and SUCCEEDED for the submit
 * vector, extracting the documented fields and the wire amount.
 */
export const otpSpec = (): IntegrationSpec => ({
  spec_version: "1.0",
  gateway: {
    code: "acme-otp",
    name: "Acme OTP",
    operator: "Acme",
    country: "LY",
    aliases: ["acme"],
    kind: "DIRECT",
    risk_class: "NORMAL",
  },
  environments: [
    {
      env: "SANDBOX",
      base_urls: { api: "https://sandbox.acme.ly" },
      allowed_hosts: ["sandbox.acme.ly"],
      inbound_ip_allowlist: [],
      enabled: true,
    },
    {
      env: "LIVE",
      base_urls: { api: "https://api.acme.ly" },
      allowed_hosts: ["api.acme.ly"],
      inbound_ip_allowlist: [],
      enabled: true,
    },
  ],
  auth: [
    { env: "SANDBOX", method: "REQUEST_SIGNATURE", apply: "HEADER", signature_header: "X-Signature", timestamp_header: "X-Timestamp", signature_algorithm: "HMAC_SHA256" },
    { env: "LIVE", method: "REQUEST_SIGNATURE", apply: "HEADER", signature_header: "X-Signature", timestamp_header: "X-Timestamp", signature_algorithm: "HMAC_SHA256" },
  ],
  required_credentials: [
    { key: "MID", is_secret: false, type: "HEADER", description: "Merchant id" },
    { key: "MerchantSecretKey", is_secret: true, encoding: "HEX", type: "HEADER", description: "HMAC key, hex encoded" },
  ],
  settings: {
    amount_scale: 1000,
    amount_precision: 2,
    amount_rounding: "NONE",
    amount_format: "INTEGER_MINOR_UNITS",
    reference_format: {},
    session_ttl_seconds: 1200,
    otp_ttl_seconds: 300,
    otp_resend_cooldown_seconds: 60,
    max_otp_attempts: 3,
    supports_status_check: true,
    supports_idempotency_key: false,
    supports_cancel: true,
    timeout_ms: 15000,
    max_response_bytes: 2097152,
    gateway_timezone: "Africa/Tripoli",
  },
  rail: {
    code: "acme-otp",
    name_ar: "أكمي",
    name_en: "Acme OTP",
    collection_mode: "OTP_PULL",
    currency: "LYD",
    capabilities: { refund: true, partial_refund: false, void: false, capture: false, recurring: false },
    instructions_ar: "أدخل رمز التحقق",
    instructions_en: "Enter the verification code",
  },
  rail_fields: [
    { key: "phone", type: "PHONE", label_ar: "رقم الهاتف", label_en: "Phone", required: true, min_length: 9, max_length: 15, sensitivity: "SENSITIVE", order_index: 0 },
    { key: "otp", type: "OTP", label_ar: "رمز التحقق", label_en: "OTP", required: true, min_length: 4, max_length: 6, sensitivity: "SENSITIVE", order_index: 1 },
  ],
  rail_route: {
    credential_policy: "PLATFORM",
    priority: 100,
    routing_strategy: "EFFECTIVE_COST",
    weight: 100,
    cost_model: { calc_type: "PERCENTAGE", percent: "1.5", accrue_fee_at_confirm: false },
    mismatch_policy: { tolerance_amount: "0.0100", underpay_action: "ACCEPT", overpay_action: "ACCEPT" },
    min_amount: "1.0000",
    max_amount: "20000.0000",
    scope: { channels: ["WEB"] },
  },
  crypto_profiles: [
    {
      name: "acme-sign",
      purpose: "OUTBOUND_SIGN",
      algorithm: "HMAC_SHA256",
      secret_key_ref: "MerchantSecretKey",
      secret_key_encoding: "HEX",
      canonicalization_mode: "SORTED_KEY_VALUE_AMP",
      included_fields: [],
      excluded_fields: ["SecureHash"],
      output_encoding: "HEX_UPPER",
    },
  ],
  flows: [
    {
      phase: "INITIATE",
      steps: [
        {
          id: "verify-phone",
          order_index: 0,
          type: "HTTP",
          method: "POST",
          url_template: "{api}/verify",
          content_type: "application/x-www-form-urlencoded",
          side_effect: "SENDS_NOTIFICATION",
          retry_policy: "SAFE_WITH_COOLDOWN",
          point_of_no_return: false,
          idempotency_config: { mode: "NONE" },
          parameters: [
            { place: "FORM", key: "MID", source: "CREDENTIAL", selector: "MID" },
            {
              place: "FORM",
              key: "Amount",
              source: "ATTEMPT",
              selector: "totalChargedAmount",
              transforms: [{ op: "scale", args: [1000] }, { op: "to_int" }],
            },
            {
              place: "FORM",
              key: "Phone",
              source: "CUSTOMER_FIELD",
              selector: "phone",
              transforms: [{ op: "phone_normalize", args: ["LOCAL_09"] }],
            },
            { place: "FORM", key: "SecureHash", source: "CRYPTO_SIGNATURE", crypto_profile: "acme-sign" },
            { place: "HEADERS", key: "X-Timestamp", source: "NOW" },
          ],
          outputs: [
            { name: "process_id", selector: "process_id", store_as: "STATE", required: true },
          ],
          status_rules: [
            { selector: "status", op: "equals", value: "PENDING", canonical_status: "AWAITING_CUSTOMER" },
          ],
        },
      ],
    },
    {
      phase: "SUBMIT",
      steps: [
        {
          id: "confirm-otp",
          order_index: 0,
          type: "HTTP",
          method: "POST",
          url_template: "{api}/confirm",
          content_type: "application/x-www-form-urlencoded",
          side_effect: "MOVES_MONEY",
          retry_policy: "NEVER",
          point_of_no_return: true,
          idempotency_config: { mode: "NONE" },
          parameters: [
            { place: "FORM", key: "MID", source: "CREDENTIAL", selector: "MID" },
            { place: "FORM", key: "ProcessId", source: "STATE", selector: "process_id" },
            { place: "FORM", key: "Otp", source: "CUSTOMER_FIELD", selector: "otp" },
          ],
          outputs: [
            { name: "transaction_id", selector: "transaction_id", store_as: "PROVIDER_REF", required: true },
            {
              name: "settled_amount",
              selector: "amount",
              store_as: "SETTLED_AMOUNT",
              transforms: [{ op: "format_decimal", args: [4] }],
            },
          ],
          status_rules: [
            { selector: "status", op: "equals", value: "PAID", canonical_status: "SUCCEEDED" },
            { selector: "status", op: "equals", value: "DECLINED", canonical_status: "FAILED", canonical_error: "TERMINAL_DECLINE" },
          ],
        },
      ],
    },
  ],
  confirmation_channels: [
    {
      type: "WEBHOOK",
      path_token: "acme-webhook-token",
      crypto_profile: "acme-sign",
      verify_method: "HMAC_BODY",
      signature_header: "X-Signature",
      timestamp_selector: "timestamp",
      timestamp_tolerance_sec: 300,
      ip_allowlist: [],
      body_format: "JSON",
      correlation_selector: "reference",
      dedupe_key_selector: "event_id",
      event_map: { PAID: "SUCCESS", DECLINED: "FAILED" },
      must_inquire: false,
      ack_status: 200,
    },
  ],
  error_maps: [
    {
      gateway_code: "OTP_EXPIRED",
      canonical_error: "RETRYABLE_OTP",
      classification: "RETRYABLE_OTP",
      retryable: true,
      counts_toward_lockout: true,
      counts_toward_breaker: false,
    },
  ],
  status_rules: [],
  test_vectors: [
    {
      name: "verify phone returns a process id",
      phase: "INITIATE",
      request: { amount: "100.0000", currency: "LYD", phone: "0912345678" },
      response: { status: "PENDING", process_id: "PROC-1" },
      expect: {
        status: "AWAITING_CUSTOMER",
        extractions: { process_id: "PROC-1" },
        wire_amount: "100000",
      },
    },
    {
      name: "confirm otp is paid",
      phase: "SUBMIT",
      request: { amount: "100.0000", currency: "LYD", otp: "1234", process_id: "PROC-1" },
      response: { status: "PAID", transaction_id: "TX-9", amount: "100.0000" },
      expect: {
        status: "SUCCEEDED",
        extractions: { settled_amount: "100.0000", providerReference: "TX-9" },
      },
    },
  ],
} as IntegrationSpec);

/** A spec with one defect of each semantic class, used by the validator test. */
export const brokenSpec = (): IntegrationSpec => {
  const spec = otpSpec();
  return {
    ...spec,
    environments: [
      {
        ...spec.environments[0]!,
        base_urls: { api: "https://127.0.0.1" },
        allowed_hosts: ["127.0.0.1"],
      },
    ],
    auth: [
      { env: "SANDBOX", method: "REQUEST_SIGNATURE", apply: "HEADER" },
    ],
    flows: [
      {
        phase: "INITIATE",
        steps: [
          {
            ...spec.flows[0]!.steps[0]!,
            parameters: [
              { place: "BODY", key: "prev", source: "PREVIOUS_RESPONSE", selector: "x" },
            ],
            side_effect: "MOVES_MONEY",
            retry_policy: "SAFE",
            status_rules: [],
          },
        ],
      },
    ],
    confirmation_channels: [],
    test_vectors: [],
  } as IntegrationSpec;
};
